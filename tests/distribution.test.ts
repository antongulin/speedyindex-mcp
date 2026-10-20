import { expect, test } from 'bun:test';
import { balanceResultSchema } from '../src/client';
import { account, connect, fixture } from './helpers';
import { verifyEof } from './stdio-eof';

test('F09: built CLI initializes, lists and calls get_balance', async () => {
  const api = await fixture((_req, res) => res.end(JSON.stringify(account)));
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    session = await connect(api.origin, 'dist/cli.js');
    expect(session.client.getServerVersion()?.name).toBe('speedyindex-mcp');
    expect(
      (await session.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(['get_balance']);
    const result = await session.client.callTool({
      name: 'get_balance',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(balanceResultSchema.parse(result.structuredContent).balance).toEqual(
      account.balance,
    );
    expect(session.stderr()).toBe('');
    expect(api.requests).toHaveLength(1);
  } finally {
    try {
      await session?.close();
    } finally {
      await api.close();
    }
  }
});

test('F09: built CLI exits naturally on stdin EOF', async () => {
  await verifyEof('dist/cli.js');
});
