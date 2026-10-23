import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { openLedger, type PrepareIntentInput } from '../src/submission-ledger';
import { createIndexingTaskResultSchema } from '../src/create-indexing-task';
import { createIndexCheckResultSchema } from '../src/create-index-check';
import { createBacklinkCheckResultSchema } from '../src/create-backlink-check';
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
  onStdout?: (chunk: Uint8Array) => void;
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
            options.onStdout?.(chunk.value);
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

// One source/built integration journey, using the existing guarded preload and
// SDK transport. These paths, keys and policy values are owned synthetic data.
async function withV2Integration(
  entry: string,
  operation: (h: {
    root: string;
    posts: { path: string; body: string }[];
    local: (
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
    open: (args: string[]) => ReturnType<typeof connect>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(
    join(realpathSync('/tmp'), 'speedyindex-v2-integration-'),
  );
  const sessions: (() => Promise<void>)[] = [];
  const sessionPids: (number | null)[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const reads: Promise<unknown>[] = [];
  const receivers: Promise<void>[] = [];
  const posts: { path: string; body: string }[] = [];
  let api: Awaited<ReturnType<typeof fixture>> | undefined;
  const errors: unknown[] = [];
  const cleanup: unknown[] = [];
  try {
    chmodSync(root, 0o700);
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    api = await fixture((req, res) => {
      const receiving = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (
          req.method !== 'POST' ||
          ![
            '/v2/task/google/indexer/create',
            '/v2/task/bing/checker/create',
            '/v2/task/backlink/checker/create',
          ].includes(req.url ?? '')
        )
          throw new Error('Unexpected integration request.');
        posts.push({
          path: req.url!,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.end(
          JSON.stringify(
            posts.length === 4
              ? { code: 0, result: { task_id: 'nested-is-not-root-ACK' } }
              : {
                  code: 0,
                  task_id: ` synthetic local ACK ${posts.length} /? `,
                  type: req.url!.slice('/v2/task/'.length, -'/create'.length),
                  ...(req.url!.includes('/indexer/')
                    ? { pay_per_indexed: true, drip_feed: false }
                    : {}),
                },
          ),
        );
      })();
      receivers.push(receiving);
      void receiving.catch(() => res.destroy());
    });
    const ownedApi = api;
    await operation({
      root,
      posts,
      async local(args) {
        const before = ownedApi.requests.length;
        const child = Bun.spawn(
          [
            process.execPath,
            '--no-env-file',
            '--preload',
            './tests/fixtures/redirect-fetch.ts',
            entry,
            ...args,
          ],
          {
            env: { HOME: home, TEST_ACCOUNT_ORIGIN: ownedApi.origin },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        children.push(child);
        const reading = Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        reads.push(reading);
        const [code, stdout, stderr] = await bounded(reading, 8_000);
        expect(ownedApi.requests.length).toBe(before);
        return { code, stdout, stderr };
      },
      async open(args) {
        const session = await connect(ownedApi.origin, entry, dummyKey, '', {
          args,
          register: (close) => sessions.push(close),
        });
        sessionPids.push(session.transport.pid);
        return session;
      },
    });
  } catch (error) {
    errors.push(error);
  }
  const stopped = await Promise.allSettled([
    ...sessions.map((close) => close()),
    ...children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await bounded(child.exited, 5_000);
    }),
  ]);
  for (const result of stopped)
    if (result.status === 'rejected') cleanup.push(result.reason);
  try {
    await api?.close();
  } catch (error) {
    cleanup.push(error);
  }
  try {
    const settled = await bounded(
      Promise.allSettled([...reads, ...receivers]),
      5_000,
    );
    for (const result of settled)
      if (result.status === 'rejected') cleanup.push(result.reason);
  } catch (error) {
    cleanup.push(error);
  }
  if (errors.length || cleanup.length) {
    console.error('V2-10 preserved', root);
    throw new AggregateError(
      [...errors, ...cleanup],
      `V2 integration failed; preserving ${root}.`,
    );
  }
  rmSync(root, { recursive: true });
  expect(existsSync(root)).toBe(false);
  console.error(
    'V2-10 cleanup',
    JSON.stringify({
      entry,
      root,
      absent: true,
      children: children.map((child) => ({
        pid: child.pid,
        code: child.exitCode,
        signal: child.signalCode,
        reaped: true,
      })),
      sessionsClosed: sessions.length,
      sessionPids,
      streamsSettled: true,
    }),
  );
}

function integrationRows(state: string, tables: readonly string[]) {
  const db = new Database(
    join(state, 'ledger.sqlite'),
    sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    // Independent complete column projection; exact decimal INTEGER text avoids
    // losing sequence/event IDs above Number.MAX_SAFE_INTEGER.
    return tables.map((table) => {
      const columns = db
        .query<{ name: string; type: string }, []>(
          `PRAGMA table_info(${table})`,
        )
        .all();
      const projection = columns
        .map((column) =>
          column.type === 'INTEGER' || column.name === 'seq'
            ? `CAST("${column.name}" AS TEXT) AS "${column.name}"`
            : `"${column.name}"`,
        )
        .join(',');
      const order =
        table === 'intent_context'
          ? 'credential_fp COLLATE BINARY, request_id COLLATE BINARY'
          : 'rowid';
      return db
        .query(`SELECT ${projection} FROM ${table} ORDER BY ${order}`)
        .all();
    });
  } finally {
    db.close();
  }
}
const integrationCore = [
  'budget_periods',
  'intents',
  'intent_urls',
  'intent_events',
  'sqlite_sequence',
] as const;

function privateTree(path: string): unknown {
  return readdirSync(path)
    .filter((name) => name !== 'home')
    .sort()
    .map((name) => {
      const file = join(path, name),
        stat = lstatSync(file, { bigint: true });
      return [
        name,
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        stat.isDirectory()
          ? privateTree(file)
          : createHash('sha256').update(readFileSync(file)).digest('hex'),
      ];
    });
}

export async function verifyV2Maintenance(entry: string) {
  await withV2Integration(entry, async (h) => {
    const state = join(h.root, 'v2'),
      v1 = join(h.root, 'v1'),
      backup = join(h.root, 'backup');
    const init = '--init-submission-state-v2',
      migrate = '--migrate-submission-state-v2',
      back = '--backup-directory';
    // Every combination is parsed completely before a mode can create a leaf.
    const bad: string[][] = [
      [init],
      [migrate],
      [migrate, v1],
      [back],
      [back, backup],
      [init, state, init, state],
      [init, state, back, backup],
      [migrate, v1, migrate, v1, back, backup],
      [migrate, v1, back, backup, back, backup],
      [init, state, '--unknown'],
      [migrate, v1, back],
      [migrate, v1, back, '--help'],
      [init, state, 'extra'],
    ];
    for (const mode of [
      [init, state],
      ['--init-submission-state', state],
      ['--submission-credential-fingerprint'],
      ['--help'],
      ['--version'],
    ]) {
      bad.push([...mode, migrate, v1, back, backup]);
    }
    for (const flags of [
      [init, state],
      [migrate, v1, back, backup],
    ]) {
      for (const extra of [
        ['--submission-policy', join(h.root, 'policy')],
        ['--submission-state', state],
        ['--submission-credential-fingerprint'],
      ])
        bad.push([...flags, ...extra]);
    }
    const untouched = privateTree(h.root);
    expect(await h.local([])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(privateTree(h.root)).toEqual(untouched);
    expect(existsSync(join(h.root, 'home', 'ledger.sqlite'))).toBe(false);
    for (const args of bad) {
      expect(await h.local(args)).toEqual({
        code: 1,
        stdout: '',
        stderr: 'Unsupported arguments. Use --help for usage.\n',
      });
      expect(privateTree(h.root)).toEqual(untouched);
    }
    expect(await h.local([init, state])).toEqual({
      code: 0,
      stdout: '{"initialized":true,"schemaVersion":2}\n',
      stderr: '',
    });
    const v2 = openLedger({ stateDirectory: state });
    v2.close();
    const schema = new Database(
      join(state, 'ledger.sqlite'),
      sqliteConstants.SQLITE_OPEN_READWRITE |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      expect(schema.query('PRAGMA user_version').get()).toEqual({
        user_version: 2,
      });
      expect(
        schema.query('SELECT COUNT(*) AS n FROM retry_ledger_meta').get(),
      ).toEqual({ n: 1 });
      expect(
        schema.query('SELECT COUNT(*) AS n FROM intent_context').get(),
      ).toEqual({ n: 0 });
    } finally {
      schema.close();
    }
    const beforeInit = privateTree(state);
    expect(await h.local([init, state])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Could not initialize submission state.\n',
    });
    expect(privateTree(state)).toEqual(beforeInit);
    expect(await h.local(['--init-submission-state', v1])).toEqual({
      code: 0,
      stdout: '{"initialized":true,"schemaVersion":1}\n',
      stderr: '',
    });
    const ledger = openLedger({ stateDirectory: v1 });
    try {
      for (const [index, status] of (
        ['accepted', 'unknown', 'prepared'] as const
      ).entries()) {
        const input: PrepareIntentInput = {
          requestId: `legacy-${status}`,
          taskFamily: 'google/indexer',
          providerRoute: '/v2/task/google/indexer/create',
          payloadDigest: 'b'.repeat(64),
          quoteVersion: 'synthetic-v1',
          quoteFingerprint: 'c'.repeat(64),
          submittedUrls: [
            `HTTPS://Synthetic.TEST/${index}/%2f?b=2&a=1#片`,
            `https://synthetic.test/${index}/`,
          ],
          reservation: { tokens: 3, indexer: 2, checker: 1 },
          budget: {
            credentialFingerprint: 'a'.repeat(64),
            budgetScope: 'synthetic-cli',
            periodId: 'synthetic-period',
            periodStartMs: 1000,
            policyRevision: 'synthetic-v1',
            policyDigest: 'd'.repeat(64),
            caps: { tokens: 100, indexer: 100, checker: 100 },
          },
        };
        const prepared = ledger.prepareIntent(input);
        if (prepared.kind !== 'created')
          throw new Error('Expected synthetic create.');
        if (status !== 'prepared') {
          const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
          if (claim.kind !== 'claimed')
            throw new Error('Expected synthetic claim.');
          expect(
            ledger.recordDispatchOutcome({
              credentialFingerprint: input.budget.credentialFingerprint,
              requestId: input.requestId,
              expectedStateVersion: claim.stateVersion,
              outcomeToken: claim.outcomeToken,
              outcome:
                status === 'accepted'
                  ? {
                      kind: 'accepted',
                      providerTaskId: ' local opaque /? ',
                      providerType: 'google/indexer',
                    }
                  : { kind: 'unknown' },
            }).state,
          ).toBe(status);
        }
      }
    } finally {
      ledger.close();
    }
    const original = integrationRows(v1, integrationCore),
      inode = lstatSync(join(v1, 'ledger.sqlite')).ino;
    // A populated V1 remains V1 on ordinary source/built startup and EOF.
    expect(await h.local(['--submission-state', v1])).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect(integrationRows(v1, integrationCore)).toEqual(original);
    expect(await h.local([migrate, v1, back, backup])).toEqual({
      code: 0,
      stdout: '{"migrated":true,"schemaVersion":2,"backupVerified":true}\n',
      stderr: '',
    });
    expect(lstatSync(join(v1, 'ledger.sqlite')).ino).toBe(inode);
    expect(integrationRows(v1, integrationCore)).toEqual(original);
    const manifest = JSON.parse(
      readFileSync(join(backup, 'backup-manifest.json'), 'utf8'),
    ) as {
      format: string;
      schemaVersion: number;
      files: Record<string, { size: string; sha256: string }>;
    };
    expect(manifest.format).toBe('speedyindex-backup-v1');
    expect(manifest.schemaVersion).toBe(1);
    for (const [name, expected] of Object.entries(manifest.files)) {
      const data = readFileSync(join(backup, name));
      expect(String(data.length)).toBe(expected.size);
      expect(createHash('sha256').update(data).digest('hex')).toBe(
        expected.sha256,
      );
    }
    expect(integrationRows(backup, integrationCore)).toEqual(original);
    expect(integrationRows(v1, ['intent_context'])[0]).toEqual(
      ['accepted', 'prepared', 'unknown'].map((status) => ({
        credential_fp: 'a'.repeat(64),
        request_id: `legacy-${status}`,
        origin_kind: 'legacy_unattributed',
        parent_family: null,
        parent_task_id: null,
        source_manifest_digest: null,
        plan_fingerprint: null,
      })),
    );
    for (const directory of [state, v1, backup]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(directory)) {
        const stat = lstatSync(join(directory, name));
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.uid).toBe(process.geteuid!());
        expect(stat.nlink).toBe(1);
      }
    }
    const unused = join(h.root, 'unused-backup');
    expect(await h.local([back, unused, migrate, v1])).toEqual({
      code: 0,
      stdout: '{"migrated":false,"schemaVersion":2,"reason":"AlreadyV2"}\n',
      stderr: '',
    });
    expect(existsSync(unused)).toBe(false);
    const strict = openLedger({ stateDirectory: v1 });
    strict.close();
    const beforeFailure = integrationRows(v1, [
      ...integrationCore,
      'intent_context',
    ]);
    expect(
      await h.local([
        migrate,
        join(h.root, 'missing'),
        back,
        join(h.root, 'no-backup'),
      ]),
    ).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Could not migrate submission state.\n',
    });
    expect(existsSync(join(h.root, 'missing'))).toBe(false);
    expect(existsSync(join(h.root, 'no-backup'))).toBe(false);
    expect(integrationRows(v1, [...integrationCore, 'intent_context'])).toEqual(
      beforeFailure,
    );
    expect(h.posts).toEqual([]);
  });
}

export async function verifyV2CreateJourney(entry: string) {
  await withV2Integration(entry, async (h) => {
    const state = join(h.root, 'state'),
      policy = join(h.root, 'policy.json');
    expect((await h.local(['--init-submission-state-v2', state])).code).toBe(0);
    const fingerprint = createHash('sha256')
      .update(`speedyindex-credential-v1\0${dummyKey}`)
      .digest('hex');
    writeFileSync(
      policy,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'operator_policy',
        policyRevision: 'synthetic-v2',
        budgetScope: 'synthetic-v2',
        credentialFingerprint: fingerprint,
        period: { kind: 'utc_day' },
        caps: { tokens: 1000, indexer: 1000, checker: 1000 },
        allowIndexChecks: true,
        indexCheckReservations: { bing: { tokens: 2, indexer: 3, checker: 4 } },
        allowBacklinkChecks: true,
        backlinkCheckReservations: { tokens: 2, indexer: 5, checker: 6 },
      }),
      { mode: 0o600 },
    );
    const args = ['--submission-policy', policy, '--submission-state', state];
    let session = await h.open(args);
    const jobs = [
      {
        name: 'create_indexing_task',
        schema: createIndexingTaskResultSchema,
        input: {
          searchEngine: 'google',
          urls: ['HTTPS://Synthetic.TEST/%2f?b=2&a=1#Part'],
        },
        body: '{"urls":["HTTPS://Synthetic.TEST/%2f?b=2&a=1#Part"],"pay_per_indexed":true,"drip_feed":false}',
        family: 'google/indexer',
        units: { tokens: 100, indexer: 0, checker: 0 },
      },
      {
        name: 'create_index_check',
        schema: createIndexCheckResultSchema,
        input: {
          searchEngine: 'bing',
          urls: ['https://synthetic.test/check/'],
        },
        body: '{"urls":["https://synthetic.test/check/"]}',
        family: 'bing/checker',
        units: { tokens: 2, indexer: 3, checker: 4 },
      },
      {
        name: 'create_backlink_check',
        schema: createBacklinkCheckResultSchema,
        input: {
          urls: ['https://synthetic.test/donor?keep=%2f'],
          targetDomains: [' Target.TEST ', '例え.テスト', ' Target.TEST '],
        },
        body: '{"urls":["https://synthetic.test/donor?keep=%2f"],"target_domains":[" Target.TEST ","例え.テスト"," Target.TEST "]}',
        family: 'backlink/checker',
        units: { tokens: 2, indexer: 5, checker: 6 },
      },
    ];
    const call = async (
      job: (typeof jobs)[number],
      input: Record<string, unknown>,
    ) => {
      const value = await session.client.callTool({
        name: job.name,
        arguments: input,
      });
      const parsed = job.schema.parse(value.structuredContent);
      expect(value.content).toEqual([
        { type: 'text', text: JSON.stringify(parsed) },
      ]);
      expect(value.isError).toBe(
        !['preview', 'accepted'].includes(parsed.status),
      );
      for (const secret of [dummyKey, fingerprint, h.root])
        expect(JSON.stringify(value)).not.toContain(secret);
      return parsed;
    };
    const accepted = [];
    for (const [i, job] of jobs.entries()) {
      const preview = await call(job, { ...job.input, mode: 'preview' });
      expect(preview.status).toBe('preview');
      expect(preview.authorization?.stateChecked).toBe(false);
      expect(preview.request?.payloadDigest).toBe(
        createHash('sha256').update(job.body).digest('hex'),
      );
      expect(h.posts).toHaveLength(i);
      const result = await call(job, {
        ...job.input,
        mode: 'submit',
        requestId: `v2-${i}`,
      });
      expect(result.status).toBe('accepted');
      expect(result.replayed).toBeUndefined();
      expect(result.intent).toMatchObject({
        state: 'accepted',
        stateVersion: 2,
        providerType: job.family,
        reservation: job.units,
      });
      expect(result.observation).toMatchObject({
        kind: 'accepted_ack',
        recorded: true,
        taskId: ` synthetic local ACK ${i + 1} /? `,
        type: job.family,
      });
      expect(h.posts[i]).toEqual({
        path: `/v2/task/${job.family}/create`,
        body: job.body,
      });
      accepted.push(result.intent);
    }
    expect(session.stderr()).toBe('');
    await session.close();
    const tables = [...integrationCore, 'retry_ledger_meta', 'intent_context'];
    const before = integrationRows(state, tables);
    expect(integrationRows(state, ['intent_context'])[0]).toEqual(
      jobs.map((_, i) => ({
        credential_fp: fingerprint,
        request_id: `v2-${i}`,
        origin_kind: 'standalone',
        parent_family: null,
        parent_task_id: null,
        source_manifest_digest: null,
        plan_fingerprint: null,
      })),
    );
    const db = new Database(
      join(state, 'ledger.sqlite'),
      sqliteConstants.SQLITE_OPEN_READWRITE |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({
        user_version: 2,
      });
      expect(
        db
          .query(
            'SELECT i.request_id,c.origin_kind,i.state,i.reserved_tokens,i.reserved_indexer,i.reserved_checker FROM intents i JOIN intent_context c USING(credential_fp,request_id) ORDER BY i.request_id',
          )
          .all(),
      ).toEqual(
        jobs.map((job, i) => ({
          request_id: `v2-${i}`,
          origin_kind: 'standalone',
          state: 'accepted',
          reserved_tokens: job.units.tokens,
          reserved_indexer: job.units.indexer,
          reserved_checker: job.units.checker,
        })),
      );
      expect(
        db
          .query(
            'SELECT request_id,ordinal,url_text FROM intent_urls ORDER BY request_id,ordinal',
          )
          .all(),
      ).toEqual(
        jobs.flatMap((job, i) =>
          job.input.urls.map((url_text, ordinal) => ({
            request_id: `v2-${i}`,
            ordinal,
            url_text,
          })),
        ),
      );
      expect(
        db
          .query(
            'SELECT request_id,event_kind FROM intent_events ORDER BY event_id',
          )
          .all(),
      ).toEqual(
        jobs.flatMap((_, i) =>
          ['prepared', 'dispatching', 'accepted'].map((event_kind) => ({
            request_id: `v2-${i}`,
            event_kind,
          })),
        ),
      );
    } finally {
      db.close();
    }
    session = await h.open(args);
    for (const [i, job] of jobs.entries()) {
      const replay = await call(job, {
        ...job.input,
        mode: 'submit',
        requestId: `v2-${i}`,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.intent).toEqual(accepted[i]);
      expect(replay.observation).toBeUndefined();
    }
    expect(h.posts).toHaveLength(3);
    expect(integrationRows(state, tables)).toEqual(before);
    const checker = jobs[1]!;
    const heldInput = {
      searchEngine: 'bing',
      urls: ['HTTPS://Synthetic.TEST/held?keep=%2f#片'],
      mode: 'submit',
      requestId: 'v2-held',
    };
    const held = await call(checker, heldInput);
    expect(held.status).toBe('unknown');
    expect(held.intent).toMatchObject({
      state: 'unknown',
      reservation: checker.units,
    });
    expect(held.observation).toMatchObject({
      kind: 'ambiguous',
      cause: 'invalid_ack',
      recorded: true,
    });
    expect(h.posts).toHaveLength(4);
    expect(session.stderr()).toBe('');
    await session.close();
    const heldBefore = integrationRows(state, tables);
    const heldDb = new Database(
      join(state, 'ledger.sqlite'),
      sqliteConstants.SQLITE_OPEN_READWRITE |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      expect(
        heldDb
          .query(
            `SELECT i.request_id,c.origin_kind,i.state,i.reserved_tokens,i.reserved_indexer,i.reserved_checker,u.ordinal,u.url_text
        FROM intents i JOIN intent_context c USING(credential_fp,request_id) JOIN intent_urls u USING(credential_fp,request_id)
        WHERE i.state IN ('prepared','dispatching','unknown') ORDER BY i.request_id,u.ordinal`,
          )
          .all(),
      ).toEqual([
        {
          request_id: 'v2-held',
          origin_kind: 'standalone',
          state: 'unknown',
          reserved_tokens: 2,
          reserved_indexer: 3,
          reserved_checker: 4,
          ordinal: 0,
          url_text: heldInput.urls[0],
        },
      ]);
    } finally {
      heldDb.close();
    }
    session = await h.open(args);
    const heldReplay = await call(checker, heldInput);
    expect(heldReplay.status).toBe('unknown');
    expect(heldReplay.replayed).toBe(true);
    expect(heldReplay.intent).toEqual(held.intent);
    expect(heldReplay.observation).toBeUndefined();
    const overlap = await call(jobs[0]!, {
      searchEngine: 'google',
      urls: heldInput.urls,
      mode: 'submit',
      requestId: 'v2-overlap',
    });
    expect(overlap.error?.code).toBe('UrlOverlap');
    expect(overlap.intent).toBeUndefined();
    expect(h.posts).toHaveLength(4);
    expect(integrationRows(state, tables)).toEqual(heldBefore);
    expect(session.stderr()).toBe('');
    await session.close();
  });
}

export async function verifyUnconfiguredReads(client: Client) {
  for (const call of [
    { name: 'get_balance', arguments: {} },
    {
      name: 'list_tasks',
      arguments: { searchEngine: 'google', taskType: 'indexer', page: 0 },
    },
    {
      name: 'get_task_status',
      arguments: { family: 'google/indexer', taskId: 'synthetic-unconfigured' },
    },
    {
      name: 'get_task_report',
      arguments: { family: 'google/indexer', taskId: 'synthetic-unconfigured' },
    },
  ]) {
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: 'Set SPEEDYINDEX_API_KEY to a nonblank API key.' },
    ]);
  }
}
