import { expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { SpeedyIndexClient } from '../src/client';
import {
  TaskStatusError,
  taskFamilySchema,
  taskStatusInputSchema,
  taskStatusResultSchema,
} from '../src/task-status';
import { bounded, deferred, dummyKey, fixture, loopbackFetch } from './helpers';

const families = [
  ['google/indexer', '/v2/task/google/indexer/status'],
  ['google/checker', '/v2/task/google/checker/status'],
  ['yandex/indexer', '/v2/task/yandex/indexer/status'],
  ['yandex/checker', '/v2/task/yandex/checker/status'],
  ['bing/checker', '/v2/task/bing/checker/status'],
  ['backlink/checker', '/v2/task/backlink/checker/status'],
] as const;

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function statusClient(
  origin: string,
  timeoutMs = 10_000,
  maxBytes = 16 * 1024 * 1024,
) {
  return new SpeedyIndexClient(
    dummyKey,
    loopbackFetch(origin),
    timeoutMs,
    maxBytes,
  );
}

test('TSP-01: each family makes one exact authenticated status POST', async () => {
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
      const taskId = (JSON.parse(body) as { task_id: string }).task_id;
      response.end(JSON.stringify({ code: 0, result: { id: taskId } }));
    });
  });
  const client = statusClient(api.origin);

  try {
    for (const [family, path] of families) {
      const taskId = `fixture-${received.length}`;
      await client.getTaskStatus({ family, taskId });
      expect(received.at(-1)?.path).toBe(path);
    }

    expect(received).toEqual(
      families.map(([, path], index) => ({
        method: 'POST',
        path,
        auth: dummyKey,
        accept: 'application/json',
        agent: 'speedyindex-mcp/0.1.0',
        contentType: 'application/json',
        body: JSON.stringify({ task_id: `fixture-${index}` }),
      })),
    );
    expect(api.requests).toHaveLength(6);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
  } finally {
    await api.close();
  }
});

test('TSP-02: strict ID input preserves opaque values and enforces the batch cap', async () => {
  const bodies: string[] = [];
  const api = await fixture((request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body);
      const parsed = JSON.parse(body) as { task_id?: string };
      response.end(
        JSON.stringify({
          code: 0,
          result: parsed.task_id === undefined ? [] : { id: parsed.task_id },
        }),
      );
    });
  });
  const client = statusClient(api.origin);
  const invalidInputs: unknown[] = [
    { family: 'google/indexer' },
    { family: 'google/indexer', taskId: 'one', taskIds: ['one'] },
    { family: 'google/indexer', taskId: '' },
    { family: 'google/indexer', taskId: '   ' },
    { family: 'google/indexer', taskIds: [] },
    { family: 'google/indexer', taskIds: ['same', 'same'] },
    {
      family: 'google/indexer',
      taskIds: Array.from({ length: 1001 }, (_, index) => `id-${index}`),
    },
    { family: 'unknown/checker', taskId: 'one' },
    { family: 'bing/indexer', taskId: 'one' },
    { family: 'backlink/indexer', taskId: 'one' },
    { family: 'google/indexer/../create', taskId: 'one' },
    { family: 'google/indexer', taskId: 'one', searchEngine: 'google' },
    { family: 'google/indexer', taskId: 'one', taskType: 'indexer' },
    {
      family: 'google/indexer',
      taskId: 'one',
      providerFamily: 'google/indexer',
    },
    { family: 'google/indexer', taskId: 'one', unexpected: true },
  ];

  try {
    expect(taskFamilySchema.options).toEqual(
      families.map(([family]) => family),
    );
    for (const input of invalidInputs) {
      expect(taskStatusInputSchema.safeParse(input).success).toBe(false);
      await expect(client.getTaskStatus(input)).rejects.toMatchObject({
        kind: 'input',
        message: 'Invalid task-status request.',
      });
    }
    expect(api.requests).toHaveLength(0);

    const opaqueId = '  opaque / ID? keep spaces  ';
    await client.getTaskStatus({ family: 'google/indexer', taskId: opaqueId });
    expect(bodies[0]).toBe(JSON.stringify({ task_id: opaqueId }));

    const thousandIds = Array.from(
      { length: 1000 },
      (_, index) => `id-${index}`,
    );
    const result = await client.getTaskStatus({
      family: 'backlink/checker',
      taskIds: thousandIds,
    });
    expect(result.requestedIds).toEqual(thousandIds);
    expect(result.tasks).toEqual([]);
    expect(result.unreturnedIds).toEqual(thousandIds);
    expect(bodies[1]).toBe(JSON.stringify({ task_ids: thousandIds }));
    expect(api.requests).toHaveLength(2);

    for (const key of [undefined, '', '   ']) {
      await expect(
        new SpeedyIndexClient(key, loopbackFetch(api.origin)).getTaskStatus({
          family: 'google/indexer',
          taskId: 'one',
        }),
      ).rejects.toMatchObject({ kind: 'credentials' });
    }
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('TSP-03: known fields map without defaults, coercion, or completion inference', async () => {
  const providerResults = [
    {
      id: 'root',
      size: 8,
      processed_count: 8,
      indexed_count: 3,
      is_completed: false,
      title: 'synthetic root',
      type: 'google/indexer',
      created_at: '2026-10-20T10:00:00.000Z',
      status: 'provider-state-next',
      pay_per_indexed: true,
      tokens_charged: 1.25,
      tokens_refunded: 0.5,
      check_after: '2026-10-21T10:00:00.000Z',
      days: 4,
      days_passed: 2,
      is_stopped: false,
      drip_feed: false,
      awaiting_result: true,
      child_task_ids: ['child'],
      children: [
        {
          id: 'child',
          size: 2,
          processed_count: 2,
          indexed_count: 1,
          is_completed: false,
          title: 'synthetic child',
          type: 'google/indexer',
          created_at: '2026-10-20T09:00:00.000Z',
          status: 'child-state-next',
          pay_per_indexed: false,
          tokens_charged: 0.75,
          tokens_refunded: 0,
          check_after: '2026-10-22T10:00:00.000Z',
          day: 7,
          drip_feed: true,
          target_domains: ['stripped.test'],
          children: [{ id: 'nested' }],
          extra_child_field: 'stripped',
        },
      ],
      target_domains: ['one.test', 'two.test'],
      extra_root_field: 'stripped',
    },
    { id: 'sparse', children: [{ id: 'sparse-child' }], extra_field: true },
  ];
  let responseIndex = 0;
  const api = await fixture((_request, response) => {
    response.end(
      JSON.stringify({ code: 0, result: providerResults[responseIndex++] }),
    );
  });
  const client = statusClient(api.origin);

  try {
    const result = await client.getTaskStatus({
      family: 'google/indexer',
      taskId: 'root',
    });
    expect(taskStatusResultSchema.parse(result)).toEqual({
      family: 'google/indexer',
      requestedIds: ['root'],
      tasks: [
        {
          id: 'root',
          size: 8,
          processedCount: 8,
          indexedCount: 3,
          isCompleted: false,
          title: 'synthetic root',
          type: 'google/indexer',
          createdAt: '2026-10-20T10:00:00.000Z',
          status: 'provider-state-next',
          payPerIndexed: true,
          tokensCharged: 1.25,
          tokensRefunded: 0.5,
          checkAfter: '2026-10-21T10:00:00.000Z',
          days: 4,
          daysPassed: 2,
          isStopped: false,
          dripFeed: false,
          awaitingResult: true,
          childTaskIds: ['child'],
          children: [
            {
              id: 'child',
              size: 2,
              processedCount: 2,
              indexedCount: 1,
              isCompleted: false,
              title: 'synthetic child',
              type: 'google/indexer',
              createdAt: '2026-10-20T09:00:00.000Z',
              status: 'child-state-next',
              payPerIndexed: false,
              tokensCharged: 0.75,
              tokensRefunded: 0,
              checkAfter: '2026-10-22T10:00:00.000Z',
              day: 7,
            },
          ],
          targetDomains: ['one.test', 'two.test'],
        },
      ],
      unreturnedIds: [],
    });

    const sparse = await client.getTaskStatus({
      family: 'google/checker',
      taskId: 'sparse',
    });
    expect(sparse.tasks).toEqual([
      { id: 'sparse', children: [{ id: 'sparse-child' }] },
    ]);
    expect(sparse.tasks[0]).not.toHaveProperty('dripFeed');
    expect(sparse.tasks[0]).not.toHaveProperty('awaitingResult');
    expect(sparse.tasks[0]?.children?.[0]).not.toHaveProperty('day');
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('TSP-04: Task and Task[] results correlate exactly in request order', async () => {
  const cases = [
    {
      input: { family: 'google/indexer', taskId: 'single-object' },
      providerResult: { id: 'single-object' },
      tasks: [{ id: 'single-object' }],
      unreturnedIds: [],
    },
    {
      input: { family: 'google/indexer', taskId: 'single-array' },
      providerResult: [{ id: 'single-array' }],
      tasks: [{ id: 'single-array' }],
      unreturnedIds: [],
    },
    {
      input: { family: 'google/indexer', taskIds: ['object-a', 'object-b'] },
      providerResult: { id: 'object-b' },
      tasks: [{ id: 'object-b' }],
      unreturnedIds: ['object-a'],
    },
    {
      input: { family: 'google/indexer', taskIds: ['array-a', 'array-b'] },
      providerResult: [{ id: 'array-b' }, { id: 'array-a' }],
      tasks: [{ id: 'array-a' }, { id: 'array-b' }],
      unreturnedIds: [],
    },
    {
      input: { family: 'google/indexer', taskIds: ['empty-a', 'empty-b'] },
      providerResult: [],
      tasks: [],
      unreturnedIds: ['empty-a', 'empty-b'],
    },
  ];
  let responseIndex = 0;
  const api = await fixture((_request, response) => {
    response.end(
      JSON.stringify({
        code: 0,
        result: cases[responseIndex++]?.providerResult,
      }),
    );
  });
  const client = statusClient(api.origin);

  try {
    for (const testCase of cases) {
      const result = await client.getTaskStatus(testCase.input);
      expect(result.tasks).toEqual(testCase.tasks);
      expect(result.unreturnedIds).toEqual(testCase.unreturnedIds);
    }
    expect(api.requests).toHaveLength(cases.length);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
  } finally {
    await api.close();
  }
});

test('TSP-05: malformed, unrelated, and partial provider responses fail closed', async () => {
  const sentinel = 'synthetic-provider-detail';
  const invalidResponses: {
    label: string;
    body?: unknown;
    raw?: string;
    status?: number;
    kind: 'http' | 'provider' | 'response';
  }[] = [
    { label: 'HTTP error', raw: sentinel, status: 503, kind: 'http' },
    {
      label: 'provider error',
      body: { code: 7, message: sentinel },
      kind: 'provider',
    },
    { label: 'invalid JSON', raw: sentinel, kind: 'response' },
    {
      label: 'missing code',
      body: { result: { id: 'requested' } },
      kind: 'response',
    },
    {
      label: 'wrong code type',
      body: { code: '0', result: { id: 'requested' } },
      kind: 'response',
    },
    { label: 'missing result', body: { code: 0 }, kind: 'response' },
    {
      label: 'wrong result root',
      body: { code: 0, result: 3 },
      kind: 'response',
    },
    {
      label: 'nullable integer',
      body: { code: 0, result: { id: 'requested', size: null } },
      kind: 'response',
    },
    {
      label: 'fractional count',
      body: { code: 0, result: { id: 'requested', processed_count: 1.5 } },
      kind: 'response',
    },
    {
      label: 'numeric token string',
      body: { code: 0, result: { id: 'requested', tokens_charged: '1.5' } },
      kind: 'response',
    },
    {
      label: 'nullable token number',
      body: { code: 0, result: { id: 'requested', tokens_refunded: null } },
      kind: 'response',
    },
    {
      label: 'negative token number',
      body: { code: 0, result: { id: 'requested', tokens_charged: -0.5 } },
      kind: 'response',
    },
    {
      label: 'missing root ID',
      body: { code: 0, result: { title: 'x' } },
      kind: 'response',
    },
    {
      label: 'blank root ID',
      body: { code: 0, result: { id: '  ' } },
      kind: 'response',
    },
    {
      label: 'wrong child task ID container',
      body: { code: 0, result: { id: 'requested', child_task_ids: 'child' } },
      kind: 'response',
    },
    {
      label: 'wrong child task ID item',
      body: { code: 0, result: { id: 'requested', child_task_ids: [''] } },
      kind: 'response',
    },
    {
      label: 'wrong child task ID item type',
      body: { code: 0, result: { id: 'requested', child_task_ids: [7] } },
      kind: 'response',
    },
    {
      label: 'wrong child summary container',
      body: { code: 0, result: { id: 'requested', children: { id: 'child' } } },
      kind: 'response',
    },
    {
      label: 'missing child ID',
      body: { code: 0, result: { id: 'requested', children: [{}] } },
      kind: 'response',
    },
    {
      label: 'wrong child summary item type',
      body: { code: 0, result: { id: 'requested', children: [null] } },
      kind: 'response',
    },
    {
      label: 'blank child ID',
      body: { code: 0, result: { id: 'requested', children: [{ id: '  ' }] } },
      kind: 'response',
    },
    {
      label: 'wrong child known field type',
      body: {
        code: 0,
        result: { id: 'requested', children: [{ id: 'child', title: null }] },
      },
      kind: 'response',
    },
    {
      label: 'fractional child day',
      body: {
        code: 0,
        result: { id: 'requested', children: [{ id: 'child', day: 1.5 }] },
      },
      kind: 'response',
    },
    {
      label: 'unrequested root after a valid root',
      body: {
        code: 0,
        result: [{ id: 'requested' }, { id: 'unrequested' }],
      },
      kind: 'response',
    },
    {
      label: 'duplicate returned root',
      body: { code: 0, result: [{ id: 'requested' }, { id: 'requested' }] },
      kind: 'response',
    },
  ];
  let responseIndex = 0;
  const api = await fixture((_request, response) => {
    const invalid = invalidResponses[responseIndex++];
    if (invalid?.status) response.statusCode = invalid.status;
    response.end(invalid?.raw ?? JSON.stringify(invalid?.body));
  });
  const client = statusClient(api.origin);
  const messages = {
    http: 'SpeedyIndex returned an unsuccessful task-status HTTP status.',
    provider: 'SpeedyIndex rejected the task-status request.',
    response: 'SpeedyIndex returned an invalid task-status response.',
  };

  try {
    for (const invalid of invalidResponses) {
      const error = await client
        .getTaskStatus({ family: 'google/indexer', taskId: 'requested' })
        .then(
          () => undefined,
          (value: unknown) => value,
        );
      expect(error, invalid.label).toBeInstanceOf(TaskStatusError);
      expect(error, invalid.label).toMatchObject({
        kind: invalid.kind,
        message: messages[invalid.kind],
      });
      expect((error as Error).message).not.toContain(sentinel);
      expect((error as Error).message).not.toContain(dummyKey);
    }
    expect(api.requests).toHaveLength(invalidResponses.length);
    expect(api.requests.every(({ method }) => method === 'POST')).toBe(true);
  } finally {
    await api.close();
  }
});

test('TSP-06: status POST uses deadline, redirect, body bound, and recovery guards', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let firstRequest = true;
  const timeoutApi = await fixture((request, response) => {
    void readBody(request).then(() => {
      if (firstRequest) {
        firstRequest = false;
        response.on('close', () => disconnected.resolve());
        arrived.resolve();
      } else {
        response.end(JSON.stringify({ code: 0, result: { id: 'recovered' } }));
      }
    });
  });
  let destination: Awaited<ReturnType<typeof fixture>> | undefined;
  let redirectApi: Awaited<ReturnType<typeof fixture>> | undefined;
  let bodyApi: Awaited<ReturnType<typeof fixture>> | undefined;

  try {
    const timeoutClient = statusClient(timeoutApi.origin, 150);
    const timedOut = timeoutClient
      .getTaskStatus({ family: 'google/indexer', taskId: 'timeout' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await bounded(arrived.promise);
    const timeoutError = await bounded(timedOut);
    expect(timeoutError).toMatchObject({
      kind: 'timeout',
      message: 'SpeedyIndex task-status request timed out.',
    });
    await bounded(disconnected.promise);
    const recovered = await timeoutClient.getTaskStatus({
      family: 'google/indexer',
      taskId: 'recovered',
    });
    expect(recovered.tasks).toEqual([{ id: 'recovered' }]);
    expect(timeoutApi.requests).toHaveLength(2);

    destination = await fixture((_request, response) =>
      response.end(JSON.stringify({ code: 0, result: { id: 'redirected' } })),
    );
    redirectApi = await fixture((_request, response) => {
      response.statusCode = 302;
      response.setHeader(
        'Location',
        `${destination!.origin}/v2/task/google/indexer/status`,
      );
      response.end();
    });
    await expect(
      statusClient(redirectApi.origin).getTaskStatus({
        family: 'google/indexer',
        taskId: 'redirected',
      }),
    ).rejects.toBeInstanceOf(TaskStatusError);
    expect(redirectApi.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);

    bodyApi = await fixture((_request, response) =>
      response.end(
        JSON.stringify({ code: 0, result: { id: 'large-response' } }),
      ),
    );
    await expect(
      statusClient(bodyApi.origin, 1000, 16).getTaskStatus({
        family: 'google/indexer',
        taskId: 'large-response',
      }),
    ).rejects.toMatchObject({ kind: 'response' });
    expect(bodyApi.requests).toHaveLength(1);
  } finally {
    await timeoutApi.close();
    await redirectApi?.close();
    await destination?.close();
    await bodyApi?.close();
  }
});
