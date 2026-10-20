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
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  buildCreateIndexingRequest,
  createIndexingTaskResultSchema,
  createIndexingTaskToolResult,
  type CreateIndexingTaskResult,
} from '../src/create-indexing-task';
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
import { bounded, deferred, fixture } from './helpers';

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
  expect(networkViolations).toEqual([]);
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
]);
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
        type: receipt.path?.includes('/yandex/')
          ? 'yandex/indexer'
          : 'google/indexer',
      }),
    );
  let api: Awaited<ReturnType<typeof fixture>>;
  try {
    api = await fixture((incoming, response) => {
      void readBody(incoming)
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
    read,
    rows,
    seed,
    fetchRequest,
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
      for (const controller of controllers) controller.abort();
      for (const fence of fences) fence.resolve();
      let settled = false;
      const errors: unknown[] = [];
      try {
        await bounded(Promise.allSettled(pending), 5_000);
        settled = true;
      } catch (error) {
        errors.push(error);
      }
      try {
        await api.close();
      } catch (error) {
        errors.push(error);
      }
      allowedOrigins.delete(api.origin);
      if (settled) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      errors.push(...handlerErrors);
      if (errors.length)
        throw new AggregateError(
          errors,
          'Test-owned host cleanup or receiver failed.',
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
