import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
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
          last_page: 1,
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
      lastPage: 1,
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
