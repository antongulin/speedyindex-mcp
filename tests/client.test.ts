import { expect, test } from 'bun:test';
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
              child_task_ids: ['child-a'],
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
          childTaskIds: ['child-a'],
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
