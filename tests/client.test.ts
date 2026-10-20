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
