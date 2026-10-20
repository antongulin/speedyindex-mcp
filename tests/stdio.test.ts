import { expect, test } from 'bun:test';
import { balanceResultSchema, listTasksResultSchema } from '../src/client';
import { taskStatusResultSchema } from '../src/task-status';
import {
  account,
  bounded,
  connect,
  deferred,
  dummyKey,
  fixture,
} from './helpers';
import { verifyEof } from './stdio-eof';

test('LT-06: real SDK process registers all read-only tools with structured and text output', async () => {
  const statusBodies: string[] = [];
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
    expect(statusBodies).toEqual([
      JSON.stringify({ task_id: 'status-task' }),
      JSON.stringify({ task_ids: batchIds }),
    ]);
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/v2/account' },
      { method: 'GET', path: '/v2/task/google/indexer/list/0' },
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
