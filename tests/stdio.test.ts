import { expect, test } from 'bun:test';
import { balanceResultSchema, listTasksResultSchema } from '../src/client';
import { taskStatusResultSchema } from '../src/task-status';
import { taskReportOutputSchema } from '../src/task-report';
import {
  account,
  bounded,
  connect,
  deferred,
  dummyKey,
  fixture,
} from './helpers';
import { verifyEof } from './stdio-eof';

type SchemaBranch = {
  type?: string;
  additionalProperties?: unknown;
  required?: string[];
  properties?: Record<string, unknown>;
};

function schemaContainsNull(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaContainsNull);
  if (typeof schema !== 'object' || schema === null) return false;
  const object = schema as Record<string, unknown>;
  if (object.type === 'null') return true;
  if (Array.isArray(object.type) && object.type.includes('null')) return true;
  return Object.values(object).some(schemaContainsNull);
}

test('LT-06: real SDK process registers all read-only tools with structured and text output', async () => {
  const statusBodies: string[] = [];
  const reportBodies: string[] = [];
  const opaqueDonor = {
    unknown: { nested: [null, false, 2, 'keep', { inner: null }] },
  };
  const api = await fixture((request, response) => {
    if (request.url === '/v2/account') {
      response.end(JSON.stringify(account));
      return;
    }
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      void (async () => {
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        if (request.url?.endsWith('/report')) {
          reportBodies.push(body);
          const parsed = JSON.parse(body) as {
            task_id: string;
            page?: number;
            limit?: number;
          };
          const result =
            request.url === '/v2/task/backlink/checker/report'
              ? {
                  id: parsed.task_id,
                  size: 1,
                  processed_count: 1,
                  donors: [opaqueDonor],
                  page: parsed.page,
                  last_page: 0,
                }
              : {
                  id: parsed.task_id,
                  size: 1,
                  processed_count: 1,
                  indexed_links: [],
                  unindexed_links: [],
                  type: 'google/indexer',
                  title: 'synthetic SDK report',
                  created_at: '2026-10-20T10:00:00.000Z',
                };
          response.end(JSON.stringify({ code: 0, result }));
          return;
        }
        statusBodies.push(body);
        const parsed = JSON.parse(body) as {
          task_id?: string;
          task_ids?: string[];
        };
        const id = parsed.task_ids?.[0] ?? parsed.task_id;
        response.end(JSON.stringify({ code: 0, result: { id } }));
      })();
      return;
    }
    const page = Number(
      new URL(request.url ?? '/', 'http://fixture').pathname.split('/').at(-1),
    );
    response.end(
      JSON.stringify({
        code: 0,
        page,
        last_page: 0,
        result: [{ id: 'task-a' }],
      }),
    );
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin);
    expect(session.client.getServerVersion()).toEqual({
      name: 'speedyindex-mcp',
      version: '0.1.0',
    });
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(tools[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['balance', 'observedAt'],
    });
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['searchEngine', 'taskType', 'page'],
      properties: {
        searchEngine: { enum: ['google', 'yandex', 'bing'] },
        taskType: { enum: ['indexer', 'checker'] },
        page: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        filter: { enum: ['standard', 'pay_per_indexed', 'drip_feed'] },
        payPerIndexed: { type: 'boolean' },
      },
    });
    expect(tools[1]?.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['searchEngine', 'taskType', 'page', 'lastPage', 'tasks'],
      properties: {
        tasks: { type: 'array', maxItems: 1000 },
      },
    });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tools[2]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['family'],
      properties: {
        family: {
          enum: [
            'google/indexer',
            'google/checker',
            'yandex/indexer',
            'yandex/checker',
            'bing/checker',
            'backlink/checker',
          ],
        },
        taskId: { type: 'string' },
        taskIds: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: { type: 'string' },
        },
      },
    });
    expect(tools[2]?.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['family', 'requestedIds', 'tasks', 'unreturnedIds'],
      properties: {
        requestedIds: { type: 'array', minItems: 1, maxItems: 1000 },
        tasks: { type: 'array', maxItems: 1000 },
        unreturnedIds: { type: 'array', maxItems: 1000 },
      },
    });
    expect(tools[2]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const reportTool = tools[3];
    const reportInputVariants = (
      reportTool?.inputSchema as { oneOf?: SchemaBranch[] } | undefined
    )?.oneOf;
    expect(reportTool?.inputSchema).toMatchObject({ type: 'object' });
    expect(reportInputVariants).toHaveLength(2);
    const genericInput = reportInputVariants?.find((variant) => {
      const family = variant.properties?.family as
        { enum?: string[] } | undefined;
      return family?.enum !== undefined;
    });
    const backlinkInput = reportInputVariants?.find((variant) => {
      const family = variant.properties?.family as
        { const?: string } | undefined;
      return family?.const === 'backlink/checker';
    });
    expect(genericInput).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['family', 'taskId'],
      properties: {
        family: {
          enum: [
            'google/indexer',
            'google/checker',
            'yandex/indexer',
            'yandex/checker',
            'bing/checker',
          ],
        },
        taskId: { type: 'string' },
      },
    });
    expect(genericInput?.properties?.page).toBeUndefined();
    expect(genericInput?.properties?.limit).toBeUndefined();
    expect(backlinkInput).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['family', 'taskId'],
      properties: {
        family: { const: 'backlink/checker' },
        page: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 100, minimum: 1, maximum: 100 },
      },
    });
    expect(
      (backlinkInput?.properties?.page as { minimum?: number } | undefined)
        ?.minimum,
    ).toBe(0);
    const reportOutputVariants = (
      reportTool?.outputSchema as { oneOf?: SchemaBranch[] } | undefined
    )?.oneOf;
    expect(reportTool?.outputSchema).toMatchObject({ type: 'object' });
    expect(reportOutputVariants).toHaveLength(2);
    expect(
      reportOutputVariants
        ?.map(
          (variant) =>
            (variant.properties?.reportKind as { const?: string } | undefined)
              ?.const,
        )
        .sort(),
    ).toEqual(['backlink', 'links']);
    for (const variant of reportOutputVariants ?? []) {
      expect(variant).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(variant.required).toContain('reportKind');
    }
    const backlinkOutput = reportOutputVariants?.find(
      (variant) =>
        (variant.properties?.reportKind as { const?: string } | undefined)
          ?.const === 'backlink',
    );
    const linksOutput = reportOutputVariants?.find(
      (variant) =>
        (variant.properties?.reportKind as { const?: string } | undefined)
          ?.const === 'links',
    );
    expect(
      (linksOutput?.properties?.family as { enum?: string[] } | undefined)
        ?.enum,
    ).toEqual([
      'google/indexer',
      'google/checker',
      'yandex/indexer',
      'yandex/checker',
      'bing/checker',
    ]);
    expect(
      (backlinkOutput?.properties?.family as { const?: string } | undefined)
        ?.const,
    ).toBe('backlink/checker');
    const donors = backlinkOutput?.properties?.donors as
      { maxItems?: number; items?: Record<string, unknown> } | undefined;
    expect(donors?.maxItems).toBe(100);
    expect(donors?.items?.type).toBe('object');
    expect(donors?.items?.additionalProperties).not.toBe(false);
    expect(schemaContainsNull(reportTool?.outputSchema)).toBe(true);
    expect(reportTool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const result = await session.client.callTool({
      name: 'get_balance',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const parsed = balanceResultSchema.parse(result.structuredContent);
    expect(parsed.balance).toEqual(account.balance);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(parsed) },
    ]);
    const listResult = await session.client.callTool({
      name: 'list_tasks',
      arguments: { searchEngine: 'google', taskType: 'indexer', page: 0 },
    });
    expect(listResult.isError).not.toBe(true);
    const parsedList = listTasksResultSchema.parse(
      listResult.structuredContent,
    );
    expect(parsedList.tasks).toEqual([{ id: 'task-a' }]);
    expect(listResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedList) },
    ]);
    const statusResult = await session.client.callTool({
      name: 'get_task_status',
      arguments: { family: 'google/indexer', taskId: 'status-task' },
    });
    expect(statusResult.isError).not.toBe(true);
    const parsedStatus = taskStatusResultSchema.parse(
      statusResult.structuredContent,
    );
    expect(parsedStatus).toEqual({
      family: 'google/indexer',
      requestedIds: ['status-task'],
      tasks: [{ id: 'status-task' }],
      unreturnedIds: [],
    });
    expect(statusResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedStatus) },
    ]);
    const batchIds = ['batch-returned', 'missing-z', 'missing-a'];
    const batchStatusResult = await session.client.callTool({
      name: 'get_task_status',
      arguments: { family: 'google/indexer', taskIds: batchIds },
    });
    expect(batchStatusResult.isError).not.toBe(true);
    const parsedBatchStatus = taskStatusResultSchema.parse(
      batchStatusResult.structuredContent,
    );
    expect(parsedBatchStatus).toEqual({
      family: 'google/indexer',
      requestedIds: batchIds,
      tasks: [{ id: 'batch-returned' }],
      unreturnedIds: ['missing-z', 'missing-a'],
    });
    expect(batchStatusResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedBatchStatus) },
    ]);
    const genericReportResult = await session.client.callTool({
      name: 'get_task_report',
      arguments: { family: 'google/indexer', taskId: 'sdk-report' },
    });
    expect(genericReportResult.isError).not.toBe(true);
    const parsedGenericReport = taskReportOutputSchema.parse(
      genericReportResult.structuredContent,
    );
    expect(parsedGenericReport).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'sdk-report',
      size: 1,
      processedCount: 1,
      indexedLinks: [],
      unindexedLinks: [],
      type: 'google/indexer',
      title: 'synthetic SDK report',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
    expect(genericReportResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedGenericReport) },
    ]);
    const backlinkReportResult = await session.client.callTool({
      name: 'get_task_report',
      arguments: { family: 'backlink/checker', taskId: 'sdk-backlink' },
    });
    expect(backlinkReportResult.isError).not.toBe(true);
    const parsedBacklinkReport = taskReportOutputSchema.parse(
      backlinkReportResult.structuredContent,
    );
    expect(parsedBacklinkReport).toEqual({
      family: 'backlink/checker',
      reportKind: 'backlink',
      taskId: 'sdk-backlink',
      size: 1,
      processedCount: 1,
      donors: [opaqueDonor],
      page: 0,
      lastPage: 0,
    });
    expect(backlinkReportResult.content).toEqual([
      { type: 'text', text: JSON.stringify(parsedBacklinkReport) },
    ]);
    const invalidReportInput = await session.client.callTool({
      name: 'get_task_report',
      arguments: {
        family: 'google/indexer',
        taskId: 'invalid-report-input',
        page: 1,
      },
    });
    expect(invalidReportInput.isError).toBe(true);
    expect(invalidReportInput.structuredContent).toBeUndefined();
    expect(reportBodies).toEqual([
      JSON.stringify({ task_id: 'sdk-report' }),
      JSON.stringify({ task_id: 'sdk-backlink', page: 0, limit: 100 }),
    ]);
    expect(statusBodies).toEqual([
      JSON.stringify({ task_id: 'status-task' }),
      JSON.stringify({ task_ids: batchIds }),
    ]);
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/v2/account' },
      { method: 'GET', path: '/v2/task/google/indexer/list/0' },
      { method: 'POST', path: '/v2/task/google/indexer/status' },
      { method: 'POST', path: '/v2/task/google/indexer/status' },
      { method: 'POST', path: '/v2/task/google/indexer/report' },
      { method: 'POST', path: '/v2/task/backlink/checker/report' },
    ]);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('TSP-07: MCP rejects invalid status IDs and families before provider HTTP', async () => {
  const api = await fixture((_request, response) =>
    response.end(JSON.stringify({ code: 0, result: { id: 'unexpected' } })),
  );
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect(api.origin);
    const invalidCalls = [
      {
        arguments: {
          family: 'google/indexer',
          taskId: 'one',
          taskIds: ['one'],
        },
        reason: 'taskId',
      },
      {
        arguments: { family: 'unsupported/checker', taskId: 'one' },
        reason: 'family',
      },
    ];
    for (const invalid of invalidCalls) {
      const result = await session.client.callTool({
        name: 'get_task_status',
        arguments: invalid.arguments,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const message = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join(' ');
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain(invalid.reason);
    }
    expect(api.requests).toHaveLength(0);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('TSP-05: MCP status errors redact provider details and omit structured output', async () => {
  const sentinel = 'synthetic-status-error-detail';
  const api = await fixture((_request, response) =>
    response.end(
      JSON.stringify({ code: 9, message: `${dummyKey}-${sentinel}` }),
    ),
  );
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect(api.origin);
    const result = await session.client.callTool({
      name: 'get_task_status',
      arguments: { family: 'google/indexer', taskId: 'requested' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(dummyKey);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.content).toEqual([
      { type: 'text', text: 'SpeedyIndex rejected the task-status request.' },
    ]);
    expect(api.requests).toHaveLength(1);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('TR-06: MCP report errors redact provider details and omit structured output', async () => {
  const sentinel = 'synthetic-report-error-detail';
  const api = await fixture((_request, response) =>
    response.end(
      JSON.stringify({ code: 9, message: `${dummyKey}-${sentinel}` }),
    ),
  );
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect(api.origin);
    const result = await session.client.callTool({
      name: 'get_task_report',
      arguments: { family: 'google/indexer', taskId: 'requested' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(dummyKey);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.content).toEqual([
      { type: 'text', text: 'SpeedyIndex rejected the task-report request.' },
    ]);
    expect(api.requests).toHaveLength(1);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('LT-02: SDK rejects invalid list_tasks input before making a provider request', async () => {
  const api = await fixture((_req, res) =>
    res.end(JSON.stringify({ code: 0, page: 0, last_page: 0, result: [] })),
  );
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  const invalidInputs: Record<string, unknown>[] = [
    { searchEngine: 'google', taskType: 'indexer' },
    { searchEngine: 'google', taskType: 'indexer', page: -1 },
    { searchEngine: 'google', taskType: 'indexer', page: 1.25 },
    { searchEngine: 'other', taskType: 'checker', page: 0 },
    {
      searchEngine: 'google',
      taskType: 'indexer',
      page: 0,
      filter: 'all',
    },
    { searchEngine: 'bing', taskType: 'indexer', page: 0 },
    {
      searchEngine: 'yandex',
      taskType: 'indexer',
      page: 0,
      filter: 'standard',
    },
    {
      searchEngine: 'google',
      taskType: 'indexer',
      page: 0,
      payPerIndexed: true,
    },
    {
      searchEngine: 'google',
      taskType: 'indexer',
      page: 0,
      unexpected: true,
    },
  ];
  try {
    session = await connect(api.origin);
    for (const input of invalidInputs) {
      const result = await session.client.callTool({
        name: 'list_tasks',
        arguments: input,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
    expect(api.requests).toHaveLength(0);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('LT-04: MCP list_tasks errors are sanitized and omit structured output', async () => {
  const api = await fixture((_req, res) =>
    res.end(JSON.stringify({ code: 2, message: dummyKey })),
  );
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin);
    const result = await session.client.callTool({
      name: 'list_tasks',
      arguments: { searchEngine: 'google', taskType: 'indexer', page: 0 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(dummyKey);
    expect(result.content).toEqual([
      { type: 'text', text: 'SpeedyIndex rejected the task-list request.' },
    ]);
    expect(api.requests).toHaveLength(1);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('F02: direct stdin EOF after initialize exits successfully', async () => {
  await verifyEof('src/cli.ts');
});

test('F02: SDK client close reaps the server process', async () => {
  const session = await connect('http://127.0.0.1:1');
  const pid = session.transport.pid;
  try {
    expect(pid).not.toBeNull();
  } finally {
    await session.close();
  }
  expect(() => process.kill(pid!, 0)).toThrow();
  expect(session.stderr()).toBe('');
});

test('F07: SDK get_balance cancellation aborts underlying HTTP and next call succeeds', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let first = true;
  const api = await fixture((_req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      arrived.resolve();
    } else res.end(JSON.stringify(account));
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin);
    const controller = new AbortController();
    const cancelled = session.client
      .callTool(
        { name: 'get_balance', arguments: {} },
        { signal: controller.signal },
      )
      .then(
        () => 'unexpected success',
        () => 'cancelled',
      );
    await bounded(arrived.promise);
    controller.abort();
    expect(await bounded(cancelled)).toBe('cancelled');
    await bounded(disconnected.promise);
    const result = await session.client.callTool({
      name: 'get_balance',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(balanceResultSchema.parse(result.structuredContent).balance).toEqual(
      account.balance,
    );
    expect(api.requests).toHaveLength(2);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

for (const [label, key, mode] of [
  ['missing', '', ''],
  ['blank', '  ', ''],
  ['network exception', dummyKey, 'throw'],
  ['provider body', dummyKey, ''],
] as const) {
  test(`F05: MCP errors and stderr redact credentials: ${label}`, async () => {
    const api = await fixture((_req, res) =>
      res.end(JSON.stringify({ code: 3, message: dummyKey })),
    );
    let session: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      session = await connect(api.origin, 'src/cli.ts', key, mode);
      const result = await session.client.callTool({
        name: 'get_balance',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(dummyKey);
      expect(JSON.stringify(result).length).toBeLessThan(300);
      expect(session.stderr()).toBe('');
      expect(api.requests).toHaveLength(label === 'provider body' ? 1 : 0);
      if (label === 'missing' || label === 'blank')
        expect(result.content).toEqual([
          {
            type: 'text',
            text: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
          },
        ]);
    } finally {
      try {
        await session?.close();
      } finally {
        await api.close();
      }
    }
  });
}

test('LT-07: SDK list_tasks cancellation aborts underlying HTTP and next call succeeds', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let first = true;
  const api = await fixture((_req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      arrived.resolve();
    } else
      res.end(
        JSON.stringify({
          code: 0,
          page: 0,
          last_page: 0,
          result: [{ id: 'task-a' }],
        }),
      );
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin);
    const controller = new AbortController();
    const cancelled = session.client
      .callTool(
        {
          name: 'list_tasks',
          arguments: {
            searchEngine: 'google',
            taskType: 'indexer',
            page: 0,
          },
        },
        { signal: controller.signal },
      )
      .then(
        () => 'unexpected success',
        () => 'cancelled',
      );
    await bounded(arrived.promise);
    controller.abort();
    expect(await bounded(cancelled)).toBe('cancelled');
    await bounded(disconnected.promise);
    const result = await session.client.callTool({
      name: 'list_tasks',
      arguments: { searchEngine: 'google', taskType: 'indexer', page: 0 },
    });
    expect(result.isError).not.toBe(true);
    expect(listTasksResultSchema.parse(result.structuredContent).tasks).toEqual(
      [{ id: 'task-a' }],
    );
    expect(api.requests).toHaveLength(2);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('TSP-08: SDK status cancellation aborts POST and the next call succeeds', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let first = true;
  const api = await fixture((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      if (first) {
        first = false;
        response.on('close', () => disconnected.resolve());
        arrived.resolve();
      } else {
        response.end(JSON.stringify({ code: 0, result: { id: 'next-task' } }));
      }
    });
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect(api.origin);
    const controller = new AbortController();
    const cancelled = session.client
      .callTool(
        {
          name: 'get_task_status',
          arguments: { family: 'google/indexer', taskId: 'cancelled-task' },
        },
        { signal: controller.signal },
      )
      .then(
        () => 'unexpected success',
        () => 'cancelled',
      );
    await bounded(arrived.promise);
    controller.abort();
    expect(await bounded(cancelled)).toBe('cancelled');
    await bounded(disconnected.promise);

    const next = await session.client.callTool({
      name: 'get_task_status',
      arguments: { family: 'google/indexer', taskId: 'next-task' },
    });
    expect(next.isError).not.toBe(true);
    expect(taskStatusResultSchema.parse(next.structuredContent).tasks).toEqual([
      { id: 'next-task' },
    ]);
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/v2/task/google/indexer/status' },
      { method: 'POST', path: '/v2/task/google/indexer/status' },
    ]);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('TR-07: SDK report cancellation aborts POST and the next report succeeds', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let first = true;
  const api = await fixture((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      if (first) {
        first = false;
        response.on('close', () => disconnected.resolve());
        arrived.resolve();
      } else {
        response.end(
          JSON.stringify({
            code: 0,
            result: {
              id: 'next-report',
              size: 1,
              processed_count: 1,
              indexed_links: [],
              unindexed_links: [],
              type: 'google/indexer',
              title: 'synthetic cancellation recovery',
              created_at: '2026-10-20T10:00:00.000Z',
            },
          }),
        );
      }
    });
  });
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect(api.origin);
    const controller = new AbortController();
    const cancelled = session.client
      .callTool(
        {
          name: 'get_task_report',
          arguments: { family: 'google/indexer', taskId: 'cancelled-report' },
        },
        { signal: controller.signal },
      )
      .then(
        () => 'unexpected success',
        () => 'cancelled',
      );
    await bounded(arrived.promise);
    controller.abort();
    expect(await bounded(cancelled)).toBe('cancelled');
    await bounded(disconnected.promise);

    const next = await session.client.callTool({
      name: 'get_task_report',
      arguments: { family: 'google/indexer', taskId: 'next-report' },
    });
    expect(next.isError).not.toBe(true);
    expect(taskReportOutputSchema.parse(next.structuredContent)).toMatchObject({
      reportKind: 'links',
      taskId: 'next-report',
    });
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/v2/task/google/indexer/report' },
      { method: 'POST', path: '/v2/task/google/indexer/report' },
    ]);
    expect(session.stderr()).toBe('');
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});
