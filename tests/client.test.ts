import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createInvocationReadBudget,
  ReadBudgetError,
  type InvocationReadBudget,
  type ReadBudgetRuntime,
} from '../src/read-budget';
import { SpeedyIndexClient } from '../src/client';
import {
  account,
  bounded,
  deferred,
  dummyKey,
  fixture,
  loopbackFetch,
} from './helpers';

const listResponse = (page: number, result: unknown[] = []) => ({
  code: 0,
  page,
  last_page: 0,
  result,
});

function streamedAccountResponse(totalBytes: number): Response {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    '{"code":0,"balance":{"tokens":0,"indexer":27,"checker":8},"ignored":"',
  );
  const suffix = encoder.encode('"}');
  let paddingRemaining = totalBytes - prefix.byteLength - suffix.byteLength;
  if (paddingRemaining < 0) throw new Error('Account fixture is too small.');
  const paddingChunk = new Uint8Array(Math.min(64 * 1024, paddingRemaining));
  paddingChunk.fill(0x78);
  let prefixSent = false;
  let suffixSent = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      if (paddingRemaining > 0) {
        const chunkLength = Math.min(paddingChunk.byteLength, paddingRemaining);
        controller.enqueue(paddingChunk.subarray(0, chunkLength));
        paddingRemaining -= chunkLength;
        return;
      }
      if (!suffixSent) {
        suffixSent = true;
        controller.enqueue(suffix);
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/json' },
  });
}

function responseFromChunks(chunks: readonly Uint8Array[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
    }),
  );
}

function captureFirstResponse(
  origin: string,
  captured: { resolve: (response: Response) => void },
): typeof fetch {
  const fetchRequest = loopbackFetch(origin);
  let capture = true;
  return (async (input, init) => {
    const response = await fetchRequest(input, init);
    if (capture) {
      capture = false;
      captured.resolve(response);
    }
    return response;
  }) as typeof fetch;
}

async function waitForBodyUse(response: Response): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('Expected an HTTP response body.');
  const deadline = Date.now() + 4_000;
  while (!response.bodyUsed || !body.locked) {
    if (Date.now() >= deadline)
      throw new Error(
        'Response body was not consumed before the fixture deadline.',
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('LT-01: list_tasks routes supported families and filter combinations once', async () => {
  const api = await fixture((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    const page = Number(path.split('/').at(-1));
    res.end(JSON.stringify(listResponse(page)));
  });
  const cases = [
    [
      { searchEngine: 'google', taskType: 'indexer', page: 2 },
      '/v2/task/google/indexer/list/2',
    ],
    [
      {
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
        filter: 'standard',
      },
      '/v2/task/google/indexer/list/2?filter=standard',
    ],
    [
      {
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
        filter: 'pay_per_indexed',
      },
      '/v2/task/google/indexer/list/2?filter=pay_per_indexed',
    ],
    [
      {
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
        filter: 'drip_feed',
      },
      '/v2/task/google/indexer/list/2?filter=drip_feed',
    ],
    [
      {
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
        filter: 'drip_feed',
        payPerIndexed: true,
      },
      '/v2/task/google/indexer/list/2?filter=drip_feed&pay_per_indexed=true',
    ],
    [
      {
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
        filter: 'drip_feed',
        payPerIndexed: false,
      },
      '/v2/task/google/indexer/list/2?filter=drip_feed&pay_per_indexed=false',
    ],
    [
      { searchEngine: 'google', taskType: 'checker', page: 1 },
      '/v2/task/google/checker/list/1',
    ],
    [
      { searchEngine: 'yandex', taskType: 'indexer', page: 0 },
      '/v2/task/yandex/indexer/list/0',
    ],
    [
      { searchEngine: 'yandex', taskType: 'checker', page: 4 },
      '/v2/task/yandex/checker/list/4',
    ],
    [
      { searchEngine: 'bing', taskType: 'checker', page: 5 },
      '/v2/task/bing/checker/list/5',
    ],
  ] as const;
  try {
    const client = new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin));
    for (const [input] of cases) await client.listTasks(input);
    expect(
      api.requests.map(({ method, path, auth }) => ({ method, path, auth })),
    ).toEqual(
      cases.map(([, path]) => ({ method: 'GET', path, auth: dummyKey })),
    );
  } finally {
    await api.close();
  }
});

test('LT-02: direct list_tasks calls reject invalid selectors and filters before HTTP', async () => {
  const api = await fixture((_req, res) =>
    res.end(JSON.stringify(listResponse(0))),
  );
  const invalidInputs: Record<string, unknown>[] = [
    { searchEngine: 'google', taskType: 'indexer' },
    { searchEngine: 'google', taskType: 'indexer', page: -1 },
    { searchEngine: 'google', taskType: 'indexer', page: 1.5 },
    {
      searchEngine: 'google',
      taskType: 'indexer',
      page: Number.MAX_SAFE_INTEGER + 1,
    },
    { searchEngine: 'google/../../account', taskType: 'indexer', page: 0 },
    { searchEngine: 'google', taskType: 'backlink_checker', page: 0 },
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
      taskType: 'checker',
      page: 0,
      filter: 'drip_feed',
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
      filter: 'standard',
      payPerIndexed: false,
    },
    {
      searchEngine: 'google',
      taskType: 'indexer',
      page: 0,
      extra: 'ignored by no one',
    },
  ];
  try {
    const client = new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin));
    for (const input of invalidInputs) {
      await expect(client.listTasks(input)).rejects.toMatchObject({
        kind: 'input',
        message: 'Invalid task-list request.',
      });
    }
    expect(api.requests).toHaveLength(0);
  } finally {
    await api.close();
  }
});

test('LT-03: list_tasks maps documented optional fields, strips unknowns, and accepts an empty page', async () => {
  const api = await fixture((req, res) => {
    const page = Number(
      new URL(req.url ?? '/', 'http://fixture').pathname.split('/').at(-1),
    );
    if (page === 2) {
      res.end(
        JSON.stringify({
          code: 0,
          page,
          last_page: 2,
          ignored: 'provider metadata',
          result: [
            {
              id: ' opaque-task-id ',
              size: 8,
              processed_count: 7,
              indexed_count: 4,
              title: 'fixture task',
              is_completed: false,
              type: 'google/indexer',
              created_at: 'provider timestamp',
              pay_per_indexed: true,
              days: 3,
              days_passed: 1,
              is_stopped: false,
              child_task_ids: [' child-a '],
              status: 'unpromised status',
              tokens_charged: 500,
              check_after: 'unpromised timestamp',
            },
            { id: 'partial-task', is_completed: false, days_passed: 0 },
          ],
        }),
      );
    } else res.end(JSON.stringify({ code: 0, page, last_page: 1, result: [] }));
  });
  try {
    const client = new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin));
    await expect(
      client.listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 2,
      }),
    ).resolves.toEqual({
      searchEngine: 'google',
      taskType: 'indexer',
      page: 2,
      lastPage: 2,
      tasks: [
        {
          id: ' opaque-task-id ',
          size: 8,
          processedCount: 7,
          indexedCount: 4,
          title: 'fixture task',
          isCompleted: false,
          type: 'google/indexer',
          createdAt: 'provider timestamp',
          payPerIndexed: true,
          days: 3,
          daysPassed: 1,
          isStopped: false,
          childTaskIds: [' child-a '],
        },
        { id: 'partial-task', isCompleted: false, daysPassed: 0 },
      ],
    });
    await expect(
      client.listTasks({ searchEngine: 'bing', taskType: 'checker', page: 5 }),
    ).resolves.toEqual({
      searchEngine: 'bing',
      taskType: 'checker',
      page: 5,
      lastPage: 1,
      tasks: [],
    });
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

const invalidTaskListBodies = [
  ['provider', JSON.stringify({ code: 3, message: dummyKey })],
  ['response', 'not-json'],
  [
    'response',
    JSON.stringify({ code: '0', page: 0, last_page: 0, result: [] }),
  ],
  ['response', JSON.stringify({ code: 0, page: 0, last_page: 0, result: {} })],
  [
    'response',
    JSON.stringify({ code: 0, page: 0, last_page: 0, result: [{}] }),
  ],
  [
    'response',
    JSON.stringify({ code: 0, page: 0, last_page: 0, result: [{ id: '' }] }),
  ],
  [
    'response',
    JSON.stringify({
      code: 0,
      page: 0,
      last_page: 0,
      result: [{ id: 'x', size: -1 }],
    }),
  ],
] as const;

for (const [index, [kind, body]] of invalidTaskListBodies.entries()) {
  test(`LT-04: list_tasks sanitizes provider response case ${index + 1}`, async () => {
    const api = await fixture((_req, res) => res.end(body));
    try {
      const error = await new SpeedyIndexClient(
        dummyKey,
        loopbackFetch(api.origin),
      )
        .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ kind });
      expect(String(error)).not.toContain(dummyKey);
      expect(String(error).length).toBeLessThan(150);
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
}

for (const [label, childTaskId] of [
  ['empty', ''],
  ['whitespace-only', ' \t '],
] as const) {
  test(`LT-11: list_tasks rejects ${label} child task IDs without retrying`, async () => {
    const api = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          code: 0,
          page: 0,
          last_page: 0,
          result: [{ id: 'parent-id', child_task_ids: [childTaskId] }],
        }),
      ),
    );
    try {
      const error = await new SpeedyIndexClient(
        dummyKey,
        loopbackFetch(api.origin),
      )
        .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        kind: 'response',
        message: 'SpeedyIndex returned an invalid task-list response.',
      });
      expect(String(error)).not.toContain(dummyKey);
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
}

test('LT-04: list_tasks sanitizes HTTP errors without retrying', async () => {
  const api = await fixture((_req, res) => {
    res.writeHead(401);
    res.end(dummyKey);
  });
  try {
    const error = await new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
    )
      .listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 0,
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      kind: 'http',
      message: 'SpeedyIndex returned an unsuccessful task-list HTTP status.',
    });
    expect(String(error)).not.toContain(dummyKey);
    expect(api.requests).toHaveLength(1);
  } finally {
    await api.close();
  }
});

test('LT-04: list_tasks missing credentials make zero requests', async () => {
  const api = await fixture((_req, res) =>
    res.end(JSON.stringify(listResponse(0))),
  );
  try {
    await expect(
      new SpeedyIndexClient(undefined, loopbackFetch(api.origin)).listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 0,
      }),
    ).rejects.toMatchObject({
      kind: 'credentials',
      message: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.',
    });
    expect(api.requests).toHaveLength(0);
  } finally {
    await api.close();
  }
});

test('LT-05: list_tasks deadline aborts an arrived request and the next call recovers', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  let first = true;
  const api = await fixture((req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      arrived.resolve();
    } else res.end(JSON.stringify(listResponse(0)));
  });
  try {
    const client = new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
      250,
    );
    const outcome = client
      .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 })
      .catch((value: unknown) => value);
    await bounded(arrived.promise);
    expect(await bounded(outcome)).toMatchObject({ kind: 'timeout' });
    await bounded(disconnected.promise);
    expect(
      await client.listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 0,
      }),
    ).toMatchObject({ tasks: [] });
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('LT-05: list_tasks rejects redirects before the destination receives a request', async () => {
  const destination = await fixture((_req, res) =>
    res.end(JSON.stringify(listResponse(0))),
  );
  const api = await fixture((_req, res) => {
    res.writeHead(302, { Location: destination.origin });
    res.end();
  });
  try {
    await expect(
      new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin)).listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 0,
      }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(api.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
  } finally {
    try {
      await api.close();
    } finally {
      await destination.close();
    }
  }
});

test('LT-12: list_tasks rejects non-empty pages beyond lastPage', async () => {
  const responseMarker = 'fixture-only-response-marker';
  const api = await fixture((_req, res) =>
    res.end(
      JSON.stringify({
        code: 0,
        page: 2,
        last_page: 1,
        result: [{ id: 'task-2', title: responseMarker }],
      }),
    ),
  );
  try {
    const error = await new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
    )
      .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 2 })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      kind: 'response',
      message: 'SpeedyIndex returned an invalid task-list response.',
    });
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toContain(dummyKey);
    expect(message).not.toContain(responseMarker);
    expect(api.requests).toHaveLength(1);
  } finally {
    await api.close();
  }
});

for (const [label, envelope] of [
  ['page echo mismatch', { code: 0, page: 2, last_page: 0, result: [] }],
  [
    'more than 1,000 rows',
    {
      code: 0,
      page: 0,
      last_page: 0,
      result: Array.from({ length: 1001 }, (_, index) => ({
        id: `task-${index}`,
      })),
    },
  ],
] as const) {
  test(`LT-10: list_tasks rejects ${label} with one sanitized response`, async () => {
    const api = await fixture((_req, res) => res.end(JSON.stringify(envelope)));
    try {
      const error = await new SpeedyIndexClient(
        dummyKey,
        loopbackFetch(api.origin),
      )
        .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        kind: 'response',
        message: 'SpeedyIndex returned an invalid task-list response.',
      });
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
}

test('LT-13: list_tasks accepts exactly 1,000 valid tasks', async () => {
  const taskIds = Array.from({ length: 1000 }, (_, index) => `task-${index}`);
  const api = await fixture((_req, res) =>
    res.end(
      JSON.stringify({
        code: 0,
        page: 0,
        last_page: 0,
        result: taskIds.map((id) => ({ id })),
      }),
    ),
  );
  try {
    const result = await new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
    ).listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 });
    expect(result.tasks).toHaveLength(1000);
    expect(result.tasks.map((task) => task.id)).toEqual(taskIds);
    expect(api.requests).toHaveLength(1);
  } finally {
    await api.close();
  }
});

test('F03: exact read-only HTTP contract, distinct wallets, zero and observation time', async () => {
  const api = await fixture((_req, res) =>
    res.end(
      JSON.stringify({
        ...account,
        extra: 'ignored',
        balance: { ...account.balance, extra: 99 },
      }),
    ),
  );
  try {
    const before = Date.now();
    const result = await new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
    ).getBalance();
    expect(result.balance).toEqual(account.balance);
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.observedAt)).toBeLessThanOrEqual(Date.now());
    expect(api.requests).toEqual([
      {
        method: 'GET',
        path: '/v2/account',
        auth: dummyKey,
        agent: 'speedyindex-mcp/0.1.0',
      },
    ]);
  } finally {
    await api.close();
  }
});

for (const status of [401, 429, 500]) {
  test(`F04: HTTP ${status} is sanitized, never retried`, async () => {
    const api = await fixture((_req, res) => {
      res.writeHead(status);
      res.end(dummyKey);
    });
    try {
      await expect(
        new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin)).getBalance(),
      ).rejects.toMatchObject({
        kind: 'http',
        message: 'SpeedyIndex returned an unsuccessful HTTP status.',
      });
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
}

const invalidBodies = [
  ['provider', JSON.stringify({ code: 3, message: dummyKey })],
  ['response', 'not-json'],
  ['response', JSON.stringify({ code: 0 })],
  ['response', JSON.stringify({ balance: account.balance })],
  ['response', JSON.stringify({ code: '0', balance: account.balance })],
  ...['tokens', 'indexer', 'checker'].flatMap((wallet) => [
    [
      'response',
      JSON.stringify({
        code: 0,
        balance: { ...account.balance, [wallet]: undefined },
      }),
    ],
    ...[-1, '5', null].map((value) => [
      'response',
      JSON.stringify({
        code: 0,
        balance: { ...account.balance, [wallet]: value },
      }),
    ]),
    [
      'response',
      `{"code":0,"balance":${JSON.stringify(account.balance).replace(`"${wallet}":${account.balance[wallet as keyof typeof account.balance]}`, `"${wallet}":1e400`)}}`,
    ],
  ]),
] as const;
for (const [i, [kind, body]] of invalidBodies.entries()) {
  test(`F04: invalid envelope/wallet case ${i + 1}`, async () => {
    const api = await fixture((_req, res) => res.end(body));
    try {
      const error = await new SpeedyIndexClient(
        dummyKey,
        loopbackFetch(api.origin),
      )
        .getBalance()
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ kind });
      expect(String(error)).not.toContain(dummyKey);
      expect(String(error).length).toBeLessThan(150);
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
}

test('F05: missing/blank credentials make zero requests', async () => {
  const api = await fixture((_req, res) => res.end(JSON.stringify(account)));
  try {
    for (const key of [undefined, '', ' \t ']) {
      await expect(
        new SpeedyIndexClient(key, loopbackFetch(api.origin)).getBalance(),
      ).rejects.toMatchObject({ kind: 'credentials' });
    }
    expect(api.requests).toHaveLength(0);
  } finally {
    await api.close();
  }
});

test('F06: redirects never reach the destination', async () => {
  const destination = await fixture((_req, res) =>
    res.end(JSON.stringify(account)),
  );
  const api = await fixture((_req, res) => {
    res.writeHead(302, { Location: destination.origin });
    res.end();
  });
  try {
    await expect(
      new SpeedyIndexClient(dummyKey, loopbackFetch(api.origin)).getBalance(),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(api.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
  } finally {
    await api.close();
    await destination.close();
  }
});

test('F07: deadline aborts an arrived HTTP request and next call recovers', async () => {
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
  try {
    const client = new SpeedyIndexClient(
      dummyKey,
      loopbackFetch(api.origin),
      250,
    );
    const outcome = client.getBalance().catch((value: unknown) => value);
    await bounded(arrived.promise);
    expect(await bounded(outcome)).toMatchObject({ kind: 'timeout' });
    await bounded(disconnected.promise);
    expect((await client.getBalance()).balance).toEqual(account.balance);
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('RB-05: default response bound accepts 16 MiB and rejects one byte above', async () => {
  const responseLimitBytes = 16 * 1024 * 1024;
  const responses = [
    streamedAccountResponse(responseLimitBytes),
    streamedAccountResponse(responseLimitBytes + 1),
  ];
  const fetchAccount = (async (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ) => {
    void _input;
    void _init;
    return responses.shift()!;
  }) as typeof fetch;
  const client = new SpeedyIndexClient(dummyKey, fetchAccount);

  await expect(client.getBalance()).resolves.toMatchObject({
    balance: { tokens: 0, indexer: 27, checker: 8 },
  });
  await expect(client.getBalance()).rejects.toMatchObject({
    kind: 'response',
    message: 'SpeedyIndex returned an invalid account response.',
  });
});

test('RB-01: response byte boundary handles split multibyte UTF-8', async () => {
  const limitBytes = 128;
  const payload = new TextEncoder().encode(
    JSON.stringify(listResponse(0, [{ id: 'task-a', title: 'é' }])),
  );
  const exact = new Uint8Array(limitBytes).fill(0x20);
  exact.set(payload);
  const splitAt = exact.indexOf(0xc3) + 1;
  const over = new Uint8Array(limitBytes + 1).fill(0x20);
  over.set(payload);
  expect(splitAt).toBeGreaterThan(0);
  expect(exact[splitAt - 1]).toBe(0xc3);
  expect(exact[splitAt]).toBe(0xa9);
  expect(exact.byteLength).toBe(limitBytes);
  expect(new TextDecoder().decode(exact).length).toBeLessThan(exact.byteLength);

  const responses = [
    responseFromChunks([exact.subarray(0, splitAt), exact.subarray(splitAt)]),
    responseFromChunks([over]),
  ];
  const fetchAccount = (async (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ) => {
    void _input;
    void _init;
    return responses.shift()!;
  }) as typeof fetch;
  const client = new SpeedyIndexClient(
    dummyKey,
    fetchAccount,
    10_000,
    limitBytes,
  );
  const input = { searchEngine: 'google', taskType: 'indexer', page: 0 };

  await expect(client.listTasks(input)).resolves.toMatchObject({
    tasks: [{ id: 'task-a', title: 'é' }],
  });
  await expect(client.listTasks(input)).rejects.toMatchObject({
    kind: 'response',
    message: 'SpeedyIndex returned an invalid task-list response.',
  });
});

test('RB-02: chunked and gzip responses are bounded by decoded bytes', async () => {
  const limitBytes = 512;
  const oversizedBody = JSON.stringify({
    ...account,
    ignored: 'x'.repeat(2_048),
  });
  const encodedBody = Buffer.from(oversizedBody);
  const compressedBody = gzipSync(encodedBody);
  expect(encodedBody.byteLength).toBeGreaterThan(limitBytes);
  expect(compressedBody.byteLength).toBeLessThan(limitBytes);

  let requestNumber = 0;
  const api = await fixture((_req, res) => {
    if (requestNumber++ === 0) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      });
      res.write(encodedBody.subarray(0, 1_024));
      res.end(encodedBody.subarray(1_024));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Content-Length': String(compressedBody.byteLength),
    });
    res.end(compressedBody);
  });
  const captured: Response[] = [];
  const mappedFetch = loopbackFetch(api.origin);
  const observingFetch = (async (input, init) => {
    const response = await mappedFetch(input, init);
    captured.push(response);
    return response;
  }) as typeof fetch;
  const client = new SpeedyIndexClient(
    dummyKey,
    observingFetch,
    10_000,
    limitBytes,
  );
  try {
    await expect(client.getBalance()).rejects.toMatchObject({
      kind: 'response',
    });
    await expect(client.getBalance()).rejects.toMatchObject({
      kind: 'response',
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]?.headers.get('content-length')).toBeNull();
    expect(captured[1]?.headers.get('content-length')).toBe(
      String(compressedBody.byteLength),
    );
    expect(compressedBody.byteLength).toBeLessThan(limitBytes);
  } finally {
    await api.close();
  }
});

test('RB-03: overflow disconnects an open response and the next call recovers', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  const oversizedBody = JSON.stringify({
    ...account,
    ignored: 'x'.repeat(512),
  });
  let first = true;
  const api = await fixture((_req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      });
      res.write(oversizedBody);
      arrived.resolve();
    } else res.end(JSON.stringify(account));
  });
  const client = new SpeedyIndexClient(
    dummyKey,
    loopbackFetch(api.origin),
    10_000,
    128,
  );
  try {
    const outcome = client.getBalance().catch((error: unknown) => error);
    await bounded(arrived.promise);
    await expect(bounded(outcome, 5_000)).resolves.toMatchObject({
      kind: 'response',
      message: 'SpeedyIndex returned an invalid account response.',
    });
    await bounded(disconnected.promise);
    await expect(client.getBalance()).resolves.toMatchObject({
      balance: { tokens: 0, indexer: 27, checker: 8 },
    });
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('RB-04: oversized account and list bodies keep fixed sanitized errors', async () => {
  const marker = 'synthetic-body-marker';
  const oversizedAccount = JSON.stringify({
    ...account,
    marker,
    ignored: dummyKey + 'x'.repeat(512),
  });
  const oversizedList = JSON.stringify({
    ...listResponse(0),
    marker,
    ignored: dummyKey + 'x'.repeat(512),
  });
  const responses = [
    responseFromChunks([new TextEncoder().encode(oversizedAccount)]),
    responseFromChunks([new TextEncoder().encode(oversizedList)]),
  ];
  const fetchAccount = (async (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ) => {
    void _input;
    void _init;
    return responses.shift()!;
  }) as typeof fetch;
  const client = new SpeedyIndexClient(dummyKey, fetchAccount, 10_000, 256);
  const accountError = await client.getBalance().then(
    () => undefined,
    (error: unknown) => error,
  );
  const taskListError = await client
    .listTasks({ searchEngine: 'google', taskType: 'indexer', page: 0 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(accountError).toBeInstanceOf(Error);
  expect(taskListError).toBeInstanceOf(Error);
  if (!(accountError instanceof Error) || !(taskListError instanceof Error))
    throw new Error('Expected sanitized response errors.');
  expect(accountError.message).toBe(
    'SpeedyIndex returned an invalid account response.',
  );
  expect(taskListError.message).toBe(
    'SpeedyIndex returned an invalid task-list response.',
  );
  for (const message of [accountError.message, taskListError.message]) {
    expect(message).not.toContain(marker);
    expect(message).not.toContain(dummyKey);
  }
});

test('RB-07: list cancellation while consuming a partial response disconnects and recovers', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  const captured = deferred<Response>();
  let first = true;
  const api = await fixture((_req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      });
      res.write('{"code":0,"page":0,"last_page":0,"result":[');
      arrived.resolve();
    } else res.end(JSON.stringify(listResponse(0)));
  });
  const client = new SpeedyIndexClient(
    dummyKey,
    captureFirstResponse(api.origin, captured),
  );
  try {
    const controller = new AbortController();
    let settled = false;
    const outcome = client
      .listTasks(
        { searchEngine: 'google', taskType: 'indexer', page: 0 },
        controller.signal,
      )
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    await bounded(arrived.promise);
    const response = await bounded(captured.promise);
    await bounded(waitForBodyUse(response), 5_000);
    expect(response.body?.locked).toBe(true);
    expect(response.bodyUsed).toBe(true);
    expect(settled).toBe(false);
    controller.abort();
    await expect(bounded(outcome, 5_000)).resolves.toMatchObject({
      kind: 'cancelled',
      message: 'SpeedyIndex task-list request was cancelled.',
    });
    await bounded(disconnected.promise);
    await expect(
      client.listTasks({
        searchEngine: 'google',
        taskType: 'indexer',
        page: 0,
      }),
    ).resolves.toMatchObject({ tasks: [] });
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('RB-07: account deadline while consuming a partial response disconnects and recovers', async () => {
  const arrived = deferred<void>();
  const disconnected = deferred<void>();
  const captured = deferred<Response>();
  let first = true;
  const api = await fixture((_req, res) => {
    if (first) {
      first = false;
      res.on('close', () => disconnected.resolve());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      });
      res.write('{"code":0,"balance":');
      arrived.resolve();
    } else res.end(JSON.stringify(account));
  });
  const client = new SpeedyIndexClient(
    dummyKey,
    captureFirstResponse(api.origin, captured),
    3_000,
  );
  try {
    let settled = false;
    const outcome = client.getBalance().then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await bounded(arrived.promise);
    const response = await bounded(captured.promise);
    await bounded(waitForBodyUse(response), 5_000);
    expect(response.body?.locked).toBe(true);
    expect(response.bodyUsed).toBe(true);
    expect(settled).toBe(false);
    await expect(bounded(outcome, 4_500)).resolves.toMatchObject({
      kind: 'timeout',
      message: 'SpeedyIndex account request timed out.',
    });
    await bounded(disconnected.promise);
    await expect(client.getBalance()).resolves.toMatchObject({
      balance: { tokens: 0, indexer: 27, checker: 8 },
    });
    expect(api.requests).toHaveLength(2);
  } finally {
    await api.close();
  }
});

test('RB-08: response limit constructor seam is positive, integral, and lower-only', () => {
  const productionLimit = 16 * 1024 * 1024;
  const invalidLimits = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    productionLimit + 1,
  ];
  let requests = 0;
  const fetchAccount = (async (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
  ) => {
    void _input;
    void _init;
    requests += 1;
    return new Response(JSON.stringify(account));
  }) as typeof fetch;

  for (const limit of invalidLimits) {
    expect(
      () => new SpeedyIndexClient(dummyKey, fetchAccount, 10_000, limit),
    ).toThrow(RangeError);
  }
  expect(requests).toBe(0);
});

// P1A fixtures keep phase/receipt controls local to the owning client suite.
type P1Kind = 'list' | 'status' | 'report';
const p1List = { searchEngine: 'google', taskType: 'indexer', page: 0 };
const p1Task = { family: 'google/indexer', taskId: 'p1-task' };
function p1Envelope(kind: P1Kind) {
  if (kind === 'list')
    return listResponse(0, [{ id: 'p1-task', title: 'é🧪' }]);
  if (kind === 'status') return { code: 0, result: [{ id: 'p1-task' }] };
  return {
    code: 0,
    result: {
      id: 'p1-task',
      size: 1,
      processed_count: 1,
      indexed_links: ['https://synthetic.invalid/é'],
      unindexed_links: [],
      type: 'google/indexer',
      title: 'é🧪',
      created_at: 'synthetic-date',
    },
  };
}
function p1Invoke(
  client: SpeedyIndexClient,
  kind: P1Kind,
  budget: InvocationReadBudget,
  signal?: AbortSignal,
) {
  if (kind === 'list') return client.listTasks(p1List, signal, budget);
  if (kind === 'status') return client.getTaskStatus(p1Task, signal, budget);
  return client.getTaskReport(p1Task, signal, budget);
}

class P1Clock implements ReadBudgetRuntime {
  time = 0;
  sequence = 0;
  handles = new Map<number, { due: number; callback: () => void }>();
  now() {
    return this.time;
  }
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.sequence;
    this.handles.set(id, { due: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.handles.delete(handle as number);
  }
  advance(time: number, fire = true) {
    this.time = time;
    if (!fire) return;
    for (const [id, timer] of [...this.handles].sort(
      (a, b) => a[1].due - b[1].due,
    )) {
      if (timer.due <= time && this.handles.delete(id)) timer.callback();
    }
  }
}
function p1Budget(
  limits: Parameters<typeof createInvocationReadBudget>[1] = {},
  signal?: AbortSignal,
) {
  return createInvocationReadBudget(
    {
      startedAtMs: limits.runtime?.now() ?? performance.now(),
      ...(signal ? { signal } : {}),
    },
    limits,
  );
}

type P1Read = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>;
type P1Hooks = {
  readStart?: () => void;
  read?: (value: P1Read) => void;
  reader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void;
  cancelled?: () => Promise<void>;
  released?: () => void;
  response?: () => Promise<void>;
};
// Each wrapper delegates the native operation; gates only delay its JS receipt.
function p1Decorate(response: Response, hooks: P1Hooks): Response {
  const body = response.body;
  if (!body) return response;
  const decoratedBody = new Proxy(body, {
    get(target, property) {
      if (property === 'cancel')
        return async () => {
          try {
            await target.cancel();
          } finally {
            await hooks.cancelled?.();
          }
        };
      if (property === 'getReader')
        return () => {
          const reader = target.getReader();
          hooks.reader?.(reader);
          return new Proxy(reader, {
            get(targetReader, field) {
              if (field === 'read')
                return async () => {
                  hooks.readStart?.();
                  const value = await targetReader.read();
                  hooks.read?.(value);
                  return value;
                };
              if (field === 'cancel')
                return async () => {
                  try {
                    await targetReader.cancel();
                  } finally {
                    await hooks.cancelled?.();
                  }
                };
              if (field === 'releaseLock')
                return () => {
                  targetReader.releaseLock();
                  hooks.released?.();
                };
              const value = Reflect.get(
                targetReader,
                field,
                targetReader,
              ) as unknown;
              return typeof value === 'function'
                ? value.bind(targetReader)
                : value;
            },
          });
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(response, {
    get(target, property) {
      if (property === 'body') return decoratedBody;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

type P1Step = {
  kind: P1Kind;
  payload?: string | Buffer;
  serve?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  hooks?: P1Hooks;
  received: ReturnType<typeof deferred<void>>;
  terminated: ReturnType<typeof deferred<void>>;
  outbound?: AbortSignal;
};
function p1Step(
  kind: P1Kind,
  options: Partial<Pick<P1Step, 'payload' | 'serve' | 'hooks'>> = {},
): P1Step {
  return {
    kind,
    ...options,
    received: deferred<void>(),
    terminated: deferred<void>(),
  };
}
async function p1Http(
  steps: P1Step[],
  timeoutMs = 10_000,
  maxResponseBytes?: number,
) {
  const priorFetch = globalThis.fetch;
  // Guard the default transport before constructing any client in this fixture.
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.username ||
        url.password
      )
        throw new Error('P1 fixture blocked external transport.');
      return priorFetch(input, init);
    },
    {
      preconnect: () => {
        throw new Error('P1 fixture blocked preconnect.');
      },
    },
  ) as typeof fetch;
  const guardedFetch = globalThis.fetch;
  const onWire: P1Step[] = [];
  const bodies: string[] = [];
  const pending: Promise<unknown>[] = [];
  const budgets = new Set<InvocationReadBudget>();
  const releases: (() => void)[] = [];
  const receiverErrors: unknown[] = [];
  let entries = 0;
  let arrivals = 0;
  const api = await fixture((req, res) => {
    const step = onWire[arrivals++];
    if (!step) {
      res.destroy();
      receiverErrors.push(new Error('Unexpected receiver arrival.'));
      return;
    }
    res.on('close', () => step.terminated.resolve());
    const work = (async () => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      bodies.push(body);
      expect(body).toBe(step.kind === 'list' ? '' : '{"task_id":"p1-task"}');
      expect(req.method).toBe(step.kind === 'list' ? 'GET' : 'POST');
      expect(req.url).toBe(
        `/v2/task/google/indexer/${step.kind === 'list' ? 'list/0' : step.kind}`,
      );
      step.received.resolve();
      if (step.serve) await step.serve(req, res);
      else res.end(step.payload ?? JSON.stringify(p1Envelope(step.kind)));
    })();
    pending.push(
      work.catch((error: unknown) => {
        receiverErrors.push(error);
        res.destroy();
      }),
    );
  });
  const mapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = steps[entries];
    const url = new URL(String(input));
    expect(step).toBeDefined();
    if (!step) throw new Error('Unexpected extra dispatch.');
    expect(url.origin).toBe('https://api.speedyindex.com');
    expect(url.username + url.password + url.hash + url.search).toBe('');
    expect(url.pathname).toBe(
      `/v2/task/google/indexer/${step.kind === 'list' ? 'list/0' : step.kind}`,
    );
    expect(init?.method).toBe(step.kind === 'list' ? 'GET' : 'POST');
    expect(init?.body).toBe(
      step.kind === 'list' ? undefined : '{"task_id":"p1-task"}',
    );
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(dummyKey);
    entries++;
    step.outbound = init!.signal as AbortSignal;
    onWire.push(step);
    const target = new URL(url.pathname, api.origin);
    expect(target.origin).toBe(api.origin);
    expect(target.hostname).toBe('127.0.0.1');
    const response = await guardedFetch(target, init);
    await step.hooks?.response?.();
    return step.hooks ? p1Decorate(response, step.hooks) : response;
  }) as typeof fetch;
  const client = new SpeedyIndexClient(
    dummyKey,
    mapped,
    timeoutMs,
    maxResponseBytes,
  );
  return {
    client,
    mapped,
    bodies,
    releases,
    get entries() {
      return entries;
    },
    get arrivals() {
      return arrivals;
    },
    call(kind: P1Kind, budget: InvocationReadBudget, signal?: AbortSignal) {
      budgets.add(budget);
      const operation = p1Invoke(client, kind, budget, signal);
      pending.push(
        operation.then(
          () => undefined,
          () => undefined,
        ),
      );
      return operation;
    },
    async close() {
      let cleanupFailure: unknown;
      let phase = 'actual work settlement';
      try {
        for (const release of releases) release();
        const closing = [...budgets].map((budget) => budget.close());
        await bounded(Promise.allSettled([...pending, ...closing]), 4_000);
        // An idle keepalive socket is not active request work. Each response must terminate.
        phase = 'peer request termination';
        await bounded(
          Promise.all(onWire.map((step) => step.terminated.promise)),
          4_000,
        );
        expect(receiverErrors).toEqual([]);
      } catch (error) {
        cleanupFailure = new Error(
          `P1 fixture failed at ${phase}; entries=${entries}, arrivals=${arrivals}, receiverErrors=${receiverErrors.length}`,
          { cause: error },
        );
      } finally {
        // Forced receiver close is teardown only, after proof, or after a FAILED watchdog.
        await api.close();
        globalThis.fetch = priorFetch;
      }
      if (cleanupFailure) throw cleanupFailure;
    },
  };
}

async function p1Error(operation: Promise<unknown>) {
  return bounded(
    operation.then(
      () => {
        throw new Error('Expected a read failure.');
      },
      (error: unknown) => error,
    ),
  );
}
function p1Code(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ReadBudgetError);
  expect(error).toMatchObject({ code });
}

test('P1A-01: lower-only construction, captured runtime and immutable limits fail safely before dispatch', async () => {
  const api = await p1Http([p1Step('list'), p1Step('list')]);
  try {
    for (const [name, ceiling] of Object.entries({
      maxAttempts: 64,
      maxDecodedBytes: 33_554_432,
      horizonMs: 60_000,
      maxRequestMs: 10_000,
    })) {
      for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, ceiling + 1]) {
        expect(() => p1Budget({ limits: { [name]: value } })).toThrow(
          'Invalid invocation read limits.',
        );
      }
    }
    for (const startedAtMs of [NaN, Infinity, -Infinity])
      expect(() => createInvocationReadBudget({ startedAtMs })).toThrow(
        'Invalid invocation read start.',
      );
    for (const timeout of [0, -1, NaN, Infinity, -Infinity]) {
      const client = new SpeedyIndexClient(dummyKey, api.mapped, timeout);
      await expect(
        client.listTasks(p1List, undefined, p1Budget()),
      ).rejects.toThrow('Invalid invocation read timeout.');
    }
    expect(api.entries).toBe(0);
    const runtime = new P1Clock();
    const limits = { maxAttempts: 1 };
    const budget = p1Budget({ limits, runtime });
    limits.maxAttempts = 64;
    runtime.now = () => Infinity;
    runtime.setTimeout = () => {
      throw new Error('MUTATED_RUNTIME');
    };
    runtime.clearTimeout = () => {
      throw new Error('MUTATED_RUNTIME');
    };
    await api.call('list', budget);
    budget.checkpoint();
    p1Code(await p1Error(api.call('list', budget)), 'ResourceLimitExceeded');
    expect(runtime.handles.size).toBe(0);
    await api.call('list', p1Budget());
    expect(api.arrivals).toBe(2);
    await budget.close();
    p1Code(await p1Error(api.call('list', budget)), 'Cancelled');
  } finally {
    await api.close();
  }
});

test('P1A-02: one shared 64/65 attempt limit counts repeated routes and failed entered fetches', async () => {
  const kinds: P1Kind[] = Array.from(
    { length: 64 },
    (_, i) => ['list', 'status', 'report', 'list'][i % 4] as P1Kind,
  );
  const resetRead = deferred<void>();
  const reset = p1Step('list', {
    serve: async (_req, res) => {
      res.writeHead(200);
      res.write('{');
      await resetRead.promise;
      res.destroy();
    },
    hooks: {
      read: (value) => {
        if (value.value) resetRead.resolve();
      },
    },
  });
  const api = await p1Http([
    ...kinds.map((kind) => p1Step(kind)),
    reset,
    p1Step('status', { payload: '{bad-json' }),
    p1Step('report'),
    p1Step('list'),
  ]);
  api.releases.push(() => resetRead.resolve());
  try {
    const budget = p1Budget();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      api.client.listTasks({}, undefined, budget),
    ).rejects.toMatchObject({ kind: 'input' });
    await expect(
      new SpeedyIndexClient(undefined, api.mapped).listTasks(
        p1List,
        undefined,
        budget,
      ),
    ).rejects.toMatchObject({ kind: 'credentials' });
    p1Code(
      await p1Error(api.call('list', budget, aborted.signal)),
      'Cancelled',
    );
    const cancelledInvocation = p1Budget({}, aborted.signal);
    p1Code(
      await p1Error(
        api.call('list', cancelledInvocation, new AbortController().signal),
      ),
      'Cancelled',
    );
    expect(api.entries).toBe(0);
    for (const kind of kinds) await api.call(kind, budget);
    budget.checkpoint();
    p1Code(await p1Error(api.call('list', budget)), 'ResourceLimitExceeded');
    expect(api.entries).toBe(64);
    expect(api.arrivals).toBe(64);
    const failed = p1Budget({ limits: { maxAttempts: 3 } });
    expect(await p1Error(api.call('list', failed))).toMatchObject({
      kind: 'response',
    });
    await bounded(reset.terminated.promise);
    expect(await p1Error(api.call('status', failed))).toMatchObject({
      kind: 'response',
    });
    await api.call('report', failed);
    p1Code(await p1Error(api.call('list', failed)), 'ResourceLimitExceeded');
    expect(api.entries).toBe(67);
    expect(api.arrivals).toBe(67);
    // A synchronous entered-fetch failure is charged too (supplements native reset).
    let throws = 0;
    const throwing = new SpeedyIndexClient(
      dummyKey,
      Object.assign(
        () => {
          throws++;
          throw new Error('SYNTHETIC_TRANSPORT_SECRET');
        },
        { preconnect: () => undefined },
      ) as typeof fetch,
    );
    const finite = p1Budget({ limits: { maxAttempts: 1 } });
    await expect(
      throwing.listTasks(p1List, undefined, finite),
    ).rejects.toMatchObject({ kind: 'network' });
    await expect(
      throwing.listTasks(p1List, undefined, finite),
    ).rejects.toMatchObject({ code: 'ResourceLimitExceeded' });
    expect(throws).toBe(1);
    await finite.close();
    await api.call('list', p1Budget());
  } finally {
    await api.close();
  }
});

test('P1A-03: aggregate counts decoded UTF-8, gzip, ignored fields and failed consumed bodies', async () => {
  const list = Buffer.from(JSON.stringify(p1Envelope('list')));
  const status = Buffer.from(
    JSON.stringify({ ...p1Envelope('status'), ignored: 'é'.repeat(180) }),
  );
  const report = Buffer.from(JSON.stringify(p1Envelope('report')));
  const compressed = gzipSync(status);
  expect(compressed.byteLength).toBeLessThan(status.byteLength);
  expect(list.byteLength).toBeGreaterThan(list.toString().length);
  const exact = list.byteLength + status.byteLength + report.byteLength;
  for (const extraByte of [false, true]) {
    const firstRead = deferred<void>();
    const split = list.indexOf(Buffer.from('é')) + 1;
    expect(list[split - 1]).toBe(0xc3);
    expect(list[split]).toBe(0xa9);
    const steps = [
      p1Step('list', {
        serve: async (_req, res) => {
          res.write(list.subarray(0, split));
          await firstRead.promise;
          res.end(list.subarray(split));
        },
        hooks: {
          read: (value) => {
            if (value.value?.byteLength) firstRead.resolve();
          },
        },
      }),
      p1Step('status', {
        serve: (_req, res) => {
          res.writeHead(200, {
            'Content-Encoding': 'gzip',
            'Content-Length': compressed.byteLength,
          });
          res.end(compressed);
        },
      }),
      p1Step('report', {
        payload: Buffer.concat([report, Buffer.from(extraByte ? ' ' : '')]),
      }),
      p1Step('list'),
    ];
    const api = await p1Http(steps, 10_000, 1024);
    api.releases.push(() => firstRead.resolve());
    const budget = p1Budget({ limits: { maxDecodedBytes: exact } });
    try {
      expect(await api.call('list', budget)).toMatchObject({
        tasks: [{ title: 'é🧪' }],
      });
      await api.call('status', budget);
      if (extraByte)
        p1Code(
          await p1Error(api.call('report', budget)),
          'ResourceLimitExceeded',
        );
      else {
        expect(await api.call('report', budget)).toMatchObject({
          title: 'é🧪',
          indexedLinks: ['https://synthetic.invalid/é'],
        });
        budget.checkpoint();
      }
      p1Code(await p1Error(api.call('list', budget)), 'ResourceLimitExceeded');
      expect(api.arrivals).toBe(3);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
  for (const invalid of [
    '{"bad":',
    JSON.stringify({
      code: 7,
      error: 'SYNTHETIC_PROVIDER_SECRET',
      ignored: 'é',
    }),
  ]) {
    const good = JSON.stringify(p1Envelope('status'));
    const api = await p1Http([
      p1Step('list', { payload: invalid }),
      p1Step('status', { payload: good }),
    ]);
    const budget = p1Budget({
      limits: {
        maxDecodedBytes:
          Buffer.byteLength(invalid) + Buffer.byteLength(good) - 1,
      },
    });
    try {
      expect(await p1Error(api.call('list', budget))).toMatchObject({
        kind: invalid.includes('code') ? 'provider' : 'response',
      });
      p1Code(
        await p1Error(api.call('status', budget)),
        'ResourceLimitExceeded',
      );
      expect(api.arrivals).toBe(2);
    } finally {
      await api.close();
    }
  }
});

test('P1A-04: open-stream overflow stops before EOF; aggregate wins a simultaneous response limit', async () => {
  const initialBytes = Buffer.byteLength(JSON.stringify(p1Envelope('list')));
  for (const variant of ['aggregate', 'both', 'response'] as const) {
    const firstRead = deferred<void>();
    const tail = deferred<void>();
    let delivered = 0;
    let reads = 0;
    let readsAtCrossing = 0;
    const crossing = variant === 'aggregate' ? ' '.repeat(32) : ' '.repeat(160);
    const available =
      variant === 'aggregate' ? 8 : variant === 'both' ? 64 : 1024;
    const open = p1Step('status', {
      serve: async (_req, res) => {
        res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        res.write('{');
        await firstRead.promise;
        res.write(crossing);
        await tail.promise;
        if (!res.destroyed) res.end('}');
      },
      hooks: {
        readStart: () => {
          reads++;
        },
        read: (value) => {
          if (value.value) {
            delivered += value.value.byteLength;
            firstRead.resolve();
            if (delivered > (variant === 'response' ? 128 : available))
              readsAtCrossing = reads;
          }
        },
      },
    });
    const api = await p1Http(
      [p1Step('list'), open, p1Step('list')],
      10_000,
      128,
    );
    api.releases.push(
      () => firstRead.resolve(),
      () => tail.resolve(),
    );
    const budget = p1Budget({
      limits: { maxDecodedBytes: initialBytes + available },
    });
    try {
      await api.call('list', budget);
      const error = await p1Error(api.call('status', budget));
      if (variant === 'response')
        expect(error).toMatchObject({
          kind: 'response',
          message: 'SpeedyIndex returned an invalid task-status response.',
        });
      else p1Code(error, 'ResourceLimitExceeded');
      expect(delivered).toBe(1 + Buffer.byteLength(crossing));
      expect(readsAtCrossing).toBeGreaterThan(0);
      expect(reads).toBe(readsAtCrossing);
      await bounded(open.terminated.promise);
      expect(api.arrivals).toBe(2);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
});

test('P1A-05: captured origin, request ceiling, remaining horizon, ties and stale checkpoints', async () => {
  const cases = [
    {
      timeout: 20_000,
      local: 0,
      due: 10_000,
      code: 'timeout',
      request: 10_000,
    },
    { timeout: 25, local: 0, due: 25, code: 'timeout', request: 10_000 },
    { timeout: 10_000, local: 0, due: 40, code: 'timeout', request: 40 },
    {
      timeout: 10_000,
      local: 59_990,
      due: 60_000,
      code: 'DeadlineExceeded',
      request: 10_000,
    },
    {
      timeout: 50,
      local: 59_950,
      due: 60_000,
      code: 'DeadlineExceeded',
      request: 10_000,
    },
    {
      timeout: 1000,
      local: 0,
      due: 1000,
      code: 'Cancelled',
      request: 10_000,
      cancelFirst: true,
    },
  ];
  for (const spec of cases) {
    const release = deferred<void>();
    const held = p1Step('status', {
      serve: async (_req, res) => {
        await release.promise;
        if (!res.destroyed) res.end(JSON.stringify(p1Envelope('status')));
      },
    });
    const api = await p1Http([held, p1Step('list')], spec.timeout);
    api.releases.push(() => release.resolve());
    const runtime = new P1Clock();
    // Explicit start precedes the simulated first local observation.
    const budget = createInvocationReadBudget(
      { startedAtMs: 0 },
      { runtime, limits: { maxRequestMs: spec.request } },
    );
    runtime.advance(spec.local);
    try {
      const caller = new AbortController();
      const operation = api.call('status', budget, caller.signal);
      await bounded(held.received.promise);
      runtime.advance(spec.due - 1);
      expect(held.outbound?.aborted).toBe(false);
      if ('cancelFirst' in spec && spec.cancelFirst) caller.abort();
      runtime.advance(spec.due);
      expect(held.outbound?.aborted).toBe(true);
      const error = await p1Error(operation);
      if (spec.code === 'timeout')
        expect(error).toMatchObject({
          kind: 'timeout',
          message: 'SpeedyIndex task-status request timed out.',
        });
      else p1Code(error, spec.code);
      await bounded(held.terminated.promise);
      expect(runtime.handles.size).toBe(0);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
  const runtime = new P1Clock();
  const eofRuntime = new P1Clock();
  const api = await p1Http([
    p1Step('list'),
    p1Step('report', {
      hooks: {
        read: (value) => {
          if (value.done) eofRuntime.advance(60_000, false);
        },
      },
    }),
  ]);
  try {
    const budget = p1Budget({ runtime });
    await api.call('list', budget);
    runtime.advance(60_000, false);
    p1Code(await p1Error(api.call('list', budget)), 'DeadlineExceeded');
    const eof = p1Budget({ runtime: eofRuntime });
    p1Code(await p1Error(api.call('report', eof)), 'DeadlineExceeded');
    expect(api.entries).toBe(2);
    for (const invalid of [-1, NaN, Infinity, -Infinity, 60_000]) {
      const clock = new P1Clock();
      const stale = p1Budget({ runtime: clock });
      clock.advance(5, false);
      stale.checkpoint();
      clock.advance(invalid, false);
      expect(() => stale.checkpoint()).toThrow(
        'Invocation read deadline exceeded.',
      );
      p1Code(await p1Error(api.call('list', stale)), 'DeadlineExceeded');
    }
    expect(api.arrivals).toBe(2);
  } finally {
    await api.close();
  }
});

test('P1A-06: native caller/invocation cancellation settles pre-header, pending-body and between reads', async () => {
  for (const phase of ['headers', 'body'] as const) {
    const release = deferred<void>();
    const pendingRead = deferred<void>();
    let reads = 0;
    let released = false;
    const kind = phase === 'headers' ? 'status' : 'report';
    const held = p1Step(kind, {
      serve: async (_req, res) => {
        if (phase === 'body') {
          res.writeHead(200);
          res.write('{"code":0,');
        }
        await release.promise;
        if (!res.destroyed) res.end();
      },
      hooks: {
        readStart: () => {
          if (++reads === 2) pendingRead.resolve();
        },
        released: () => {
          released = true;
        },
      },
    });
    const api = await p1Http([held, p1Step('list')]);
    api.releases.push(() => release.resolve());
    const controller = new AbortController();
    const other = new AbortController();
    let sentinel = 0;
    other.signal.addEventListener('abort', () => {
      sentinel++;
    });
    const budget = p1Budget(
      {},
      phase === 'body' ? controller.signal : undefined,
    );
    try {
      const operation = api.call(
        kind,
        budget,
        phase === 'headers' ? controller.signal : other.signal,
      );
      await bounded(held.received.promise);
      if (phase === 'body') await bounded(pendingRead.promise);
      expect(held.outbound?.aborted).toBe(false);
      controller.abort();
      p1Code(await p1Error(operation), 'Cancelled');
      await bounded(held.terminated.promise);
      if (phase === 'body') {
        expect(released).toBe(true);
        p1Code(
          await p1Error(api.call('list', budget, new AbortController().signal)),
          'Cancelled',
        );
      }
      expect(other.signal.aborted).toBe(false);
      other.abort();
      expect(sentinel).toBe(1);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
  const invocation = new AbortController();
  const api = await p1Http([p1Step('list'), p1Step('list')]);
  try {
    const budget = p1Budget({}, invocation.signal);
    await api.call('list', budget);
    invocation.abort();
    p1Code(
      await p1Error(api.call('status', budget, new AbortController().signal)),
      'Cancelled',
    );
    expect(api.entries).toBe(1);
    await api.call('list', p1Budget());
  } finally {
    await api.close();
  }
});

test('P1A-07: held native cancellation receipt retains lease, frozen HTTP cause and idempotent close', async () => {
  // All three outer catches must retain the selected transport cause after late abort.
  for (const kind of ['list', 'status', 'report'] as const) {
    const cancelEntered = deferred<void>();
    const cancelRelease = deferred<void>();
    const tail = deferred<void>();
    const held = p1Step(kind, {
      serve: async (_req, res) => {
        res.writeHead(503);
        res.write('SYNTHETIC_HTTP_BODY_SECRET');
        await tail.promise;
        if (!res.destroyed) res.end();
      },
      hooks: {
        cancelled: async () => {
          cancelEntered.resolve();
          await cancelRelease.promise;
        },
      },
    });
    const api = await p1Http([held, p1Step('list'), p1Step('list')]);
    api.releases.push(
      () => tail.resolve(),
      () => cancelRelease.resolve(),
    );
    const runtime = new P1Clock();
    const budget = p1Budget({ runtime, limits: { maxAttempts: 1 } });
    const controller = new AbortController();
    let settled = false;
    let closeSettled = false;
    try {
      const operation = api.call(kind, budget, controller.signal);
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await bounded(cancelEntered.promise);
      await bounded(held.terminated.promise);
      // Busy precedes exhausted capacity and introduces no timer/listener/attempt.
      p1Code(await p1Error(api.call('list', budget)), 'ReadInProgress');
      const preAborted = new AbortController();
      preAborted.abort();
      p1Code(
        await p1Error(api.call('list', budget, preAborted.signal)),
        'Cancelled',
      );
      expect(runtime.handles.size).toBe(1);
      runtime.advance(60_000);
      p1Code(await p1Error(api.call('list', budget)), 'DeadlineExceeded');
      // The scheduler consumes a fired timer; the lease still owns its receipt.
      expect(runtime.handles.size).toBe(0);
      controller.abort();
      const closing = budget.close();
      expect(budget.close()).toBe(closing);
      void closing.then(() => {
        closeSettled = true;
      });
      p1Code(await p1Error(api.call('list', budget)), 'Cancelled');
      expect(api.entries).toBe(1);
      expect(settled).toBe(false);
      expect(closeSettled).toBe(false);
      // A separate invocation on the same client is not held by this lease.
      await api.call('list', p1Budget());
      expect(api.entries).toBe(2);
      expect(settled).toBe(false);
      expect(closeSettled).toBe(false);
      cancelRelease.resolve();
      expect(await p1Error(operation)).toMatchObject({ kind: 'http' });
      await bounded(closing);
      expect(settled).toBe(true);
      expect(closeSettled).toBe(true);
      expect(runtime.handles.size).toBe(0);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
});

test('P1A-07: close waits for an actual late native Response and its cancellation receipt', async () => {
  const nativeHeaders = deferred<void>();
  const forwardResponse = deferred<void>();
  const tail = deferred<void>();
  let cancellations = 0;
  const held = p1Step('report', {
    serve: async (_req, res) => {
      res.writeHead(200);
      res.write('{"code":0,');
      await tail.promise;
      if (!res.destroyed) res.end();
    },
    hooks: {
      response: async () => {
        nativeHeaders.resolve();
        await forwardResponse.promise;
      },
      cancelled: async () => {
        cancellations++;
      },
    },
  });
  const api = await p1Http([held, p1Step('list')]);
  api.releases.push(
    () => tail.resolve(),
    () => forwardResponse.resolve(),
  );
  const budget = p1Budget();
  let operationSettled = false;
  let closeSettled = false;
  try {
    const operation = api.call('report', budget);
    void operation.then(
      () => {
        operationSettled = true;
      },
      () => {
        operationSettled = true;
      },
    );
    await bounded(nativeHeaders.promise);
    const closing = budget.close();
    void closing.then(() => {
      closeSettled = true;
    });
    p1Code(await p1Error(api.call('list', budget)), 'Cancelled');
    expect(operationSettled).toBe(false);
    expect(closeSettled).toBe(false);
    forwardResponse.resolve();
    p1Code(await p1Error(operation), 'Cancelled');
    await bounded(closing);
    await bounded(held.terminated.promise);
    expect(cancellations).toBe(1);
    await api.call('list', p1Budget());
  } finally {
    await api.close();
  }
});

function p1Subscriptions(signal: AbortSignal) {
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const listeners = new Set<unknown>();
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value: (
      name: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (name === 'abort') listeners.add(callback);
      add(name, callback, options);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value: (
      name: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (name === 'abort') listeners.delete(callback);
      remove(name, callback, options);
    },
  });
  return {
    listeners,
    restore() {
      Reflect.deleteProperty(signal, 'addEventListener');
      Reflect.deleteProperty(signal, 'removeEventListener');
    },
  };
}

test('P1A-08: owned timers/listeners/reader receipts settle; errors stay fixed and handled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', onUnhandled);
  const marker = 'SYNTHETIC_PRIVATE_PATH_KEY_BODY';
  const controller = new AbortController();
  let sentinel = 0;
  controller.signal.addEventListener('abort', () => {
    sentinel++;
  });
  const subscriptions = p1Subscriptions(controller.signal);
  const runtime = new P1Clock();
  const streamRead = deferred<void>();
  const steps = [
    p1Step('list'),
    p1Step('status', { payload: `{${marker}` }),
    p1Step('report', { payload: JSON.stringify({ code: 9, error: marker }) }),
    p1Step('list', {
      serve: async (_req, res) => {
        res.writeHead(200);
        res.write('{');
        await streamRead.promise;
        res.destroy();
      },
      hooks: {
        read: (value) => {
          if (value.value) streamRead.resolve();
        },
      },
    }),
    p1Step('list'),
  ];
  const api = await p1Http(steps);
  api.releases.push(() => streamRead.resolve());
  try {
    for (const [index, step] of steps.entries()) {
      const budget = p1Budget({ runtime }, controller.signal);
      const released = deferred<void>();
      const existing = step.hooks ?? {};
      step.hooks = {
        ...existing,
        released: () => {
          // Timers/subscriptions belong to the lease until reader settlement/release.
          expect(runtime.handles.size).toBe(1);
          expect(subscriptions.listeners.size).toBe(1);
          released.resolve();
        },
      };
      const operation = api.call(step.kind, budget, controller.signal);
      if (index === 0 || index === 4) await operation;
      else {
        const error = await p1Error(operation);
        expect(error).toMatchObject({
          kind: index === 2 ? 'provider' : 'response',
        });
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(marker);
        expect(String(error)).not.toContain(dummyKey);
        expect(String(error)).not.toContain('https://');
      }
      await bounded(released.promise);
      expect(runtime.handles.size).toBe(0);
      expect(subscriptions.listeners.size).toBe(0);
      await budget.close();
    }
    controller.abort();
    expect(sentinel).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    await api.close();
    subscriptions.restore();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('P1A-08: charge a fulfilled chunk before same-turn abort; cancellation wins overflow without refund', async () => {
  const payload = JSON.stringify(p1Envelope('list'));
  const controller = new AbortController();
  let delivered = 0;
  const step = p1Step('list', {
    payload,
    hooks: {
      read: (value) => {
        delivered += value.value?.byteLength ?? 0;
        if (delivered === Buffer.byteLength(payload)) controller.abort();
      },
    },
  });
  const api = await p1Http([step, p1Step('list')]);
  const budget = p1Budget({
    limits: { maxDecodedBytes: Buffer.byteLength(payload) - 1 },
  });
  try {
    p1Code(
      await p1Error(api.call('list', budget, controller.signal)),
      'Cancelled',
    );
    expect(delivered).toBe(Buffer.byteLength(payload));
    p1Code(await p1Error(api.call('list', budget)), 'ResourceLimitExceeded');
    expect(api.entries).toBe(1);
    await budget.close();
    await api.call('list', p1Budget());
  } finally {
    await api.close();
  }
});

test('P1A-08: unexpected cleanup failure poisons close and admission, retaining any primary cause', async () => {
  for (const primary of [false, true]) {
    const tail = deferred<void>();
    const marker = 'SYNTHETIC_CLEANUP_SECRET';
    const broken = p1Step(
      'list',
      primary
        ? {
            serve: async (_req, res) => {
              res.writeHead(502);
              res.write(marker);
              await tail.promise;
              if (!res.destroyed) res.end();
            },
            hooks: {
              cancelled: async () => {
                throw new Error(marker);
              },
            },
          }
        : {
            hooks: {
              released: () => {
                throw new Error(marker);
              },
            },
          },
    );
    const api = await p1Http([broken, p1Step('list')]);
    api.releases.push(() => tail.resolve());
    const runtime = new P1Clock();
    const controller = new AbortController();
    const budget = p1Budget({ runtime }, controller.signal);
    try {
      const error = await p1Error(api.call('list', budget));
      if (primary) expect(error).toMatchObject({ kind: 'http' });
      else p1Code(error, 'CleanupFailed');
      expect(String(error)).not.toContain(marker);
      const closing = budget.close();
      expect(budget.close()).toBe(closing);
      p1Code(await p1Error(closing), 'CleanupFailed');
      p1Code(await p1Error(budget.close()), 'CleanupFailed');
      controller.abort();
      runtime.advance(Infinity, false);
      p1Code(await p1Error(api.call('list', budget)), 'CleanupFailed');
      expect(runtime.handles.size).toBe(0);
      expect(api.entries).toBe(1);
      await api.call('list', p1Budget());
    } finally {
      await api.close();
    }
  }
});
