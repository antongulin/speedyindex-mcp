import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const dummyKey = 'synthetic-test-key-do-not-use';
export const account = {
  code: 0,
  balance: { tokens: 0, indexer: 27, checker: 8 },
};
export const officialOrigin = 'https://api.speedyindex.com';
export const officialUrl = `${officialOrigin}/v2/account`;

function isSupportedProviderTarget(url: URL) {
  return (
    url.origin === officialOrigin &&
    (url.pathname === '/v2/account' ||
      /^\/v2\/task\/(google|yandex|bing)\/(indexer|checker)\/list\/\d+$/.test(
        url.pathname,
      ))
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture deadline exceeded')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fixture(handler: RequestListener) {
  const requests: {
    method: string | undefined;
    path: string | undefined;
    auth: string | undefined;
    agent: string | undefined;
  }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      agent: req.headers['user-agent'],
    });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  let address: ReturnType<typeof server.address>;
  try {
    await bounded(once(server, 'listening'));
    address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
  } catch (error) {
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((closeError) =>
          closeError ? reject(closeError) : resolve(),
        ),
      );
      server.closeAllConnections();
      await bounded(closed);
    }
    throw error;
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    async close() {
      if (!server.listening) return;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await bounded(closed);
    },
  };
}

export function loopbackFetch(origin: string): typeof fetch {
  const redirected = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const target = new URL(String(input));
    if (!isSupportedProviderTarget(target))
      throw new Error('Unexpected production URL');
    return fetch(new URL(`${target.pathname}${target.search}`, origin), init);
  }) as typeof fetch;
  return redirected;
}

export async function connect(
  origin: string,
  entry = 'src/cli.ts',
  key = dummyKey,
  mode = '',
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--preload', './tests/fixtures/redirect-fetch.ts', entry],
    cwd: process.cwd(),
    env: {
      SPEEDYINDEX_API_KEY: key,
      TEST_ACCOUNT_ORIGIN: origin,
      TEST_FETCH_MODE: mode,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({
    name: 'synthetic-test-client',
    version: '1.0.0',
  });
  try {
    await bounded(client.connect(transport));
  } catch (error) {
    try {
      await bounded(transport.close());
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'MCP connection failed and its subprocess could not be closed.',
        { cause: closeError },
      );
    }
    throw error;
  }
  return {
    client,
    transport,
    stderr: () => stderr,
    async close() {
      try {
        await bounded(client.close());
      } catch (error) {
        try {
          await bounded(transport.close());
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'MCP session and subprocess could not be closed.',
            { cause: closeError },
          );
        }
        throw error;
      }
    },
  };
}
