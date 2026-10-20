import { expect, test } from 'bun:test';
import { balanceResultSchema } from '../src/client';
import {
  account,
  bounded,
  connect,
  deferred,
  dummyKey,
  fixture,
} from './helpers';
import { verifyEof } from './stdio-eof';

test('F01: real SDK process initializes, advertises only read-only get_balance and calls it', async () => {
  const api = await fixture((_req, res) => res.end(JSON.stringify(account)));
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin);
    expect(session.client.getServerVersion()).toEqual({
      name: 'speedyindex-mcp',
      version: '0.1.0',
    });
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['get_balance']);
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

test('F07: SDK cancellation aborts underlying HTTP and next call succeeds', async () => {
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
