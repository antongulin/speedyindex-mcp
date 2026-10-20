import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  initializeLedger,
  openLedger,
  SubmissionLedgerError,
  type DispatchCapability,
  type DispatchOutcome,
  type PrepareIntentInput,
  type ProviderRoute,
  type SubmissionLedger,
  type TrustedBudgetContext,
  type UnitVector,
} from '../src/submission-ledger';
import type { TaskFamily } from '../src/task-status';

const fakeCredential = 'a'.repeat(64);
const defaultCaps: UnitVector = {
  tokens: 1_000,
  indexer: 1_000,
  checker: 1_000,
};
const defaultReservation: UnitVector = { tokens: 3, indexer: 2, checker: 1 };
const testTimeoutMs = 5_000;

type BudgetOverrides = Omit<Partial<TrustedBudgetContext>, 'caps'> & {
  caps?: Partial<UnitVector>;
};

type InputOverrides = Omit<Partial<PrepareIntentInput>, 'budget'> & {
  budget?: BudgetOverrides;
};

function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function routeFor(family: TaskFamily): ProviderRoute {
  return `/v2/task/${family}/create`;
}

function makeInput(overrides: InputOverrides = {}): PrepareIntentInput {
  const family = overrides.taskFamily ?? 'google/indexer';
  const { caps: capOverrides, ...budgetOverrides } = overrides.budget ?? {};
  const budget: TrustedBudgetContext = {
    credentialFingerprint: fakeCredential,
    budgetScope: 'synthetic-scope',
    periodId: 'period-1',
    periodStartMs: 1_000,
    policyRevision: 'policy-a',
    policyDigest: digest('policy-a'),
    ...budgetOverrides,
    caps: { ...defaultCaps, ...capOverrides },
  };
  return {
    requestId: 'synthetic-request',
    taskFamily: family,
    providerRoute: overrides.providerRoute ?? routeFor(family),
    payloadDigest: digest('synthetic-payload'),
    submittedUrls: ['https://example.test/one'],
    quoteVersion: 'quote-v1',
    quoteFingerprint: digest('synthetic-quote'),
    reservation: { ...defaultReservation },
    ...overrides,
    budget,
  };
}

function createPrivateRoot() {
  const canonicalTemp = realpathSync(tmpdir());
  const root = mkdtempSync(join(canonicalTemp, 'speedyindex-ledger-'));
  chmodSync(root, 0o700);
  return root;
}

function captureLedgerError(operation: () => unknown): SubmissionLedgerError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SubmissionLedgerError);
    return error as SubmissionLedgerError;
  }
  throw new Error('Expected the ledger operation to fail.');
}

function expectLedgerError(
  operation: () => unknown,
  code: SubmissionLedgerError['code'],
) {
  expect(captureLedgerError(operation).code).toBe(code);
}

function createIntent(ledger: SubmissionLedger, input: PrepareIntentInput) {
  const result = ledger.prepareIntent(input);
  expect(result.kind).toBe('created');
  if (result.kind !== 'created') throw new Error('Expected a new test intent.');
  return result;
}

function prepareAndClaim(ledger: SubmissionLedger, input: PrepareIntentInput) {
  const created = createIntent(ledger, input);
  const claim = ledger.claimDispatch(created.dispatchCapability, 0);
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('Expected a dispatch claim.');
  return { prepared: created, claim };
}

function finishOutcome(
  ledger: SubmissionLedger,
  input: PrepareIntentInput,
  outcome: DispatchOutcome,
) {
  const { prepared, claim } = prepareAndClaim(ledger, input);
  const result = ledger.recordDispatchOutcome({
    credentialFingerprint: input.budget.credentialFingerprint,
    requestId: input.requestId,
    expectedStateVersion: claim.stateVersion,
    outcomeToken: claim.outcomeToken,
    outcome,
  });
  return { prepared, claim, result };
}

interface AuditRow {
  state: string;
  state_version_text: string;
  reserved_tokens_text: string;
  reserved_indexer_text: string;
  reserved_checker_text: string;
  claim_token_digest: string | null;
  dispatch_outcome_token_digest: string | null;
  provider_task_id: string | null;
  provider_type: string | null;
}

function inspectIntent(
  stateDirectory: string,
  credential: string,
  requestId: string,
) {
  const path = join(stateDirectory, 'ledger.sqlite');
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const row = database
      .query(
        `SELECT state, CAST(state_version AS TEXT) AS state_version_text,
                CAST(reserved_tokens AS TEXT) AS reserved_tokens_text,
                CAST(reserved_indexer AS TEXT) AS reserved_indexer_text,
                CAST(reserved_checker AS TEXT) AS reserved_checker_text,
                claim_token_digest, dispatch_outcome_token_digest,
                provider_task_id, provider_type
         FROM intents WHERE credential_fp = ? AND request_id = ?`,
      )
      .get(credential, requestId) as AuditRow | null;
    const eventCount = database
      .query(
        `SELECT CAST(COUNT(*) AS TEXT) AS count_text
         FROM intent_events WHERE credential_fp = ? AND request_id = ?`,
      )
      .get(credential, requestId) as { count_text: string };
    return {
      row,
      eventCount: Number(BigInt(eventCount.count_text)),
    };
  } finally {
    database.close();
  }
}

function readLedgerPragmas(path: string) {
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const version = database.query('PRAGMA user_version').get() as {
      user_version: number;
    };
    const journal = database.query('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    return { version: version.user_version, journal: journal.journal_mode };
  } finally {
    database.close();
  }
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs = testTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Submission ledger child deadline exceeded.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type ChildProcess = ReturnType<typeof Bun.spawn>;

interface ChildHandle {
  process: ChildProcess;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  stderr: Promise<string>;
  decoder: TextDecoder;
  buffer: string;
}

async function startChild(
  config: Record<string, unknown>,
): Promise<ChildHandle> {
  const child = Bun.spawn(
    [process.execPath, resolve('tests/fixtures/submission-ledger-child.ts')],
    {
      cwd: process.cwd(),
      env: {},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const input = child.stdin;
  const output = child.stdout;
  const errorOutput = child.stderr;
  if (
    !input ||
    typeof input === 'number' ||
    !output ||
    typeof output === 'number' ||
    !errorOutput ||
    typeof errorOutput === 'number'
  ) {
    child.kill('SIGKILL');
    await child.exited;
    throw new Error('Could not create the bounded ledger child fixture.');
  }
  const handle: ChildHandle = {
    process: child,
    reader: output.getReader(),
    stderr: new Response(errorOutput).text(),
    decoder: new TextDecoder(),
    buffer: '',
  };
  await writeChildInput(handle, `${JSON.stringify(config)}\n`);
  return handle;
}

async function writeChildInput(handle: ChildHandle, line: string) {
  const input = handle.process.stdin;
  if (!input || typeof input === 'number')
    throw new Error('Ledger child stdin is unavailable.');
  await input.write(line);
  await input.flush();
}

async function sendControl(handle: ChildHandle, control: string) {
  await writeChildInput(handle, `${control}\n`);
}

async function closeChildInput(handle: ChildHandle) {
  const input = handle.process.stdin;
  if (input && typeof input !== 'number') await input.end();
}

async function nextChildMessage(handle: ChildHandle) {
  while (true) {
    const newline = handle.buffer.indexOf('\n');
    if (newline >= 0) {
      const line = handle.buffer.slice(0, newline);
      handle.buffer = handle.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      return JSON.parse(line) as Record<string, unknown>;
    }
    const chunk = await bounded(handle.reader.read());
    if (chunk.done) throw new Error('Ledger child closed before its event.');
    handle.buffer += handle.decoder.decode(chunk.value, { stream: true });
  }
}

async function startChildrenAtReady(
  configs: readonly Record<string, unknown>[],
  allChildren: ChildHandle[],
) {
  const children: ChildHandle[] = [];
  const ready: Record<string, unknown>[] = [];
  for (const config of configs) {
    const child = await startChild(config);
    children.push(child);
    allChildren.push(child);
    ready.push(await nextChildMessage(child));
  }
  return { children, ready };
}

async function expectChildExit(handle: ChildHandle, code = 0) {
  expect(await bounded(handle.process.exited)).toBe(code);
  expect(await bounded(handle.stderr)).toBe('');
}

async function stopAndReap(handle: ChildHandle) {
  if (handle.process.exitCode === null && handle.process.signalCode === null) {
    try {
      await sendControl(handle, 'STOP');
      const input = handle.process.stdin;
      if (input && typeof input !== 'number') await input.end();
    } catch {
      // A child may have exited between the state check and the release.
    }
    try {
      await bounded(handle.process.exited, 1_000);
    } catch {
      handle.process.kill('SIGTERM');
      try {
        await bounded(handle.process.exited, 1_000);
      } catch {
        handle.process.kill('SIGKILL');
        await bounded(handle.process.exited, testTimeoutMs);
      }
    }
  } else {
    await bounded(handle.process.exited, testTimeoutMs);
  }
  await bounded(handle.stderr, testTimeoutMs);
}

function cleanupErrorMessage(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

async function cleanupLedgerTestRoot(
  root: string,
  ledgers: readonly SubmissionLedger[],
  children: readonly ChildHandle[] = [],
) {
  const failures: string[] = [];
  const reapResults = await Promise.allSettled(
    children.map((child) => stopAndReap(child)),
  );
  for (const [index, result] of reapResults.entries()) {
    if (result.status === 'rejected') {
      failures.push(
        `child ${index + 1} stop/reap: ${cleanupErrorMessage(result.reason)}`,
      );
    }
  }

  for (const [index, ledger] of ledgers.entries()) {
    try {
      ledger.close();
    } catch (error) {
      failures.push(
        `ledger handle ${index + 1} close: ${cleanupErrorMessage(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Ledger test cleanup failed; preserving test-owned root ${root}: ${failures.join('; ')}`,
    );
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Ledger test cleanup could not remove test-owned root ${root}: ${cleanupErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function createBareSqlite(
  path: string,
  initialize: (database: Database) => void,
) {
  const file = openSync(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  closeSync(file);
  const database = new Database(
    path,
    sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    initialize(database);
  } finally {
    database.close();
  }
}

function createCaseChangedVersionOneFixture(
  sourcePath: string,
  stateDirectory: string,
) {
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);

  const source = new Database(
    sourcePath,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  );
  let definitions: Array<{
    type: 'table' | 'index';
    name: string;
    sql: string;
  }>;
  try {
    definitions = source
      .query(
        `SELECT type, name, sql
         FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*'
           AND type IN ('table', 'index')
         ORDER BY rowid`,
      )
      .all() as typeof definitions;
  } finally {
    source.close();
  }

  const intents = definitions.find(
    (definition) =>
      definition.type === 'table' && definition.name === 'intents',
  );
  if (!intents) throw new Error('The valid v1 fixture has no intents table.');
  const changedIntentsSql = intents.sql.replace("'prepared'", "'Prepared'");
  if (changedIntentsSql === intents.sql)
    throw new Error('The valid v1 intents DDL has no prepared literal.');
  const changedDefinitions = definitions.map((definition) =>
    definition === intents
      ? { ...definition, sql: changedIntentsSql }
      : definition,
  );
  if (
    changedDefinitions.filter(
      (definition, index) => definition.sql !== definitions[index]!.sql,
    ).length !== 1 ||
    changedIntentsSql.replace("'Prepared'", "'prepared'") !== intents.sql
  ) {
    throw new Error('The v1 fixture must change exactly one quoted literal.');
  }

  const fixturePath = join(stateDirectory, 'ledger.sqlite');
  createBareSqlite(fixturePath, (database) => {
    for (const type of ['table', 'index'] as const) {
      for (const definition of changedDefinitions) {
        if (definition.type === type) database.run(definition.sql);
      }
    }
    database.run('PRAGMA user_version = 1');
    const integrity = database.query('PRAGMA integrity_check').get() as {
      integrity_check: string;
    } | null;
    const storedIntents = database
      .query(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'intents'",
      )
      .get() as { sql: string } | null;
    if (
      integrity?.integrity_check !== 'ok' ||
      storedIntents?.sql !== changedIntentsSql
    ) {
      throw new Error('The case-changed v1 SQLite fixture is not valid.');
    }
  });
  return fixturePath;
}

function snapshotFile(path: string) {
  const stats = lstatSync(path);
  return {
    bytes: readFileSync(path),
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    nlink: stats.nlink,
  };
}

function expectFileUnchanged(
  path: string,
  before: ReturnType<typeof snapshotFile>,
) {
  const after = snapshotFile(path);
  expect(after.bytes.equals(before.bytes)).toBe(true);
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
  expect(after.mode).toBe(before.mode);
  expect(after.uid).toBe(before.uid);
  expect(after.nlink).toBe(before.nlink);
}

test('L01: unit reservations carry across periods and policy revisions', () => {
  const root = createPrivateRoot();
  const stateDirectory = join(root, 'state');
  let ledger: SubmissionLedger | undefined;
  try {
    ledger = initializeLedger({ stateDirectory });

    const oldUnknown = makeInput({
      requestId: 'old-unknown',
      budget: { periodId: 'period-old', periodStartMs: 1_000 },
      submittedUrls: ['https://example.test/old-unknown'],
      reservation: { tokens: 15, indexer: 3, checker: 4 },
    });
    finishOutcome(ledger, oldUnknown, { kind: 'unknown' });

    const oldAccepted = makeInput({
      requestId: 'old-accepted',
      budget: { periodId: 'period-old', periodStartMs: 1_000 },
      submittedUrls: ['https://example.test/old-accepted'],
      reservation: { tokens: 9, indexer: 1, checker: 6 },
    });
    finishOutcome(ledger, oldAccepted, {
      kind: 'accepted',
      providerTaskId: 'synthetic-old-task',
      providerType: 'google/indexer',
    });

    const currentAccepted = makeInput({
      requestId: 'current-accepted-a',
      budget: {
        periodId: 'period-current',
        periodStartMs: 2_000,
        caps: { tokens: 50, indexer: 10, checker: 10 },
      },
      submittedUrls: ['https://example.test/current-a'],
      reservation: { tokens: 10, indexer: 2, checker: 1 },
    });
    finishOutcome(ledger, currentAccepted, {
      kind: 'accepted',
      providerTaskId: 'synthetic-current-a',
      providerType: 'google/indexer',
    });

    const revisedAccepted = makeInput({
      requestId: 'current-accepted-b',
      budget: {
        periodId: 'period-current',
        periodStartMs: 2_000,
        policyRevision: 'policy-b',
        policyDigest: digest('policy-b'),
        caps: { tokens: 50, indexer: 10, checker: 10 },
      },
      submittedUrls: ['https://example.test/current-b'],
      reservation: { tokens: 20, indexer: 3, checker: 4 },
    });
    finishOutcome(ledger, revisedAccepted, {
      kind: 'accepted',
      providerTaskId: 'synthetic-current-b',
      providerType: 'google/indexer',
    });

    for (const [unit, amount] of [
      ['tokens', 21],
      ['indexer', 6],
      ['checker', 6],
    ] as const) {
      const reservation: UnitVector = { tokens: 0, indexer: 0, checker: 0 };
      const mutableReservation = { ...reservation };
      mutableReservation[unit] = amount;
      const over = makeInput({
        requestId: `over-current-${unit}`,
        budget: {
          periodId: 'period-current',
          periodStartMs: 2_000,
          policyRevision: 'policy-c',
          policyDigest: digest('policy-c'),
          caps: { tokens: 50, indexer: 10, checker: 10 },
        },
        submittedUrls: [`https://example.test/over-${unit}`],
        reservation: mutableReservation,
      });
      const error = captureLedgerError(() => ledger!.prepareIntent(over));
      expect(error.code).toBe('BudgetExceeded');
      expect(error.unit).toBe(unit);
    }

    const nextPeriod = makeInput({
      requestId: 'next-period-exact-cap',
      budget: {
        periodId: 'period-next',
        periodStartMs: 3_000,
        policyRevision: 'policy-c',
        policyDigest: digest('policy-c'),
        caps: { tokens: 50, indexer: 10, checker: 10 },
      },
      submittedUrls: ['https://example.test/next-period'],
      reservation: { tokens: 35, indexer: 7, checker: 6 },
    });
    expect(ledger.prepareIntent(nextPeriod).kind).toBe('created');

    const samePeriodControl = makeInput({
      requestId: 'same-period-identity-control',
      budget: { ...nextPeriod.budget },
      submittedUrls: ['https://example.test/same-period-identity-control'],
      reservation: { tokens: 0, indexer: 0, checker: 0 },
    });
    expect(ledger.prepareIntent(samePeriodControl).kind).toBe('created');
    expect(
      ledger.readIntent(fakeCredential, samePeriodControl.requestId),
    ).toMatchObject({
      periodId: nextPeriod.budget.periodId,
      periodStartMs: nextPeriod.budget.periodStartMs,
      reservation: { tokens: 0, indexer: 0, checker: 0 },
    });

    const overNextPeriod = makeInput({
      ...nextPeriod,
      requestId: 'next-period-over-cap',
      submittedUrls: ['https://example.test/next-period-over'],
      reservation: { tokens: 1, indexer: 0, checker: 0 },
    });
    expectLedgerError(
      () => ledger!.prepareIntent(overNextPeriod),
      'BudgetExceeded',
    );

    const stalePeriod = makeInput({
      requestId: 'stale-period',
      budget: {
        periodId: 'period-old',
        periodStartMs: 1_000,
        caps: { tokens: 1_000, indexer: 1_000, checker: 1_000 },
      },
      submittedUrls: ['https://example.test/stale-period'],
    });
    expectLedgerError(
      () => ledger!.prepareIntent(stalePeriod),
      'StalePeriodContext',
    );

    const sameIdChangedStart = makeInput({
      requestId: 'same-period-id-changed-start',
      budget: {
        ...nextPeriod.budget,
        periodStartMs: 3_001,
      },
      submittedUrls: ['https://example.test/same-id-changed-start'],
      reservation: { tokens: 0, indexer: 0, checker: 0 },
    });
    expectLedgerError(
      () => ledger!.prepareIntent(sameIdChangedStart),
      'StalePeriodContext',
    );
    expect(
      ledger.readIntent(fakeCredential, sameIdChangedStart.requestId),
    ).toBeNull();

    const sameStartChangedId = makeInput({
      requestId: 'same-period-start-changed-id',
      budget: {
        ...nextPeriod.budget,
        periodId: 'period-next-alias',
      },
      submittedUrls: ['https://example.test/same-start-changed-id'],
      reservation: { tokens: 0, indexer: 0, checker: 0 },
    });
    expectLedgerError(
      () => ledger!.prepareIntent(sameStartChangedId),
      'StalePeriodContext',
    );
    expect(
      ledger.readIntent(fakeCredential, sameStartChangedId.requestId),
    ).toBeNull();
    expect(
      ledger.readIntent(fakeCredential, currentAccepted.requestId),
    ).toMatchObject({
      periodId: 'period-current',
      reservation: { tokens: 10, indexer: 2, checker: 1 },
    });

    const maxInput = makeInput({
      requestId: 'max-safe',
      budget: {
        budgetScope: 'max-safe-scope',
        periodId: 'period-max',
        caps: {
          tokens: Number.MAX_SAFE_INTEGER,
          indexer: 0,
          checker: 0,
        },
      },
      submittedUrls: ['https://example.test/max-safe'],
      reservation: {
        tokens: Number.MAX_SAFE_INTEGER,
        indexer: 0,
        checker: 0,
      },
    });
    finishOutcome(ledger, maxInput, {
      kind: 'accepted',
      providerTaskId: 'max-safe-task',
      providerType: 'google/indexer',
    });
    const beyondMax = makeInput({
      ...maxInput,
      requestId: 'beyond-max-safe',
      submittedUrls: ['https://example.test/beyond-max-safe'],
      reservation: { tokens: 1, indexer: 0, checker: 0 },
    });
    expectLedgerError(() => ledger!.prepareIntent(beyondMax), 'BudgetExceeded');
  } finally {
    ledger?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L02: request replay, outcomes, and URL holds remain immutable', () => {
  const root = createPrivateRoot();
  const stateDirectory = join(root, 'state');
  let ledger: SubmissionLedger | undefined;
  try {
    ledger = initializeLedger({ stateDirectory });
    const duplicateUrlInput = makeInput({
      requestId: 'duplicate-url-input',
      submittedUrls: [
        'https://example.test/duplicate-in-batch',
        'https://example.test/duplicate-in-batch',
      ],
    });
    expectLedgerError(
      () => ledger!.prepareIntent(duplicateUrlInput),
      'InvalidLedgerInput',
    );
    expect(
      ledger.readIntent(fakeCredential, duplicateUrlInput.requestId),
    ).toBeNull();

    const original = makeInput({
      requestId: 'immutable-request',
      submittedUrls: [
        'https://example.test/one?x=1',
        'https://example.test/two',
      ],
    });
    const created = createIntent(ledger, original);
    const claim = ledger.claimDispatch(created.dispatchCapability, 0);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('Expected a dispatch claim.');

    const beforeMismatch = inspectIntent(
      stateDirectory,
      fakeCredential,
      original.requestId,
    );
    expectLedgerError(
      () =>
        ledger!.recordDispatchOutcome({
          credentialFingerprint: fakeCredential,
          requestId: original.requestId,
          expectedStateVersion: claim.stateVersion,
          outcomeToken: claim.outcomeToken,
          outcome: {
            kind: 'accepted',
            providerTaskId: 'synthetic-mismatch',
            providerType: 'yandex/indexer',
          },
        }),
      'ProviderTypeMismatch',
    );
    const afterMismatch = inspectIntent(
      stateDirectory,
      fakeCredential,
      original.requestId,
    );
    expect(afterMismatch).toEqual(beforeMismatch);
    expect(ledger.readIntent(fakeCredential, original.requestId)?.state).toBe(
      'dispatching',
    );

    const accepted = ledger.recordDispatchOutcome({
      credentialFingerprint: fakeCredential,
      requestId: original.requestId,
      expectedStateVersion: claim.stateVersion,
      outcomeToken: claim.outcomeToken,
      outcome: {
        kind: 'accepted',
        providerTaskId: 'synthetic-accepted-task',
        providerType: 'google/indexer',
      },
    });
    expect(accepted).toMatchObject({
      state: 'accepted',
      stateVersion: 2,
      providerType: 'google/indexer',
      providerTaskId: 'synthetic-accepted-task',
    });
    expect(
      inspectIntent(stateDirectory, fakeCredential, original.requestId),
    ).toMatchObject({
      eventCount: 3,
      row: { dispatch_outcome_token_digest: null },
    });

    ledger.close();
    ledger = openLedger({ stateDirectory });
    const replay = ledger.prepareIntent({
      ...original,
      budget: {
        ...original.budget,
        periodId: 'period-later',
        periodStartMs: 2_000,
      },
    });
    expect(replay.kind).toBe('replay');
    expect(replay.intent.periodId).toBe(original.budget.periodId);
    expect(replay).not.toHaveProperty('dispatchCapability');

    const conflicts: PrepareIntentInput[] = [
      {
        ...original,
        taskFamily: 'yandex/indexer',
        providerRoute: routeFor('yandex/indexer'),
      },
      { ...original, payloadDigest: digest('changed-payload') },
      { ...original, submittedUrls: [...original.submittedUrls].reverse() },
      { ...original, quoteVersion: 'quote-v2' },
      { ...original, quoteFingerprint: digest('changed-quote') },
      { ...original, reservation: { tokens: 4, indexer: 2, checker: 1 } },
      {
        ...original,
        budget: { ...original.budget, budgetScope: 'other-scope' },
      },
      {
        ...original,
        budget: {
          ...original.budget,
          policyRevision: 'policy-b',
          policyDigest: digest('policy-b'),
        },
      },
      {
        ...original,
        budget: { ...original.budget, policyDigest: digest('changed-policy') },
      },
    ];
    for (const conflict of conflicts) {
      expectLedgerError(
        () => ledger!.prepareIntent(conflict),
        'RequestIdConflict',
      );
    }

    const rejectedInput = makeInput({
      requestId: 'known-rejected',
      submittedUrls: ['https://example.test/rejected'],
    });
    const rejected = finishOutcome(ledger, rejectedInput, { kind: 'rejected' });
    expect(rejected.result.state).toBe('rejected');
    const afterRejectedSameUrl = makeInput({
      requestId: 'after-rejected',
      submittedUrls: ['https://example.test/rejected'],
    });
    expect(ledger.prepareIntent(afterRejectedSameUrl).kind).toBe('created');

    const unknownInput = makeInput({
      requestId: 'known-unknown',
      submittedUrls: ['https://example.test/unknown?exact=1'],
    });
    const unknown = finishOutcome(ledger, unknownInput, { kind: 'unknown' });
    expect(unknown.result.state).toBe('unknown');

    for (const terminal of [
      {
        requestId: original.requestId,
        token: claim.outcomeToken,
        outcome: {
          kind: 'accepted' as const,
          providerTaskId: 'changed-task',
          providerType: 'google/indexer' as const,
        },
      },
      {
        requestId: rejectedInput.requestId,
        token: rejected.claim.outcomeToken,
        outcome: { kind: 'rejected' as const },
      },
      {
        requestId: unknownInput.requestId,
        token: unknown.claim.outcomeToken,
        outcome: { kind: 'unknown' as const },
      },
    ]) {
      const before = inspectIntent(
        stateDirectory,
        fakeCredential,
        terminal.requestId,
      );
      expectLedgerError(
        () =>
          ledger!.recordDispatchOutcome({
            credentialFingerprint: fakeCredential,
            requestId: terminal.requestId,
            expectedStateVersion: 1,
            outcomeToken: terminal.token,
            outcome: terminal.outcome,
          }),
        'DispatchOutcomeClaimLost',
      );
      expect(
        inspectIntent(stateDirectory, fakeCredential, terminal.requestId),
      ).toEqual(before);
    }

    for (const [index, family] of [
      ['same-scope-family', 'yandex/checker'],
      ['other-scope-family', 'yandex/indexer'],
    ] as const) {
      const overlap = makeInput({
        requestId: `unknown-overlap-${index}`,
        taskFamily: family,
        budget: {
          budgetScope:
            index === 'same-scope-family' ? 'synthetic-scope' : 'other-scope',
        },
        submittedUrls: ['https://example.test/unknown?exact=1'],
      });
      expectLedgerError(() => ledger!.prepareIntent(overlap), 'UrlOverlap');
    }

    const queryDistinct = makeInput({
      requestId: 'query-distinct',
      submittedUrls: ['https://example.test/unknown?exact=2'],
    });
    expect(ledger.prepareIntent(queryDistinct).kind).toBe('created');

    const acceptedUrlReuse = makeInput({
      requestId: 'after-accepted',
      submittedUrls: ['https://example.test/one?x=1'],
    });
    expect(ledger.prepareIntent(acceptedUrlReuse).kind).toBe('created');

    const malformedOutcome = captureLedgerError(() =>
      ledger!.recordDispatchOutcome({
        credentialFingerprint: fakeCredential,
        requestId: 'missing-outcome-token',
      } as never),
    );
    expect(malformedOutcome.code).toBe('InvalidLedgerInput');
  } finally {
    ledger?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L02-MAX: checks the 10,000 URL boundary and last URL overlap', () => {
  const root = createPrivateRoot();
  const stateDirectory = join(root, 'state');
  let ledger: SubmissionLedger | undefined;
  try {
    ledger = initializeLedger({ stateDirectory });
    const submittedUrls = Array.from(
      { length: 10_000 },
      (_, index) => `https://example.test/bulk/${index}`,
    );
    const input = makeInput({
      requestId: 'max-url-count',
      submittedUrls,
    });
    expect(createIntent(ledger, input).intent.state).toBe('prepared');

    const lastUrlOverlap = makeInput({
      requestId: 'max-url-overlap-last',
      submittedUrls: [submittedUrls[submittedUrls.length - 1]!],
    });
    expectLedgerError(
      () => ledger!.prepareIntent(lastUrlOverlap),
      'UrlOverlap',
    );

    const tooManyUrls = makeInput({
      requestId: 'max-url-count-plus-one',
      submittedUrls: [...submittedUrls, 'https://example.test/bulk/10000'],
    });
    expectLedgerError(
      () => ledger!.prepareIntent(tooManyUrls),
      'InvalidLedgerInput',
    );
    expect(ledger.readIntent(fakeCredential, tooManyUrls.requestId)).toBeNull();
  } finally {
    ledger?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L03: separate processes cannot duplicate IDs or over-reserve a period', async () => {
  const root = createPrivateRoot();
  const children: ChildHandle[] = [];
  const reopenedLedgers: SubmissionLedger[] = [];
  try {
    const sameState = join(root, 'same-id-state');
    const sameLedger = initializeLedger({ stateDirectory: sameState });
    sameLedger.close();
    const sameInput = makeInput({
      requestId: 'cross-process-same-id',
      submittedUrls: ['https://example.test/cross-process-same'],
      reservation: { tokens: 5, indexer: 1, checker: 0 },
    });
    const { children: sameChildren, ready: sameReady } =
      await startChildrenAtReady(
        [
          {
            mode: 'prepare-race',
            stateDirectory: sameState,
            input: sameInput,
          },
          {
            mode: 'prepare-race',
            stateDirectory: sameState,
            input: sameInput,
          },
        ],
        children,
      );
    expect(sameReady.map((message) => message.event)).toEqual([
      'READY',
      'READY',
    ]);
    await Promise.all(sameChildren.map((child) => sendControl(child, 'GO')));
    await Promise.all(sameChildren.map(closeChildInput));
    const sameResults = await Promise.all(sameChildren.map(nextChildMessage));
    expect(sameResults.map((message) => message.kind).sort()).toEqual([
      'created',
      'replay',
    ]);
    const created = sameResults.find((message) => message.kind === 'created');
    const replay = sameResults.find((message) => message.kind === 'replay');
    expect(created).toHaveProperty('dispatchCapability');
    expect(replay).not.toHaveProperty('dispatchCapability');
    await Promise.all(sameChildren.map((child) => expectChildExit(child)));
    const reopenedSame = openLedger({ stateDirectory: sameState });
    reopenedLedgers.push(reopenedSame);
    expect(
      reopenedSame.readIntent(fakeCredential, sameInput.requestId)?.state,
    ).toBe('prepared');
    expect(
      inspectIntent(sameState, fakeCredential, sameInput.requestId).eventCount,
    ).toBe(1);
    reopenedSame.close();

    const budgetState = join(root, 'budget-race-state');
    const budgetLedger = initializeLedger({ stateDirectory: budgetState });
    budgetLedger.close();
    const budgetA = makeInput({
      requestId: 'cross-process-budget-a',
      budget: {
        budgetScope: 'race-scope',
        caps: { tokens: 5, indexer: 0, checker: 0 },
      },
      submittedUrls: ['https://example.test/race-a'],
      reservation: { tokens: 5, indexer: 0, checker: 0 },
    });
    const budgetB = makeInput({
      requestId: 'cross-process-budget-b',
      budget: {
        budgetScope: 'race-scope',
        caps: { tokens: 5, indexer: 0, checker: 0 },
      },
      submittedUrls: ['https://example.test/race-b'],
      reservation: { tokens: 5, indexer: 0, checker: 0 },
    });
    const { children: budgetChildren, ready: budgetReady } =
      await startChildrenAtReady(
        [
          {
            mode: 'prepare-race',
            stateDirectory: budgetState,
            input: budgetA,
          },
          {
            mode: 'prepare-race',
            stateDirectory: budgetState,
            input: budgetB,
          },
        ],
        children,
      );
    expect(budgetReady.map((message) => message.event)).toEqual([
      'READY',
      'READY',
    ]);
    await Promise.all(budgetChildren.map((child) => sendControl(child, 'GO')));
    await Promise.all(budgetChildren.map(closeChildInput));
    const budgetResults = await Promise.all(
      budgetChildren.map(nextChildMessage),
    );
    expect(
      budgetResults.filter((message) => message.kind === 'created'),
    ).toHaveLength(1);
    expect(
      budgetResults.every(
        (message) =>
          message.kind === 'created' ||
          (message.kind === 'error' &&
            ['BudgetExceeded', 'LedgerBusy'].includes(String(message.code))),
      ),
    ).toBe(true);
    expect(
      budgetResults.filter((message) => message.kind === 'error'),
    ).toHaveLength(1);
    expect(
      budgetResults.filter((message) => message.kind === 'error')[0],
    ).not.toHaveProperty('dispatchCapability');
    await Promise.all(budgetChildren.map((child) => expectChildExit(child)));
    const accounted = openLedger({ stateDirectory: budgetState });
    reopenedLedgers.push(accounted);
    const survivingId =
      budgetResults.find((message) => message.kind === 'created') ===
      budgetResults[0]
        ? budgetA.requestId
        : budgetB.requestId;
    expect(
      accounted.readIntent(fakeCredential, survivingId)?.reservation.tokens,
    ).toBe(5);
    expect(
      accounted.readIntent(
        fakeCredential,
        survivingId === budgetA.requestId
          ? budgetB.requestId
          : budgetA.requestId,
      ),
    ).toBeNull();
    accounted.close();
  } finally {
    await cleanupLedgerTestRoot(root, reopenedLedgers, children);
  }
}, 30_000);

test('L04: one process owns the dispatch claim and its result token', async () => {
  const root = createPrivateRoot();
  const children: ChildHandle[] = [];
  let ledger: SubmissionLedger | undefined;
  try {
    const stateDirectory = join(root, 'state');
    ledger = initializeLedger({ stateDirectory });
    const input = makeInput({
      requestId: 'cross-process-claim',
      submittedUrls: ['https://example.test/cross-process-claim'],
    });
    const prepared = createIntent(ledger, input);
    ledger.close();
    ledger = undefined;

    const { children: contenders, ready } = await startChildrenAtReady(
      [
        {
          mode: 'claim-race',
          stateDirectory,
          input,
          capability: prepared.dispatchCapability,
        },
        {
          mode: 'claim-race',
          stateDirectory,
          input,
          capability: prepared.dispatchCapability,
        },
      ],
      children,
    );
    expect(ready.map((message) => message.event)).toEqual(['READY', 'READY']);
    await Promise.all(contenders.map((child) => sendControl(child, 'GO')));
    const claims = await Promise.all(contenders.map(nextChildMessage));
    expect(claims.map((message) => message.kind).sort()).toEqual([
      'claimed',
      'lost',
    ]);
    const winnerIndex = claims.findIndex(
      (message) => message.kind === 'claimed',
    );
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = contenders[winnerIndex]!;
    const loser = contenders[loserIndex]!;
    const winnerClaim = claims[winnerIndex]!;
    const loserChecks = await nextChildMessage(loser);
    await closeChildInput(loser);
    expect(loserChecks).toEqual({
      event: 'LOSER_CHECKS',
      invalidProof: 'InvalidLedgerInput',
      oldCapabilityProof: 'DispatchOutcomeClaimLost',
    });

    const beforeWinnerOutcome = inspectIntent(
      stateDirectory,
      fakeCredential,
      input.requestId,
    );
    expect(beforeWinnerOutcome.row).toMatchObject({
      state: 'dispatching',
      state_version_text: '1',
      dispatch_outcome_token_digest: digest(String(winnerClaim.outcomeToken)),
    });
    expect(beforeWinnerOutcome.eventCount).toBe(2);

    await sendControl(winner, 'RECORD');
    await closeChildInput(winner);
    expect(await nextChildMessage(winner)).toEqual({
      event: 'RECORDED',
      state: 'accepted',
      stateVersion: 2,
    });
    await Promise.all(contenders.map((child) => expectChildExit(child)));
    const afterWinnerOutcome = inspectIntent(
      stateDirectory,
      fakeCredential,
      input.requestId,
    );
    expect(afterWinnerOutcome).toMatchObject({
      eventCount: 3,
      row: {
        state: 'accepted',
        state_version_text: '2',
        dispatch_outcome_token_digest: null,
        provider_type: 'google/indexer',
      },
    });
  } finally {
    ledger?.close();
    await Promise.all(children.map(stopAndReap));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('L05: a killed dispatcher remains held after database reopen', async () => {
  const root = createPrivateRoot();
  const children: ChildHandle[] = [];
  try {
    const stateDirectory = join(root, 'state');
    const initial = initializeLedger({ stateDirectory });
    initial.close();
    const input = makeInput({
      requestId: 'crash-after-claim',
      submittedUrls: ['https://example.test/crash-after-claim'],
    });
    const child = await startChild({
      mode: 'crash-after-claim',
      stateDirectory,
      input,
    });
    children.push(child);
    expect(await nextChildMessage(child)).toEqual({ event: 'CLAIM_COMMITTED' });
    child.process.kill('SIGKILL');
    await bounded(child.process.exited, testTimeoutMs);
    expect(child.process.signalCode).toBe('SIGKILL');
    expect(await bounded(child.stderr)).toBe('');

    const reopened = openLedger({ stateDirectory });
    try {
      expect(
        reopened.readIntent(fakeCredential, input.requestId),
      ).toMatchObject({
        state: 'dispatching',
        stateVersion: 1,
      });
      const replay = reopened.prepareIntent(input);
      expect(replay.kind).toBe('replay');
      expect(replay).not.toHaveProperty('dispatchCapability');
      const overlap = makeInput({
        requestId: 'after-crashed-claim',
        submittedUrls: ['https://example.test/crash-after-claim'],
      });
      expectLedgerError(() => reopened.prepareIntent(overlap), 'UrlOverlap');
      expect(
        reopened.claimDispatch('Z'.repeat(43) as DispatchCapability, 0),
      ).toEqual({ kind: 'lost' });
    } finally {
      reopened.close();
    }
    const audit = inspectIntent(
      stateDirectory,
      fakeCredential,
      input.requestId,
    );
    expect(audit).toMatchObject({
      eventCount: 2,
      row: {
        state: 'dispatching',
        dispatch_outcome_token_digest: expect.any(String),
      },
    });
  } finally {
    await Promise.all(children.map(stopAndReap));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('L06: prepared cancellation and the dispatch claim cannot release each other', () => {
  const root = createPrivateRoot();
  const stateDirectory = join(root, 'state');
  let first: SubmissionLedger | undefined;
  let second: SubmissionLedger | undefined;
  try {
    first = initializeLedger({ stateDirectory });
    second = openLedger({ stateDirectory });

    const cancelFirst = makeInput({
      requestId: 'cancel-first',
      submittedUrls: ['https://example.test/cancel-first'],
      reservation: { tokens: 4, indexer: 0, checker: 0 },
    });
    const preparedCancel = createIntent(first, cancelFirst);
    expect(
      first.cancelPrepared(fakeCredential, cancelFirst.requestId, 0),
    ).toEqual({
      kind: 'cancelled',
      stateVersion: 1,
    });
    expect(first.claimDispatch(preparedCancel.dispatchCapability, 0)).toEqual({
      kind: 'lost',
    });
    const reusedAfterCancel = makeInput({
      requestId: 'after-cancel',
      submittedUrls: ['https://example.test/cancel-first'],
      reservation: { tokens: 4, indexer: 0, checker: 0 },
    });
    expect(first.prepareIntent(reusedAfterCancel).kind).toBe('created');

    const claimFirst = makeInput({
      requestId: 'claim-first',
      submittedUrls: ['https://example.test/claim-first'],
      reservation: { tokens: 7, indexer: 0, checker: 0 },
    });
    const preparedClaim = createIntent(first, claimFirst);
    expect(first.claimDispatch(preparedClaim.dispatchCapability, 0).kind).toBe(
      'claimed',
    );
    expect(
      second.cancelPrepared(fakeCredential, claimFirst.requestId, 0),
    ).toEqual({
      kind: 'lost',
    });
    expect(
      second.readIntent(fakeCredential, claimFirst.requestId),
    ).toMatchObject({
      state: 'dispatching',
      reservation: { tokens: 7 },
    });
    const overlap = makeInput({
      requestId: 'claim-first-overlap',
      submittedUrls: ['https://example.test/claim-first'],
    });
    expectLedgerError(() => second!.prepareIntent(overlap), 'UrlOverlap');
  } finally {
    second?.close();
    first?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L07-SCHEMA-LITERAL: case-changed v1 CHECK literals fail closed', async () => {
  const root = createPrivateRoot();
  const ledgers: SubmissionLedger[] = [];
  try {
    const validDirectory = join(root, 'valid-v1');
    const validLedger = initializeLedger({ stateDirectory: validDirectory });
    ledgers.push(validLedger);
    validLedger.close();

    const incompatibleDirectory = join(root, 'case-changed-v1');
    const incompatiblePath = createCaseChangedVersionOneFixture(
      join(validDirectory, 'ledger.sqlite'),
      incompatibleDirectory,
    );
    const incompatibleBefore = snapshotFile(incompatiblePath);

    let openError: unknown;
    try {
      ledgers.push(openLedger({ stateDirectory: incompatibleDirectory }));
    } catch (error) {
      openError = error;
    }
    if (openError === undefined) {
      throw new Error(
        'openLedger unexpectedly accepted a v1 schema with a case-changed CHECK literal.',
      );
    }
    expect(openError).toBeInstanceOf(SubmissionLedgerError);
    expect((openError as SubmissionLedgerError).code).toBe('LedgerUnavailable');
    expectFileUnchanged(incompatiblePath, incompatibleBefore);

    const reopenedValid = openLedger({ stateDirectory: validDirectory });
    ledgers.push(reopenedValid);
    expect(
      reopenedValid.readIntent(fakeCredential, 'schema-literal-probe'),
    ).toBeNull();
    reopenedValid.close();
  } finally {
    await cleanupLedgerTestRoot(root, ledgers);
  }
});

test('L07: unsafe or incomplete storage fails closed without replacing state', async () => {
  const root = createPrivateRoot();
  if (typeof process.geteuid !== 'function')
    throw new Error('POSIX UID lookup is required for this test.');
  const uid = process.geteuid();
  const readonlySkips: string[] = [];
  const ledgers: SubmissionLedger[] = [];
  let ledger: SubmissionLedger | undefined;
  try {
    const validDirectory = join(root, 'valid');
    ledger = initializeLedger({ stateDirectory: validDirectory });
    ledgers.push(ledger);
    const validDb = join(validDirectory, 'ledger.sqlite');
    expect(lstatSync(validDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(validDb).mode & 0o777).toBe(0o600);
    expect(lstatSync(validDirectory).uid).toBe(uid);
    expect(lstatSync(validDb).uid).toBe(uid);
    expect(readLedgerPragmas(validDb)).toEqual({ version: 1, journal: 'wal' });
    ledger.close();
    ledger = openLedger({ stateDirectory: validDirectory });
    ledgers.push(ledger);
    expect(ledger.readIntent(fakeCredential, 'no-row')).toBeNull();
    ledger.close();

    const closedDatabaseBefore = snapshotFile(validDb);
    ledger.close();
    expectLedgerError(
      () => ledger!.readIntent(fakeCredential, 'after-close-read'),
      'LedgerUnavailable',
    );
    expectLedgerError(
      () =>
        ledger!.prepareIntent(makeInput({ requestId: 'after-close-prepare' })),
      'LedgerUnavailable',
    );
    expectFileUnchanged(validDb, closedDatabaseBefore);

    const relativeStateDirectory = relative(
      process.cwd(),
      join(root, 'relative-state'),
    );
    const nulStateDirectory = `${join(root, 'nul-state')}\0suffix`;
    const aliasParent = join(root, 'path-alias');
    mkdirSync(aliasParent, { mode: 0o700 });
    chmodSync(aliasParent, 0o700);
    const noncanonicalStateDirectory = `${aliasParent}/../valid`;
    expect(resolve(noncanonicalStateDirectory)).toBe(validDirectory);
    expect(noncanonicalStateDirectory).not.toBe(validDirectory);

    const validDatabaseBeforeInvalidPaths = snapshotFile(validDb);
    for (const stateDirectory of [
      relativeStateDirectory,
      nulStateDirectory,
      noncanonicalStateDirectory,
    ]) {
      expectLedgerError(
        () => initializeLedger({ stateDirectory }),
        'InvalidLedgerInput',
      );
      expectLedgerError(
        () => openLedger({ stateDirectory }),
        'InvalidLedgerInput',
      );
    }
    expect(existsSync(join(root, 'relative-state'))).toBe(false);
    expect(existsSync(join(root, 'nul-state'))).toBe(false);
    expectFileUnchanged(validDb, validDatabaseBeforeInvalidPaths);

    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${validDb}${suffix}`;
      if (existsSync(sidecar)) {
        const stats = lstatSync(sidecar);
        expect(stats.isFile()).toBe(true);
        expect(stats.isSymbolicLink()).toBe(false);
        expect(stats.uid).toBe(uid);
        expect(stats.nlink).toBe(1);
        expect(stats.mode & 0o077).toBe(0);
      }
    }

    const preexistingDirectory = join(root, 'already-exists');
    mkdirSync(preexistingDirectory, { mode: 0o700 });
    const directoryBefore = lstatSync(preexistingDirectory);
    expectLedgerError(
      () => initializeLedger({ stateDirectory: preexistingDirectory }),
      'LedgerUnavailable',
    );
    const directoryAfter = lstatSync(preexistingDirectory);
    expect(directoryAfter.ino).toBe(directoryBefore.ino);
    expect(directoryAfter.mode & 0o7777).toBe(directoryBefore.mode & 0o7777);
    expect(existsSync(join(preexistingDirectory, 'ledger.sqlite'))).toBe(false);

    const missingDirectory = join(root, 'missing-directory');
    expectLedgerError(
      () => openLedger({ stateDirectory: missingDirectory }),
      'LedgerUnavailable',
    );
    expect(existsSync(missingDirectory)).toBe(false);

    const missingDatabase = join(root, 'missing-database');
    mkdirSync(missingDatabase, { mode: 0o700 });
    chmodSync(missingDatabase, 0o700);
    expectLedgerError(
      () => openLedger({ stateDirectory: missingDatabase }),
      'LedgerUnavailable',
    );
    expect(existsSync(join(missingDatabase, 'ledger.sqlite'))).toBe(false);

    const zeroDirectory = join(root, 'zero-byte');
    mkdirSync(zeroDirectory, { mode: 0o700 });
    chmodSync(zeroDirectory, 0o700);
    const zeroPath = join(zeroDirectory, 'ledger.sqlite');
    const zeroFd = openSync(
      zeroPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_RDWR |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    closeSync(zeroFd);
    const zeroBefore = snapshotFile(zeroPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: zeroDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(zeroPath, zeroBefore);

    const truncatedDirectory = join(root, 'truncated');
    mkdirSync(truncatedDirectory, { mode: 0o700 });
    chmodSync(truncatedDirectory, 0o700);
    const truncatedPath = join(truncatedDirectory, 'ledger.sqlite');
    writeFileSync(truncatedPath, Buffer.from('SQLite format 3\0', 'binary'), {
      mode: 0o600,
      flag: 'wx',
    });
    const truncatedBefore = snapshotFile(truncatedPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: truncatedDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(truncatedPath, truncatedBefore);

    const emptyVersionDirectory = join(root, 'empty-version-zero');
    mkdirSync(emptyVersionDirectory, { mode: 0o700 });
    chmodSync(emptyVersionDirectory, 0o700);
    const emptyVersionPath = join(emptyVersionDirectory, 'ledger.sqlite');
    createBareSqlite(emptyVersionPath, (database) => {
      database.run('CREATE TABLE temporary_table (value INTEGER)');
      database.run('DROP TABLE temporary_table');
    });
    const emptyVersionBefore = snapshotFile(emptyVersionPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: emptyVersionDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(emptyVersionPath, emptyVersionBefore);

    const unknownVersionDirectory = join(root, 'unknown-version');
    mkdirSync(unknownVersionDirectory, { mode: 0o700 });
    chmodSync(unknownVersionDirectory, 0o700);
    const unknownVersionPath = join(unknownVersionDirectory, 'ledger.sqlite');
    createBareSqlite(unknownVersionPath, (database) => {
      database.run('CREATE TABLE known_fixture (value INTEGER)');
      database.run('PRAGMA user_version = 2');
    });
    const unknownVersionBefore = snapshotFile(unknownVersionPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: unknownVersionDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(unknownVersionPath, unknownVersionBefore);

    const nonemptyVersionZeroDirectory = join(root, 'nonempty-version-zero');
    mkdirSync(nonemptyVersionZeroDirectory, { mode: 0o700 });
    chmodSync(nonemptyVersionZeroDirectory, 0o700);
    const nonemptyVersionZeroPath = join(
      nonemptyVersionZeroDirectory,
      'ledger.sqlite',
    );
    createBareSqlite(nonemptyVersionZeroPath, (database) => {
      database.run('CREATE TABLE unrelated_fixture (value INTEGER)');
    });
    const nonemptyVersionZeroBefore = snapshotFile(nonemptyVersionZeroPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: nonemptyVersionZeroDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(nonemptyVersionZeroPath, nonemptyVersionZeroBefore);

    const realState = join(root, 'symlink-target-state');
    const targetLedger = initializeLedger({ stateDirectory: realState });
    ledgers.push(targetLedger);
    targetLedger.close();
    const symlinkDirectory = join(root, 'symlinked-state');
    symlinkSync(realState, symlinkDirectory, 'dir');
    const targetBefore = snapshotFile(join(realState, 'ledger.sqlite'));
    expectLedgerError(
      () => openLedger({ stateDirectory: symlinkDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(join(realState, 'ledger.sqlite'), targetBefore);

    const realFileDirectory = join(root, 'symlink-file-target');
    mkdirSync(realFileDirectory, { mode: 0o700 });
    chmodSync(realFileDirectory, 0o700);
    const realFile = join(realFileDirectory, 'target.sqlite');
    createBareSqlite(realFile, () => {});
    const symlinkFileDirectory = join(root, 'symlinked-database');
    mkdirSync(symlinkFileDirectory, { mode: 0o700 });
    chmodSync(symlinkFileDirectory, 0o700);
    const symlinkFile = join(symlinkFileDirectory, 'ledger.sqlite');
    symlinkSync(realFile, symlinkFile, 'file');
    const linkTargetBefore = snapshotFile(realFile);
    const linkTextBefore = readlinkSync(symlinkFile);
    expectLedgerError(
      () => openLedger({ stateDirectory: symlinkFileDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(realFile, linkTargetBefore);
    expect(readlinkSync(symlinkFile)).toBe(linkTextBefore);

    const permissiveDirectory = join(root, 'permissive-directory');
    mkdirSync(permissiveDirectory, { mode: 0o755 });
    chmodSync(permissiveDirectory, 0o755);
    const permissiveDirectoryBefore = lstatSync(permissiveDirectory);
    expectLedgerError(
      () => openLedger({ stateDirectory: permissiveDirectory }),
      'LedgerUnavailable',
    );
    const permissiveDirectoryAfter = lstatSync(permissiveDirectory);
    expect(permissiveDirectoryAfter.ino).toBe(permissiveDirectoryBefore.ino);
    expect(permissiveDirectoryAfter.mode & 0o7777).toBe(
      permissiveDirectoryBefore.mode & 0o7777,
    );

    const permissiveFileDirectory = join(root, 'permissive-file');
    mkdirSync(permissiveFileDirectory, { mode: 0o700 });
    chmodSync(permissiveFileDirectory, 0o700);
    const permissiveFile = join(permissiveFileDirectory, 'ledger.sqlite');
    writeFileSync(permissiveFile, Buffer.from('private fixture'), {
      mode: 0o644,
      flag: 'wx',
    });
    chmodSync(permissiveFile, 0o644);
    const permissiveFileBefore = snapshotFile(permissiveFile);
    expectLedgerError(
      () => openLedger({ stateDirectory: permissiveFileDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(permissiveFile, permissiveFileBefore);

    const readonlyDirectory = join(root, 'readonly-file');
    const readonlyLedger = initializeLedger({
      stateDirectory: readonlyDirectory,
    });
    ledgers.push(readonlyLedger);
    readonlyLedger.close();
    const readonlyPath = join(readonlyDirectory, 'ledger.sqlite');
    chmodSync(readonlyPath, 0o400);
    const readonlyBefore = snapshotFile(readonlyPath);
    expectLedgerError(
      () => openLedger({ stateDirectory: readonlyDirectory }),
      'LedgerUnavailable',
    );
    expectFileUnchanged(readonlyPath, readonlyBefore);
    let writeDenied = false;
    try {
      const descriptor = openSync(readonlyPath, fsConstants.O_WRONLY);
      closeSync(descriptor);
    } catch {
      writeDenied = true;
    }
    if (!writeDenied) {
      readonlySkips.push(
        `Read-only OS enforcement bypassed for effective UID ${uid}; mode rejection still passed.`,
      );
    }

    if (readonlySkips.length > 0)
      console.info(`L07 skipped subcase: ${readonlySkips.join(' ')}`);
  } finally {
    await cleanupLedgerTestRoot(root, ledgers);
  }
});
