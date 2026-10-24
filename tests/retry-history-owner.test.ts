import { expect, test } from 'bun:test';
import { Database, SQLiteError } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  initializeLedger,
  initializeLedgerV2,
  migrateLedgerV2,
  openLedger,
  openRetryLedgerV2,
  readRetrySnapshot,
  type DispatchCapability,
  type IntentState,
  type PrepareIntentInput,
  type PrepareResult,
  type SubmissionLedger,
} from '../src/submission-ledger';
import { buildCreateIndexingRequest } from '../src/create-indexing-task';
import {
  createSubmissionContext,
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
  type ConfiguredSubmission,
  type SubmissionConfigurationOptions,
  type SubmissionPolicy,
} from '../src/submission-policy';
import type {
  RetryHistoryOwnerOptions,
  HistoryOwnerPhase,
} from '../src/retry-history-owner';
import type {
  RetryHistoryResult,
  RetryHistoryToolResult,
} from '../src/get-retry-history';
import type { SubmissionHostOptions } from '../src/submission-host';

const fixtureSchema = z.strictObject({
  version: z.literal(1),
  rows: z
    .array(
      z.strictObject({
        requestId: z.string().regex(/^fixture-[a-z-]+$/),
        state: z.enum([
          'prepared',
          'dispatching',
          'accepted',
          'rejected',
          'unknown',
          'cancelled',
        ]),
        engine: z.enum(['google', 'yandex']),
      }),
    )
    .min(1)
    .max(20),
});
const savedSeed =
  '{"version":1,"rows":[{"requestId":"fixture-prepared","state":"prepared","engine":"google"},{"requestId":"fixture-dispatching","state":"dispatching","engine":"google"},{"requestId":"fixture-accepted","state":"accepted","engine":"google"},{"requestId":"fixture-rejected","state":"rejected","engine":"google"},{"requestId":"fixture-unknown","state":"unknown","engine":"google"},{"requestId":"fixture-cancelled","state":"cancelled","engine":"google"},{"requestId":"fixture-yandex","state":"accepted","engine":"yandex"}]}';
function readSeed(path: string) {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return fixtureSchema.parse(value);
}
function privateRoot() {
  const root = mkdtempSync(join(tmpdir(), 'retry-history-native-'));
  chmodSync(root, 0o700);
  return root;
}

test('GRH-PREP-00 exact in-process fixture entry reads a saved closed finite seed before native use', () => {
  const root = privateRoot();
  let passed = false;
  try {
    const path = join(root, 'seed.json');
    writeFileSync(path, savedSeed, { mode: 0o600 });
    const seed = readSeed(path);
    expect(seed.version).toBe(1);
    expect(
      seed.rows.map((row) => [row.requestId, row.state, row.engine]),
    ).toEqual([
      ['fixture-prepared', 'prepared', 'google'],
      ['fixture-dispatching', 'dispatching', 'google'],
      ['fixture-accepted', 'accepted', 'google'],
      ['fixture-rejected', 'rejected', 'google'],
      ['fixture-unknown', 'unknown', 'google'],
      ['fixture-cancelled', 'cancelled', 'google'],
      ['fixture-yandex', 'accepted', 'yandex'],
    ]);
    for (const invalid of [
      { ...seed, path: 'not-a-selector' },
      { version: 2, rows: seed.rows },
      {
        version: 1,
        rows: [
          { requestId: 'fixture-valid', state: 'complete', engine: 'google' },
        ],
      },
      {
        version: 1,
        rows: [
          {
            requestId: 'fixture-valid',
            state: 'prepared',
            engine: 'google',
            proof: 'not-authority',
          },
        ],
      },
      { version: 1, rows: [] },
    ])
      expect(fixtureSchema.safeParse(invalid).success).toBe(false);
    console.info(
      JSON.stringify({
        receipt: 'HISTORY_FIXTURE_SHAPE_OK',
        entry: 'tests/retry-history-owner.test.ts:GRH-PREP-00',
        savedSeed: seed,
      }),
    );
    passed = true;
  } finally {
    if (passed) rmSync(root, { recursive: true });
    else
      console.error(
        JSON.stringify({ receipt: 'PRESERVED_FIXTURE_ROOT', root }),
      );
  }
});

test('GRH-PREP-01 actual private WAL exclusive-lock preparation witnesses SQLITE_BUSY or SQLITE_LOCKED and closes', () => {
  const root = privateRoot();
  const state = join(root, 'state');
  let locker: Database | undefined;
  let reader: Database | undefined;
  let passed = false;
  let cleanupFailed = false;
  try {
    const ledger = initializeLedgerV2({ stateDirectory: state });
    ledger.close();
    const path = join(state, 'ledger.sqlite');
    locker = new Database(path, {
      readwrite: true,
      create: false,
      strict: true,
    });
    expect(locker.query('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    });
    expect(locker.query('PRAGMA locking_mode = EXCLUSIVE').get()).toEqual({
      locking_mode: 'exclusive',
    });
    locker.run('BEGIN EXCLUSIVE');
    locker.query('SELECT COUNT(*) FROM sqlite_schema').get();
    reader = new Database(path, {
      readwrite: true,
      create: false,
      strict: true,
    });
    reader.run('PRAGMA busy_timeout = 20');
    let observed: string | undefined;
    try {
      reader.query('SELECT COUNT(*) FROM sqlite_schema').get();
    } catch (error) {
      if (!(error instanceof SQLiteError)) throw error;
      observed = error.code;
    }
    expect(observed).toBeDefined();
    if (observed === undefined)
      throw new Error(
        'Native busy fixture preparation failed to produce a SQLite lock receipt.',
      );
    expect(observed).toMatch(/^SQLITE_(BUSY|LOCKED)/);
    reader.close(true);
    reader = undefined;
    locker.run('ROLLBACK');
    locker.close(true);
    locker = undefined;
    const available = readRetrySnapshot(
      { stateDirectory: state },
      'a'.repeat(64),
    );
    expect(available.availability).toBe('available');
    console.info(
      JSON.stringify({
        receipt: 'HISTORY_NATIVE_BUSY_PREPARATION_OK',
        sqliteCode: observed,
        setup:
          'private initialized WAL, locking_mode EXCLUSIVE, BEGIN EXCLUSIVE, schema read, independent connection',
        release:
          'reader closed; actual rollback and native locker close; independent real snapshot available',
      }),
    );
    passed = true;
  } finally {
    for (const database of [reader, locker]) {
      if (database === undefined) continue;
      try {
        if (database.inTransaction) database.run('ROLLBACK');
        database.close(true);
      } catch {
        cleanupFailed = true;
      }
    }
    if (passed && !cleanupFailed) rmSync(root, { recursive: true });
    else
      console.error(
        JSON.stringify({
          receipt: 'PRESERVED_FIXTURE_ROOT',
          root,
          cleanupFailed,
        }),
      );
  }
  if (cleanupFailed) throw new Error('Native preparation cleanup failed.');
});

const syntheticKey = 'history-native-synthetic-key';
const selectedBinding = submissionCredentialFingerprint(syntheticKey);
const utc = Date.parse('2026-10-23T12:00:00Z');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const parentId = ' Native Parent Ω ';
type FixtureRow = z.infer<typeof fixtureSchema>['rows'][number];
type Ok = Extract<RetryHistoryResult, { status: 'ok' }>;
type ErrorCode = Extract<
  RetryHistoryResult,
  { status: 'error' }
>['error']['code'];
async function nativeCase(
  body: (f: ReturnType<typeof nativeFixture>) => Promise<void> | void,
) {
  const f = nativeFixture();
  let passed = false;
  try {
    await body(f);
    passed = true;
  } finally {
    await f.cleanup(passed);
  }
}
function nativeFixture() {
  const root = privateRoot();
  const closers = new Set<() => void>();
  const releases = new Set<() => void>();
  const pending: Promise<unknown>[] = [];
  const savedFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = new Proxy(savedFetch, {
    apply() {
      attempts++;
      throw new Error('SYNTHETIC_HISTORY_DENIED_HTTP');
    },
  });
  const track = <T extends { close(): void }>(handle: T) => {
    closers.add(() => handle.close());
    return handle;
  };
  const raw = (state: string) => {
    const db = new Database(join(state, 'ledger.sqlite'), {
      readwrite: true,
      create: false,
      strict: true,
    });
    closers.add(() => db.close(true));
    return db;
  };
  const configure = (
    state: string,
    overrides: Partial<SubmissionPolicy> = {},
    key = syntheticKey,
    loader: Partial<SubmissionConfigurationOptions> = {},
  ) => {
    const policy: SubmissionPolicy = {
      version: 1,
      enabled: true,
      mode: 'operator_policy',
      policyRevision: 'history-native',
      budgetScope: 'history-native',
      credentialFingerprint: submissionCredentialFingerprint(key),
      period: { kind: 'utc_day' },
      caps: { tokens: 100_000, indexer: 100_000, checker: 100_000 },
      retry: {
        enabled: true,
        allowUnattributedParents: false,
        maxAttemptsPerSource: 20,
      },
      ...overrides,
    };
    const policyPath = join(
      root,
      'policy-' + closers.size + '-' + hash(JSON.stringify(policy)) + '.json',
    );
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    return loadSubmissionConfiguration({
      policyPath,
      stateDirectory: state,
      apiKey: key,
      ...loader,
    });
  };
  const configured = (
    state: string,
    overrides: Partial<SubmissionPolicy> = {},
    key = syntheticKey,
  ) => {
    const config = configure(state, overrides, key);
    if (config.state !== 'configured')
      throw new Error('Synthetic history configuration failed.');
    return config;
  };
  const host = async (
    config: ReturnType<typeof loadSubmissionConfiguration>,
    options: SubmissionHostOptions = {},
  ) => {
    const Host = (await import('../src/submission-host')).SubmissionHost;
    return new Host(config, options);
  };
  const barrier = () => {
    let arrive: () => void = () => {
      throw new Error('Uninitialized barrier.');
    };
    let release: () => void = () => {
      throw new Error('Uninitialized barrier.');
    };
    const entered = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.add(release);
    return {
      entered,
      release,
      hold: async () => {
        arrive();
        await wait;
      },
    };
  };
  return {
    root,
    raw,
    track,
    configure,
    configured,
    host,
    barrier,
    pending,
    attempts: () => attempts,
    init: (state: string, version: 1 | 2 = 2) =>
      track(
        (version === 1 ? initializeLedger : initializeLedgerV2)({
          stateDirectory: state,
        }),
      ),
    async cleanup(passed: boolean) {
      const failures: unknown[] = [];
      for (const release of releases) release();
      await Promise.allSettled(pending);
      for (const close of [...closers].reverse()) {
        try {
          close();
        } catch (error) {
          failures.push(error);
        }
      }
      globalThis.fetch = savedFetch;
      if (passed && failures.length === 0) rmSync(root, { recursive: true });
      else
        console.error(
          JSON.stringify({
            receipt: 'PRESERVED_FIXTURE_ROOT',
            root,
            closeFailures: failures.length,
          }),
        );
      if (failures.length)
        throw new AggregateError(failures, 'Native history cleanup failed.');
    },
  };
}
function resultOk(envelope: RetryHistoryToolResult): Ok {
  expect(envelope.isError).toBe(false);
  const value = envelope.structuredContent;
  expect(value.status).toBe('ok');
  if (value.status !== 'ok')
    throw new Error(
      'Expected native history success: ' + JSON.stringify(value),
    );
  const text = envelope.content[0]?.text;
  if (text === undefined) throw new Error('Missing native envelope text.');
  const parsed: unknown = JSON.parse(text);
  expect(parsed).toEqual(value);
  expect(
    Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
  ).toBeLessThanOrEqual(2_097_152);
  return value;
}
function resultError(envelope: RetryHistoryToolResult, code: ErrorCode) {
  expect(envelope.isError).toBe(true);
  const value = envelope.structuredContent;
  expect(value.status).toBe('error');
  if (value.status !== 'error')
    throw new Error('Expected native history error.');
  expect(value.error.code).toBe(code);
  expect(JSON.stringify(envelope)).not.toContain('SYNTHETIC_');
}
function intent(
  config: ConfiguredSubmission,
  id: string,
  urls: readonly string[],
  engine: 'google' | 'yandex' = 'google',
  index = 0,
): PrepareIntentInput {
  const built = buildCreateIndexingRequest({
    mode: 'preview',
    searchEngine: engine,
    urls,
  });
  const context = createSubmissionContext(
    config,
    built.quote.fingerprint,
    utc - index * 86_400_000,
  );
  return {
    requestId: id,
    budget: {
      ...context.budget,
      budgetScope: 'history-scope-' + index,
      policyRevision: 'history-policy-' + index,
    },
    taskFamily: engine === 'google' ? 'google/indexer' : 'yandex/indexer',
    providerRoute: built.request.providerRoute,
    payloadDigest: built.request.payloadDigest,
    submittedUrls: urls,
    quoteVersion: built.quote.version,
    quoteFingerprint: built.quote.fingerprint,
    reservation: built.quote.maximumExposure,
  };
}
function created(
  value: PrepareResult,
): Extract<PrepareResult, { kind: 'created' }> {
  if (value.kind !== 'created')
    throw new Error('Fixture requires a new real prepared intent.');
  return value;
}
function transition(
  writer: SubmissionLedger,
  config: ConfiguredSubmission,
  id: string,
  capability: DispatchCapability,
  state: IntentState,
  family: PrepareIntentInput['taskFamily'],
  provider = ' Native ACK ' + id + ' Ω ',
) {
  if (state === 'prepared') return;
  if (state === 'cancelled') {
    expect(
      writer.cancelPrepared(config.credential.fingerprint, id, 0).kind,
    ).toBe('cancelled');
    return;
  }
  const claim = writer.claimDispatch(capability, 0);
  if (claim.kind !== 'claimed')
    throw new Error('Fixture requires actual native claim.');
  if (state === 'dispatching') return;
  writer.recordDispatchOutcome({
    credentialFingerprint: config.credential.fingerprint,
    requestId: id,
    expectedStateVersion: 1,
    outcomeToken: claim.outcomeToken,
    outcome:
      state === 'accepted'
        ? { kind: 'accepted', providerTaskId: provider, providerType: family }
        : { kind: state },
  });
}
function seedNative(
  f: ReturnType<typeof nativeFixture>,
  state: string,
  config: ConfiguredSubmission,
  rows: readonly FixtureRow[],
  prefix = '',
) {
  const writer = f.track(openRetryLedgerV2({ stateDirectory: state }));
  const parents = new Map<
    'google' | 'yandex',
    { family: 'google/indexer' | 'yandex/indexer'; taskId: string }
  >();
  for (const engine of ['google', 'yandex'] as const) {
    if (!rows.some((row) => row.engine === engine)) continue;
    const urls = Array.from(
      { length: 20 },
      (_, i) => `https://history.test/${prefix}${engine}/${i}`,
    );
    const original = intent(config, prefix + 'source-' + engine, urls, engine);
    const parent = created(writer.prepareIntent(original));
    transition(
      writer,
      config,
      original.requestId,
      parent.dispatchCapability,
      'accepted',
      original.taskFamily,
      parentId,
    );
    parents.set(engine, {
      family: engine === 'google' ? 'google/indexer' : 'yandex/indexer',
      taskId: parentId,
    });
  }
  const prepared = rows.map((row, index) => {
    const parent = parents.get(row.engine);
    if (parent === undefined) throw new Error('Missing fixture parent.');
    const snapshot = readRetrySnapshot(
      { stateDirectory: state },
      config.credential.fingerprint,
    );
    if (snapshot.availability !== 'available')
      throw new Error('Fixture snapshot failed.');
    const manifest = snapshot.acceptedManifests.find(
      (m) =>
        m.taskFamily === parent.family && m.providerTaskId === parent.taskId,
    );
    const url = manifest?.submittedUrls[index];
    if (manifest === undefined || url === undefined)
      throw new Error('Missing fixture source URL.');
    const value = intent(
      config,
      prefix + row.requestId,
      [url],
      row.engine,
      index,
    );
    const entry = created(
      writer.prepareRetryIntent({
        intent: value,
        parent,
        sourceManifestDigest: manifest.manifestDigest,
        planFingerprint: hash('fixture-plan-' + index),
        expectedRevision: snapshot.revision,
      }),
    );
    return { row, value, capability: entry.dispatchCapability };
  });
  for (const item of prepared)
    transition(
      writer,
      config,
      item.value.requestId,
      item.capability,
      item.row.state,
      item.value.taskFamily,
    );
  writer.close();
}
function logical(database: Database) {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all();
  return {
    version: database.query('PRAGMA user_version').get(),
    schema: database
      .query(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name',
      )
      .values(),
    tables: tables.map(({ name }) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected fixture table.');
      const columns = database
        .query<{ name: string }, []>(`PRAGMA table_info("${name}")`)
        .all();
      return [
        name,
        database
          .query(
            `SELECT ${columns.map((c) => `CAST("${c.name}" AS TEXT)`).join(',')} FROM "${name}" ORDER BY rowid`,
          )
          .values(),
      ];
    }),
  };
}

test('GRH-PREP-02 saved seed helper creates actual six-state cross-period V2 rows with independent SQL receipt', async () => {
  await nativeCase((f) => {
    const path = join(f.root, 'seed.json');
    writeFileSync(path, savedSeed, { mode: 0o600 });
    const seed = readSeed(path);
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seed.rows);
    const db = f.raw(state);
    const rows = db
      .query<{ state: string; n: string }, [string]>(
        "SELECT i.state, CAST(COUNT(*) AS TEXT) AS n FROM intents i JOIN intent_context c USING(credential_fp,request_id) WHERE i.credential_fp=? AND c.origin_kind='retry' GROUP BY i.state ORDER BY i.state",
      )
      .all(selectedBinding);
    expect(rows).toEqual([
      { state: 'accepted', n: '2' },
      { state: 'cancelled', n: '1' },
      { state: 'dispatching', n: '1' },
      { state: 'prepared', n: '1' },
      { state: 'rejected', n: '1' },
      { state: 'unknown', n: '1' },
    ]);
    expect(
      db
        .query<{ n: number }, []>(
          'SELECT COUNT(DISTINCT period_id) AS n FROM intents',
        )
        .get()?.n,
    ).toBe(7);
    console.info(
      JSON.stringify({
        receipt: 'HISTORY_NATIVE_SEED_SANITY_OK',
        states: rows,
        periods: 7,
        logicalTables: logical(db).tables.length,
      }),
    );
  });
});

const seedRows = fixtureSchema.parse(JSON.parse(savedSeed)).rows;
const ownerPhases: readonly HistoryOwnerPhase[] = [
  'before_read',
  'after_read',
  'after_read_io',
  'after_projection',
  'after_envelope',
  'before_budget_close',
  'after_budget_close',
  'before_publish',
];

test('GRH-07 actual loaded enabled/absent/disabled retry and old-day/small-cap configurations retain diagnostic reads', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const original = f.configured(state);
    seedNative(f, state, original, seedRows);
    const db = f.raw(state),
      before = logical(db);
    for (const mode of ['enabled', 'absent', 'disabled'] as const) {
      const policy = {
        ...original.snapshot.policy,
        caps: { tokens: 1, indexer: 1, checker: 1 },
      };
      if (mode === 'absent') delete policy.retry;
      if (mode === 'disabled')
        policy.retry = {
          enabled: false,
          allowUnattributedParents: false,
          maxAttemptsPerSource: 1,
        };
      const path = join(f.root, 'loaded-' + mode + '.json');
      writeFileSync(path, JSON.stringify(policy), { mode: 0o600 });
      const loaded = loadSubmissionConfiguration({
        policyPath: path,
        stateDirectory: state,
        apiKey: syntheticKey,
      });
      expect(loaded.state).toBe('configured');
      let reads = 0;
      const host = await f.host(loaded, {
        clock: () => utc + 10 * 86_400_000,
        history: {
          onPhase(phase) {
            if (phase === 'before_read') reads++;
          },
        },
      });
      expect(reads).toBe(0);
      expect(logical(db)).toEqual(before);
      expect(
        resultOk(await host.getRetryHistoryToolResult({})).counts
          .localRetryAttempts,
      ).toBe(7);
      expect(reads).toBe(1);
      expect(logical(db)).toEqual(before);
    }
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-07 inactive loader states and invalid inputs never enter SQL; mutable original configuration and selectors cannot redirect', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'missing');
    let reads = 0;
    for (const resultBytes of [undefined, 346]) {
      for (const config of [
        loadSubmissionConfiguration({}),
        f.configure(state, { enabled: false }),
        f.configure(state, {}, syntheticKey, {
          policyPath: join(f.root, 'nonexistent-policy'),
        }),
        f.configure(state, {}, syntheticKey, { apiKey: null }),
        f.configure(state, {}, syntheticKey, { apiKey: 'different-key' }),
      ]) {
        const host = await f.host(config, {
          history: {
            ...(resultBytes === undefined ? {} : { resultBytes }),
            onPhase() {
              reads++;
            },
          },
        });
        const value = await host.getRetryHistoryToolResult({});
        const expected = {
          status: 'blocked',
          reason: {
            code: 'ReadConfigurationUnavailable',
            message: 'Retry history requires configured local state.',
          },
        } as const;
        expect(value).toEqual({
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(expected) }],
          structuredContent: expected,
        });
        expect(
          Buffer.byteLength(JSON.stringify(value), 'utf8'),
        ).toBeLessThanOrEqual(resultBytes ?? 2_097_152);
      }
    }
    expect(reads).toBe(0);
    expect(existsSync(state)).toBe(false);
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const mutable = { ...config, credential: { ...config.credential } };
    const gate = f.barrier();
    let once = true;
    const host = await f.host(mutable, {
      history: {
        afterReadIO: async () => {
          if (once) {
            once = false;
            await gate.hold();
          }
        },
      },
    });
    mutable.stateDirectory = join(f.root, 'wrong');
    mutable.credential.fingerprint = 'f'.repeat(64);
    const selectors = { state: 'prepared' };
    const operation = host.getRetryHistoryToolResult(selectors);
    f.pending.push(operation);
    await gate.entered;
    selectors.state = 'cancelled';
    gate.release();
    const result = resultOk(await operation);
    expect(result.entries.map((entry) => entry.state)).toEqual(['prepared']);
    resultError(
      await host.getRetryHistoryToolResult({ key: 'SYNTHETIC_EXTRA' }),
      'InvalidInput',
    );
    expect(f.attempts()).toBe(0);
    expect(existsSync(mutable.stateDirectory)).toBe(false);
  });
});

test('GRH-08 missing/V1/empty/standalone/migrated-legacy stores have distinct honest reusable outcomes', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state'),
      host = await f.host(f.configured(state));
    expect(
      (await host.getRetryHistoryToolResult({})).structuredContent,
    ).toMatchObject({ status: 'blocked', reason: { code: 'StateMissing' } });
    expect(existsSync(state)).toBe(false);
    const v1 = f.init(state, 1);
    v1.close();
    expect(
      (await host.getRetryHistoryToolResult({})).structuredContent,
    ).toMatchObject({ status: 'blocked', reason: { code: 'V2Required' } });
    const v1Oracle = f.raw(state);
    expect(v1Oracle.query('PRAGMA user_version').get()).toEqual({
      user_version: 1,
    });
    v1Oracle.close(true);
    // Separate owned empty V2; no automatic init/migration in the history owner.
    const empty = join(f.root, 'empty');
    f.init(empty).close();
    expect(
      resultOk(
        await (await f.host(f.configured(empty))).getRetryHistoryToolResult({}),
      ).entries,
    ).toEqual([]);
    // Seed one real V1 accepted record and perform the explicit existing offline migration.
    const config = f.configured(state),
      writer = f.track(openLedger({ stateDirectory: state }));
    const value = intent(config, 'legacy-record', [
      'https://history.test/legacy',
    ]);
    transition(
      writer,
      config,
      value.requestId,
      created(writer.prepareIntent(value)).dispatchCapability,
      'accepted',
      value.taskFamily,
    );
    writer.close();
    expect(
      migrateLedgerV2({
        stateDirectory: state,
        backupDirectory: join(f.root, 'backup'),
      }).migrated,
    ).toBe(true);
    const before = logical(f.raw(state));
    const legacy = resultOk(await host.getRetryHistoryToolResult({}));
    expect(legacy.entries).toEqual([]);
    expect(legacy.counts.legacyUnattributedLocalRecords).toBe(1);
    expect(legacy.coverage.coverageInception).toBe('unknown');
    expect(logical(f.raw(state))).toEqual(before);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-08 invalid schema and missing grouped event return fixed StateUnavailable without repair or permanent poison', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const db = f.raw(state),
      host = await f.host(config);
    db.run('PRAGMA user_version = 99');
    const invalid = logical(db);
    resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
    expect(logical(db)).toEqual(invalid);
    db.run('PRAGMA user_version = 2');
    resultOk(await host.getRetryHistoryToolResult({}));
    db.query(
      "DELETE FROM intent_events WHERE credential_fp=? AND request_id='fixture-unknown' AND state_version=1",
    ).run(selectedBinding);
    const broken = logical(db);
    resultError(
      await host.getRetryHistoryToolResult({ state: 'accepted' }),
      'StateUnavailable',
    );
    expect(logical(db)).toEqual(broken);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-09 real six-state cross-scope/policy/period SQL rows and provider IDs match an independent selected-key hash/count oracle', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    seedNative(
      f,
      state,
      f.configured(state, {}, 'history-other-key'),
      seedRows,
      'other-',
    );
    const db = f.raw(state),
      before = logical(db),
      host = await f.host(config);
    const ledgerId = db
      .query<{ ledger_id: string }, []>(
        'SELECT ledger_id FROM retry_ledger_meta',
      )
      .get()?.ledger_id;
    if (ledgerId === undefined)
      throw new Error('Missing private fixture ledger identity.');
    const rows = db
      .query<
        {
          request_id: string;
          task_family: string;
          state: IntentState;
          version: string;
          provider_task_id: string | null;
          attempts: string;
        },
        [string]
      >(
        `SELECT i.request_id,i.task_family,i.state,CAST(i.state_version AS TEXT) AS version,i.provider_task_id,
      CAST((SELECT COUNT(*) FROM intent_context p WHERE p.credential_fp=c.credential_fp AND p.origin_kind='retry'
      AND p.parent_family=c.parent_family AND p.parent_task_id=c.parent_task_id) AS TEXT) AS attempts
      FROM intents i JOIN intent_context c USING(credential_fp,request_id) WHERE c.credential_fp=? AND c.origin_kind='retry'`,
      )
      .all(selectedBinding);
    const expected = rows
      .map((row) => ({
        row,
        ref: createHash('sha256')
          .update(
            'speedyindex-retry-history-attempt-v1\0' +
              JSON.stringify([ledgerId, selectedBinding, row.request_id]),
          )
          .digest('hex'),
      }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    const value = resultOk(await host.getRetryHistoryToolResult({}));
    expect(
      value.entries.map((entry) => [
        entry.attemptRef,
        entry.family,
        entry.state,
        String(entry.stateVersion),
        entry.providerTaskId,
        String(entry.source.recordedAttempts),
      ]),
    ).toEqual(
      expected.map(({ row, ref }) => [
        ref,
        row.task_family,
        row.state,
        row.version,
        row.provider_task_id,
        row.attempts,
      ]),
    );
    expect(value.counts.localRetryAttempts).toBe(7);
    for (const entry of value.entries) {
      expect(entry.source.taskId).toBe(parentId);
      expect(entry.source.attribution).toBe('local_standalone_manifest');
      expect(entry.unresolvedHold).toBe(
        ['prepared', 'dispatching', 'unknown'].includes(entry.state),
      );
      if (['accepted', 'rejected', 'cancelled'].includes(entry.state)) {
        expect(entry.createdAtMs).toBeNull();
        expect(entry.reservation).toBeNull();
      }
      expect(entry.submittedUrlCount).toBe(
        entry.state === 'rejected' || entry.state === 'cancelled' ? null : 1,
      );
    }
    const filtered = resultOk(
      await host.getRetryHistoryToolResult({
        searchEngine: 'google',
        parentTaskId: parentId,
        state: 'accepted',
      }),
    );
    expect(filtered.counts.matchingRetryAttempts).toBe(1);
    expect(filtered.entries[0]?.source.recordedAttempts).toBe(6);
    for (const marker of [
      'other-fixture',
      'history-other-key',
      'history-policy-',
      'history-scope-',
      'https://history.test/',
      ledgerId,
      selectedBinding,
    ])
      expect(JSON.stringify(value)).not.toContain(marker);
    expect(logical(db)).toEqual(before);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-09 documented legacy SQL ambiguity is preserved and never converted to invented source ancestry', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const writer = f.track(openLedger({ stateDirectory: state }));
    const value = intent(config, 'duplicate-legacy-reference', [
      'https://history.test/duplicate',
    ]);
    transition(
      writer,
      config,
      value.requestId,
      created(writer.prepareIntent(value)).dispatchCapability,
      'accepted',
      value.taskFamily,
      'temporary-unique',
    );
    writer.close();
    const db = f.raw(state);
    // Explicit fixture-only simulation of historical duplicate accepted ACK references.
    db.query(
      "UPDATE intents SET provider_task_id=? WHERE credential_fp=? AND request_id='duplicate-legacy-reference'",
    ).run(parentId, selectedBinding);
    db.query(
      "UPDATE intent_events SET provider_task_id=? WHERE credential_fp=? AND request_id='duplicate-legacy-reference' AND event_kind='accepted'",
    ).run(parentId, selectedBinding);
    const before = logical(db),
      host = await f.host(config),
      result = resultOk(
        await host.getRetryHistoryToolResult({ searchEngine: 'google' }),
      );
    expect(result.counts.ambiguousLocalProviderReferences).toBe(1);
    expect(
      result.entries.every(
        (entry) =>
          entry.source.attribution === 'ambiguous_local_reference' &&
          entry.source.originalAncestry === 'unknown',
      ),
    ).toBe(true);
    expect(logical(db)).toEqual(before);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-10 pinned history stays coherent during a second-connection retry commit and refuses stale continuation without rereading', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(
      f,
      state,
      config,
      seedRows.slice(0, 3).map((row) => ({ ...row, state: 'cancelled' })),
    );
    const writer = f.track(openRetryLedgerV2({ stateDirectory: state }));
    const initial = readRetrySnapshot(
      { stateDirectory: state },
      selectedBinding,
    );
    if (initial.availability !== 'available')
      throw new Error('Missing pinned fixture snapshot.');
    const parent = initial.acceptedManifests.find(
        (m) => m.providerTaskId === parentId,
      ),
      url = parent?.submittedUrls[17];
    if (parent === undefined || url === undefined)
      throw new Error('Missing pinned fixture source.');
    const added = intent(config, 'concurrent-child', [url]);
    let once = true,
      reads = 0;
    const host = await f.host(config, {
      history: {
        onPhase(phase) {
          if (phase === 'before_read') reads++;
        },
        snapshotHooks: {
          onPhase(phase) {
            if (once && phase === 'snapshot_fixed') {
              once = false;
              created(
                writer.prepareRetryIntent({
                  intent: added,
                  parent: { family: 'google/indexer', taskId: parentId },
                  sourceManifestDigest: parent.manifestDigest,
                  planFingerprint: hash('concurrent'),
                  expectedRevision: initial.revision,
                }),
              );
            }
          },
        },
      },
    });
    const first = resultOk(await host.getRetryHistoryToolResult({ limit: 1 }));
    expect(first.snapshot.revision).toBe(initial.revision);
    expect(first.counts.localRetryAttempts).toBe(3);
    expect(reads).toBe(1);
    const current = readRetrySnapshot(
      { stateDirectory: state },
      selectedBinding,
    );
    if (current.availability !== 'available')
      throw new Error('Missing concurrent fixture snapshot.');
    expect(current.retryChildren.length).toBe(4);
    expect(current.revision).not.toBe(initial.revision);
    if (first.page.nextCursor === null)
      throw new Error('Missing continuation.');
    resultError(
      await host.getRetryHistoryToolResult({
        limit: 1,
        cursor: first.page.nextCursor,
      }),
      'SnapshotChanged',
    );
    expect(reads).toBe(2);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-10 another-key commit leaves continuation valid while documented retained-row deletion invalidates it', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(
      f,
      state,
      config,
      seedRows.slice(0, 3).map((row) => ({ ...row, state: 'cancelled' })),
    );
    const host = await f.host(config),
      first = resultOk(await host.getRetryHistoryToolResult({ limit: 1 }));
    if (first.page.nextCursor === null)
      throw new Error('Missing continuation.');
    const other = f.configured(state, {}, 'history-other-key'),
      writer = f.track(openLedger({ stateDirectory: state }));
    created(
      writer.prepareIntent(
        intent(other, 'other-key-new', ['https://history.test/other-new']),
      ),
    );
    writer.close();
    expect(
      resultOk(
        await host.getRetryHistoryToolResult({
          limit: 1,
          cursor: first.page.nextCursor,
        }),
      ).snapshot.revision,
    ).toBe(first.snapshot.revision);
    const db = f.raw(state);
    // Explicit offline fixture retention simulation, not a production retention feature.
    db.transaction(() => {
      for (const table of [
        'intent_context',
        'intent_urls',
        'intent_events',
        'intents',
      ])
        db.query(
          `DELETE FROM ${table} WHERE credential_fp=? AND request_id=?`,
        ).run(selectedBinding, 'fixture-prepared');
    })();
    resultError(
      await host.getRetryHistoryToolResult({
        limit: 1,
        cursor: first.page.nextCursor,
      }),
      'SnapshotChanged',
    );
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-11 full native intent/event/URL/byte ceilings precede disjoint filters and every outcome leaves logical rows unchanged', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const db = f.raw(state),
      before = logical(db);
    for (const limits of [
      { intents: 0 },
      { events: 0 },
      { urls: 0 },
      { bytes: 0 },
    ]) {
      const host = await f.host(config, {
        history: { snapshotHooks: { limits } },
      });
      resultError(
        await host.getRetryHistoryToolResult({
          searchEngine: 'yandex',
          state: 'cancelled',
          limit: 1,
        }),
        'ResourceLimitExceeded',
      );
      expect(logical(db)).toEqual(before);
    }
    const limits = { intents: 100 },
      host = await f.host(config, { history: { snapshotHooks: { limits } } });
    limits.intents = 0;
    resultOk(await host.getRetryHistoryToolResult({}));
    resultOk(await host.getRetryHistoryToolResult({ state: 'rejected' }));
    resultError(
      await host.getRetryHistoryToolResult({ limit: 0 }),
      'InvalidInput',
    );
    expect(logical(db)).toEqual(before);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-12 safe exact stored IDs and signed-int64/reservation observations survive without Date coercion or maximum-wall-time selection', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const db = f.raw(state),
      safe = ' Native ' + 'é'.repeat(2000) + ' Ω ';
    db.query(
      "UPDATE intents SET provider_task_id=? WHERE credential_fp=? AND request_id='fixture-accepted'",
    ).run(safe, selectedBinding);
    db.query(
      "UPDATE intent_events SET provider_task_id=? WHERE credential_fp=? AND request_id='fixture-accepted' AND event_kind='accepted'",
    ).run(safe, selectedBinding);
    db.query(
      "UPDATE intents SET created_at_ms=CAST(? AS INTEGER),reserved_tokens=CAST(? AS INTEGER),reserved_indexer=CAST(? AS INTEGER),reserved_checker=0 WHERE credential_fp=? AND request_id='fixture-unknown'",
    ).run(
      '-9223372036854775808',
      '9223372036854775807',
      '9007199254740993',
      selectedBinding,
    );
    for (const [version, time] of [
      [0, '-9223372036854775808'],
      [1, '9223372036854775807'],
      [2, '-9'],
    ] as const)
      db.query(
        "UPDATE intent_events SET occurred_at_ms=CAST(? AS INTEGER) WHERE credential_fp=? AND request_id='fixture-unknown' AND state_version=?",
      ).run(time, selectedBinding, version);
    const before = logical(db),
      host = await f.host(config),
      value = resultOk(await host.getRetryHistoryToolResult({}));
    expect(
      value.entries.find(
        (e) => e.state === 'accepted' && e.family === 'google/indexer',
      )?.providerTaskId,
    ).toBe(safe);
    const unknown = value.entries.find((e) => e.state === 'unknown');
    expect(unknown?.createdAtMs).toBe('-9223372036854775808');
    expect(unknown?.latestStateAtMs).toBe('-9');
    expect(unknown?.reservation).toEqual({
      tokens: '9223372036854775807',
      indexer: '9007199254740993',
      checker: '0',
    });
    expect(
      db
        .query(
          "SELECT CAST(reserved_tokens AS TEXT) AS tokens FROM intents WHERE request_id='fixture-unknown'",
        )
        .get(),
    ).toEqual({ tokens: '9223372036854775807' });
    expect(logical(db)).toEqual(before);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-12 unsafe or oversized accepted IDs outside the selected page block the complete native projection without omission', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const db = f.raw(state),
      host = await f.host(config);
    for (const bad of ['bad\nprovider-SYNTHETIC_PRIVATE', 'é'.repeat(2049)]) {
      db.query(
        "UPDATE intents SET provider_task_id=? WHERE credential_fp=? AND request_id='fixture-accepted'",
      ).run(bad, selectedBinding);
      db.query(
        "UPDATE intent_events SET provider_task_id=? WHERE credential_fp=? AND request_id='fixture-accepted' AND event_kind='accepted'",
      ).run(bad, selectedBinding);
      const before = logical(db);
      resultError(
        await host.getRetryHistoryToolResult({
          searchEngine: 'yandex',
          limit: 1,
        }),
        'StateUnavailable',
      );
      expect(logical(db)).toEqual(before);
    }
    expect(f.attempts()).toBe(0);
  });
});

for (const resultBytes of [undefined, 346])
  for (const boundary of ['read', 'close'] as const)
    test(`GRH-13 independent history guard remains held through actual native close and ${boundary} receipt barrier${resultBytes === undefined ? '' : ' at minimum 346'}`, async () => {
      await nativeCase(async (f) => {
        const state = join(f.root, 'state');
        f.init(state).close();
        const config = f.configured(state),
          gate = f.barrier();
        const db = f.raw(state),
          before = logical(db);
        let once = true,
          nativeCloses = 0,
          settled = false;
        const hold = async () => {
          if (once) {
            once = false;
            await gate.hold();
          }
        };
        const history: RetryHistoryOwnerOptions = {
          ...(resultBytes === undefined ? {} : { resultBytes }),
          snapshotHooks: {
            afterNativeClose() {
              nativeCloses++;
            },
          },
          ...(boundary === 'read'
            ? { afterReadIO: hold }
            : { afterBudgetClose: hold }),
        };
        const host = await f.host(config, { history }),
          operation = host.getRetryHistoryToolResult({});
        f.pending.push(operation);
        void operation.then(() => {
          settled = true;
        });
        await gate.entered;
        expect(nativeCloses).toBe(1);
        expect(settled).toBe(false);
        expect(logical(db)).toEqual(before);
        const refused = await host.getRetryHistoryToolResult({});
        const busyValue = {
          status: 'error',
          error: {
            code: 'HistoryBusy',
            message:
              'Another history read or incompatible state operation is active.',
          },
        } as const;
        expect(refused).toEqual({
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(busyValue) }],
          structuredContent: busyValue,
        });
        expect(nativeCloses).toBe(1);
        expect(logical(db)).toEqual(before);
        gate.release();
        const result = await operation;
        expect(settled).toBe(true);
        const reused = await host.getRetryHistoryToolResult({});
        if (resultBytes === undefined) {
          resultOk(result);
          resultOk(reused);
        } else {
          resultError(result, 'ResourceLimitExceeded');
          resultError(reused, 'ResourceLimitExceeded');
        }
        for (const value of [refused, result, reused])
          expect(
            Buffer.byteLength(JSON.stringify(value), 'utf8'),
          ).toBeLessThanOrEqual(resultBytes ?? 2_097_152);
        expect(nativeCloses).toBe(2);
        expect(logical(db)).toEqual(before);
        expect(f.attempts()).toBe(0);
      });
    });

test('GRH-13 actual prepared WAL exclusive native busy maps to HistoryBusy and the same host recovers after native release', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state),
      locker = f.raw(state);
    locker.query('PRAGMA locking_mode=EXCLUSIVE').get();
    locker.run('BEGIN EXCLUSIVE');
    locker.query('SELECT COUNT(*) FROM sqlite_schema').get();
    const host = await f.host(config);
    resultError(await host.getRetryHistoryToolResult({}), 'HistoryBusy');
    locker.run('ROLLBACK');
    locker.close(true);
    resultOk(await host.getRetryHistoryToolResult({}));
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-13 native close notification throw/nonvoid/async returns are fixed opaque failures, run once, and latch only history', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state),
      before = logical(f.raw(state));
    for (const mode of ['throw', 'value', 'async'] as const) {
      let closes = 0;
      const notify = () => {
        closes++;
        if (mode === 'throw') throw new Error('SYNTHETIC_CLOSE_RECEIPT');
        if (mode === 'value') return 1;
        if (mode === 'async') return Promise.resolve();
      };
      const host = await f.host(config, {
        history: { snapshotHooks: { afterNativeClose: notify } },
      });
      resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
      expect(closes).toBe(1);
      resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
      expect(closes).toBe(1);
      expect(
        (
          await host.createIndexingTask({
            mode: 'preview',
            searchEngine: 'google',
            urls: ['https://history.test/preview'],
          })
        ).status,
      ).toBe('preview');
      expect(logical(f.raw(state))).toEqual(before);
    }
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-13 every owner phase-hook failure still settles its original budget and permits clean reuse', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    for (const target of ownerPhases) {
      const phases: HistoryOwnerPhase[] = [];
      let once = true,
        closes = 0;
      const host = await f.host(config, {
        history: {
          onPhase(phase) {
            phases.push(phase);
            if (once && phase === target) {
              once = false;
              throw new Error('SYNTHETIC_PHASE');
            }
          },
          snapshotHooks: {
            afterNativeClose() {
              closes++;
            },
          },
        },
      });
      resultError(await host.getRetryHistoryToolResult({}), 'InternalError');
      expect(phases).toContain('before_budget_close');
      expect(phases).toContain('after_budget_close');
      expect(closes).toBe(target === 'before_read' ? 0 : 1);
      resultOk(await host.getRetryHistoryToolResult({}));
    }
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-13 reader phase failures always attempt actual native close and latch conservatively without claiming a close cause', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    for (const target of [
      'snapshot_fixed',
      'before_projection',
      'before_close',
    ] as const) {
      let closes = 0;
      const host = await f.host(config, {
        history: {
          snapshotHooks: {
            onPhase(phase) {
              if (phase === target) throw new Error('SYNTHETIC_READER_PHASE');
            },
            afterNativeClose() {
              closes++;
            },
          },
        },
      });
      resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
      expect(closes).toBe(1);
      resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
      expect(closes).toBe(1);
    }
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-13 post-real-budget-close decorator rejection suppresses pending success and permanently latches history', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    let closes = 0;
    const phases: HistoryOwnerPhase[] = [];
    const host = await f.host(config, {
      history: {
        onPhase(phase) {
          phases.push(phase);
        },
        snapshotHooks: {
          afterNativeClose() {
            closes++;
          },
        },
        async afterBudgetClose() {
          throw new Error('SYNTHETIC_SETTLEMENT_RECEIPT');
        },
      },
    });
    resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
    expect(closes).toBe(1);
    expect(phases).toContain('after_budget_close');
    resultError(await host.getRetryHistoryToolResult({}), 'StateUnavailable');
    expect(closes).toBe(1);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-14 actual create paid guard and planner cleanup poison do not become diagnostic read authority gates', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    seedNative(f, state, config, seedRows);
    const host = await f.host(config),
      controller = new AbortController();
    const create = host.createIndexingTask(
      {
        mode: 'submit',
        searchEngine: 'google',
        requestId: 'owned-cancelled-create',
        urls: ['https://history.test/concurrent-create'],
      },
      controller.signal,
    );
    f.pending.push(create);
    const history = host.getRetryHistoryToolResult({});
    f.pending.push(history);
    const busy = await host.createIndexingTask({
      mode: 'submit',
      searchEngine: 'google',
      requestId: 'second-while-paid-busy',
      urls: ['https://history.test/second-busy'],
    });
    expect(busy.status).toBe('blocked');
    expect(JSON.stringify(busy)).toContain('SubmissionBusy');
    controller.abort();
    expect(resultOk(await history).counts.localRetryAttempts).toBe(7);
    await create;
    expect(f.attempts()).toBe(0);
    const nativeArm = globalThis.setTimeout.bind(globalThis),
      nativeClear = globalThis.clearTimeout.bind(globalThis);
    let failed = false;
    const poisoned = await f.host(config, {
      retry: {
        runtime: {
          setTimeout(callback, delay) {
            return nativeArm(callback, delay);
          },
          clearTimeout(handle) {
            Reflect.apply(nativeClear, undefined, [handle]);
            if (!failed) {
              failed = true;
              throw new Error('SYNTHETIC_PLANNER_NATIVE_CLEAR_RECEIPT');
            }
          },
        },
      },
    });
    expect((await poisoned.planRetry({})).status).toBe('error');
    expect(failed).toBe(true);
    const attempts = f.attempts();
    const before = logical(f.raw(state));
    resultOk(await poisoned.getRetryHistoryToolResult({}));
    expect(f.attempts()).toBe(attempts);
    expect(logical(f.raw(state))).toEqual(before);
    const blocked = await poisoned.createIndexingTask({
      mode: 'submit',
      searchEngine: 'google',
      requestId: 'blocked-after-planner-poison',
      urls: ['https://history.test/must-not-dispatch'],
    });
    expect(blocked.status).toBe('blocked');
    expect(JSON.stringify(blocked)).toContain('StateUnavailable');
    expect(f.attempts()).toBe(attempts);
  });
});

for (const target of [
  'before_read',
  'after_read',
  'after_projection',
  'after_envelope',
  'after_budget_close',
  'before_publish',
] as const)
  test(`GRH-18 original monotonic horizon includes ${target} and actual native/budget settlement before reuse`, async () => {
    await nativeCase(async (f) => {
      const state = join(f.root, 'state');
      f.init(state).close();
      const config = f.configured(state);
      let mono = 0,
        once = true,
        closes = 0;
      const phases: HistoryOwnerPhase[] = [],
        runtime = {
          now() {
            return mono;
          },
          setTimeout(callback: () => void, delay: number) {
            return setTimeout(callback, delay);
          },
          clearTimeout(handle: unknown) {
            Reflect.apply(globalThis.clearTimeout, globalThis, [handle]);
          },
        };
      const host = await f.host(config, {
        history: {
          runtime,
          onPhase(phase) {
            phases.push(phase);
            if (once && phase === target) {
              once = false;
              mono += 60_000;
            }
          },
          snapshotHooks: {
            afterNativeClose() {
              closes++;
            },
          },
        },
      });
      runtime.now = () => Number.POSITIVE_INFINITY; // Construction captured the original method/receiver.
      resultError(await host.getRetryHistoryToolResult({}), 'DeadlineExceeded');
      expect(phases).toContain('after_budget_close');
      expect(closes).toBe(target === 'before_read' ? 0 : 1);
      resultOk(await host.getRetryHistoryToolResult({}));
      expect(f.attempts()).toBe(0);
    });
  });

test('GRH-18 backward/nonfinite clocks stay failed for that invocation and pre-aborted signals never enter SQL', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state);
    for (const bad of [-1, NaN, Infinity]) {
      let mono = 0,
        once = true;
      const phases: HistoryOwnerPhase[] = [];
      const host = await f.host(config, {
        history: {
          runtime: {
            now: () => mono,
            setTimeout: (callback, delay) => setTimeout(callback, delay),
            clearTimeout: (handle) => {
              Reflect.apply(globalThis.clearTimeout, globalThis, [handle]);
            },
          },
          onPhase(phase) {
            phases.push(phase);
            if (once && phase === 'after_read') {
              once = false;
              mono = bad;
            }
            if (phase === 'after_budget_close') mono = 0;
          },
        },
      });
      resultError(await host.getRetryHistoryToolResult({}), 'DeadlineExceeded');
      resultOk(await host.getRetryHistoryToolResult({}));
      expect(phases).toContain('after_budget_close');
    }
    let reads = 0;
    const host = await f.host(config, {
        history: {
          onPhase(phase) {
            if (phase === 'before_read') reads++;
          },
        },
      }),
      abort = new AbortController();
    abort.abort();
    resultError(
      await host.getRetryHistoryToolResult({}, abort.signal),
      'Cancelled',
    );
    expect(reads).toBe(0);
    expect(f.attempts()).toBe(0);
  });
});

test('GRH-18 real post-SQL I/O observes delivered cancellation and post-close cancellation selects the prebuilt bounded envelope', async () => {
  await nativeCase(async (f) => {
    const state = join(f.root, 'state');
    f.init(state).close();
    const config = f.configured(state),
      abort = new AbortController();
    let closes = 0;
    const host = await f.host(config, {
      history: {
        onPhase(phase) {
          if (phase === 'before_read') setImmediate(() => abort.abort());
        },
        snapshotHooks: {
          afterNativeClose() {
            closes++;
          },
        },
      },
    });
    resultError(
      await host.getRetryHistoryToolResult({}, abort.signal),
      'Cancelled',
    );
    expect(closes).toBe(1);
    const late = new AbortController();
    const bounded = await f.host(config, {
      history: {
        resultBytes: 650,
        onPhase(phase) {
          if (phase === 'before_publish') late.abort();
        },
      },
    });
    const value = await bounded.getRetryHistoryToolResult({}, late.signal);
    resultError(value, 'Cancelled');
    expect(value).toBe(
      await bounded.getRetryHistoryToolResult({}, late.signal),
    );
    expect(
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    ).toBeLessThanOrEqual(650);
    expect(f.attempts()).toBe(0);
  });
});
