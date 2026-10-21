import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import {
  buildCreateIndexingRequest,
  createIndexingTaskResultSchema,
  createIndexingTaskToolResult,
  type CreateIndexingTaskResult,
} from '../src/create-indexing-task';
import {
  createIndexCheckResultSchema,
  createIndexCheckToolResult,
} from '../src/create-index-check';
import {
  createSubmissionContext,
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
  type SubmissionConfiguration,
  type SubmissionPolicy,
} from '../src/submission-policy';
import {
  initializeLedger,
  openLedger,
  type IntentState,
  type PrepareIntentInput,
} from '../src/submission-ledger';
import type { SubmissionHostOptions } from '../src/submission-host';
import identity from './fixtures/indexing-v1-identity.json';
import {
  account,
  bounded,
  connect,
  connectOwnedStdio,
  deferred,
  fixture,
} from './helpers';

function sdkPhases() {
  const messages: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const waiters: {
    event: string;
    operation?: number;
    done: (message: Record<string, unknown>) => void;
  }[] = [];
  let buffer = '';
  return {
    messages,
    errors,
    receive(chunk: string) {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('SUBMISSION_PHASE ')) {
          errors.push('Unexpected SDK fixture stderr.');
          continue;
        }
        try {
          const message = JSON.parse(
            line.slice('SUBMISSION_PHASE '.length),
          ) as Record<string, unknown>;
          messages.push(message);
          if (
            message.event === 'PROTOCOL_ERROR' ||
            message.event === 'FIXTURE_ERROR'
          )
            errors.push('SDK fixture error phase.');
          for (const waiter of waiters)
            if (
              message.event === waiter.event &&
              (waiter.operation === undefined ||
                waiter.operation === message.operation)
            )
              waiter.done(message);
        } catch {
          errors.push('Invalid SDK fixture phase.');
        }
      }
    },
    wait(event: string, operation?: number) {
      const existing = messages.find(
        (m) =>
          m.event === event &&
          (operation === undefined || m.operation === operation),
      );
      if (existing) return Promise.resolve(existing);
      const next = deferred<Record<string, unknown>>();
      waiters.push({
        event,
        ...(operation === undefined ? {} : { operation }),
        done: next.resolve,
      });
      return bounded(next.promise, 8_000);
    },
  };
}

const savedFetch = globalThis.fetch;
const allowedOrigins = new Set<string>();
const networkViolations: string[] = [];
const guardedFetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    !allowedOrigins.has(target.origin) ||
    target.username ||
    target.password ||
    init?.redirect !== 'error'
  ) {
    networkViolations.push('Unexpected network target or redirect policy');
    throw new Error('Test network isolation violation.');
  }
  return savedFetch(input, init);
}) as typeof fetch;
let Host: (typeof import('../src/submission-host'))['SubmissionHost'];
beforeAll(async () => {
  // Guard before even importing the module: default transport capture must not
  // retain an unguarded production fetch. Each test also guards construction.
  globalThis.fetch = guardedFetch;
  try {
    Host = (await import('../src/submission-host')).SubmissionHost;
  } finally {
    globalThis.fetch = savedFetch;
  }
});
beforeEach(() => {
  globalThis.fetch = guardedFetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  allowedOrigins.clear();
  expect(networkViolations.splice(0)).toEqual([]);
});
afterAll(() => {
  globalThis.fetch = savedFetch;
});

const key = 'synthetic-host-key-only';
const fp = submissionCredentialFingerprint(key);
const day1 = Date.parse('2026-10-20T12:00:00Z');
const request = (id = 'request-1', urls = ['https://example.test/one']) =>
  ({ mode: 'submit', searchEngine: 'google', requestId: id, urls }) as const;
const paths = new Set([
  '/v2/task/google/indexer/create',
  '/v2/task/yandex/indexer/create',
  '/v2/task/google/checker/create',
  '/v2/task/yandex/checker/create',
  '/v2/task/bing/checker/create',
]);

type ChildMode =
  | 'normal'
  | 'already_aborted'
  | 'abort_after_prepare'
  | 'stop_after_prepare'
  | 'abort_after_claim'
  | 'stop_after_claim'
  | 'abort_before_record'
  | 'read_fault_after_write_failure';
function spawnHostProcess(home: string) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      resolve('tests/fixtures/submission-host-child.ts'),
    ],
    {
      cwd: process.cwd(),
      env: { HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
type HostProcess = ReturnType<typeof spawnHostProcess>;
interface HostChild {
  process: HostProcess;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  stderr: Promise<string>;
  decoder: TextDecoder;
  buffer: string;
  messages: Record<string, unknown>[];
  operations: Promise<unknown>[];
}
async function childControl(child: HostChild, event: 'GO' | 'CANCEL') {
  child.process.stdin.write(`${JSON.stringify({ event })}\n`);
  await child.process.stdin.flush();
}
async function startHostChild(
  setup: Record<string, unknown>,
  registry: HostProcess[],
  streams: HostChild[],
  home: string,
) {
  const process = spawnHostProcess(home);
  // Register the raw handle before stream setup, serialization, writing or
  // flushing: every startup failure must still leave a reapable owned child.
  registry.push(process);
  const child: HostChild = {
    process,
    reader: process.stdout.getReader(),
    stderr: new Response(process.stderr).text(),
    decoder: new TextDecoder(),
    buffer: '',
    messages: [],
    operations: [],
  };
  streams.push(child);
  process.stdin.write(`${JSON.stringify(setup)}\n`);
  await process.stdin.flush();
  expect(await childEvent(child, 'READY')).toEqual({ event: 'READY' });
  return child;
}
async function childEvent(child: HostChild, event: string) {
  while (true) {
    const end = child.buffer.indexOf('\n');
    if (end < 0) {
      const chunk = await bounded(child.reader.read(), 8_000);
      if (chunk.done) throw new Error('Host child closed before its phase.');
      child.buffer += child.decoder.decode(chunk.value, { stream: true });
      continue;
    }
    const message = JSON.parse(child.buffer.slice(0, end)) as Record<
      string,
      unknown
    >;
    child.buffer = child.buffer.slice(end + 1);
    child.messages.push(message);
    if (message.event === 'ERROR')
      throw new Error('Host child fixture failed.');
    if (message.event === event) return message;
  }
}
function childResult(
  child: HostChild,
  family: 'indexer' | 'checker' = 'indexer',
) {
  const operation = readChildResult(child, family);
  child.operations.push(operation);
  return operation;
}
async function readChildResult(
  child: HostChild,
  family: 'indexer' | 'checker',
) {
  const message = await childEvent(child, 'RESULT');
  expect(await bounded(child.process.exited, 5_000)).toBe(0);
  expect(await bounded(child.stderr)).toBe('');
  expect(message.violations).toBe(0);
  const result =
    family === 'checker'
      ? createIndexCheckResultSchema.parse(message.result)
      : createIndexingTaskResultSchema.parse(message.result);
  expect(result.error?.code).not.toBe('InternalError');
  for (const secret of [key, fp, 'dispatchCapability', 'outcomeToken'])
    expect(JSON.stringify(child.messages).includes(secret)).toBe(false);
  return { result, fetchInvocations: message.fetchInvocations as number };
}
async function killHostChild(child: HostChild) {
  child.process.kill('SIGKILL');
  await bounded(child.process.exited, 5_000);
  expect(child.process.signalCode).toBe('SIGKILL');
  expect(await bounded(child.stderr)).toBe('');
}
function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface Receipt {
  method: string | undefined;
  path: string | undefined;
  auth: string | undefined;
  agent: string | undefined;
  accept: string | undefined;
  contentType: string | undefined;
  body: string;
}
type Handler = (
  receipt: Receipt,
  response: ServerResponse,
  incoming: IncomingMessage,
) => unknown;
async function readBody(incoming: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
function tree(root: string): unknown[] {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      const s = lstatSync(path, { bigint: true });
      return [
        name,
        String(s.ino),
        String(s.mode),
        String(s.size),
        String(s.mtimeNs),
        String(s.ctimeNs),
        s.isDirectory() ? tree(path) : null,
      ];
    });
}

async function withHost(
  operation: (h: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>,
) {
  const h = await makeHarness();
  try {
    await operation(h);
  } finally {
    await h.close();
  }
}
async function makeHarness() {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'speedyindex-host-'));
  chmodSync(root, 0o700);
  const stateDirectory = join(root, 'state');
  const policyPath = join(root, 'policy.json');
  const records: Receipt[] = [];
  const handlerErrors: unknown[] = [];
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  const receivers: Promise<unknown>[] = [];
  const children: HostProcess[] = [];
  const childStreams: HostChild[] = [];
  const locks: (() => void)[] = [];
  const sdkClosers: (() => Promise<void>)[] = [];
  const phaseRecorders: ReturnType<typeof sdkPhases>[] = [];
  const fences: ReturnType<typeof deferred<void>>[] = [];
  const received = deferred<void>();
  let now = day1,
    attempts = 0,
    opens = 0;
  let handler: Handler = (receipt, response) =>
    response.end(
      JSON.stringify({
        code: 0,
        task_id: `provider-${records.length}`,
        type: receipt.path?.includes('/checker/')
          ? receipt.path.slice('/v2/task/'.length, -'/create'.length)
          : receipt.path?.includes('/yandex/')
            ? 'yandex/indexer'
            : 'google/indexer',
      }),
    );
  let api: Awaited<ReturnType<typeof fixture>>;
  try {
    api = await fixture((incoming, response) => {
      const receiving = readBody(incoming)
        .then(async (body) => {
          const record = {
            body,
            method: incoming.method,
            path: incoming.url,
            auth: incoming.headers.authorization,
            agent: incoming.headers['user-agent'],
            accept: incoming.headers.accept,
            contentType: incoming.headers['content-type'],
          };
          records.push(record);
          received.resolve();
          await handler(record, response, incoming);
        })
        .catch((error) => {
          handlerErrors.push(error);
          response.destroy();
        });
      receivers.push(receiving);
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  allowedOrigins.add(api.origin);
  function policy(overrides: Partial<SubmissionPolicy> = {}): SubmissionPolicy {
    return {
      version: 1,
      enabled: true,
      mode: 'operator_policy',
      policyRevision: 'fixture-v1',
      budgetScope: 'fixture-scope',
      credentialFingerprint: fp,
      period: { kind: 'utc_day' },
      caps: { tokens: 2_000_000, indexer: 20_000, checker: 0 },
      ...overrides,
    };
  }
  function config(
    overrides: Partial<SubmissionPolicy> = {},
    apiKey: unknown = key,
  ): SubmissionConfiguration {
    writeFileSync(policyPath, JSON.stringify(policy(overrides)), {
      mode: 0o600,
    });
    return loadSubmissionConfiguration({ policyPath, stateDirectory, apiKey });
  }
  const fetchRequest = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const target = new URL(String(input));
    attempts++;
    if (
      target.origin !== 'https://api.speedyindex.com' ||
      init?.method !== 'POST' ||
      !paths.has(target.pathname) ||
      target.search ||
      target.hash
    ) {
      networkViolations.push('Invalid production create route or method');
      throw new Error('Unexpected create transport request.');
    }
    return fetch(new URL(target.pathname, api.origin), init);
  }) as typeof fetch;
  function host(
    configuration: SubmissionConfiguration = config(),
    options: SubmissionHostOptions = {},
  ) {
    return new Host(configuration, {
      fetchRequest,
      clock: () => now,
      openLedger: (opts) => {
        opens++;
        return openLedger(opts);
      },
      ...options,
    });
  }
  function call(
    instance: InstanceType<typeof Host>,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const cleanup = new AbortController();
    controllers.push(cleanup);
    const result = instance.createIndexingTask(
      input,
      signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal,
    );
    pending.push(result);
    return bounded(result, 5_000).then((value) => {
      expect(createIndexingTaskResultSchema.safeParse(value).success).toBe(
        true,
      );
      expect(value.error?.code).not.toBe('InternalError');
      return value;
    });
  }
  function read(id: string) {
    const ledger = openLedger({ stateDirectory });
    try {
      return ledger.readIntent(fp, id);
    } finally {
      ledger.close();
    }
  }
  function rows<T>(sql: string, ...args: (string | number)[]): T[] {
    const db = new Database(
      join(stateDirectory, 'ledger.sqlite'),
      sqliteConstants.SQLITE_OPEN_READONLY |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      return db.query(sql).all(...args) as T[];
    } finally {
      db.close();
    }
  }
  function seed(
    input: ReturnType<typeof request>,
    state: IntentState,
    configuration: SubmissionConfiguration = config(),
  ) {
    if (configuration.state !== 'configured')
      throw new Error('Bad seed configuration.');
    const built = buildCreateIndexingRequest(input);
    const budget = createSubmissionContext(
      configuration,
      built.quote.fingerprint,
      now,
    ).budget;
    const value: PrepareIntentInput = {
      requestId: input.requestId,
      budget,
      taskFamily: built.request.family,
      providerRoute: built.request.providerRoute,
      payloadDigest: built.request.payloadDigest,
      submittedUrls: built.input.urls,
      quoteVersion: built.quote.version,
      quoteFingerprint: built.quote.fingerprint,
      reservation: built.quote.maximumExposure,
    };
    const ledger = openLedger({ stateDirectory });
    try {
      const made = ledger.prepareIntent(value);
      if (made.kind !== 'created')
        throw new Error('Seed must create a real intent.');
      if (state === 'cancelled') ledger.cancelPrepared(fp, input.requestId, 0);
      else if (state !== 'prepared') {
        const claim = ledger.claimDispatch(made.dispatchCapability, 0);
        if (claim.kind !== 'claimed') throw new Error('Seed claim failed.');
        if (state !== 'dispatching')
          ledger.recordDispatchOutcome({
            credentialFingerprint: fp,
            requestId: input.requestId,
            expectedStateVersion: claim.stateVersion,
            outcomeToken: claim.outcomeToken,
            outcome:
              state === 'accepted'
                ? {
                    kind: 'accepted',
                    providerTaskId: 'seed-provider',
                    providerType: 'google/indexer',
                  }
                : { kind: state },
          });
      }
    } finally {
      ledger.close();
    }
  }
  return {
    root,
    stateDirectory,
    policyPath,
    records,
    received,
    api,
    config,
    policy,
    host,
    call,
    check(
      instance: InstanceType<typeof Host>,
      input: unknown,
      signal?: AbortSignal,
    ) {
      const cleanup = new AbortController();
      controllers.push(cleanup);
      const operation = instance.createIndexCheck(
        input,
        signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal,
      );
      pending.push(operation);
      return bounded(operation, 5_000).then((result) => {
        expect(createIndexCheckResultSchema.safeParse(result).success).toBe(
          true,
        );
        expect(result.error?.code).not.toBe('InternalError');
        const wire = createIndexCheckToolResult(result);
        expect(wire.structuredContent).toEqual(result);
        expect(JSON.parse(wire.content[0]!.text)).toEqual(result);
        expect(wire.isError).toBe(
          result.status !== 'preview' && result.status !== 'accepted',
        );
        return result;
      });
    },
    read,
    rows,
    seed,
    fetchRequest,
    async sdk(
      instrumented = false,
      args = [
        '--submission-policy',
        policyPath,
        '--submission-state',
        stateDirectory,
      ],
    ) {
      const phases = sdkPhases();
      if (instrumented) phaseRecorders.push(phases);
      const register = (close: () => Promise<void>) => sdkClosers.push(close);
      const session = instrumented
        ? await connectOwnedStdio(
            ['tests/fixtures/submission-sdk-child.ts'],
            {
              SPEEDYINDEX_API_KEY: key,
              TEST_ACCOUNT_ORIGIN: api.origin,
              HOME: root,
              TEST_SUBMISSION_POLICY: policyPath,
              TEST_SUBMISSION_STATE: stateDirectory,
              TEST_SUBMISSION_NOW: String(now),
            },
            (child) => children.push(child),
            { onStderr: phases.receive, register },
          )
        : await connect(api.origin, 'src/cli.ts', key, '', { args, register });
      return { ...session, phases };
    },
    track<T>(operation: Promise<T>) {
      pending.push(operation);
      return operation;
    },
    async child(
      input: unknown,
      mode: ChildMode = 'normal',
      operation: 'indexer' | 'checker' = 'indexer',
    ) {
      return startHostChild(
        {
          stateDirectory,
          policyPath,
          apiKey: key,
          origin: api.origin,
          now,
          input,
          mode,
          operation,
        },
        children,
        childStreams,
        root,
      );
    },
    writerLock() {
      const db = new Database(
        join(stateDirectory, 'ledger.sqlite'),
        sqliteConstants.SQLITE_OPEN_READWRITE |
          sqliteConstants.SQLITE_OPEN_NOFOLLOW,
      );
      let closed = false;
      const release = () => {
        if (!closed) {
          try {
            if (db.inTransaction) db.exec('ROLLBACK');
          } finally {
            db.close();
            closed = true;
          }
        }
      };
      locks.push(release);
      db.exec('BEGIN IMMEDIATE');
      return release;
    },
    get attempts() {
      return attempts;
    },
    get opens() {
      return opens;
    },
    set now(value: number) {
      now = value;
    },
    get now() {
      return now;
    },
    set handler(value: Handler) {
      handler = value;
    },
    init() {
      initializeLedger({ stateDirectory }).close();
    },
    fence() {
      const fence = deferred<void>();
      fences.push(fence);
      return fence;
    },
    async close() {
      const errors: unknown[] = [];
      for (const release of locks) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const controller of controllers) controller.abort();
      for (const fence of fences) fence.resolve();
      const sdkClosed = await Promise.allSettled(
        sdkClosers.map((close) => close()),
      );
      for (const result of sdkClosed)
        if (result.status === 'rejected') errors.push(result.reason);
      for (const recorder of phaseRecorders)
        if (recorder.errors.length)
          errors.push(new Error(recorder.errors.join(' ')));
      let settled = false;
      const reaped = await Promise.allSettled(
        children.map(async (child) => {
          // SIGTERM cannot resume a SIGSTOP'ed child. All handles in this
          // registry belong to this fixture, including incomplete startup.
          try {
            if (child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL');
            await bounded(child.exited, 5_000);
          } finally {
            await bounded(Promise.resolve(child.stdin.end()), 5_000);
          }
        }),
      );
      for (const result of reaped)
        if (result.status === 'rejected') errors.push(result.reason);
      const drained = await Promise.allSettled(
        childStreams.map(async (child) => {
          const closed = await Promise.allSettled([
            bounded(child.stderr, 5_000).then((stderr) => {
              if (stderr !== '')
                throw new Error('Host child emitted unexpected stderr.');
            }),
            (async () => {
              try {
                await bounded(child.reader.cancel(), 5_000);
              } finally {
                child.reader.releaseLock();
              }
            })(),
            bounded(Promise.allSettled(child.operations), 5_000),
          ]);
          const failures = closed.filter(
            (result) => result.status === 'rejected',
          );
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              'Host child stream cleanup failed.',
            );
        }),
      );
      for (const result of drained)
        if (result.status === 'rejected') errors.push(result.reason);
      try {
        await bounded(Promise.allSettled([...pending, ...receivers]), 5_000);
        settled = errors.length === 0;
      } catch (error) {
        errors.push(error);
      }
      try {
        await api.close();
      } catch (error) {
        errors.push(error);
      }
      allowedOrigins.delete(api.origin);
      errors.push(...handlerErrors);
      if (settled && errors.length === 0) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          `Test-owned host cleanup or receiver failed; unsettled state preserved at ${root}.`,
        );
    },
  };
}

function ack(preview: CreateIndexingTaskResult) {
  return {
    quoteFingerprint: preview.quote!.fingerprint,
    authorizationFingerprint: preview.authorization!.fingerprint!,
  };
}
function assertNoPrivate(
  value: unknown,
  h: Awaited<ReturnType<typeof makeHarness>>,
) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    key,
    fp,
    h.root,
    'private-provider-error',
    'dispatchCapability',
    'outcomeToken',
  ])
    expect(serialized.includes(secret)).toBe(false);
}

test('C01 HOST: default/disabled/invalid/unbound profiles preview with zero writes and block submit', async () => {
  await withHost(async (h) => {
    const cases: {
      config: SubmissionConfiguration;
      state: NonNullable<CreateIndexingTaskResult['authorization']>['state'];
      error: NonNullable<CreateIndexingTaskResult['error']>['code'];
    }[] = [
      {
        config: loadSubmissionConfiguration(),
        state: 'unconfigured',
        error: 'WritesDisabled',
      },
      {
        config: h.config({ enabled: false }),
        state: 'disabled',
        error: 'WritesDisabled',
      },
      {
        config: loadSubmissionConfiguration({ policyPath: h.policyPath }),
        state: 'invalid',
        error: 'InvalidPolicy',
      },
      {
        config: h.config({}, null),
        state: 'credential_missing',
        error: 'MissingCredentials',
      },
      {
        config: h.config({}, 'other-fixture-key'),
        state: 'credential_mismatch',
        error: 'CredentialMismatch',
      },
    ];
    h.config();
    cases.push({
      config: loadSubmissionConfiguration({
        policyPath: h.policyPath,
        stateDirectory: h.stateDirectory,
      }),
      state: 'credential_missing',
      error: 'MissingCredentials',
    });
    for (const raw of [
      '{',
      ' '.repeat(16_385),
      JSON.stringify({ ...h.policy(), caps: { tokens: 100 } }),
      JSON.stringify({
        ...h.policy(),
        caps: { tokens: -1, indexer: 0, checker: 0 },
      }),
    ]) {
      writeFileSync(h.policyPath, raw);
      cases.push({
        config: loadSubmissionConfiguration({
          policyPath: h.policyPath,
          stateDirectory: h.stateDirectory,
          apiKey: key,
        }),
        state: 'invalid',
        error: 'InvalidPolicy',
      });
    }
    rmSync(h.policyPath);
    cases.push({
      config: loadSubmissionConfiguration({
        policyPath: h.policyPath,
        stateDirectory: h.stateDirectory,
        apiKey: key,
      }),
      state: 'invalid',
      error: 'InvalidPolicy',
    });
    const before = tree(h.root);
    for (const item of cases) {
      const instance = h.host(item.config);
      const preview = await h.call(instance, {
        mode: 'preview',
        searchEngine: 'google',
        urls: request().urls,
      });
      expect(preview.status).toBe('preview');
      expect(preview.authorization).toEqual({
        state: item.state,
        stateChecked: false,
      });
      expect(preview.quote!.maximumExposure).toEqual({
        tokens: 100,
        indexer: 0,
        checker: 0,
      });
      const result = await h.call(instance, request());
      expect(result.status).toBe('blocked');
      expect(result.error?.code).toBe(item.error);
      assertNoPrivate(result, h);
    }
    const defaultHost = new Host();
    expect((await h.call(defaultHost, request())).error?.code).toBe(
      'WritesDisabled',
    );
    expect(tree(h.root)).toEqual(before);
    expect(h.opens).toBe(0);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
    expect(existsSync(h.stateDirectory)).toBe(false);
  });
});

test('C01 HOST: configured preview never opens state and missing/invalid state never auto-initializes', async () => {
  await withHost(async (h) => {
    const config = h.config();
    const instance = h.host(config);
    const before = tree(h.root);
    const preview = await h.call(instance, {
      mode: 'preview',
      searchEngine: 'google',
      urls: request().urls,
    });
    expect(preview.authorization?.state).toBe('configured');
    expect(preview.authorization?.stateChecked).toBe(false);
    expect(tree(h.root)).toEqual(before);
    expect(h.opens).toBe(0);
    expect((await h.call(instance, request())).error?.code).toBe(
      'StateUnavailable',
    );
    expect(existsSync(h.stateDirectory)).toBe(false);
    const sentinel = 'synthetic private state sentinel';
    writeFileSync(h.stateDirectory, sentinel, { mode: 0o600 });
    expect(
      (
        await h.call(instance, {
          mode: 'preview',
          searchEngine: 'google',
          urls: request().urls,
        })
      ).status,
    ).toBe('preview');
    expect((await h.call(instance, request())).error?.code).toBe(
      'StateUnavailable',
    );
    expect(readFileSync(h.stateDirectory, 'utf8')).toBe(sentinel);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
  });
});

const preservedUrls = [
  'HTTPS://Example.TEST/%2f?b=2&a=1#fragment',
  'https://example.test/白🦊/',
];
test.each([
  {
    label: 'Google non-drip',
    searchEngine: 'google',
    urls: preservedUrls,
    exposure: { tokens: 200, indexer: 0, checker: 0 },
    body: '{"title":"  白い title  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"],"pay_per_indexed":true,"drip_feed":false}',
  },
  {
    label: 'Google drip',
    searchEngine: 'google',
    urls: [...preservedUrls, 'http://example.test/end'],
    dripFeedDays: 2,
    exposure: { tokens: 300, indexer: 0, checker: 0 },
    body: '{"title":"  白い title  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/","http://example.test/end"],"pay_per_indexed":true,"drip_feed":true,"drip_feed_days":2}',
  },
  {
    label: 'Yandex',
    searchEngine: 'yandex',
    urls: preservedUrls,
    exposure: { tokens: 40, indexer: 2, checker: 0 },
    body: '{"title":"  白い title  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"]}',
  },
])(
  'C02 HOST: $label has exact real wire bytes and committed independent reservations',
  async (vector) => {
    await withHost(async (h) => {
      h.init();
      const instance = h.host(h.config({}, ' \t' + key + '\n '));
      const input = {
        ...request(),
        searchEngine: vector.searchEngine,
        urls: vector.urls,
        title: '  白い title  ',
        ...('dripFeedDays' in vector
          ? { dripFeedDays: vector.dripFeedDays }
          : {}),
      };
      const result = await h.call(instance, input);
      expect(result.status).toBe('accepted');
      expect(result.observation?.recorded).toBe(true);
      expect(h.records).toEqual([
        {
          method: 'POST',
          path: `/v2/task/${vector.searchEngine}/indexer/create`,
          auth: key,
          accept: 'application/json',
          contentType: 'application/json',
          agent: 'speedyindex-mcp/0.1.0',
          body: vector.body,
        },
      ]);
      expect(result.request?.payloadDigest).toBe(sha(vector.body));
      expect(result.request?.providerBodyBytes).toBe(
        Buffer.byteLength(vector.body, 'utf8'),
      );
      expect(result.quote?.maximumExposure).toEqual(vector.exposure);
      expect(h.read('request-1')?.reservation).toEqual(vector.exposure);
      expect(h.read('request-1')?.payloadDigest).toBe(sha(vector.body));
      expect(
        h
          .rows<{ url_text: string }>(
            'SELECT url_text FROM intent_urls ORDER BY ordinal',
          )
          .map((row) => row.url_text),
      ).toEqual([...vector.urls]);
      expect(
        h
          .rows<{ event_kind: string }>(
            'SELECT event_kind FROM intent_events ORDER BY state_version',
          )
          .map((row) => row.event_kind),
      ).toEqual(['prepared', 'dispatching', 'accepted']);
      expect(h.attempts).toBe(1);
      assertNoPrivate(result, h);
    });
  },
);

test('C03 HOST: representative invalid inputs create no intent or request', async () => {
  await withHost(async (h) => {
    h.init();
    const instance = h.host();
    const large = Array.from({ length: 256 }, (_, n) => {
      const prefix = `https://example.test/${n}/`;
      return prefix + 'a'.repeat(8_192 - prefix.length);
    });
    const oversizedWire =
      '{"title":"' +
      'a'.repeat(1_024) +
      '","urls":[' +
      large.map((url) => JSON.stringify(url)).join(',') +
      '],"pay_per_indexed":true,"drip_feed":false}';
    expect(Buffer.byteLength(oversizedWire, 'utf8')).toBeGreaterThan(2_097_152);
    const bad: unknown[] = [
      { ...request(), urls: [] },
      {
        ...request(),
        urls: Array.from(
          { length: 10_001 },
          (_, n) => `https://example.test/${n}`,
        ),
      },
      {
        ...request(),
        urls: ['https://example.test/same', 'https://example.test/same'],
      },
      { ...request(), urls: ['https://user@example.test/'] },
      { ...request(), title: 'a'.repeat(1_025) },
      { ...request(), urls: large, title: 'a'.repeat(1_024) },
      { ...request(), dripFeedDays: 2 },
      { ...request(), caps: { tokens: 100 } },
    ];
    for (const input of bad) {
      const result = await h.call(instance, input);
      expect(result.status).toBe('blocked');
      expect(result.error?.code).toBe('InvalidInput');
      expect(result.request).toBeUndefined();
      expect(result.authorization).toBeUndefined();
    }
    expect(h.rows('SELECT * FROM intents')).toHaveLength(0);
    expect(h.opens).toBe(0);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
  });
});

test('C03 HOST: the 10,000th URL reaches actual HTTP and SQLite without truncation', async () => {
  await withHost(async (h) => {
    h.init();
    const urls = Array.from(
      { length: 10_000 },
      (_, n) => `https://example.test/${n}`,
    );
    const result = await h.call(h.host(), request('maximum-count', urls));
    expect(result.status).toBe('accepted');
    expect(result.quote?.maximumExposure).toEqual({
      tokens: 1_000_000,
      indexer: 0,
      checker: 0,
    });
    expect((JSON.parse(h.records[0]!.body) as { urls: string[] }).urls).toEqual(
      urls,
    );
    expect(
      h
        .rows<{ url_text: string }>(
          'SELECT url_text FROM intent_urls ORDER BY ordinal',
        )
        .map((r) => r.url_text),
    ).toEqual(urls);
    expect(h.records).toHaveLength(1);
    expect(h.attempts).toBe(1);
  });
});

test('C03 HOST: inclusive 2 MiB exact body is received and bound to the durable digest', async () => {
  await withHost(async (h) => {
    h.init();
    const urls = Array.from({ length: 256 }, (_, n) => {
      const prefix = `https://example.test/${n}/`;
      return prefix + 'a'.repeat(8_192 - prefix.length);
    });
    const wire = () =>
      '{"urls":[' +
      urls.map((u) => JSON.stringify(u)).join(',') +
      '],"pay_per_indexed":true,"drip_feed":false}';
    const excess = Buffer.byteLength(wire(), 'utf8') - 2_097_152;
    urls[255] = urls[255]!.slice(0, -excess);
    const expected = wire();
    expect(Buffer.byteLength(expected, 'utf8')).toBe(2_097_152);
    const result = await h.call(h.host(), request('maximum-body', urls));
    expect(result.status).toBe('accepted');
    expect(h.records[0]?.body).toBe(expected);
    expect(result.request?.payloadDigest).toBe(sha(expected));
    expect(h.read('maximum-body')?.payloadDigest).toBe(sha(expected));
    expect(
      h
        .rows<{ url_text: string }>(
          'SELECT url_text FROM intent_urls ORDER BY ordinal',
        )
        .map((r) => r.url_text),
    ).toEqual(urls);
    expect(h.attempts).toBe(1);
  });
});

test('C04 HOST: caller acknowledgement binds trusted quote/policy/key and optional operator ack is checked', async () => {
  await withHost(async (h) => {
    h.init();
    const instance = h.host(h.config({ mode: 'caller_acknowledgement' }));
    const preview = await h.call(instance, {
      mode: 'preview',
      searchEngine: 'google',
      urls: request().urls,
    });
    const acknowledgement = ack(preview);
    expect((await h.call(instance, request())).error?.code).toBe(
      'AcknowledgementRequired',
    );
    for (const changed of [
      { ...acknowledgement, quoteFingerprint: 'a'.repeat(64) },
      { ...acknowledgement, authorizationFingerprint: 'b'.repeat(64) },
    ])
      expect(
        (await h.call(instance, { ...request(), acknowledgement: changed }))
          .error?.code,
      ).toBe('AcknowledgementMismatch');
    const revised = h.host(
      h.config({
        mode: 'caller_acknowledgement',
        policyRevision: 'fixture-v2',
        caps: { tokens: 1_999_999, indexer: 20_000, checker: 0 },
      }),
    );
    expect(
      (await h.call(revised, { ...request(), acknowledgement })).error?.code,
    ).toBe('AcknowledgementMismatch');
    expect(h.rows('SELECT * FROM intents')).toHaveLength(0);
    expect(h.records).toHaveLength(0);
    const accepted = await h.call(instance, { ...request(), acknowledgement });
    expect(accepted.status).toBe('accepted');
    assertNoPrivate(accepted, h);
    const operator = h.host(h.config());
    expect(
      (
        await h.call(
          operator,
          request('operator', ['https://example.test/operator']),
        )
      ).status,
    ).toBe('accepted');
    expect(
      (
        await h.call(operator, {
          ...request('operator-bad', ['https://example.test/bad']),
          acknowledgement,
        })
      ).error?.code,
    ).toBe('AcknowledgementMismatch');
    for (const authority of [
      { caps: { tokens: 1 } },
      { budgetScope: 'override' },
      { period: 'reset' },
      { stateDirectory: h.stateDirectory },
      { mode: 'operator_policy' },
    ])
      expect(
        (await h.call(operator, { ...request('authority'), ...authority }))
          .error?.code,
      ).toBe('InvalidInput');
    expect(h.attempts).toBe(2);
    expect(h.records).toHaveLength(2);
  });
});

test('C05 HOST: real unknown holds survive day/cap changes while old accepted exposure rolls over', async () => {
  await withHost(async (h) => {
    h.init();
    const caps = { tokens: 200, indexer: 0, checker: 0 };
    const config = h.config({ caps });
    const instance = h.host(config);
    h.handler = (record, response) =>
      response.end(
        JSON.stringify(
          record.body.includes('/unknown')
            ? { code: 3 }
            : { code: 0, task_id: 'accepted-id', type: 'google/indexer' },
        ),
      );
    expect(
      (
        await h.call(
          instance,
          request('unknown', ['https://example.test/unknown']),
        )
      ).status,
    ).toBe('unknown');
    expect(
      (
        await h.call(
          instance,
          request('accepted-before', ['https://example.test/before']),
        )
      ).status,
    ).toBe('accepted');
    h.now = Date.parse('2026-10-21T00:00:00Z');
    expect(
      (
        await h.call(
          instance,
          request('accepted-after', ['https://example.test/after']),
        )
      ).status,
    ).toBe('accepted');
    expect(
      (
        await h.call(
          instance,
          request('too-much', ['https://example.test/more']),
        )
      ).error?.code,
    ).toBe('BudgetExceeded');
    const revised = h.host(
      h.config({
        policyRevision: 'fixture-v2',
        caps: { tokens: 150, indexer: 0, checker: 0 },
      }),
    );
    expect(
      (
        await h.call(
          revised,
          request('revised', ['https://example.test/revised']),
        )
      ).error?.code,
    ).toBe('BudgetExceeded');
    h.now = day1;
    expect(
      (
        await h.call(
          instance,
          request('rollback', ['https://example.test/rollback']),
        )
      ).error?.code,
    ).toBe('StalePeriodContext');
    expect(h.read('unknown')?.state).toBe('unknown');
    expect(h.read('unknown')?.periodId).toBe('utc-day:2026-10-20');
    expect(h.read('accepted-after')?.periodId).toBe('utc-day:2026-10-21');
    expect(h.attempts).toBe(3);
    expect(h.records).toHaveLength(3);
  });
});

test('C05 HOST: expired preview cannot create a new-period intent; core-seeded unresolved exposure remains held', async () => {
  await withHost(async (h) => {
    h.init();
    const caller = h.host(h.config({ mode: 'caller_acknowledgement' }));
    const preview = await h.call(caller, {
      mode: 'preview',
      searchEngine: 'google',
      urls: request().urls,
    });
    h.now = Date.parse('2026-10-21T00:00:00Z');
    expect(
      (await h.call(caller, { ...request(), acknowledgement: ack(preview) }))
        .error?.code,
    ).toBe('AcknowledgementMismatch');
    h.now = day1;
    const config = h.config({ caps: { tokens: 250, indexer: 0, checker: 0 } });
    h.seed(
      request('seed-prepared', ['https://example.test/prepared']),
      'prepared',
      config,
    );
    h.seed(
      request('seed-dispatching', ['https://example.test/dispatching']),
      'dispatching',
      config,
    );
    h.now = Date.parse('2026-10-21T00:00:00Z');
    expect(
      (
        await h.call(
          h.host(config),
          request('next-day', ['https://example.test/next']),
        )
      ).error?.code,
    ).toBe('BudgetExceeded');
    expect(h.read('seed-prepared')?.state).toBe('prepared');
    expect(h.read('seed-dispatching')?.state).toBe('dispatching');
    expect(h.records).toHaveLength(0);
    expect(h.attempts).toBe(0);
  });
});

test('IC01 HOST: literal V1 accepted and held identities reopen and replay without new authority', async () => {
  await withHost(async (h) => {
    const policy = JSON.parse(identity.policyCanonical) as SubmissionPolicy;
    const config = h.config(policy, identity.syntheticKey);
    if (config.state !== 'configured')
      throw new Error('Expected legacy configuration.');
    expect(JSON.stringify(config.snapshot.policy)).toBe(
      identity.policyCanonical,
    );
    expect(config.snapshot.digest).toBe(identity.policyDigest);
    expect(config.credential.fingerprint).toBe(identity.credentialFingerprint);
    expect(
      createHash('sha256')
        .update('speedyindex-submission-policy-v1\0' + identity.policyCanonical)
        .digest('hex'),
    ).toBe(identity.policyDigest);
    h.init();
    const ledger = openLedger({ stateDirectory: h.stateDirectory });
    try {
      for (const vector of identity.vectors) {
        const quote = JSON.parse(vector.quoteCanonical);
        const auth = JSON.parse(vector.authorizationCanonical);
        const context = createSubmissionContext(
          config,
          vector.quoteFingerprint,
          identity.nowMs,
        );
        expect(context.authorization.fingerprint).toBe(
          vector.authorizationFingerprint,
        );
        expect(
          createHash('sha256')
            .update(
              'speedyindex-submission-authorization-v1\0' +
                vector.authorizationCanonical,
            )
            .digest('hex'),
        ).toBe(vector.authorizationFingerprint);
        expect(
          JSON.stringify({
            quoteFingerprint: vector.quoteFingerprint,
            policyDigest: context.budget.policyDigest,
            credentialFingerprint: context.budget.credentialFingerprint,
            budgetScope: context.budget.budgetScope,
            periodId: context.budget.periodId,
            periodStartMs: context.budget.periodStartMs,
          }),
        ).toBe(vector.authorizationCanonical);
        // Identity inputs come from portable literals, never the current builder.
        const made = ledger.prepareIntent({
          requestId: vector.input.requestId,
          budget: {
            credentialFingerprint: auth.credentialFingerprint,
            budgetScope: auth.budgetScope,
            periodId: auth.periodId,
            periodStartMs: auth.periodStartMs,
            policyRevision: policy.policyRevision,
            policyDigest: identity.policyDigest,
            caps: policy.caps,
          },
          taskFamily: quote.family,
          providerRoute: quote.providerRoute,
          payloadDigest: vector.payloadDigest,
          submittedUrls: vector.input.urls,
          quoteVersion: quote.version,
          quoteFingerprint: vector.quoteFingerprint,
          reservation: quote.maximumExposure,
        });
        if (made.kind !== 'created')
          throw new Error('Expected a new literal intent.');
        const claim = ledger.claimDispatch(made.dispatchCapability, 0);
        if (claim.kind !== 'claimed')
          throw new Error('Expected literal dispatch claim.');
        ledger.recordDispatchOutcome({
          credentialFingerprint: identity.credentialFingerprint,
          requestId: vector.input.requestId,
          expectedStateVersion: claim.stateVersion,
          outcomeToken: claim.outcomeToken,
          outcome:
            vector.storedState === 'accepted'
              ? {
                  kind: 'accepted',
                  providerTaskId: vector.providerTaskId!,
                  providerType: quote.family,
                }
              : { kind: 'unknown' },
        });
      }
    } finally {
      ledger.close();
    }
    const tables = [
      'budget_periods',
      'intents',
      'intent_urls',
      'intent_events',
    ];
    const snapshot = () =>
      tables.map((table) => h.rows(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = snapshot();
    let replays = 0,
      claims = 0,
      records = 0,
      cancels = 0;
    h.now = identity.replayNowMs;
    const instance = h.host(h.config(policy, identity.syntheticKey), {
      openLedger(options) {
        const reopened = openLedger(options);
        return {
          prepareIntent(input) {
            const result = reopened.prepareIntent(input);
            expect(result.kind).toBe('replay');
            expect('dispatchCapability' in result).toBe(false);
            replays++;
            return result;
          },
          claimDispatch(...args) {
            claims++;
            return reopened.claimDispatch(...args);
          },
          recordDispatchOutcome(input) {
            records++;
            return reopened.recordDispatchOutcome(input);
          },
          cancelPrepared(...args) {
            cancels++;
            return reopened.cancelPrepared(...args);
          },
          readIntent: reopened.readIntent.bind(reopened),
          close: reopened.close.bind(reopened),
        };
      },
    });
    for (const vector of identity.vectors) {
      for (const acknowledgement of [
        undefined,
        {
          quoteFingerprint: vector.quoteFingerprint,
          authorizationFingerprint: vector.authorizationFingerprint,
        },
      ]) {
        const result = await h.call(instance, {
          ...vector.input,
          ...(acknowledgement ? { acknowledgement } : {}),
        });
        expect(String(result.status)).toBe(vector.storedState);
        expect(result.replayed).toBe(true);
        expect(result.quote?.fingerprint).toBe(vector.quoteFingerprint);
        expect(result.authorization?.fingerprint).not.toBe(
          vector.authorizationFingerprint,
        );
        expect(result.intent?.periodId).toBe('utc-day:2026-10-20');
        expect(result.intent?.periodStartMs).toBe(1_792_454_400_000);
        expect(result.intent?.policyDigest).toBe(identity.policyDigest);
        expect(result.intent?.reservation).toEqual(
          JSON.parse(vector.quoteCanonical).maximumExposure,
        );
        if (vector.storedState === 'accepted')
          expect(result.intent?.providerTaskId).toBe(vector.providerTaskId!);
        expect(result.observation).toBeUndefined();
        assertNoPrivate(result, h);
      }
    }
    expect(replays).toBe(4);
    expect([claims, records, cancels]).toEqual([0, 0, 0]);
    expect(snapshot()).toEqual(before);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
  });
});

test('C06 HOST: all durable states replay across midnight without ack, events, capability or POST', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config({ mode: 'caller_acknowledgement' });
    const instance = h.host(config);
    for (const state of [
      'accepted',
      'rejected',
      'unknown',
      'prepared',
      'dispatching',
      'cancelled',
    ] as const) {
      // Supporting fixtures delegate every transition to the real accepted core;
      // crash/cancellation mechanics are mandatory in the next process chunk.
      h.seed(
        request(`seed-${state}`, [`https://example.test/${state}`]),
        state,
        config,
      );
    }
    const before = h.rows(
      'SELECT * FROM intent_events ORDER BY credential_fp, request_id, state_version',
    );
    h.now = Date.parse('2026-10-21T00:00:00Z');
    for (const state of [
      'accepted',
      'rejected',
      'unknown',
      'prepared',
      'dispatching',
      'cancelled',
    ] as const) {
      const result = await h.call(
        instance,
        request(`seed-${state}`, [`https://example.test/${state}`]),
      );
      expect(result.replayed).toBe(true);
      expect(result.status).toBe(state);
      expect(result.intent?.periodId).toBe('utc-day:2026-10-20');
      expect(result.observation).toBeUndefined();
      expect(createIndexingTaskToolResult(result).isError).toBe(
        state !== 'accepted',
      );
      assertNoPrivate(result, h);
    }
    expect(
      h.rows(
        'SELECT * FROM intent_events ORDER BY credential_fp, request_id, state_version',
      ),
    ).toEqual(before);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
  });
});

test('C06 HOST: immutable body/policy conflicts never dispatch; deliberate new accepted IDs may create', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config();
    const instance = h.host(config);
    const original = request('immutable', preservedUrls);
    expect((await h.call(instance, original)).status).toBe('accepted');
    for (const changed of [
      { ...original, title: '' },
      { ...original, urls: [...preservedUrls].reverse() },
      {
        ...original,
        urls: [preservedUrls[0]!.replace('%2f', '%2F'), preservedUrls[1]!],
      },
      { ...original, searchEngine: 'yandex' },
      { ...original, dripFeedDays: 2 },
    ])
      expect((await h.call(instance, changed)).error?.code).toBe(
        'RequestIdConflict',
      );
    for (const overrides of [
      { policyRevision: 'fixture-v2' },
      { budgetScope: 'new-scope' },
      { caps: { tokens: 1_999_999, indexer: 20_000, checker: 0 } },
    ])
      expect(
        (await h.call(h.host(h.config(overrides)), original)).error?.code,
      ).toBe('RequestIdConflict');
    expect(h.attempts).toBe(1);
    expect(
      (await h.call(instance, { ...original, requestId: 'deliberate-new-id' }))
        .status,
    ).toBe('accepted');
    expect(h.attempts).toBe(2);
    expect(h.records).toHaveLength(2);
  });
});

test('C06 HOST: held exact URLs span scopes; distinct spellings and released terminal holds are deliberate new work', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config();
    const instance = h.host(config);
    h.seed(request('held', ['https://example.test/%2f']), 'unknown', config);
    expect(
      (await h.call(instance, request('overlap', ['https://example.test/%2f'])))
        .error?.code,
    ).toBe('UrlOverlap');
    expect(
      (
        await h.call(
          h.host(h.config({ budgetScope: 'other-scope' })),
          request('other-overlap', ['https://example.test/%2f']),
        )
      ).error?.code,
    ).toBe('UrlOverlap');
    expect(
      (
        await h.call(
          instance,
          request('different-spelling', ['https://example.test/%2F']),
        )
      ).status,
    ).toBe('accepted');
    for (const state of ['rejected', 'cancelled'] as const) {
      const url = `https://example.test/released-${state}`;
      h.seed(request(`seed-${state}`, [url]), state, config);
      expect(
        (await h.call(instance, request(`new-${state}`, [url]))).status,
      ).toBe('accepted');
    }
    expect(h.attempts).toBe(3);
    expect(h.records).toHaveLength(3);
  });
});

test('C06 HOST: an actual core-seeded checker hold participates even when the new checker quote is zero', async () => {
  await withHost(async (h) => {
    h.init();
    const initial = h.config({
      caps: { tokens: 1_000, indexer: 100, checker: 3 },
    });
    if (initial.state !== 'configured') throw new Error('Bad fixture profile.');
    const budget = createSubmissionContext(
      initial,
      'c'.repeat(64),
      h.now,
    ).budget;
    const ledger = openLedger({ stateDirectory: h.stateDirectory });
    try {
      ledger.prepareIntent({
        requestId: 'checker-support-fixture',
        budget,
        taskFamily: 'google/checker',
        providerRoute: '/v2/task/google/checker/create',
        payloadDigest: sha('checker-fixture'),
        submittedUrls: ['https://example.test/checker'],
        quoteVersion: 'checker-support-fixture',
        quoteFingerprint: 'c'.repeat(64),
        reservation: { tokens: 0, indexer: 0, checker: 3 },
      });
    } finally {
      ledger.close();
    }
    const low = await h.call(
      h.host(h.config({ caps: { tokens: 1_000, indexer: 100, checker: 2 } })),
      request(),
    );
    expect(low.error?.code).toBe('BudgetExceeded');
    expect(low.error?.unit).toBe('checker');
    expect(h.attempts).toBe(0);
    expect((await h.call(h.host(initial), request())).status).toBe('accepted');
    expect(h.attempts).toBe(1);
  });
});

test('C06 HOST: one new in-flight guard permits durable replay and releases after settlement', async () => {
  await withHost(async (h) => {
    h.init();
    const fence = h.fence();
    h.handler = async (_record, response) => {
      await fence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'guard-job',
          type: 'google/indexer',
        }),
      );
    };
    const instance = h.host();
    const first = h.call(instance, request());
    await bounded(h.received.promise);
    expect(
      (await h.call(instance, request('busy', ['https://example.test/busy'])))
        .error?.code,
    ).toBe('SubmissionBusy');
    const replay = await h.call(instance, request());
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('dispatching');
    expect(h.attempts).toBe(1);
    expect(h.records).toHaveLength(1);
    fence.resolve();
    expect((await first).status).toBe('accepted');
    expect(
      (await h.call(instance, request('after', ['https://example.test/after'])))
        .status,
    ).toBe('accepted');
    expect(h.attempts).toBe(2);
  });
});

test.each([
  {
    label: 'root family',
    value: { code: 0, task_id: 'job', type: 'yandex/indexer' },
  },
  {
    label: 'nested legacy ACK',
    value: { code: 0, result: { task_id: 'job', type: 'google/indexer' } },
  },
  {
    label: 'code type',
    value: { code: '0', task_id: 'job', type: 'google/indexer' },
  },
  {
    label: 'PPR false',
    value: {
      code: 0,
      task_id: 'job',
      type: 'google/indexer',
      pay_per_indexed: false,
    },
  },
  {
    label: 'drip contradiction',
    value: {
      code: 0,
      task_id: 'job',
      type: 'google/indexer',
      drip_feed_days: 2,
    },
  },
  {
    label: 'null echo',
    value: { code: 0, task_id: 'job', type: 'google/indexer', drip_feed: null },
  },
  {
    label: 'oversized ID',
    value: {
      code: 0,
      task_id: 'é'.repeat(2_048) + 'a',
      type: 'google/indexer',
    },
  },
])(
  'C08 HOST: malformed apparent success ($label) persists unknown and keeps URL held',
  async ({ value }) => {
    await withHost(async (h) => {
      h.init();
      h.handler = (_r, response) => response.end(JSON.stringify(value));
      const instance = h.host();
      const result = await h.call(instance, request());
      expect(result.status).toBe('unknown');
      expect(result.observation).toEqual({
        kind: 'ambiguous',
        recorded: true,
        cause: 'invalid_ack',
      });
      expect(h.read('request-1')?.state).toBe('unknown');
      expect((await h.call(instance, request('overlap'))).error?.code).toBe(
        'UrlOverlap',
      );
      expect(h.records).toHaveLength(1);
      expect(h.attempts).toBe(1);
    });
  },
);

test('C08 HOST: opaque 4,096-byte ID and consistent echoes persist exactly; unknown fields disappear', async () => {
  await withHost(async (h) => {
    h.init();
    const id = ' ' + 'é'.repeat(2_047) + 'a';
    expect(Buffer.byteLength(id, 'utf8')).toBe(4_096);
    h.handler = (_r, response) =>
      response.end(
        JSON.stringify({
          code: 0,
          task_id: id,
          type: 'google/indexer',
          pay_per_indexed: true,
          drip_feed: false,
          unknown: 'private-provider-error',
          message: key,
        }),
      );
    const result = await h.call(h.host(), request());
    expect(result.status).toBe('accepted');
    expect(result.intent?.providerTaskId).toBe(id);
    expect(h.read('request-1')?.providerTaskId).toBe(id);
    expect(result.observation).toEqual({
      kind: 'accepted_ack',
      recorded: true,
      taskId: id,
      type: 'google/indexer',
    });
    assertNoPrivate(result, h);
  });
});

test.each([65_536, 65_537])(
  'C08 HOST: actual chunked response bound is inclusive at %i bytes',
  async (bytes) => {
    await withHost(async (h) => {
      h.init();
      const base =
        '{"code":0,"task_id":"cap-job","type":"google/indexer","padding":""}';
      const body =
        base.slice(0, -2) +
        'a'.repeat(bytes - Buffer.byteLength(base, 'utf8')) +
        '"}';
      expect(Buffer.byteLength(body, 'utf8')).toBe(bytes);
      h.handler = (_r, response) => {
        response.write(body.slice(0, 20_000));
        response.end(body.slice(20_000));
      };
      const result = await h.call(h.host(), request());
      expect(result.status).toBe(bytes === 65_536 ? 'accepted' : 'unknown');
      expect(h.read('request-1')?.state).toBe(result.status as IntentState);
      expect(JSON.stringify(result).includes('padding')).toBe(false);
      expect(h.records).toHaveLength(1);
    });
  },
);

test.each([
  {
    label: 'fatal UTF8',
    body: Buffer.concat([
      Buffer.from('{"code":0,"task_id":"'),
      Buffer.from([0xff]),
      Buffer.from('","type":"google/indexer"}'),
    ]),
  },
  { label: 'truncated JSON', body: Buffer.from('{"code":0,"task_id":"job"') },
])('C08 HOST: $label after real receipt stays unknown', async ({ body }) => {
  await withHost(async (h) => {
    h.init();
    h.handler = (_r, response) => {
      response.write(body.subarray(0, 5));
      response.end(body.subarray(5));
    };
    const result = await h.call(h.host(), request());
    expect(result.status).toBe('unknown');
    expect(result.observation).toEqual({
      kind: 'ambiguous',
      recorded: true,
      cause: 'invalid_ack',
    });
    expect(h.read('request-1')?.state).toBe('unknown');
    expect(h.attempts).toBe(1);
    expect(h.records).toHaveLength(1);
  });
});

test.each([
  { status: 200, value: { code: 1 }, expected: 'rejected' },
  { status: 401, value: { code: 2 }, expected: 'rejected' },
  { status: 402, value: { code: 1 }, expected: 'rejected' },
  { status: 413, value: { code: 2 }, expected: 'rejected' },
  { status: 200, value: { code: 1, task_id: null }, expected: 'unknown' },
  { status: 200, value: { code: 3 }, expected: 'unknown' },
  { status: 400, value: { code: 1 }, expected: 'unknown' },
  { status: 429, value: { code: 3 }, expected: 'unknown' },
  {
    status: 503,
    value: { code: 0, task_id: 'job', type: 'google/indexer' },
    expected: 'unknown',
  },
])(
  'C09 HOST: HTTP $status code $value.code classifies as $expected without resend',
  async ({ status, value, expected }) => {
    await withHost(async (h) => {
      h.init();
      h.handler = (_r, response) => {
        response.statusCode = status;
        response.end(
          JSON.stringify({ ...value, message: 'private-provider-error' }),
        );
      };
      const instance = h.host();
      const result = await h.call(instance, request());
      expect(result.status).toBe(expected as IntentState);
      expect(h.read('request-1')?.state).toBe(expected as IntentState);
      expect((await h.call(h.host(), request())).replayed).toBe(true);
      if (expected === 'unknown')
        expect((await h.call(instance, request('overlap'))).error?.code).toBe(
          'UrlOverlap',
        );
      else {
        h.handler = (_r, response) =>
          response.end(
            JSON.stringify({
              code: 0,
              task_id: 'new-deliberate-job',
              type: 'google/indexer',
            }),
          );
        expect(
          (await h.call(instance, request('deliberate-after-rejection')))
            .status,
        ).toBe('accepted');
      }
      expect(h.attempts).toBe(expected === 'unknown' ? 1 : 2);
      expect(h.records).toHaveLength(h.attempts);
      assertNoPrivate(result, h);
      expect(
        JSON.stringify(h.rows('SELECT * FROM intent_events')).includes(
          'private-provider-error',
        ),
      ).toBe(false);
    });
  },
);

test('C09 HOST: redirecterror never sends a second endpoint request', async () => {
  await withHost(async (h) => {
    h.init();
    const second = await fixture((_r, response) => response.end('{}'));
    allowedOrigins.add(second.origin);
    try {
      h.handler = (_r, response) => {
        response.statusCode = 302;
        response.setHeader('Location', second.origin + '/redirect-target');
        response.end();
      };
      expect((await h.call(h.host(), request())).status).toBe('unknown');
      expect(h.read('request-1')?.state).toBe('unknown');
      expect(h.records).toHaveLength(1);
      expect(second.requests).toHaveLength(0);
      expect(h.attempts).toBe(1);
    } finally {
      await second.close();
      allowedOrigins.delete(second.origin);
    }
  });
});

test('C09 HOST: reset after full request receipt is unknown and survives reopening without resend', async () => {
  await withHost(async (h) => {
    h.init();
    h.handler = (_r, _response, incoming) => incoming.socket.destroy();
    const result = await h.call(h.host(), request());
    expect(result.status).toBe('unknown');
    expect(h.records).toHaveLength(1);
    expect((await h.call(h.host(), request())).status).toBe('unknown');
    expect((await h.call(h.host(), request('overlap'))).error?.code).toBe(
      'UrlOverlap',
    );
    expect(h.attempts).toBe(1);
    assertNoPrivate(result, h);
  });
});

test('C09 HOST: deadline covers awaited response body and keeps the single attempted job held', async () => {
  await withHost(async (h) => {
    h.init();
    const fence = h.fence();
    h.handler = async (_r, response) => {
      response.write('{"code":0,');
      await fence.promise;
      response.end('"task_id":"late","type":"google/indexer"}');
    };
    const result = await h.call(
      h.host(undefined, { timeoutMs: 50 }),
      request(),
    );
    expect(h.records).toHaveLength(1);
    expect(result.status).toBe('unknown');
    expect(result.observation).toEqual({
      kind: 'ambiguous',
      recorded: true,
      cause: 'timeout',
    });
    expect((await h.call(h.host(), request())).status).toBe('unknown');
    expect((await h.call(h.host(), request('overlap'))).error?.code).toBe(
      'UrlOverlap',
    );
    expect(h.attempts).toBe(1);
  });
});

test('C09 HOST: a throwing transport invocation is attempted/unknown, never reflected or retried', async () => {
  await withHost(async (h) => {
    h.init();
    let attempted = 0;
    const invocations: { endpoint: string; method: string | undefined }[] = [];
    const throwing = ((
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      attempted++;
      invocations.push({ endpoint: String(input), method: init?.method });
      throw new Error(key + h.root + ' private-provider-error');
    }) as typeof fetch;
    const instance = h.host(undefined, { fetchRequest: throwing });
    const result = await h.call(instance, request());
    expect(result.status).toBe('unknown');
    expect(result.observation).toEqual({
      kind: 'ambiguous',
      recorded: true,
      cause: 'transport',
    });
    expect((await h.call(instance, request())).replayed).toBe(true);
    expect(h.read('request-1')?.state).toBe('unknown');
    expect(h.records).toHaveLength(0);
    expect(attempted).toBe(1);
    expect(invocations).toEqual([
      {
        endpoint: 'https://api.speedyindex.com/v2/task/google/indexer/create',
        method: 'POST',
      },
    ]);
    assertNoPrivate(result, h);
  });
});

type HostHarness = Awaited<ReturnType<typeof makeHarness>>;
function sdkApplication(value: {
  structuredContent?: unknown;
  content: unknown;
  isError?: boolean | undefined;
}) {
  const result = createIndexingTaskResultSchema.parse(value.structuredContent);
  expect(value.content).toEqual([
    { type: 'text', text: JSON.stringify(result) },
  ]);
  expect(value.isError).toBe(
    result.status !== 'preview' && result.status !== 'accepted',
  );
  return result;
}
function sdkWrites(session: Awaited<ReturnType<HostHarness['sdk']>>) {
  type Write = {
    method: string;
    name?: string;
    id?: string | number;
    requestId?: unknown;
  };
  const messages: Write[] = [];
  const waiters: {
    method: string;
    name?: string;
    done: (write: Write) => void;
  }[] = [];
  const send = session.transport.send.bind(session.transport);
  session.transport.send = async (
    message: Parameters<typeof session.transport.send>[0],
  ) => {
    await send(message);
    if (!('method' in message)) return;
    const params = message.params as Record<string, unknown> | undefined;
    const write: Write = {
      method: message.method,
      ...('id' in message ? { id: message.id } : {}),
      ...(typeof params?.name === 'string' ? { name: params.name } : {}),
      ...(params && 'requestId' in params
        ? { requestId: params.requestId }
        : {}),
    };
    messages.push(write);
    for (const waiter of waiters)
      if (
        waiter.method === write.method &&
        (!waiter.name || waiter.name === write.name)
      )
        waiter.done(write);
  };
  return {
    messages,
    wait(method: string, name?: string) {
      const found = messages.find(
        (m) => m.method === method && (!name || m.name === name),
      );
      if (found) return Promise.resolve(found);
      const next = deferred<Write>();
      waiters.push({ method, ...(name ? { name } : {}), done: next.resolve });
      return bounded(next.promise, 8_000);
    },
  };
}
function events(h: HostHarness, id: string) {
  return h.rows<{ event_kind: string; state_version: number }>(
    'SELECT event_kind, state_version FROM intent_events WHERE request_id = ? ORDER BY state_version',
    id,
  );
}
function heldTokens(h: HostHarness) {
  return h.rows<{ tokens: number }>(
    "SELECT coalesce(sum(reserved_tokens), 0) AS tokens FROM intents WHERE state IN ('prepared','dispatching','unknown')",
  )[0]!.tokens;
}

async function runChild(
  h: HostHarness,
  input: unknown,
  mode: ChildMode = 'normal',
  operation: 'indexer' | 'checker' = 'indexer',
) {
  const child = await h.child(input, mode, operation);
  await childControl(child, 'GO');
  return { child, ...(await childResult(child, operation)) };
}
function expectDispatchHeld(h: HostHarness, input: ReturnType<typeof request>) {
  expect(h.read(input.requestId)).toMatchObject({
    state: 'dispatching',
    stateVersion: 1,
    reservation: { tokens: 100, indexer: 0, checker: 0 },
  });
  expect(events(h, input.requestId)).toEqual([
    { event_kind: 'prepared', state_version: 0 },
    { event_kind: 'dispatching', state_version: 1 },
  ]);
  expect(heldTokens(h)).toBe(100);
  expect(
    h.rows(
      'SELECT url_text FROM intent_urls WHERE request_id = ? ORDER BY ordinal',
      input.requestId,
    ),
  ).toEqual(input.urls.map((url_text) => ({ url_text })));
}
async function expectHeldRestart(
  h: HostHarness,
  input: ReturnType<typeof request>,
  state: 'prepared' | 'dispatching' | 'unknown',
) {
  const before = events(h, input.requestId);
  const posts = h.records.length;
  const replay = await runChild(h, input);
  expect(replay.fetchInvocations).toBe(0);
  expect(replay.result.status).toBe(state);
  expect(replay.result.replayed).toBe(true);
  expect(replay.result.observation).toBeUndefined();
  assertNoPrivate(replay.result, h);
  const overlap = await runChild(h, {
    ...input,
    requestId: `${input.requestId}-overlap`,
  });
  expect(overlap.fetchInvocations).toBe(0);
  expect(overlap.result.error?.code).toBe('UrlOverlap');
  expect(h.read(`${input.requestId}-overlap`)).toBeNull();
  expect(events(h, input.requestId)).toEqual(before);
  expect(heldTokens(h)).toBe(100);
  expect(h.records).toHaveLength(posts);
}

for (const variant of [
  'same body',
  'different body',
  'finite cap',
  'held URL',
] as const) {
  test(`C07 HOST: two real children race with ${variant} and only one POST`, async () => {
    await withHost(async (h) => {
      h.init();
      h.config({
        caps: {
          tokens: variant === 'finite cap' ? 100 : 1_000,
          indexer: 0,
          checker: 0,
        },
      });
      const first = request('race-a');
      const second =
        variant === 'same body'
          ? first
          : variant === 'different body'
            ? { ...first, title: 'other synthetic title' }
            : request(
                'race-b',
                variant === 'finite cap'
                  ? ['https://example.test/two']
                  : first.urls,
              );
      const children = [await h.child(first), await h.child(second)];
      const ackFence = h.fence();
      h.handler = async (_receipt, response) => {
        await ackFence.promise;
        response.end(
          JSON.stringify({
            code: 0,
            task_id: 'race-winner',
            type: 'google/indexer',
          }),
        );
      };
      await Promise.all(children.map((child) => childControl(child, 'GO')));
      const outcomes = children.map(async (child, index) => ({
        index,
        ...(await childResult(child)),
      }));
      await bounded(h.received.promise, 8_000);
      const loser = await bounded(Promise.race(outcomes), 8_000);
      expect(loser.fetchInvocations).toBe(0);
      if (variant === 'same body') {
        expect(loser.result.replayed).toBe(true);
        expect(['prepared', 'dispatching']).toContain(loser.result.status);
      } else
        expect(loser.result.error?.code).toBe(
          variant === 'different body'
            ? 'RequestIdConflict'
            : variant === 'finite cap'
              ? 'BudgetExceeded'
              : 'UrlOverlap',
        );
      const rows = h.rows<{
        request_id: string;
        payload_digest: string;
        reserved_tokens: number;
        reserved_indexer: number;
        reserved_checker: number;
        state: string;
        state_version: number;
      }>(
        'SELECT request_id, payload_digest, reserved_tokens, reserved_indexer, reserved_checker, state, state_version FROM intents',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'dispatching',
        state_version: 1,
        reserved_tokens: 100,
        reserved_indexer: 0,
        reserved_checker: 0,
      });
      expect(heldTokens(h)).toBe(100);
      expect(
        h.rows('SELECT budget_scope, period_id FROM budget_periods'),
      ).toEqual([
        { budget_scope: 'fixture-scope', period_id: 'utc-day:2026-10-20' },
      ]);
      expect(h.records).toHaveLength(1);
      const wire = h.records[0]!;
      const winnerInput = loser.index === 0 ? second : first;
      const expectedBody = `${'title' in winnerInput ? '{"title":"other synthetic title",' : '{'}"urls":["${winnerInput.urls[0]}"],"pay_per_indexed":true,"drip_feed":false}`;
      expect(wire.body).toBe(expectedBody);
      expect(rows[0]!.payload_digest).toBe(sha(expectedBody));
      expect(wire).toMatchObject({
        method: 'POST',
        path: '/v2/task/google/indexer/create',
        auth: key,
        contentType: 'application/json',
        accept: 'application/json',
        agent: 'speedyindex-mcp/0.1.0',
      });
      expect(h.rows('SELECT url_text FROM intent_urls')).toEqual([
        { url_text: winnerInput.urls[0] },
      ]);
      expect(events(h, rows[0]!.request_id)).toEqual([
        { event_kind: 'prepared', state_version: 0 },
        { event_kind: 'dispatching', state_version: 1 },
      ]);
      ackFence.resolve();
      const settled = await Promise.all(outcomes);
      const winner = settled.find((value) => value.index !== loser.index)!;
      expect(winner.fetchInvocations).toBe(1);
      expect(winner.result.status).toBe('accepted');
      expect(h.read(rows[0]!.request_id)).toMatchObject({
        state: 'accepted',
        stateVersion: 2,
        providerTaskId: 'race-winner',
      });
      expect(events(h, rows[0]!.request_id)).toEqual([
        { event_kind: 'prepared', state_version: 0 },
        { event_kind: 'dispatching', state_version: 1 },
        { event_kind: 'accepted', state_version: 2 },
      ]);
      const replay = await runChild(h, winnerInput);
      expect(replay.fetchInvocations).toBe(0);
      expect(replay.result.status).toBe('accepted');
      expect(replay.result.replayed).toBe(true);
      expect(h.records).toHaveLength(1);
      expect(h.rows('SELECT request_id FROM intents')).toHaveLength(1);
      expect(events(h, rows[0]!.request_id)).toHaveLength(3);
      for (const value of settled) assertNoPrivate(value.result, h);
    });
  }, 30_000);
}

for (const finalReadFault of [false, true]) {
  test(`C10 HOST: real outcome busy timeout preserves dispatching${finalReadFault ? ' with narrow final-read fault' : ''}`, async () => {
    await withHost(async (h) => {
      h.init();
      h.config();
      const ackFence = h.fence();
      h.handler = async (_receipt, response) => {
        await ackFence.promise;
        response.end(
          JSON.stringify({
            code: 0,
            task_id: 'ack-not-recorded',
            type: 'google/indexer',
          }),
        );
      };
      const input = request('outcome-busy');
      const child = await h.child(
        input,
        finalReadFault ? 'read_fault_after_write_failure' : 'normal',
      );
      await childControl(child, 'GO');
      await bounded(h.received.promise, 8_000);
      expect(h.records[0]!.body).toBe(
        '{"urls":["https://example.test/one"],"pay_per_indexed":true,"drip_feed":false}',
      );
      expectDispatchHeld(h, input);
      const release = h.writerLock();
      // Keep this actual independent BEGIN IMMEDIATE until the child has
      // finished its own synchronous 2000 ms record attempt and projection.
      ackFence.resolve();
      const observed = await childResult(child);
      expect(observed.fetchInvocations).toBe(1);
      expect(child.messages.filter((m) => m.event === 'RECORD_ENTER')).toEqual([
        { event: 'RECORD_ENTER', outcome: 'accepted' },
      ]);
      const failures = child.messages.filter((m) => m.event === 'WRITE_FAILED');
      console.info(
        'C10 phase evidence',
        JSON.stringify({
          finalReadFault,
          phases: child.messages.map((message) => message.event),
          writeFailure: failures[0],
          status: observed.result.status,
          error: observed.result.error?.code,
          observation: observed.result.observation,
        }),
      );
      expect(failures).toHaveLength(1);
      // BEGIN IMMEDIATE fails before the core's outcome transaction starts.
      expect(failures[0]!.code).toBe('LedgerBusy');
      expect(typeof failures[0]!.elapsedMs).toBe('number');
      expect(observed.result.status).toBe(
        finalReadFault ? 'blocked' : 'dispatching',
      );
      expect(observed.result.error?.code).toBe(
        finalReadFault ? 'StateUnavailable' : 'OutcomePersistenceFailed',
      );
      expect(observed.result.observation).toEqual({
        kind: 'accepted_ack',
        recorded: false,
        taskId: 'ack-not-recorded',
        type: 'google/indexer',
      });
      if (finalReadFault) {
        expect(observed.result.error?.lastObservedState).toBe('dispatching');
        expect(observed.result.intent).toBeUndefined();
        expect(
          child.messages.filter((m) => m.event === 'FINAL_READ_FAULT'),
        ).toHaveLength(1);
      } else expect(observed.result.intent?.stateVersion).toBe(1);
      release();
      // Independent file/ledger reads after lock release, never a canned
      // recordDispatchOutcome failure or a fabricated successful commit.
      expectDispatchHeld(h, input);
      expect(
        h.rows('SELECT provider_task_id, provider_type FROM intents'),
      ).toEqual([{ provider_task_id: null, provider_type: null }]);
      await expectHeldRestart(h, input, 'dispatching');
      expectDispatchHeld(h, input);
      expect(h.records).toHaveLength(1);
      assertNoPrivate(observed.result, h);
    });
  }, 30_000);
}

test('C11 HOST: SIGKILL after full HTTP receipt leaves dispatching held across fresh children', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const ackFence = h.fence();
    h.handler = async (_receipt, response) => {
      await ackFence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'abandoned-ack',
          type: 'google/indexer',
        }),
      );
    };
    const input = request('killed-after-receipt');
    const child = await h.child(input);
    await childControl(child, 'GO');
    await bounded(h.received.promise, 8_000);
    expect(h.records[0]!.body).toBe(
      '{"urls":["https://example.test/one"],"pay_per_indexed":true,"drip_feed":false}',
    );
    await childEvent(child, 'FETCH_INVOKED');
    expectDispatchHeld(h, input);
    await killHostChild(child);
    expectDispatchHeld(h, input);
    await expectHeldRestart(h, input, 'dispatching');
    expectDispatchHeld(h, input);
    expect(h.records).toHaveLength(1);
  });
}, 30_000);

test('C12 HOST: already-aborted input creates no intent and no POST', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const observed = await runChild(
      h,
      request('already-aborted'),
      'already_aborted',
    );
    expect(observed.result.status).toBe('blocked');
    expect(observed.result.error?.code).toBe('Cancelled');
    expect(observed.fetchInvocations).toBe(0);
    expect(h.rows('SELECT request_id FROM intents')).toEqual([]);
    expect(h.rows('SELECT event_id FROM intent_events')).toEqual([]);
    expect(h.rows('SELECT period_id FROM budget_periods')).toEqual([]);
    expect(h.records).toHaveLength(0);
  });
}, 30_000);

test('C12 HOST: abort after real prepare commits uses cancelled CAS before releasing its hold', async () => {
  await withHost(async (h) => {
    h.init();
    h.config({ caps: { tokens: 100, indexer: 0, checker: 0 } });
    const input = request('cancel-prepared');
    const observed = await runChild(h, input, 'abort_after_prepare');
    expect(observed.fetchInvocations).toBe(0);
    expect(observed.result.status).toBe('cancelled');
    expect(observed.result.observation).toBeUndefined();
    expect(h.read(input.requestId)).toMatchObject({
      state: 'cancelled',
      stateVersion: 1,
    });
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
      { event_kind: 'cancelled', state_version: 1 },
    ]);
    expect(heldTokens(h)).toBe(0);
    expect(h.records).toHaveLength(0);
    const next = await runChild(h, { ...input, requestId: 'after-cancel' });
    expect(next.result.status).toBe('accepted');
    expect(next.fetchInvocations).toBe(1);
    expect(h.records).toHaveLength(1);
  });
}, 30_000);

test('C12 HOST: killed prepared owner loses its capability and leaves a genuine held orphan', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const input = request('killed-prepared');
    const child = await h.child(input, 'stop_after_prepare');
    await childControl(child, 'GO');
    await childEvent(child, 'PREPARED_STOP');
    expect(h.read(input.requestId)).toMatchObject({
      state: 'prepared',
      stateVersion: 0,
    });
    expect(heldTokens(h)).toBe(100);
    await killHostChild(child);
    expect(child.messages.some((m) => m.event === 'FETCH_INVOKED')).toBe(false);
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
    ]);
    await expectHeldRestart(h, input, 'prepared');
    expect(h.read(input.requestId)).toMatchObject({
      state: 'prepared',
      stateVersion: 0,
    });
    expect(h.records).toHaveLength(0);
  });
}, 30_000);

test('C13 HOST: direct abort after real claim records rejected not_sent without a fetch invocation', async () => {
  await withHost(async (h) => {
    h.init();
    h.config({ caps: { tokens: 100, indexer: 0, checker: 0 } });
    const input = request('claimed-no-send');
    const observed = await runChild(h, input, 'abort_after_claim');
    expect(observed.fetchInvocations).toBe(0);
    expect(observed.result.status).toBe('rejected');
    expect(observed.result.error?.code).toBe('Cancelled');
    expect(observed.result.observation).toEqual({
      kind: 'not_sent',
      recorded: true,
      cause: 'cancelled',
    });
    expect(h.read(input.requestId)).toMatchObject({
      state: 'rejected',
      stateVersion: 2,
    });
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
      { event_kind: 'dispatching', state_version: 1 },
      { event_kind: 'rejected', state_version: 2 },
    ]);
    expect(heldTokens(h)).toBe(0);
    expect(h.records).toHaveLength(0);
    const next = await runChild(h, { ...input, requestId: 'after-not-sent' });
    expect(next.result.status).toBe('accepted');
    expect(next.fetchInvocations).toBe(1);
    expect(h.records).toHaveLength(1);
  });
}, 30_000);

test('C13 HOST: cancellation after full HTTP arrival records unknown and retains the hold', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const ackFence = h.fence();
    h.handler = async (_receipt, response) => {
      await ackFence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'too-late-ack',
          type: 'google/indexer',
        }),
      );
    };
    const input = request('cancel-at-receiver');
    const child = await h.child(input);
    await childControl(child, 'GO');
    await bounded(h.received.promise, 8_000);
    expectDispatchHeld(h, input);
    await childControl(child, 'CANCEL');
    const observed = await childResult(child);
    expect(observed.fetchInvocations).toBe(1);
    expect(observed.result.status).toBe('unknown');
    expect(observed.result.observation).toEqual({
      kind: 'ambiguous',
      recorded: true,
      cause: 'cancelled',
    });
    expect(h.read(input.requestId)).toMatchObject({
      state: 'unknown',
      stateVersion: 2,
    });
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
      { event_kind: 'dispatching', state_version: 1 },
      { event_kind: 'unknown', state_version: 2 },
    ]);
    await expectHeldRestart(h, input, 'unknown');
    expect(h.records).toHaveLength(1);
  });
}, 30_000);

test('C13 HOST: parsed valid ACK is persisted accepted despite abort immediately before the real record', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const input = request('ack-before-abort');
    const observed = await runChild(h, input, 'abort_before_record');
    expect(observed.fetchInvocations).toBe(1);
    expect(
      observed.child.messages.filter((m) => m.event === 'ABORT_BEFORE_RECORD'),
    ).toEqual([{ event: 'ABORT_BEFORE_RECORD', outcome: 'accepted' }]);
    expect(observed.result.status).toBe('accepted');
    expect(observed.result.observation).toEqual({
      kind: 'accepted_ack',
      recorded: true,
      taskId: 'provider-1',
      type: 'google/indexer',
    });
    expect(h.read(input.requestId)).toMatchObject({
      state: 'accepted',
      stateVersion: 2,
      providerTaskId: 'provider-1',
      providerType: 'google/indexer',
    });
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
      { event_kind: 'dispatching', state_version: 1 },
      { event_kind: 'accepted', state_version: 2 },
    ]);
    const replay = await runChild(h, input);
    expect(replay.result.status).toBe('accepted');
    expect(replay.result.replayed).toBe(true);
    expect(replay.fetchInvocations).toBe(0);
    expect(h.records).toHaveLength(1);
  });
}, 30_000);

test('C13-Q HOST: queued stdin cancellation after committed claim is serviced before fetch', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const ackFence = h.fence();
    h.handler = async (_receipt, response) => {
      await ackFence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'queued-ack',
          type: 'google/indexer',
        }),
      );
    };
    const input = request('queued-cancel');
    const child = await h.child(input, 'stop_after_claim');
    await childControl(child, 'GO');
    await childEvent(child, 'CLAIMED_STOP');
    // The actual claim is already committed. Queue and flush cancellation
    // while this owned child is stopped, then let its concurrent reader run.
    expect(h.read(input.requestId)?.state).toBe('dispatching');
    expect(heldTokens(h)).toBe(100);
    await childControl(child, 'CANCEL');
    process.kill(child.process.pid, 'SIGCONT');
    const observed = await childResult(child);
    expect(child.messages.some((m) => m.event === 'CANCEL_APPLIED')).toBe(true);
    expect(child.messages.find((m) => m.event === 'RESUMED')).toEqual({
      event: 'RESUMED',
      after: 'CLAIMED_STOP',
    });
    expect(
      child.messages.findIndex((m) => m.event === 'CANCEL_APPLIED'),
    ).toBeLessThan(child.messages.findIndex((m) => m.event === 'RECORD_ENTER'));
    const durable = h.read(input.requestId);
    const facts = {
      fetchInvocations: observed.fetchInvocations,
      posts: h.records.length,
      status: observed.result.status,
      observation: observed.result.observation,
      state: durable?.state,
      version: durable?.stateVersion,
      events: events(h, input.requestId),
      heldTokens: heldTokens(h),
    };
    console.info(
      'C13-Q phase evidence',
      JSON.stringify({
        phases: child.messages.map((message) => message.event),
        ...facts,
      }),
    );
    expect(facts).toEqual({
      fetchInvocations: 0,
      posts: 0,
      status: 'rejected',
      observation: { kind: 'not_sent', recorded: true, cause: 'cancelled' },
      state: 'rejected',
      version: 2,
      events: [
        { event_kind: 'prepared', state_version: 0 },
        { event_kind: 'dispatching', state_version: 1 },
        { event_kind: 'rejected', state_version: 2 },
      ],
      heldTokens: 0,
    });
    expect(observed.result.error?.code).toBe('Cancelled');
    assertNoPrivate(observed.result, h);
  });
}, 30_000);

for (const succeeds of [false, true]) {
  test(`${succeeds ? 'C14-B' : 'C14'} SDK: cancellation is flushed while real prepare ${succeeds ? 'waits then commits' : 'waits through busy timeout'}`, async () => {
    await withHost(async (h) => {
      h.init();
      h.config();
      h.handler = (receipt, response) =>
        response.end(
          JSON.stringify(
            receipt.path === '/v2/account'
              ? account
              : { code: 0, task_id: 'after-sql', type: 'google/indexer' },
          ),
        );
      const session = await h.sdk(true);
      await session.phases.wait('READY');
      const writes = sdkWrites(session);
      const release = h.writerLock();
      const controller = new AbortController();
      const input = request(succeeds ? 'queued-sdk-commit' : 'queued-sdk-busy');
      const call = h.track(
        session.client
          .callTool(
            { name: 'create_indexing_task', arguments: input },
            { signal: controller.signal, timeout: 15_000 },
          )
          .then(
            () => 'delivered',
            () => 'cancelled',
          ),
      );
      const sent = await writes.wait('tools/call', 'create_indexing_task');
      await session.phases.wait('PREPARE_ENTER', 1);
      let pingFinished = false,
        readFinished = false;
      const ping = h.track(
        session.client.ping({ timeout: 15_000 }).then((value) => {
          pingFinished = true;
          return value;
        }),
      );
      await writes.wait('ping');
      const read = h.track(
        session.client
          .callTool({ name: 'get_balance', arguments: {} }, { timeout: 15_000 })
          .then((value) => {
            readFinished = true;
            return value;
          }),
      );
      await writes.wait('tools/call', 'get_balance');
      controller.abort('synthetic queued cancellation');
      const cancel = await writes.wait('notifications/cancelled');
      expect(cancel.requestId).toBe(sent.id);
      expect(
        session.phases.messages.some((m) => m.event === 'PREPARE_LEAVE'),
      ).toBe(false);
      expect(pingFinished).toBe(false);
      expect(readFinished).toBe(false);
      if (succeeds) release();
      const leave = await session.phases.wait('PREPARE_LEAVE', 1);
      if (!succeeds) release();
      await session.phases.wait('CLOSED', 1);
      expect(await bounded(call, 8_000)).toBe('cancelled');
      await bounded(ping, 8_000);
      expect((await bounded(read, 8_000)).isError).not.toBe(true);
      expect(
        h.records.filter((receipt) => receipt.method === 'POST'),
      ).toHaveLength(0);
      expect(
        session.phases.messages.filter(
          (m) => m.event === 'CLAIM' && m.operation === 1,
        ),
      ).toEqual([]);
      if (succeeds) {
        expect(leave.kind).toBe('created');
        expect(h.read(input.requestId)).toMatchObject({
          state: 'cancelled',
          stateVersion: 1,
        });
        expect(events(h, input.requestId)).toEqual([
          { event_kind: 'prepared', state_version: 0 },
          { event_kind: 'cancelled', state_version: 1 },
        ]);
        expect(
          session.phases.messages.find((m) => m.event === 'CANCEL'),
        ).toEqual({ event: 'CANCEL', operation: 1, kind: 'cancelled' });
      } else {
        expect(leave.code).toBe('LedgerBusy');
        expect(h.read(input.requestId)).toBeNull();
        expect(h.rows('SELECT event_id FROM intent_events')).toEqual([]);
        expect(h.rows('SELECT period_id FROM budget_periods')).toEqual([]);
      }
      expect(heldTokens(h)).toBe(0);
      console.info(
        `${succeeds ? 'C14-B' : 'C14'} real SDK phase evidence`,
        JSON.stringify({
          writes: writes.messages,
          phases: session.phases.messages,
          createPosts: h.records.filter((r) => r.method === 'POST').length,
          durable: h.read(input.requestId)?.state ?? 'absent',
          events: events(h, input.requestId),
        }),
      );
      const next = sdkApplication(
        await session.client.callTool({
          name: 'create_indexing_task',
          arguments: request('after-sql'),
        }),
      );
      expect(next.status).toBe('accepted');
      expect(h.read('after-sql')).toMatchObject({
        state: 'accepted',
        stateVersion: 2,
        providerTaskId: 'after-sql',
      });
      expect(
        h.records.filter((receipt) => receipt.method === 'POST'),
      ).toHaveLength(1);
      expect(session.phases.errors).toEqual([]);
    });
  }, 30_000);
}

test('C15 SOURCE SDK: real CLI cancellation after full POST persists unknown, fresh replay sends nothing', async () => {
  await withHost(async (h) => {
    h.init();
    h.config();
    const ackFence = h.fence(),
      disconnected = deferred<void>();
    h.handler = async (receipt, response) => {
      if (receipt.path === '/v2/account') {
        response.end(JSON.stringify(account));
        return;
      }
      response.once('close', () => disconnected.resolve());
      await ackFence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'late-cli-ack',
          type: 'google/indexer',
        }),
      );
    };
    const session = await h.sdk();
    expect((await session.client.listTools()).tools).toHaveLength(5);
    const controller = new AbortController();
    const input = request('sdk-after-receipt');
    const call = h.track(
      session.client
        .callTool(
          { name: 'create_indexing_task', arguments: input },
          { signal: controller.signal },
        )
        .then(
          () => 'delivered',
          () => 'cancelled',
        ),
    );
    await bounded(h.received.promise);
    expect(h.records[0]!.body).toBe(
      '{"urls":["https://example.test/one"],"pay_per_indexed":true,"drip_feed":false}',
    );
    expectDispatchHeld(h, input);
    controller.abort('synthetic caller stop after receipt');
    expect(await bounded(call)).toBe('cancelled');
    await bounded(disconnected.promise);
    const balance = await session.client.callTool({
      name: 'get_balance',
      arguments: {},
    });
    expect(balance.isError).not.toBe(true);
    expect(h.read(input.requestId)).toMatchObject({
      state: 'unknown',
      stateVersion: 2,
    });
    expect(events(h, input.requestId)).toEqual([
      { event_kind: 'prepared', state_version: 0 },
      { event_kind: 'dispatching', state_version: 1 },
      { event_kind: 'unknown', state_version: 2 },
    ]);
    expect(session.stderr()).toBe('');
    await session.close();
    const restarted = await h.sdk();
    const replay = sdkApplication(
      await restarted.client.callTool({
        name: 'create_indexing_task',
        arguments: input,
      }),
    );
    expect(replay.status).toBe('unknown');
    expect(replay.replayed).toBe(true);
    expect(replay.observation).toBeUndefined();
    const overlap = sdkApplication(
      await restarted.client.callTool({
        name: 'create_indexing_task',
        arguments: { ...input, requestId: 'sdk-overlap' },
      }),
    );
    expect(overlap.error?.code).toBe('UrlOverlap');
    expect(heldTokens(h)).toBe(100);
    expect(
      h.records.filter((receipt) => receipt.method === 'POST'),
    ).toHaveLength(1);
    expect(restarted.stderr()).toBe('');
    assertNoPrivate(replay, h);
    assertNoPrivate(overlap, h);
    console.info(
      'C15 source cancellation evidence',
      JSON.stringify({
        client: 'cancelled; server response not asserted delivered',
        state: h.read(input.requestId)?.state,
        events: events(h, input.requestId),
        createPosts: 1,
        replay: replay.status,
        overlap: overlap.error?.code,
      }),
    );
  });
}, 30_000);

for (const state of [
  'missing',
  'missing database',
  'zero',
  'truncated',
  'wrong version',
  'symlink',
] as const) {
  test(`C16 SOURCE CLI: ${state} state is untouched by startup/preview and never repaired on submit`, async () => {
    await withHost(async (h) => {
      h.config();
      if (state === 'wrong version') {
        h.init();
        const db = new Database(join(h.stateDirectory, 'ledger.sqlite'));
        try {
          db.exec('PRAGMA user_version = 2');
        } finally {
          db.close();
        }
      } else if (state === 'symlink') {
        const target = join(h.root, 'sentinel-target');
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'sentinel'), 'preserve synthetic target', {
          mode: 0o600,
        });
        symlinkSync(target, h.stateDirectory);
      } else if (state !== 'missing') {
        mkdirSync(h.stateDirectory, { mode: 0o700 });
        writeFileSync(
          join(
            h.stateDirectory,
            state === 'missing database' ? 'sentinel' : 'ledger.sqlite',
          ),
          state === 'zero' ? '' : 'preserve synthetic truncated bytes',
          { mode: 0o600 },
        );
      }
      const before = tree(h.root);
      const primary =
        state === 'wrong version'
          ? readFileSync(join(h.stateDirectory, 'ledger.sqlite'))
          : undefined;
      const primaryIdentity =
        state === 'wrong version'
          ? lstatSync(join(h.stateDirectory, 'ledger.sqlite')).ino
          : undefined;
      const session = await h.sdk();
      const preview = sdkApplication(
        await session.client.callTool({
          name: 'create_indexing_task',
          arguments: {
            mode: 'preview',
            searchEngine: 'google',
            urls: ['https://example.test/one'],
          },
        }),
      );
      expect(preview.status).toBe('preview');
      expect(preview.authorization?.stateChecked).toBe(false);
      expect(tree(h.root)).toEqual(before);
      const blocked = sdkApplication(
        await session.client.callTool({
          name: 'create_indexing_task',
          arguments: request('bad-state'),
        }),
      );
      expect(blocked.error?.code).toBe('StateUnavailable');
      if (state === 'wrong version') {
        // Normal open can update WAL shared-memory bookkeeping before schema
        // rejection. It must preserve the database bytes and identity.
        expect(lstatSync(join(h.stateDirectory, 'ledger.sqlite')).ino).toBe(
          primaryIdentity!,
        );
        expect(readFileSync(join(h.stateDirectory, 'ledger.sqlite'))).toEqual(
          primary!,
        );
      } else expect(tree(h.root)).toEqual(before);
      h.handler = (_receipt, response) => response.end(JSON.stringify(account));
      expect(
        (await session.client.callTool({ name: 'get_balance', arguments: {} }))
          .isError,
      ).not.toBe(true);
      expect(
        h.records.filter((receipt) => receipt.method === 'POST'),
      ).toHaveLength(0);
      expect(session.stderr()).toBe('');
      assertNoPrivate(blocked, h);
    });
  }, 30_000);
}

test('C15 SOURCE CLI: incomplete or malformed trusted configuration disables writes while reads remain usable', async () => {
  await withHost(async (h) => {
    h.config();
    h.handler = (_receipt, response) => response.end(JSON.stringify(account));
    const malformedArgs = [
      '--submission-policy',
      h.policyPath,
      '--submission-state',
      h.stateDirectory,
    ];
    for (const args of [
      ['--submission-policy', h.policyPath],
      ['--submission-state', h.stateDirectory],
      [
        '--submission-policy',
        join(h.root, 'absent-policy'),
        '--submission-state',
        h.stateDirectory,
      ],
      [
        '--submission-policy',
        h.policyPath,
        '--submission-state',
        'relative-state',
      ],
      malformedArgs,
    ]) {
      if (args === malformedArgs)
        writeFileSync(h.policyPath, '{"version":1,}', { mode: 0o600 });
      const session = await h.sdk(false, args);
      const preview = sdkApplication(
        await session.client.callTool({
          name: 'create_indexing_task',
          arguments: {
            mode: 'preview',
            searchEngine: 'google',
            urls: ['https://example.test/config-preview'],
          },
        }),
      );
      expect(preview.status).toBe('preview');
      expect(preview.authorization).toEqual({
        state: 'invalid',
        stateChecked: false,
      });
      const result = sdkApplication(
        await session.client.callTool({
          name: 'create_indexing_task',
          arguments: request('disabled-config'),
        }),
      );
      expect(result.error?.code).toBe('InvalidPolicy');
      expect(result.authorization).toEqual({
        state: 'invalid',
        stateChecked: false,
      });
      expect((await session.client.listTools()).tools).toHaveLength(5);
      expect(
        (await session.client.callTool({ name: 'get_balance', arguments: {} }))
          .isError,
      ).not.toBe(true);
      expect(session.stderr()).toBe('');
      assertNoPrivate(result, h);
      await session.close();
    }
    expect(existsSync(h.stateDirectory)).toBe(false);
    expect(h.records).toHaveLength(5);
    expect(h.records.every((receipt) => receipt.method === 'GET')).toBe(true);
  });
}, 30_000);

// Synthetic local reservation declarations, unrelated to provider fees.
const checkerVector = { tokens: 7, indexer: 5, checker: 11 };
const checkerPolicy: Partial<SubmissionPolicy> = {
  allowIndexChecks: true,
  indexCheckReservations: {
    google: checkerVector,
    yandex: checkerVector,
    bing: checkerVector,
  },
  caps: { tokens: 2_000_000, indexer: 20_000, checker: 20_000 },
};
function checkRequest(
  id = 'check-1',
  engine: 'google' | 'yandex' | 'bing' = 'google',
  urls = ['https://example.test/check'],
) {
  return { mode: 'submit', searchEngine: engine, requestId: id, urls } as const;
}
function checkerAck(result: Awaited<ReturnType<HostHarness['check']>>) {
  if (
    result.quote?.availability !== 'available' ||
    !result.authorization?.fingerprint
  )
    throw new Error('Expected available configured preview.');
  return {
    quoteFingerprint: result.quote.fingerprint,
    authorizationFingerprint: result.authorization.fingerprint,
  };
}
function storedUnits(h: HostHarness, where = '1 = 1') {
  return h.rows<{ tokens: number; indexer: number; checker: number }>(
    `SELECT coalesce(sum(reserved_tokens),0) AS tokens, coalesce(sum(reserved_indexer),0) AS indexer, coalesce(sum(reserved_checker),0) AS checker FROM intents WHERE ${where}`,
  )[0]!;
}

test.each(['google', 'yandex', 'bing'] as const)(
  'IC02 HOST: %s checker sends one exact request and records selected three-unit reservation',
  async (engine) => {
    await withHost(async (h) => {
      h.init();
      const config = h.config(checkerPolicy);
      const instance = h.host(config);
      const urls = [
        'HTTPS://Example.TEST/%2f?b=2&a=1#fragment',
        'https://example.test/白🦊/',
      ];
      const result = await h.check(instance, {
        ...checkRequest('wire-check', engine, urls),
        title: '  白 "title"  ',
      });
      const expectedBody =
        '{"title":"  白 \\"title\\"  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"]}';
      expect(result.status).toBe('accepted');
      expect(result.observation).toMatchObject({
        kind: 'accepted_ack',
        recorded: true,
        type: `${engine}/checker`,
      });
      expect(result.intent?.reservation).toEqual({
        tokens: 14,
        indexer: 10,
        checker: 22,
      });
      expect(h.records).toEqual([
        {
          method: 'POST',
          path: `/v2/task/${engine}/checker/create`,
          auth: key,
          agent: 'speedyindex-mcp/0.1.0',
          accept: 'application/json',
          contentType: 'application/json',
          body: expectedBody,
        },
      ]);
      expect(result.request?.payloadDigest).toBe(sha(expectedBody));
      expect(storedUnits(h)).toEqual({ tokens: 14, indexer: 10, checker: 22 });
      expect(
        h.rows('SELECT url_text FROM intent_urls ORDER BY ordinal'),
      ).toEqual(urls.map((url_text) => ({ url_text })));
      expect(events(h, 'wire-check').map((row) => row.event_kind)).toEqual([
        'prepared',
        'dispatching',
        'accepted',
      ]);
      expect(h.attempts).toBe(1);
      assertNoPrivate(result, h);
    });
  },
);

test('IC03 HOST: checker preview and pre-open error precedence use configuration, permission, profile, clock and cancellation', async () => {
  await withHost(async (h) => {
    const stale = {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    };
    const setups = [
      {
        config: loadSubmissionConfiguration(),
        error: 'WritesDisabled',
        availability: 'unavailable',
        state: 'unconfigured',
      },
      {
        config: h.config({ ...checkerPolicy, enabled: false }),
        error: 'WritesDisabled',
        availability: 'available',
        state: 'disabled',
      },
      {
        config: h.config(checkerPolicy, ''),
        error: 'MissingCredentials',
        availability: 'available',
        state: 'credential_missing',
      },
      {
        config: h.config(checkerPolicy, 'wrong-synthetic-key'),
        error: 'CredentialMismatch',
        availability: 'available',
        state: 'credential_mismatch',
      },
      {
        config: h.config({
          ...checkerPolicy,
          allowIndexChecks: false,
          indexCheckReservations: {},
        }),
        error: 'WritesDisabled',
        availability: 'unavailable',
        state: 'disabled',
      },
      {
        config: h.config({
          ...checkerPolicy,
          allowIndexChecks: undefined,
          indexCheckReservations: {},
        }),
        error: 'WritesDisabled',
        availability: 'unavailable',
        state: 'disabled',
      },
      {
        config: h.config({
          ...checkerPolicy,
          indexCheckReservations: { bing: checkerVector },
        }),
        error: 'ReservationProfileRequired',
        availability: 'unavailable',
        state: 'reservation_unavailable',
      },
      {
        config: h.config({
          ...checkerPolicy,
          indexCheckReservations: {
            google: { ...checkerVector, checker: Number.MAX_SAFE_INTEGER },
          },
        }),
        error: 'ReservationOverflow',
        availability: 'unavailable',
        state: 'reservation_unavailable',
      },
    ];
    // A valid policy alone supplies quotes; incomplete state never grants a submit.
    h.config(checkerPolicy);
    setups.push({
      config: loadSubmissionConfiguration({ policyPath: h.policyPath }),
      error: 'InvalidPolicy',
      availability: 'available',
      state: 'invalid',
    });
    for (const setup of setups) {
      const instance = h.host(setup.config);
      const preview = await h.check(instance, {
        mode: 'preview',
        searchEngine: 'google',
        urls: ['https://example.test/a', 'https://example.test/b'],
      });
      expect(preview.status).toBe('preview');
      expect(String(preview.quote?.availability)).toBe(setup.availability);
      expect(String(preview.authorization?.state)).toBe(setup.state);
      expect(preview.authorization?.stateChecked).toBe(false);
      if (preview.quote?.availability === 'unavailable') {
        expect(Object.hasOwn(preview.quote, 'fingerprint')).toBe(false);
        expect(Object.hasOwn(preview.quote, 'reservation')).toBe(false);
        expect(preview.authorization?.fingerprint).toBeUndefined();
      }
      const result = await h.check(instance, {
        ...checkRequest('admission', 'google', [
          'https://example.test/a',
          'https://example.test/b',
        ]),
        acknowledgement: stale,
      });
      expect(String(result.error?.code)).toBe(setup.error);
      assertNoPrivate(result, h);
    }
    const active = h.config(checkerPolicy);
    const badClock = h.host(active, { clock: () => NaN });
    expect((await h.check(badClock, checkRequest())).error?.code).toBe(
      'StateUnavailable',
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await h.check(h.host(active), checkRequest(), aborted.signal)).error
        ?.code,
    ).toBe('Cancelled');
    expect(
      (
        await h.check(h.host(active), {
          ...checkRequest(),
          acknowledgement: { quoteFingerprint: 'BAD' },
        })
      ).error?.code,
    ).toBe('InvalidInput');
    expect(h.opens).toBe(0);
    expect(h.attempts).toBe(0);
    expect(h.records).toHaveLength(0);
    expect(existsSync(h.stateDirectory)).toBe(false);
  });
});

test('IC03 HOST: admitted policy owns active quote; contradictory private preview view cannot override or grant a profile', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config(checkerPolicy);
    if (config.state !== 'configured')
      throw new Error('Expected synthetic configuration.');
    const contradictory = {
      ...config,
      indexCheckReservationSource: {
        state: 'loaded' as const,
        profiles: { google: { tokens: 99, indexer: 99, checker: 99 } },
      },
    };
    const result = await h.check(h.host(contradictory), checkRequest());
    expect(result.intent?.reservation).toEqual(checkerVector);
    const missing = h.config({ ...checkerPolicy, indexCheckReservations: {} });
    if (missing.state !== 'configured')
      throw new Error('Expected synthetic configuration.');
    const opens = h.opens;
    const blocked = await h.check(
      h.host({
        ...missing,
        indexCheckReservationSource: contradictory.indexCheckReservationSource,
      }),
      checkRequest('injected'),
    );
    expect(blocked.error?.code).toBe('ReservationProfileRequired');
    expect(blocked.quote?.availability).toBe('unavailable');
    expect(h.opens).toBe(opens);
    expect(h.attempts).toBe(1);
    expect(storedUnits(h)).toEqual(checkerVector);
  });
});

test('IC05/IC07 HOST: exact checker replay precedes busy/current ack and retains old period without capability or events', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config({
      ...checkerPolicy,
      mode: 'caller_acknowledgement',
    });
    const instance = h.host(config);
    const input = checkRequest();
    const preview = await h.check(instance, {
      mode: 'preview',
      searchEngine: input.searchEngine,
      urls: input.urls,
    });
    const current = checkerAck(preview);
    expect((await h.check(instance, input)).error?.code).toBe(
      'AcknowledgementRequired',
    );
    expect(
      (
        await h.check(instance, {
          ...input,
          acknowledgement: {
            ...current,
            authorizationFingerprint: 'a'.repeat(64),
          },
        })
      ).error?.code,
    ).toBe('AcknowledgementMismatch');
    expect(h.rows('SELECT request_id FROM intents')).toEqual([]);
    expect(
      (await h.check(instance, { ...input, acknowledgement: current })).status,
    ).toBe('accepted');
    const before = [
      'budget_periods',
      'intents',
      'intent_urls',
      'intent_events',
    ].map((table) => h.rows(`SELECT * FROM ${table} ORDER BY rowid`));
    h.now += 86_400_000;
    let noCapability = 0;
    const reopened = h.host(config, {
      openLedger(options) {
        const ledger = openLedger(options);
        return new Proxy(ledger, {
          get(target, property) {
            if (property === 'prepareIntent')
              return (value: PrepareIntentInput) => {
                const replay = target.prepareIntent(value);
                expect(replay.kind).toBe('replay');
                expect('dispatchCapability' in replay).toBe(false);
                noCapability++;
                return replay;
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    for (const acknowledgement of [undefined, current]) {
      const result = await h.check(reopened, {
        ...input,
        ...(acknowledgement ? { acknowledgement } : {}),
      });
      expect(result.status).toBe('accepted');
      expect(result.replayed).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(result.intent?.periodId).toBe('utc-day:2026-10-20');
      expect(result.authorization?.fingerprint).not.toBe(
        current.authorizationFingerprint,
      );
    }
    expect(noCapability).toBe(2);
    expect(
      ['budget_periods', 'intents', 'intent_urls', 'intent_events'].map(
        (table) => h.rows(`SELECT * FROM ${table} ORDER BY rowid`),
      ),
    ).toEqual(before);
    expect(
      (
        await h.check(instance, {
          ...input,
          requestId: 'new-day',
          acknowledgement: current,
        })
      ).error?.code,
    ).toBe('AcknowledgementMismatch');
    expect(h.attempts).toBe(1);
  });
});

test.each([
  {
    label: 'definite rejection',
    status: 401,
    body: { code: 1 },
    state: 'rejected',
  },
  {
    label: 'contradictory PPR echo',
    status: 200,
    body: {
      code: 0,
      task_id: 'ambiguous-check',
      type: 'google/checker',
      pay_per_indexed: true,
    },
    state: 'unknown',
  },
  { label: 'HTTP ambiguous', status: 429, body: { code: 2 }, state: 'unknown' },
])(
  'IC04/IC05 HOST: $label records durable outcome and never resends replay',
  async (vector) => {
    await withHost(async (h) => {
      h.init();
      const config = h.config(checkerPolicy);
      const instance = h.host(config);
      h.handler = (_record, response) => {
        response.statusCode = vector.status;
        response.end(JSON.stringify(vector.body));
      };
      const input = checkRequest();
      const result = await h.check(instance, input);
      expect(String(result.status)).toBe(vector.state);
      expect(result.observation?.recorded).toBe(true);
      expect(h.read(input.requestId)?.reservation).toEqual(checkerVector);
      const replay = await h.check(h.host(config), input);
      expect(replay.replayed).toBe(true);
      expect(String(replay.status)).toBe(vector.state);
      expect(replay.observation).toBeUndefined();
      expect(
        (await h.call(h.host(config), request('overlap', input.urls))).error
          ?.code,
      ).toBe(vector.state === 'unknown' ? 'UrlOverlap' : 'ProviderRejected');
      // For rejected rows the overlap is allowed to dispatch; the same synthetic
      // rejection/ambiguous response then determines that new indexing outcome.
      expect(h.attempts).toBe(vector.state === 'unknown' ? 1 : 2);
      assertNoPrivate(result, h);
    });
  },
);

test('IC06 HOST: accepted checker and indexing reservations constrain shared current-day caps in both directions', async () => {
  await withHost(async (h) => {
    h.init();
    const caps = { tokens: 26, indexer: 6, checker: 11 };
    const config = h.config({ ...checkerPolicy, caps });
    expect((await h.check(h.host(config), checkRequest())).status).toBe(
      'accepted',
    );
    const next = {
      ...request('index-boundary', ['https://example.test/yandex-index']),
      searchEngine: 'yandex',
    };
    expect((await h.call(h.host(config), next)).error?.code).toBe(
      'BudgetExceeded',
    );
    expect(h.attempts).toBe(1);
    const fitting = h.config({
      ...checkerPolicy,
      caps: { ...caps, tokens: 27 },
    });
    expect((await h.call(h.host(fitting), next)).status).toBe('accepted');
    expect(storedUnits(h)).toEqual({ tokens: 27, indexer: 6, checker: 11 });
    expect(
      (
        await h.check(
          h.host(fitting),
          checkRequest('over', 'google', ['https://example.test/over']),
        )
      ).error?.code,
    ).toBe('BudgetExceeded');
    expect(h.attempts).toBe(2);
  });
  await withHost(async (h) => {
    h.init();
    const config = h.config({
      ...checkerPolicy,
      caps: { tokens: 106, indexer: 5, checker: 11 },
    });
    expect((await h.call(h.host(config), request())).status).toBe('accepted');
    expect((await h.check(h.host(config), checkRequest())).error?.code).toBe(
      'BudgetExceeded',
    );
    const fitting = h.config({
      ...checkerPolicy,
      caps: { tokens: 107, indexer: 5, checker: 11 },
    });
    expect((await h.check(h.host(fitting), checkRequest())).status).toBe(
      'accepted',
    );
    expect(storedUnits(h)).toEqual({ tokens: 107, indexer: 5, checker: 11 });
    expect(
      (await h.check(h.host(fitting), checkRequest('request-1'))).error?.code,
    ).toBe('RequestIdConflict');
    expect(h.attempts).toBe(2);
  });
});

test('IC06 HOST: unknown checker holds retain all units across day/revision/profile changes while old accepted units roll over', async () => {
  await withHost(async (h) => {
    h.init();
    const original = h.config(checkerPolicy);
    expect(
      (await h.check(h.host(original), checkRequest('old-accepted'))).status,
    ).toBe('accepted');
    h.handler = (_r, response) =>
      response.end(
        JSON.stringify({ code: 0, task_id: 'hold', type: 'google/indexer' }),
      );
    const held = checkRequest('old-unknown', 'google', [
      'https://example.test/held-check',
    ]);
    expect((await h.check(h.host(original), held)).status).toBe('unknown');
    h.now += 86_400_000;
    h.handler = (_r, response) =>
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'new-index',
          type: 'yandex/indexer',
        }),
      );
    const next = {
      ...request('rollover-index', ['https://example.test/new-day-index']),
      searchEngine: 'yandex',
    };
    const changed = {
      ...checkerPolicy,
      policyRevision: 'synthetic-v2',
      indexCheckReservations: {
        google: { tokens: 8, indexer: 9, checker: 12 },
      },
    };
    for (const [caps, unit] of [
      [{ tokens: 26, indexer: 6, checker: 11 }, 'tokens'],
      [{ tokens: 27, indexer: 5, checker: 11 }, 'indexer'],
      [{ tokens: 27, indexer: 6, checker: 10 }, 'checker'],
    ] as const) {
      const blocked = await h.call(
        h.host(h.config({ ...changed, caps })),
        next,
      );
      expect(blocked.error?.code).toBe('BudgetExceeded');
      expect(String(blocked.error?.unit)).toBe(unit);
      expect(h.read(held.requestId)?.reservation).toEqual(checkerVector);
    }
    expect(h.attempts).toBe(2);
    expect(
      (
        await h.call(
          h.host(
            h.config({
              ...changed,
              caps: { tokens: 27, indexer: 6, checker: 11 },
            }),
          ),
          next,
        )
      ).status,
    ).toBe('accepted');
    expect(
      storedUnits(
        h,
        "state IN ('prepared','dispatching','unknown') OR (state = 'accepted' AND period_id = 'utc-day:2026-10-21')",
      ),
    ).toEqual({ tokens: 27, indexer: 6, checker: 11 });
    expect(h.attempts).toBe(3);
  });
});

test('IC07 HOST: family/body/profile policy conflicts preserve unknown identity; restore permits replay, disappearing authority blocks pre-read', async () => {
  await withHost(async (h) => {
    h.init();
    const config = h.config(checkerPolicy);
    const input = checkRequest();
    h.handler = (_r, response) =>
      response.end(
        JSON.stringify({ code: 0, task_id: 'held', type: 'google/indexer' }),
      );
    const first = await h.check(h.host(config), input);
    expect(first.status).toBe('unknown');
    expect(
      (
        await h.call(h.host(config), {
          ...request(input.requestId, input.urls),
        })
      ).error?.code,
    ).toBe('RequestIdConflict');
    expect(
      (await h.check(h.host(config), { ...input, searchEngine: 'bing' })).error
        ?.code,
    ).toBe('RequestIdConflict');
    expect(
      (await h.check(h.host(config), { ...input, title: '' })).error?.code,
    ).toBe('RequestIdConflict');
    for (const engine of ['google', 'bing'] as const) {
      const profiles = {
        ...checkerPolicy.indexCheckReservations,
        [engine]: { ...checkerVector, tokens: 8 },
      };
      const changed = h.config({
        ...checkerPolicy,
        indexCheckReservations: profiles,
      });
      const result = await h.check(h.host(changed), input);
      expect(result.error?.code).toBe('RequestIdConflict');
      if (
        first.quote?.availability !== 'available' ||
        result.quote?.availability !== 'available'
      )
        throw new Error('Expected quote.');
      if (engine === 'google')
        expect(result.quote.fingerprint).not.toBe(first.quote.fingerprint);
      else expect(result.quote.fingerprint).toBe(first.quote.fingerprint);
      expect(result.authorization?.policyDigest).not.toBe(
        first.authorization?.policyDigest,
      );
    }
    const before = events(h, input.requestId);
    const restored = h.config(checkerPolicy);
    expect((await h.check(h.host(restored), input)).replayed).toBe(true);
    expect(events(h, input.requestId)).toEqual(before);
    expect(h.read(input.requestId)?.reservation).toEqual(checkerVector);
    for (const [configuration, code] of [
      [
        h.config({ ...checkerPolicy, allowIndexChecks: false }),
        'WritesDisabled',
      ],
      [
        h.config({ ...checkerPolicy, indexCheckReservations: {} }),
        'ReservationProfileRequired',
      ],
      [h.config(checkerPolicy, 'wrong-synthetic-key'), 'CredentialMismatch'],
    ] as const) {
      const opens = h.opens;
      expect(
        String((await h.check(h.host(configuration), input)).error?.code),
      ).toBe(code);
      expect(h.opens).toBe(opens);
    }
    expect(
      (await h.call(h.host(restored), request('url-overlap', input.urls))).error
        ?.code,
    ).toBe('UrlOverlap');
    const otherScope = h.config({
      ...checkerPolicy,
      budgetScope: 'other-scope',
    });
    expect(
      (
        await h.check(
          h.host(otherScope),
          checkRequest('other-engine', 'bing', input.urls),
        )
      ).error?.code,
    ).toBe('UrlOverlap');
    expect(h.attempts).toBe(1);
    expect(events(h, input.requestId)).toEqual(before);
  });
});

test.each(['indexer', 'checker'] as const)(
  'IC08 HOST: %s-first shares one busy guard, permits replay, and releases for the other family',
  async (firstFamily) => {
    await withHost(async (h) => {
      h.init();
      const config = h.config(checkerPolicy);
      const instance = h.host(config);
      const fence = h.fence();
      h.handler = async (receipt, response) => {
        await fence.promise;
        response.end(
          JSON.stringify({
            code: 0,
            task_id: 'guard-job',
            type: receipt.path!.slice('/v2/task/'.length, -'/create'.length),
          }),
        );
      };
      const indexing = request('guard-index', [
        'https://example.test/guard-index',
      ]);
      const checking = checkRequest('guard-check', 'google', [
        'https://example.test/guard-check',
      ]);
      const first =
        firstFamily === 'indexer'
          ? h.call(instance, indexing)
          : h.check(instance, checking);
      await bounded(h.received.promise);
      const stale = {
        quoteFingerprint: 'a'.repeat(64),
        authorizationFingerprint: 'b'.repeat(64),
      };
      const busy =
        firstFamily === 'indexer'
          ? await h.check(instance, { ...checking, acknowledgement: stale })
          : await h.call(instance, { ...indexing, acknowledgement: stale });
      expect(busy.error?.code).toBe('SubmissionBusy');
      const replay =
        firstFamily === 'indexer'
          ? await h.call(instance, indexing)
          : await h.check(instance, checking);
      expect(replay.replayed).toBe(true);
      expect(replay.status).toBe('dispatching');
      expect(h.attempts).toBe(1);
      fence.resolve();
      expect((await first).status).toBe('accepted');
      const after =
        firstFamily === 'indexer'
          ? await h.check(instance, checking)
          : await h.call(instance, indexing);
      expect(after.status).toBe('accepted');
      expect(h.attempts).toBe(2);
      expect(h.records).toHaveLength(2);
    });
  },
);

test('IC08 HOST: two real mixed-family children race under one shared token cap without predetermined winner', async () => {
  await withHost(async (h) => {
    h.init();
    h.config({
      ...checkerPolicy,
      caps: { tokens: 100, indexer: 5, checker: 11 },
    });
    const inputs = [
      request('mixed-index', ['https://example.test/mixed-index']),
      checkRequest('mixed-check', 'google', [
        'https://example.test/mixed-check',
      ]),
    ];
    const families = ['indexer', 'checker'] as const;
    const children = [
      await h.child(inputs[0], 'normal', families[0]),
      await h.child(inputs[1], 'normal', families[1]),
    ];
    const fence = h.fence();
    h.handler = async (receipt, response) => {
      await fence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'mixed-winner',
          type: receipt.path!.slice('/v2/task/'.length, -'/create'.length),
        }),
      );
    };
    await Promise.all(children.map((child) => childControl(child, 'GO')));
    const outcomes = children.map(async (child, i) => ({
      i,
      ...(await childResult(child, families[i]!)),
    }));
    await bounded(h.received.promise, 8_000);
    const loser = await bounded(Promise.race(outcomes), 8_000);
    expect(loser.fetchInvocations).toBe(0);
    expect(loser.result.error?.code).toBe('BudgetExceeded');
    const winner = loser.i === 0 ? 1 : 0;
    const units =
      winner === 0 ? { tokens: 100, indexer: 0, checker: 0 } : checkerVector;
    expect(storedUnits(h)).toEqual(units);
    expect(h.rows('SELECT request_id FROM intents')).toHaveLength(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.path).toBe(
      `/v2/task/google/${families[winner]}/create`,
    );
    expect(h.records[0]!.body).toBe(
      winner === 0
        ? '{"urls":["https://example.test/mixed-index"],"pay_per_indexed":true,"drip_feed":false}'
        : '{"urls":["https://example.test/mixed-check"]}',
    );
    fence.resolve();
    const settled = await Promise.all(outcomes);
    expect(settled[winner]!.result.status).toBe('accepted');
    expect(settled[winner]!.fetchInvocations).toBe(1);
    const replay = await runChild(
      h,
      inputs[winner],
      'normal',
      families[winner],
    );
    expect(replay.result.replayed).toBe(true);
    expect(replay.fetchInvocations).toBe(0);
    expect(
      events(h, inputs[winner]!.requestId).map((row) => row.event_kind),
    ).toEqual(['prepared', 'dispatching', 'accepted']);
    expect(h.records).toHaveLength(1);
    expect(storedUnits(h)).toEqual(units);
  });
}, 30_000);

test('IC09 HOST: checker ACK under actual SQLite writer lock remains held/unrecorded and admitted restart never resends', async () => {
  await withHost(async (h) => {
    h.init();
    h.config(checkerPolicy);
    const fence = h.fence();
    h.handler = async (_receipt, response) => {
      await fence.promise;
      response.end(
        JSON.stringify({
          code: 0,
          task_id: 'ack-check-not-recorded',
          type: 'google/checker',
        }),
      );
    };
    const input = checkRequest('checker-outcome-busy');
    const child = await h.child(input, 'normal', 'checker');
    await childControl(child, 'GO');
    await bounded(h.received.promise, 8_000);
    const release = h.writerLock();
    fence.resolve();
    const observed = await childResult(child, 'checker');
    expect(child.messages.filter((m) => m.event === 'RECORD_ENTER')).toEqual([
      { event: 'RECORD_ENTER', outcome: 'accepted' },
    ]);
    const failed = child.messages.filter((m) => m.event === 'WRITE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.code).toBe('LedgerBusy');
    expect(observed.result.status).toBe('dispatching');
    expect(observed.result.error?.code).toBe('OutcomePersistenceFailed');
    expect(observed.result.observation).toEqual({
      kind: 'accepted_ack',
      recorded: false,
      taskId: 'ack-check-not-recorded',
      type: 'google/checker',
    });
    release();
    expect(h.read(input.requestId)).toMatchObject({
      state: 'dispatching',
      stateVersion: 1,
      reservation: checkerVector,
    });
    expect(storedUnits(h)).toEqual(checkerVector);
    const before = events(h, input.requestId);
    const replay = await runChild(h, input, 'normal', 'checker');
    expect(replay.result.replayed).toBe(true);
    expect(replay.fetchInvocations).toBe(0);
    expect(replay.result.status).toBe('dispatching');
    expect(replay.result.observation).toBeUndefined();
    const overlap = await runChild(
      h,
      request('checker-held-overlap', input.urls),
    );
    expect(overlap.result.error?.code).toBe('UrlOverlap');
    expect(overlap.fetchInvocations).toBe(0);
    expect(events(h, input.requestId)).toEqual(before);
    expect(storedUnits(h)).toEqual(checkerVector);
    expect(h.records).toHaveLength(1);
    assertNoPrivate(observed.result, h);
    console.info(
      'IC09 checker SQL evidence',
      JSON.stringify({
        phases: child.messages.map((m) => m.event),
        status: observed.result.status,
        writeCode: failed[0]!.code,
        reservation: checkerVector,
      }),
    );
  });
}, 30_000);
