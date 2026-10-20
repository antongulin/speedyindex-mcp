import { expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { SpeedyIndexClient } from '../src/client';
import {
  TaskReportError,
  taskReportInputSchema,
  taskReportOutputSchema,
} from '../src/task-report';
import { dummyKey, fixture, loopbackFetch } from './helpers';

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function reportClient(
  origin: string,
  key: string | undefined = dummyKey,
  maxBytes = 16 * 1024 * 1024,
) {
  return new SpeedyIndexClient(key, loopbackFetch(origin), 10_000, maxBytes);
}

function linksReport(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    size: 3,
    processed_count: 2,
    indexed_links: [],
    unindexed_links: [],
    type: 'google/indexer',
    title: 'synthetic report',
    created_at: '2026-10-20T10:00:00.000Z',
    ...fields,
  };
}

test('TR-01: strict single-task input fails before HTTP and preserves opaque IDs', async () => {
  const bodies: string[] = [];
  const api = await fixture((request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body);
      const { task_id: taskId } = JSON.parse(body) as { task_id: string };
      response.end(JSON.stringify({ code: 0, result: linksReport(taskId) }));
    });
  });
  const client = reportClient(api.origin);
  const invalidInputs: unknown[] = [
    undefined,
    { family: 'google/indexer' },
    { family: 'google/indexer', taskId: '' },
    { family: 'google/indexer', taskId: '   ' },
    { family: 'bing/indexer', taskId: 'one' },
    { family: 'google/indexer/../report', taskId: 'one' },
    { family: 'google/indexer', taskIds: ['one'] },
    { family: 'google/indexer', taskId: 'one', page: 0 },
    { family: 'google/indexer', taskId: 'one', limit: 1 },
    { family: 'google/indexer', taskId: 'one', unexpected: true },
    { family: 'backlink/checker', taskId: 'one', page: -1 },
    { family: 'backlink/checker', taskId: 'one', page: 1.5 },
    { family: 'backlink/checker', taskId: 'one', page: Infinity },
    {
      family: 'backlink/checker',
      taskId: 'one',
      page: Number.MAX_SAFE_INTEGER + 1,
    },
    { family: 'backlink/checker', taskId: 'one', limit: 0 },
    { family: 'backlink/checker', taskId: 'one', limit: 101 },
    { family: 'backlink/checker', taskId: 'one', limit: 1.5 },
    { family: 'backlink/checker', taskId: 'one', unexpected: true },
  ];

  try {
    for (const input of invalidInputs) {
      expect(taskReportInputSchema.safeParse(input).success).toBe(false);
      await expect(client.getTaskReport(input)).rejects.toMatchObject({
        kind: 'input',
        message: 'Invalid task-report request.',
      });
    }
    expect(api.requests).toHaveLength(0);

    for (const key of [undefined, '', '   ']) {
      await expect(
        new SpeedyIndexClient(key, loopbackFetch(api.origin)).getTaskReport({
          family: 'google/indexer',
          taskId: 'opaque',
        }),
      ).rejects.toMatchObject({ kind: 'credentials' });
    }
    expect(api.requests).toHaveLength(0);

    const opaqueId = '  opaque / ID? keep spaces  ';
    const result = await client.getTaskReport({
      family: 'google/indexer',
      taskId: opaqueId,
    });
    expect(taskReportOutputSchema.parse(result)).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: opaqueId,
      size: 3,
      processedCount: 2,
      indexedLinks: [],
      unindexedLinks: [],
      type: 'google/indexer',
      title: 'synthetic report',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
    expect(bodies).toEqual([JSON.stringify({ task_id: opaqueId })]);
    expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/v2/task/google/indexer/report' },
    ]);
  } finally {
    await api.close();
  }
});

test('TR-02: each generic family makes one exact authenticated report POST', async () => {
  const families = [
    ['google/indexer', '/v2/task/google/indexer/report'],
    ['google/checker', '/v2/task/google/checker/report'],
    ['yandex/indexer', '/v2/task/yandex/indexer/report'],
    ['yandex/checker', '/v2/task/yandex/checker/report'],
    ['bing/checker', '/v2/task/bing/checker/report'],
  ] as const;
  const received: {
    method: string | undefined;
    path: string | undefined;
    auth: string | undefined;
    accept: string | undefined;
    agent: string | undefined;
    contentType: string | undefined;
    body: string;
  }[] = [];
  const api = await fixture((request, response) => {
    void readBody(request).then((body) => {
      received.push({
        method: request.method,
        path: request.url,
        auth: request.headers.authorization,
        accept: request.headers.accept,
        agent: request.headers['user-agent'],
        contentType: request.headers['content-type'],
        body,
      });
      const { task_id: taskId } = JSON.parse(body) as { task_id: string };
      response.end(JSON.stringify({ code: 0, result: linksReport(taskId) }));
    });
  });
  const client = reportClient(api.origin);

  try {
    for (const [family] of families) {
      const taskId = `generic-${received.length}`;
      const result = await client.getTaskReport({ family, taskId });
      expect(result).toMatchObject({ family, reportKind: 'links', taskId });
    }

    expect(received).toEqual(
      families.map(([, path], index) => ({
        method: 'POST',
        path,
        auth: dummyKey,
        accept: 'application/json',
        agent: 'speedyindex-mcp/0.1.0',
        contentType: 'application/json',
        body: JSON.stringify({ task_id: `generic-${index}` }),
      })),
    );
    expect(api.requests).toHaveLength(5);
  } finally {
    await api.close();
  }
});

test('TR-03: generic reports map only known fields and retain URL strings unchanged', async () => {
  const responses = [
    {
      code: 0,
      envelope_metadata: 'discarded',
      result: linksReport('complete-id', {
        size: 10,
        processed_count: 7,
        indexed_links: [
          'https://example.test/a?x=1/',
          '  https://example.test/b  ',
          'https://example.test/a?x=1/',
        ],
        unindexed_links: ['https://example.test/a?x=1/'],
        indexed_count: 99,
        is_completed: true,
        status: 'provider-state-next',
        check_after: '2026-10-21T10:00:00.000Z',
        pay_per_indexed: false,
        tokens_charged: 1.25,
        tokens_refunded: 0.5,
        drip_feed: false,
        days: 4,
        days_passed: 2,
        is_stopped: false,
        awaiting_result: true,
        child_task_ids: ['  opaque child  '],
        cancel_refund_tokens: 100,
        pre_check_status: 'discarded',
        unknown_provider_field: 'discarded',
      }),
    },
    {
      code: 0,
      result: linksReport('sparse-id', { provider_extra: true }),
    },
    { code: 0, result: linksReport('returned-other-id') },
    {
      code: 0,
      result: {
        id: 'missing-array',
        size: 1,
        processed_count: 1,
        indexed_links: [],
        type: 'google/indexer',
        title: 'synthetic',
        created_at: '2026-10-20T10:00:00.000Z',
      },
    },
    { code: 0, result: linksReport('nullable-field', { size: null }) },
    {
      code: 0,
      result: linksReport('wrong-array-item', { indexed_links: ['ok', 7] }),
    },
    {
      code: 0,
      result: linksReport('nullable-optional', { is_completed: null }),
    },
  ];
  let responseIndex = 0;
  const api = await fixture((request, response) => {
    request.resume();
    response.end(JSON.stringify(responses[responseIndex++]));
  });
  const client = reportClient(api.origin);

  try {
    const complete = await client.getTaskReport({
      family: 'google/indexer',
      taskId: 'complete-id',
    });
    expect(complete).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'complete-id',
      size: 10,
      processedCount: 7,
      indexedLinks: [
        'https://example.test/a?x=1/',
        '  https://example.test/b  ',
        'https://example.test/a?x=1/',
      ],
      unindexedLinks: ['https://example.test/a?x=1/'],
      type: 'google/indexer',
      title: 'synthetic report',
      createdAt: '2026-10-20T10:00:00.000Z',
      indexedCount: 99,
      isCompleted: true,
      status: 'provider-state-next',
      checkAfter: '2026-10-21T10:00:00.000Z',
      payPerIndexed: false,
      tokensCharged: 1.25,
      tokensRefunded: 0.5,
      dripFeed: false,
      days: 4,
      daysPassed: 2,
      isStopped: false,
      awaitingResult: true,
      childTaskIds: ['  opaque child  '],
    });

    expect(
      await client.getTaskReport({
        family: 'google/indexer',
        taskId: 'sparse-id',
      }),
    ).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'sparse-id',
      size: 3,
      processedCount: 2,
      indexedLinks: [],
      unindexedLinks: [],
      type: 'google/indexer',
      title: 'synthetic report',
      createdAt: '2026-10-20T10:00:00.000Z',
    });

    for (const taskId of [
      'id-mismatch',
      'missing-array',
      'nullable-field',
      'wrong-array-item',
      'nullable-optional',
    ]) {
      await expect(
        client.getTaskReport({ family: 'google/indexer', taskId }),
      ).rejects.toMatchObject({
        kind: 'response',
        message: 'SpeedyIndex returned an invalid task-report response.',
      });
    }
    expect(api.requests).toHaveLength(responses.length);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
  } finally {
    await api.close();
  }
});

test('TR-04: backlink reports preserve opaque JSON and enforce one-page coherence', async () => {
  const opaqueDonor = {
    unknown: { deeper: [null, false, 2, 'keep', { inner: null }] },
  };
  const bodies: Record<string, unknown>[] = [];
  const api = await fixture((request, response) => {
    void readBody(request).then((body) => {
      const parsed = JSON.parse(body) as Record<string, unknown> & {
        task_id: string;
        page: number;
        limit: number;
      };
      bodies.push(parsed);
      const taskId = parsed.task_id;
      if (taskId === 'raw-overflow') {
        response.end(
          '{"code":0,"result":{"id":"raw-overflow","size":1,"processed_count":1,"donors":[{"nested":{"n":1e400}}],"page":0,"last_page":0}}',
        );
        return;
      }

      let result: Record<string, unknown>;
      if (taskId === 'defaults') {
        result = {
          id: taskId,
          size: 3,
          processed_count: 2,
          donors: [opaqueDonor],
          page: 0,
          last_page: 2,
          unknown_envelope_field: true,
        };
      } else if (taskId === 'explicit') {
        result = {
          id: taskId,
          size: 3,
          processed_count: 2,
          donors: [opaqueDonor],
          page: parsed.page,
          last_page: parsed.page,
          is_completed: true,
        };
      } else if (taskId === 'false-completion') {
        result = {
          id: taskId,
          size: 3,
          processed_count: 2,
          donors: [opaqueDonor],
          page: parsed.page,
          last_page: parsed.page,
          is_completed: false,
        };
      } else if (taskId === 'max-rows') {
        result = {
          id: taskId,
          size: 100,
          processed_count: 100,
          donors: Array.from({ length: 100 }, (_, index) => ({ index })),
          page: parsed.page,
          last_page: parsed.page,
        };
      } else if (taskId === 'empty-beyond') {
        result = {
          id: taskId,
          size: 1,
          processed_count: 1,
          donors: [],
          page: parsed.page,
          last_page: 2,
        };
      } else if (taskId.startsWith('invalid-root-')) {
        const roots: unknown[] = [null, 1, true, 'text', [], [opaqueDonor]];
        result = {
          id: taskId,
          size: 1,
          processed_count: 1,
          donors: [roots[Number(taskId.at(-1))]],
          page: parsed.page,
          last_page: parsed.page,
        };
      } else if (taskId === 'too-many-requested') {
        result = {
          id: taskId,
          size: 2,
          processed_count: 2,
          donors: [{ one: 1 }, { two: 2 }],
          page: parsed.page,
          last_page: parsed.page,
        };
      } else if (taskId === 'too-many-maximum') {
        result = {
          id: taskId,
          size: 101,
          processed_count: 101,
          donors: Array.from({ length: 101 }, (_, index) => ({ index })),
          page: parsed.page,
          last_page: parsed.page,
        };
      } else if (taskId === 'nonempty-beyond') {
        result = {
          id: taskId,
          size: 1,
          processed_count: 1,
          donors: [opaqueDonor],
          page: parsed.page,
          last_page: 2,
        };
      } else if (taskId === 'wrong-page') {
        result = {
          id: taskId,
          size: 0,
          processed_count: 0,
          donors: [],
          page: parsed.page + 1,
          last_page: parsed.page + 1,
        };
      } else {
        result = {
          id: 'other-id',
          size: 0,
          processed_count: 0,
          donors: [],
          page: parsed.page,
          last_page: parsed.page,
        };
      }
      response.end(JSON.stringify({ code: 0, result }));
    });
  });
  const client = reportClient(api.origin);

  try {
    const defaults = await client.getTaskReport({
      family: 'backlink/checker',
      taskId: 'defaults',
    });
    expect(defaults).toEqual({
      family: 'backlink/checker',
      reportKind: 'backlink',
      taskId: 'defaults',
      size: 3,
      processedCount: 2,
      donors: [opaqueDonor],
      page: 0,
      lastPage: 2,
    });
    expect(bodies[0]).toEqual({ task_id: 'defaults', page: 0, limit: 100 });

    const explicit = await client.getTaskReport({
      family: 'backlink/checker',
      taskId: 'explicit',
      page: 2,
      limit: 1,
    });
    expect(explicit).toMatchObject({
      page: 2,
      lastPage: 2,
      donors: [opaqueDonor],
      isCompleted: true,
    });
    expect(bodies[1]).toEqual({
      task_id: 'explicit',
      page: 2,
      limit: 1,
    });

    const falseCompletion = await client.getTaskReport({
      family: 'backlink/checker',
      taskId: 'false-completion',
    });
    expect(falseCompletion).toMatchObject({
      reportKind: 'backlink',
      taskId: 'false-completion',
      donors: [opaqueDonor],
      isCompleted: false,
    });

    const maximum = await client.getTaskReport({
      family: 'backlink/checker',
      taskId: 'max-rows',
      limit: 100,
    });
    if (maximum.reportKind !== 'backlink')
      throw new Error('Expected a backlink report.');
    expect(maximum.donors).toHaveLength(100);

    const emptyBeyond = await client.getTaskReport({
      family: 'backlink/checker',
      taskId: 'empty-beyond',
      page: 3,
      limit: 1,
    });
    expect(emptyBeyond).toMatchObject({ page: 3, lastPage: 2, donors: [] });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        client.getTaskReport({
          family: 'backlink/checker',
          taskId: `invalid-root-${index}`,
        }),
      ).rejects.toMatchObject({ kind: 'response' });
    }

    const invalidCases = [
      ['raw-overflow', 0, 100],
      ['too-many-requested', 0, 1],
      ['too-many-maximum', 0, 100],
      ['nonempty-beyond', 3, 1],
      ['wrong-page', 0, 100],
      ['wrong-id', 0, 100],
    ] as const;
    for (const [taskId, page, limit] of invalidCases) {
      await expect(
        client.getTaskReport({
          family: 'backlink/checker',
          taskId,
          page,
          limit,
        }),
      ).rejects.toMatchObject({
        kind: 'response',
        message: 'SpeedyIndex returned an invalid task-report response.',
      });
    }
    expect(api.requests).toHaveLength(bodies.length);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
    expect(
      api.requests.every(
        ({ path }) => path === '/v2/task/backlink/checker/report',
      ),
    ).toBe(true);
  } finally {
    await api.close();
  }
});

test('TR-05: partial reports pass through while HTTP, provider, schema, and cap failures are sanitized', async () => {
  const sentinel = 'synthetic-report-provider-detail';
  const partial = linksReport('partial', {
    size: 10,
    processed_count: 4,
    indexed_links: ['https://partial.test/a'],
    unindexed_links: [],
    is_completed: false,
  });
  let responseIndex = 0;
  const api = await fixture((request, response) => {
    request.resume();
    const current = responseIndex++;
    if (current === 0) {
      response.end(JSON.stringify({ code: 0, result: partial }));
    } else if (current === 1) {
      response.writeHead(503);
      response.end(sentinel);
    } else if (current === 2) {
      response.end(
        JSON.stringify({ code: 7, message: `${dummyKey}-${sentinel}` }),
      );
    } else if (current === 3) {
      response.end(
        JSON.stringify({
          code: 0,
          result: {
            id: 'malformed',
            size: 1,
            processed_count: 1,
            indexed_links: [],
            type: 'google/indexer',
            title: 'missing required array',
            created_at: '2026-10-20T10:00:00.000Z',
          },
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          code: 0,
          result: linksReport('large', { title: 'x'.repeat(512) }),
        }),
      );
    }
  });
  const client = reportClient(api.origin);

  try {
    expect(
      await client.getTaskReport({
        family: 'google/indexer',
        taskId: 'partial',
      }),
    ).toEqual({
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'partial',
      size: 10,
      processedCount: 4,
      indexedLinks: ['https://partial.test/a'],
      unindexedLinks: [],
      type: 'google/indexer',
      title: 'synthetic report',
      createdAt: '2026-10-20T10:00:00.000Z',
      isCompleted: false,
    });

    const expectedErrors = [
      ['http', 'SpeedyIndex returned an unsuccessful task-report HTTP status.'],
      ['provider', 'SpeedyIndex rejected the task-report request.'],
      ['response', 'SpeedyIndex returned an invalid task-report response.'],
    ] as const;
    for (const [index, [kind, message]] of expectedErrors.entries()) {
      const error = await client
        .getTaskReport({ family: 'google/indexer', taskId: `failure-${index}` })
        .then(
          () => undefined,
          (value: unknown) => value,
        );
      expect(error).toBeInstanceOf(TaskReportError);
      expect(error).toMatchObject({ kind, message });
      expect(String(error)).not.toContain(dummyKey);
      expect(String(error)).not.toContain(sentinel);
    }

    const capError = await reportClient(api.origin, dummyKey, 128)
      .getTaskReport({ family: 'google/indexer', taskId: 'large' })
      .then(
        () => undefined,
        (value: unknown) => value,
      );
    expect(capError).toBeInstanceOf(TaskReportError);
    expect(capError).toMatchObject({
      kind: 'response',
      message: 'SpeedyIndex returned an invalid task-report response.',
    });
    expect(String(capError)).not.toContain(dummyKey);
    expect(api.requests).toHaveLength(5);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
  } finally {
    await api.close();
  }
});
