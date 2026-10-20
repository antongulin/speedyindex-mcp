import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';

export const dummyKey = 'synthetic-test-key-do-not-use';
export const account = {
  code: 0,
  balance: { tokens: 0, indexer: 27, checker: 8 },
};
export const officialOrigin = 'https://api.speedyindex.com';
export const officialUrl = `${officialOrigin}/v2/account`;

const statusPaths = new Set([
  '/v2/task/google/indexer/status',
  '/v2/task/google/checker/status',
  '/v2/task/yandex/indexer/status',
  '/v2/task/yandex/checker/status',
  '/v2/task/bing/checker/status',
  '/v2/task/backlink/checker/status',
]);
const reportPaths = new Set([
  '/v2/task/google/indexer/report',
  '/v2/task/google/checker/report',
  '/v2/task/yandex/indexer/report',
  '/v2/task/yandex/checker/report',
  '/v2/task/bing/checker/report',
  '/v2/task/backlink/checker/report',
]);

function isSupportedProviderTarget(url: URL, method: string) {
  return (
    url.origin === officialOrigin &&
    ((method === 'GET' &&
      (url.pathname === '/v2/account' ||
        /^\/v2\/task\/(google\/(indexer|checker)|yandex\/(indexer|checker)|bing\/checker)\/list\/\d+$/.test(
          url.pathname,
        ))) ||
      (method === 'POST' &&
        (statusPaths.has(url.pathname) || reportPaths.has(url.pathname))))
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
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!isSupportedProviderTarget(target, method))
      throw new Error('Unexpected production URL');
    return fetch(new URL(`${target.pathname}${target.search}`, origin), init);
  }) as typeof fetch;
  return redirected;
}

export interface ConnectionOptions {
  args?: string[];
  environment?: Record<string, string>;
  onStderr?: (chunk: string) => void;
  register?: (close: () => Promise<void>) => void;
}

function spawnOwnedStdio(args: string[], environment: Record<string, string>) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--preload',
      './tests/fixtures/redirect-fetch.ts',
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
// The lock tests need a completed pipe flush, which SDK2.3.1's Node stdio
// send promise does not distinguish from accepting a buffered write. This is
// a real byte transport for the actual SDK Client, using its public framing.
export async function connectOwnedStdio(
  args: string[],
  environment: Record<string, string>,
  registerChild: (child: ReturnType<typeof spawnOwnedStdio>) => void,
  options: ConnectionOptions,
) {
  let child: ReturnType<typeof spawnOwnedStdio> | undefined;
  let stderr = '';
  let finished: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const errors: string[] = [];
  const transport: Transport & { readonly pid: number | null } = {
    get pid() {
      return child?.pid ?? null;
    },
    async start() {
      child = spawnOwnedStdio(args, environment);
      registerChild(child); // before readers, serialization, write or flush
      const output = child.stdout.getReader();
      const errorOutput = child.stderr.getReader();
      const buffer = new ReadBuffer();
      const read = (async () => {
        try {
          while (true) {
            const chunk = await output.read();
            if (chunk.done) break;
            buffer.append(Buffer.from(chunk.value));
            let message = buffer.readMessage();
            while (message !== null) {
              transport.onmessage?.(message);
              message = buffer.readMessage();
            }
          }
        } finally {
          output.releaseLock();
        }
      })();
      const readErrors = (async () => {
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await errorOutput.read();
            if (chunk.done) break;
            const text = decoder.decode(chunk.value, { stream: true });
            stderr += text;
            options.onStderr?.(text);
          }
        } finally {
          errorOutput.releaseLock();
        }
      })();
      finished = Promise.allSettled([child.exited, read, readErrors]).then(
        (results) => {
          if (results.some((result) => result.status === 'rejected'))
            errors.push('Owned SDK pipe failed.');
          transport.onclose?.();
        },
      );
    },
    async send(message) {
      if (!child) throw new Error('SDK child is not connected.');
      child.stdin.write(serializeMessage(message));
      await child.stdin.flush();
    },
    close() {
      closing ??= (async () => {
        if (!child) return;
        try {
          await child.stdin.end();
          await bounded(child.exited, 1_000);
        } catch {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await bounded(child.exited, 5_000);
        }
        await bounded(finished, 5_000);
        if (child.exitCode !== 0)
          errors.push('Owned SDK child exited abnormally.');
        if (errors.length) throw new Error(errors.join(' '));
      })();
      return closing;
    },
  };
  const client = new Client({
    name: 'synthetic-owned-stdio-client',
    version: '1.0.0',
  });
  const close = () => client.close();
  options.register?.(close);
  try {
    await bounded(client.connect(transport), 8_000);
  } catch (error) {
    try {
      await transport.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Owned SDK startup and cleanup failed.',
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return { client, transport, stderr: () => stderr, close };
}

export async function connect(
  origin: string,
  entry = 'src/cli.ts',
  key = dummyKey,
  mode = '',
  options: ConnectionOptions = {},
) {
  const fixtureHome = mkdtempSync(
    join(realpathSync('/tmp'), 'speedyindex-sdk-home-'),
  );
  chmodSync(fixtureHome, 0o700);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--no-env-file',
      '--preload',
      './tests/fixtures/redirect-fetch.ts',
      entry,
      ...(options.args ?? []),
    ],
    cwd: process.cwd(),
    env: {
      // SDK2.3.1 overlays its safe inherited list even with explicit env.
      // Override that list without reading it so fixtures have synthetic env.
      ...Object.fromEntries(
        DEFAULT_INHERITED_ENV_VARS.map((name) => [name, '']),
      ),
      HOME: fixtureHome,
      SPEEDYINDEX_API_KEY: key,
      TEST_ACCOUNT_ORIGIN: origin,
      TEST_FETCH_MODE: mode,
      ...options.environment,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    options.onStderr?.(chunk.toString());
  });
  const client = new Client({
    name: 'synthetic-test-client',
    version: '1.0.0',
  });
  const exited = deferred<void>();
  let started = false;
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    started = true;
    const onclose = transport.onclose;
    transport.onclose = () => {
      exited.resolve();
      onclose?.();
    };
  };
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      try {
        await bounded(client.close(), 5_000);
      } catch (error) {
        try {
          await bounded(transport.close(), 5_000);
          if (started) await bounded(exited.promise, 5_000);
          rmSync(fixtureHome, { recursive: true, force: true });
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'MCP session and subprocess could not be closed.',
            { cause: closeError },
          );
        }
        throw error;
      }
      if (started) await bounded(exited.promise, 5_000);
      rmSync(fixtureHome, { recursive: true, force: true });
    })();
    return closing;
  }
  // Ownership precedes Client.connect starting/spawning and serializing its
  // initialize frame, including failures before connect returns to the caller.
  options.register?.(close);
  try {
    await bounded(client.connect(transport));
  } catch (error) {
    try {
      await close();
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
    close,
  };
}
