import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  constants as sqliteConstants,
  Database,
  SQLiteError,
} from 'bun:sqlite';
import { taskFamilySchema, type TaskFamily } from './task-status';
import { providerTaskIdSchema } from './submission-contract';
import {
  checkSnapshotBounds,
  freezeSnapshot,
  projectRetrySnapshot,
  signalSnapshotPhase,
  snapshotLimits,
  SnapshotReadError,
  type RetrySnapshot,
  type SnapshotReadHooks,
} from './retry-ledger-snapshot';

export type Unit = 'tokens' | 'indexer' | 'checker';
export type UnitVector = Readonly<Record<Unit, number>>;
export type ProviderRoute = `/v2/task/${TaskFamily}/create`;

export interface TrustedBudgetContext {
  credentialFingerprint: string;
  budgetScope: string;
  periodId: string;
  periodStartMs: number;
  policyRevision: string;
  policyDigest: string;
  caps: UnitVector;
}

export interface PrepareIntentInput {
  requestId: string;
  budget: TrustedBudgetContext;
  taskFamily: TaskFamily;
  providerRoute: ProviderRoute;
  payloadDigest: string;
  submittedUrls: readonly string[];
  quoteVersion: string;
  quoteFingerprint: string;
  reservation: UnitVector;
}

export type IntentState =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'cancelled';

export interface IntentView {
  credentialFingerprint: string;
  requestId: string;
  budgetScope: string;
  periodId: string;
  periodStartMs: number;
  policyRevision: string;
  policyDigest: string;
  taskFamily: TaskFamily;
  providerRoute: ProviderRoute;
  payloadDigest: string;
  quoteVersion: string;
  quoteFingerprint: string;
  reservation: UnitVector;
  urlCount: number;
  state: IntentState;
  stateVersion: number;
  createdAtMs: number;
  providerTaskId?: string;
  providerType?: TaskFamily;
}

declare const dispatchCapabilityBrand: unique symbol;
export type DispatchCapability = string & {
  readonly [dispatchCapabilityBrand]: true;
};

declare const dispatchOutcomeTokenBrand: unique symbol;
export type DispatchOutcomeToken = string & {
  readonly [dispatchOutcomeTokenBrand]: true;
};

export type PrepareResult =
  | {
      kind: 'created';
      intent: IntentView;
      dispatchCapability: DispatchCapability;
    }
  | { kind: 'replay'; intent: IntentView };

export type DispatchClaimResult =
  | {
      kind: 'claimed';
      stateVersion: number;
      outcomeToken: DispatchOutcomeToken;
    }
  | { kind: 'lost' };

export type CancelResult =
  { kind: 'cancelled'; stateVersion: number } | { kind: 'lost' };

export type DispatchOutcome =
  | {
      kind: 'accepted';
      providerTaskId: string;
      providerType: TaskFamily;
    }
  | { kind: 'rejected' }
  | { kind: 'unknown' };

export interface LedgerPathOptions {
  stateDirectory: string;
}

export type LedgerErrorCode =
  | 'InvalidLedgerInput'
  | 'RequestIdConflict'
  | 'ProviderTypeMismatch'
  | 'UrlOverlap'
  | 'BudgetExceeded'
  | 'StalePeriodContext'
  | 'DispatchClaimLost'
  | 'DispatchOutcomeClaimLost'
  | 'PreparedCancelLost'
  | 'LedgerBusy'
  | 'LedgerUnavailable'
  | 'OutcomePersistenceFailed';

const errorMessages: Record<LedgerErrorCode, string> = {
  InvalidLedgerInput: 'Invalid submission ledger input.',
  RequestIdConflict: 'Submission request ID conflicts with its stored intent.',
  ProviderTypeMismatch:
    'Provider task type does not match the prepared intent.',
  UrlOverlap: 'A submitted URL is held by another unresolved intent.',
  BudgetExceeded: 'Submission unit allowance would be exceeded.',
  StalePeriodContext: 'Submission period context is stale or inconsistent.',
  DispatchClaimLost: 'Submission dispatch claim is no longer available.',
  DispatchOutcomeClaimLost: 'Submission outcome claim is no longer available.',
  PreparedCancelLost: 'Prepared submission can no longer be cancelled.',
  LedgerBusy: 'Submission ledger is busy.',
  LedgerUnavailable: 'Submission ledger is unavailable.',
  OutcomePersistenceFailed: 'Submission outcome could not be persisted.',
};

export class SubmissionLedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly unit: Unit | undefined;

  constructor(code: LedgerErrorCode, unit?: Unit) {
    super(errorMessages[code]);
    this.name = 'SubmissionLedgerError';
    this.code = code;
    this.unit = unit;
  }
}

const units = [
  'tokens',
  'indexer',
  'checker',
] as const satisfies readonly Unit[];
const databaseFilename = 'ledger.sqlite';
type SchemaVersion = 1 | 2;
const busyTimeoutMs = 2_000;
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const minSafeInteger = BigInt(Number.MIN_SAFE_INTEGER);
const sha256Pattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const schemaStatements = [
  `CREATE TABLE budget_periods (
    credential_fp TEXT NOT NULL,
    budget_scope TEXT NOT NULL,
    period_id TEXT NOT NULL,
    period_start_ms INTEGER NOT NULL CHECK (typeof(period_start_ms) = 'integer'),
    first_seen_at_ms INTEGER NOT NULL CHECK (typeof(first_seen_at_ms) = 'integer'),
    PRIMARY KEY (credential_fp, budget_scope, period_id),
    UNIQUE (credential_fp, budget_scope, period_start_ms)
  )`,
  `CREATE TABLE intents (
    credential_fp TEXT NOT NULL,
    request_id TEXT NOT NULL,
    budget_scope TEXT NOT NULL,
    period_id TEXT NOT NULL,
    period_start_ms INTEGER NOT NULL CHECK (typeof(period_start_ms) = 'integer'),
    policy_revision TEXT NOT NULL,
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
    task_family TEXT NOT NULL CHECK (task_family IN ('google/indexer', 'google/checker', 'yandex/indexer', 'yandex/checker', 'bing/checker', 'backlink/checker')),
    provider_route TEXT NOT NULL CHECK (provider_route = '/v2/task/' || task_family || '/create'),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
    quote_version TEXT NOT NULL,
    quote_fingerprint TEXT NOT NULL CHECK (length(quote_fingerprint) = 64 AND quote_fingerprint NOT GLOB '*[^0-9a-f]*'),
    reserved_tokens INTEGER NOT NULL CHECK (typeof(reserved_tokens) = 'integer' AND reserved_tokens >= 0),
    reserved_indexer INTEGER NOT NULL CHECK (typeof(reserved_indexer) = 'integer' AND reserved_indexer >= 0),
    reserved_checker INTEGER NOT NULL CHECK (typeof(reserved_checker) = 'integer' AND reserved_checker >= 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatching', 'accepted', 'rejected', 'unknown', 'cancelled')),
    state_version INTEGER NOT NULL CHECK (typeof(state_version) = 'integer'),
    claim_token_digest TEXT CHECK (claim_token_digest IS NULL OR (length(claim_token_digest) = 64 AND claim_token_digest NOT GLOB '*[^0-9a-f]*')),
    dispatch_outcome_token_digest TEXT CHECK (dispatch_outcome_token_digest IS NULL OR (length(dispatch_outcome_token_digest) = 64 AND dispatch_outcome_token_digest NOT GLOB '*[^0-9a-f]*')),
    created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer'),
    provider_task_id TEXT,
    provider_type TEXT CHECK (provider_type IS NULL OR provider_type IN ('google/indexer', 'google/checker', 'yandex/indexer', 'yandex/checker', 'bing/checker', 'backlink/checker')),
    PRIMARY KEY (credential_fp, request_id),
    FOREIGN KEY (credential_fp, budget_scope, period_id)
      REFERENCES budget_periods (credential_fp, budget_scope, period_id),
    CHECK (
      (state = 'prepared' AND state_version = 0 AND claim_token_digest IS NOT NULL AND dispatch_outcome_token_digest IS NULL AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (state = 'dispatching' AND state_version = 1 AND claim_token_digest IS NULL AND dispatch_outcome_token_digest IS NOT NULL AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (state = 'cancelled' AND state_version = 1 AND claim_token_digest IS NULL AND dispatch_outcome_token_digest IS NULL AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (state = 'accepted' AND state_version = 2 AND claim_token_digest IS NULL AND dispatch_outcome_token_digest IS NULL AND provider_task_id IS NOT NULL AND provider_type = task_family)
      OR (state IN ('rejected', 'unknown') AND state_version = 2 AND claim_token_digest IS NULL AND dispatch_outcome_token_digest IS NULL AND provider_task_id IS NULL AND provider_type IS NULL)
    )
  )`,
  `CREATE TABLE intent_urls (
    credential_fp TEXT NOT NULL,
    request_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
    url_text TEXT NOT NULL CHECK (length(url_text) > 0),
    PRIMARY KEY (credential_fp, request_id, ordinal),
    FOREIGN KEY (credential_fp, request_id)
      REFERENCES intents (credential_fp, request_id)
  )`,
  `CREATE TABLE intent_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_fp TEXT NOT NULL,
    request_id TEXT NOT NULL,
    state_version INTEGER NOT NULL CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 0 AND 2),
    event_kind TEXT NOT NULL CHECK (event_kind IN ('prepared', 'dispatching', 'accepted', 'rejected', 'unknown', 'cancelled')),
    occurred_at_ms INTEGER NOT NULL CHECK (typeof(occurred_at_ms) = 'integer'),
    provider_task_id TEXT,
    provider_type TEXT CHECK (provider_type IS NULL OR provider_type IN ('google/indexer', 'google/checker', 'yandex/indexer', 'yandex/checker', 'bing/checker', 'backlink/checker')),
    FOREIGN KEY (credential_fp, request_id)
      REFERENCES intents (credential_fp, request_id),
    CHECK (
      (event_kind = 'prepared' AND state_version = 0 AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (event_kind = 'dispatching' AND state_version = 1 AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (event_kind = 'cancelled' AND state_version = 1 AND provider_task_id IS NULL AND provider_type IS NULL)
      OR (event_kind = 'accepted' AND state_version = 2 AND provider_task_id IS NOT NULL AND provider_type IS NOT NULL)
      OR (event_kind IN ('rejected', 'unknown') AND state_version = 2 AND provider_task_id IS NULL AND provider_type IS NULL)
    )
  )`,
  'CREATE INDEX intents_budget_state_idx ON intents (credential_fp, budget_scope, state, period_id)',
  'CREATE INDEX intents_claim_token_digest_idx ON intents (claim_token_digest) WHERE claim_token_digest IS NOT NULL',
  'CREATE INDEX intent_urls_overlap_idx ON intent_urls (credential_fp, url_text)',
] as const;

const v2SchemaStatements = [
  `CREATE TABLE retry_ledger_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    ledger_id TEXT NOT NULL CHECK (length(ledger_id) = 64 AND ledger_id NOT GLOB '*[^0-9a-f]*')
  )`,
  `CREATE TABLE intent_context (
    credential_fp TEXT NOT NULL,
    request_id TEXT NOT NULL,
    origin_kind TEXT NOT NULL CHECK (origin_kind IN ('legacy_unattributed', 'standalone', 'retry')),
    parent_family TEXT,
    parent_task_id TEXT,
    source_manifest_digest TEXT,
    plan_fingerprint TEXT,
    PRIMARY KEY (credential_fp, request_id),
    FOREIGN KEY (credential_fp, request_id)
      REFERENCES intents (credential_fp, request_id),
    CHECK (
      (origin_kind IN ('legacy_unattributed', 'standalone') AND parent_family IS NULL AND parent_task_id IS NULL AND source_manifest_digest IS NULL AND plan_fingerprint IS NULL)
      OR (origin_kind = 'retry' AND parent_family IS NOT NULL AND parent_family IN ('google/indexer', 'yandex/indexer')
        AND parent_task_id IS NOT NULL AND length(trim(parent_task_id)) > 0
        AND source_manifest_digest IS NOT NULL AND length(source_manifest_digest) = 64 AND source_manifest_digest NOT GLOB '*[^0-9a-f]*'
        AND plan_fingerprint IS NOT NULL AND length(plan_fingerprint) = 64 AND plan_fingerprint NOT GLOB '*[^0-9a-f]*')
    )
  )`,
  'CREATE INDEX intent_context_parent_idx ON intent_context (credential_fp, parent_family, parent_task_id)',
  "CREATE INDEX intents_provider_ref_idx ON intents (credential_fp, task_family, provider_task_id) WHERE state = 'accepted'",
] as const;

function schemaObjectMap(statements: readonly string[]) {
  return new Map(
    statements.map((sql) => {
      const match = /^CREATE (TABLE|INDEX) (\w+)/i.exec(sql);
      if (!match) throw new Error('Invalid built-in ledger schema.');
      return [`${match[1]!.toLowerCase()}:${match[2]}`, sql] as const;
    }),
  );
}

const versionedSchemaObjects = {
  1: schemaObjectMap(schemaStatements),
  2: schemaObjectMap([...schemaStatements, ...v2SchemaStatements]),
};

export interface SubmissionLedger {
  prepareIntent(input: PrepareIntentInput): PrepareResult;
  claimDispatch(
    dispatchCapability: DispatchCapability,
    expectedStateVersion: number,
  ): DispatchClaimResult;
  recordDispatchOutcome(input: {
    credentialFingerprint: string;
    requestId: string;
    expectedStateVersion: number;
    outcomeToken: DispatchOutcomeToken;
    outcome: DispatchOutcome;
  }): IntentView;
  cancelPrepared(
    credentialFingerprint: string,
    requestId: string,
    expectedStateVersion: number,
  ): CancelResult;
  readIntent(
    credentialFingerprint: string,
    requestId: string,
  ): IntentView | null;
  close(): void;
}

function fail(code: LedgerErrorCode, unit?: Unit): never {
  throw new SubmissionLedgerError(code, unit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail('InvalidLedgerInput');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail('InvalidLedgerInput');
}

function requireVisibleAscii(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    fail('InvalidLedgerInput');
  }
}

function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !sha256Pattern.test(value))
    fail('InvalidLedgerInput');
}

function requireSafeNonnegativeInteger(
  value: unknown,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('InvalidLedgerInput');
}

function validateUnitVector(value: unknown): asserts value is UnitVector {
  requireKeys(value, units);
  for (const unit of units) requireSafeNonnegativeInteger(value[unit]);
}

function validateBudget(value: unknown): asserts value is TrustedBudgetContext {
  requireKeys(value, [
    'credentialFingerprint',
    'budgetScope',
    'periodId',
    'periodStartMs',
    'policyRevision',
    'policyDigest',
    'caps',
  ]);
  requireDigest(value.credentialFingerprint);
  requireVisibleAscii(value.budgetScope);
  requireVisibleAscii(value.periodId);
  if (!Number.isSafeInteger(value.periodStartMs)) fail('InvalidLedgerInput');
  requireVisibleAscii(value.policyRevision);
  requireDigest(value.policyDigest);
  validateUnitVector(value.caps);
}

function validatePrepareInput(
  value: unknown,
): asserts value is PrepareIntentInput {
  requireKeys(value, [
    'requestId',
    'budget',
    'taskFamily',
    'providerRoute',
    'payloadDigest',
    'submittedUrls',
    'quoteVersion',
    'quoteFingerprint',
    'reservation',
  ]);
  requireVisibleAscii(value.requestId);
  validateBudget(value.budget);
  const family = taskFamilySchema.safeParse(value.taskFamily);
  if (!family.success) fail('InvalidLedgerInput');
  const expectedRoute = `/v2/task/${family.data}/create`;
  if (value.providerRoute !== expectedRoute) fail('InvalidLedgerInput');
  requireDigest(value.payloadDigest);
  if (
    !Array.isArray(value.submittedUrls) ||
    value.submittedUrls.length < 1 ||
    value.submittedUrls.length > 10_000
  ) {
    fail('InvalidLedgerInput');
  }
  const seen = new Set<string>();
  for (const url of value.submittedUrls) {
    if (typeof url !== 'string' || url.length === 0 || seen.has(url))
      fail('InvalidLedgerInput');
    seen.add(url);
  }
  requireVisibleAscii(value.quoteVersion);
  requireDigest(value.quoteFingerprint);
  validateUnitVector(value.reservation);
}

function validateStateVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('InvalidLedgerInput');
}

function validateOutcome(value: unknown): asserts value is DispatchOutcome {
  if (!isRecord(value)) fail('InvalidLedgerInput');
  if (value.kind === 'accepted') {
    requireKeys(value, ['kind', 'providerTaskId', 'providerType']);
    if (
      typeof value.providerTaskId !== 'string' ||
      value.providerTaskId.length === 0
    )
      fail('InvalidLedgerInput');
    const type = taskFamilySchema.safeParse(value.providerType);
    if (!type.success) fail('InvalidLedgerInput');
    return;
  }
  if (value.kind === 'rejected' || value.kind === 'unknown') {
    requireKeys(value, ['kind']);
    return;
  }
  fail('InvalidLedgerInput');
}

function ensurePosixRuntime(): number {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    typeof process.geteuid !== 'function'
  ) {
    fail('LedgerUnavailable');
  }
  return process.geteuid();
}

function validatePathInput(value: unknown): asserts value is LedgerPathOptions {
  requireKeys(value, ['stateDirectory']);
  const directory = value.stateDirectory;
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.includes('\0') ||
    !isAbsolute(directory)
  ) {
    fail('InvalidLedgerInput');
  }
  try {
    if (resolve(directory) !== directory || basename(directory) === '')
      fail('InvalidLedgerInput');
  } catch {
    fail('InvalidLedgerInput');
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function lstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function validateTrustedAncestor(path: string, stats: Stats, uid: number) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail('LedgerUnavailable');
  if (stats.uid !== 0 && stats.uid !== uid) fail('LedgerUnavailable');
  const mode = stats.mode & 0o7777;
  const untrustedWrite = mode & 0o022;
  const rootStickyTemporary = stats.uid === 0 && (mode & 0o1000) !== 0;
  if (untrustedWrite !== 0 && !rootStickyTemporary) fail('LedgerUnavailable');
  if (path === '/' && stats.uid !== 0) fail('LedgerUnavailable');
}

function validateCanonicalPathComponents(directory: string, uid: number) {
  let current = '/';
  const rootStats = lstatSync(current);
  validateTrustedAncestor(current, rootStats, uid);
  const components = directory.split('/').filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    const stats = lstatSync(current);
    if (index < components.length - 1) {
      validateTrustedAncestor(current, stats, uid);
    } else {
      if (stats.isSymbolicLink() || !stats.isDirectory())
        fail('LedgerUnavailable');
      if (stats.uid !== uid || (stats.mode & 0o777) !== 0o700)
        fail('LedgerUnavailable');
    }
  }
  if (realpathSync(directory) !== directory) fail('LedgerUnavailable');
  return lstatSync(directory);
}

function validateCreationParent(parent: string, uid: number) {
  if (!isAbsolute(parent) || resolve(parent) !== parent)
    fail('LedgerUnavailable');
  let current = '/';
  validateTrustedAncestor(current, lstatSync(current), uid);
  for (const component of parent.split('/').filter(Boolean)) {
    current = join(current, component);
    validateTrustedAncestor(current, lstatSync(current), uid);
  }
  if (realpathSync(parent) !== parent) fail('LedgerUnavailable');
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  nlink: number;
}

function identityFrom(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    nlink: stats.nlink,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink
  );
}

function validateDatabaseFile(
  path: string,
  uid: number,
  requireNonzero: boolean,
) {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.uid !== uid ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    (requireNonzero && stats.size === 0)
  ) {
    fail('LedgerUnavailable');
  }
  if (realpathSync(path) !== path) fail('LedgerUnavailable');
  return identityFrom(stats);
}

function validateSidecars(directory: string, uid: number) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = join(directory, `${databaseFilename}${suffix}`);
    const stats = lstatOrMissing(path);
    if (stats === undefined) continue;
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.uid !== uid ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      (suffix === '-journal' && stats.size !== 0)
    ) {
      fail('LedgerUnavailable');
    }
  }
}

function openFlags() {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') fail('LedgerUnavailable');
  if (
    typeof sqliteConstants.SQLITE_OPEN_READWRITE !== 'number' ||
    typeof sqliteConstants.SQLITE_OPEN_NOFOLLOW !== 'number'
  ) {
    fail('LedgerUnavailable');
  }
  return {
    fileNoFollow: fsConstants.O_NOFOLLOW,
    database:
      sqliteConstants.SQLITE_OPEN_READWRITE |
      sqliteConstants.SQLITE_OPEN_NOFOLLOW,
  };
}

function createNewState(directory: string, uid: number) {
  const parent = dirname(directory);
  validateCreationParent(parent, uid);
  if (lstatOrMissing(directory) !== undefined) fail('LedgerUnavailable');
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch {
    fail('LedgerUnavailable');
  }
  validateCanonicalPathComponents(directory, uid);

  const path = join(directory, databaseFilename);
  const flags = openFlags();
  const createFlags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_RDWR |
    flags.fileNoFollow;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, createFlags, 0o600);
    const descriptorStats = fstatSync(fileDescriptor);
    const pathIdentity = validateDatabaseFile(path, uid, false);
    if (
      descriptorStats.uid !== uid ||
      !descriptorStats.isFile() ||
      descriptorStats.nlink !== 1 ||
      (descriptorStats.mode & 0o777) !== 0o600 ||
      descriptorStats.size !== 0 ||
      !sameIdentity(identityFrom(descriptorStats), pathIdentity)
    ) {
      fail('LedgerUnavailable');
    }
  } catch (error) {
    if (error instanceof SubmissionLedgerError) throw error;
    fail('LedgerUnavailable');
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        fail('LedgerUnavailable');
      }
    }
  }
  return path;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenDigestMatches(stored: string | null, token: string): boolean {
  if (stored === null || !sha256Pattern.test(stored)) return false;
  const expected = Buffer.from(stored, 'hex');
  const actual = Buffer.from(digestToken(token), 'hex');
  return timingSafeEqual(expected, actual);
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

function schemaRows(database: Database): SchemaRow[] {
  return database
    .query(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE name NOT GLOB 'sqlite_*'
         AND type IN ('table', 'index', 'view', 'trigger')
       ORDER BY type, name`,
    )
    .all() as SchemaRow[];
}

function ensureEmptyVersionZero(database: Database) {
  const version = readUserVersion(database);
  if (version !== 0 || schemaRows(database).length !== 0)
    fail('LedgerUnavailable');
}

function readUserVersion(database: Database): number {
  const row = database.query('PRAGMA user_version').get() as {
    user_version: number;
  } | null;
  if (!row || !Number.isSafeInteger(row.user_version))
    fail('LedgerUnavailable');
  return row.user_version;
}

interface SchemaIdentity {
  version: SchemaVersion;
  ledgerId: string | null;
}

function readLedgerId(database: Database): string {
  const rows = database
    .query(
      `SELECT singleton,
      CASE WHEN length(CAST(ledger_id AS BLOB)) = 64 THEN ledger_id END AS ledger_id
      FROM retry_ledger_meta LIMIT 2`,
    )
    .all() as {
    singleton: number;
    ledger_id: string;
  }[];
  if (
    rows.length !== 1 ||
    rows[0]!.singleton !== 1 ||
    typeof rows[0]!.ledger_id !== 'string' ||
    !sha256Pattern.test(rows[0]!.ledger_id)
  )
    fail('LedgerUnavailable');
  return rows[0]!.ledger_id;
}

function verifyCoreData(database: Database) {
  const check = database.query('PRAGMA quick_check').get() as {
    quick_check: string;
  } | null;
  if (
    check?.quick_check !== 'ok' ||
    database.query('PRAGMA foreign_key_check').get()
  )
    fail('LedgerUnavailable');
  // These are consistency checks, not snapshot resource limits or new V1 scalar limits.
  if (
    database
      .query(
        `SELECT 1 FROM intents i
      LEFT JOIN (
        SELECT credential_fp, request_id, COUNT(*) AS event_count,
          SUM(CASE WHEN state_version = 0 AND event_kind = 'prepared' THEN 1 ELSE 0 END) AS prepared_count,
          MAX(CASE WHEN state_version = 1 THEN event_kind END) AS phase_one_kind,
          MAX(CASE WHEN state_version = 2 THEN event_kind END) AS terminal_kind,
          MAX(CASE WHEN state_version = 2 THEN provider_task_id END) AS terminal_task_id,
          MAX(CASE WHEN state_version = 2 THEN provider_type END) AS terminal_type,
          MIN(CASE WHEN state_version = 0 THEN event_id END) AS prepared_event_id,
          MIN(CASE WHEN state_version = 1 THEN event_id END) AS phase_one_event_id,
          MIN(CASE WHEN state_version = 2 THEN event_id END) AS terminal_event_id
        FROM intent_events
        GROUP BY credential_fp, request_id
      ) e USING (credential_fp, request_id)
      WHERE NOT EXISTS (SELECT 1 FROM budget_periods b
        WHERE b.credential_fp = i.credential_fp AND b.budget_scope = i.budget_scope
          AND b.period_id = i.period_id AND b.period_start_ms = i.period_start_ms)
        OR NOT EXISTS (SELECT 1 FROM intent_urls u
          WHERE u.credential_fp = i.credential_fp AND u.request_id = i.request_id
          GROUP BY u.credential_fp, u.request_id
          HAVING MIN(u.ordinal) = 0 AND MAX(u.ordinal) = COUNT(*) - 1
            AND COUNT(DISTINCT u.url_text) = COUNT(*))
        OR e.event_count IS NULL OR e.event_count != i.state_version + 1
        OR e.prepared_count != 1
        OR (i.state_version >= 1 AND (
          e.phase_one_kind IS NOT CASE WHEN i.state = 'cancelled' THEN 'cancelled' ELSE 'dispatching' END
          OR e.prepared_event_id >= e.phase_one_event_id))
        OR (i.state_version = 2 AND (
          e.terminal_kind IS NOT i.state
          OR e.terminal_task_id IS NOT i.provider_task_id OR e.terminal_type IS NOT i.provider_type
          OR e.phase_one_event_id >= e.terminal_event_id))
      LIMIT 1`,
      )
      .get()
  )
    fail('LedgerUnavailable');
}

function verifyV2Data(database: Database, binding?: string) {
  verifyCoreData(database);
  if (
    database
      .query(
        `SELECT 1 FROM intents i
      LEFT JOIN intent_context c USING (credential_fp, request_id)
      WHERE c.request_id IS NULL LIMIT 1`,
      )
      .get()
  )
    fail('LedgerUnavailable');

  const contexts = database.query<
    {
      parent_family: string;
      parent_task_id: string;
      source_manifest_digest: unknown;
      plan_fingerprint: unknown;
      task_family: string;
      provider_task_id: string | null;
    },
    string[]
  >(`SELECT c.parent_family, c.parent_task_id, c.source_manifest_digest, c.plan_fingerprint,
      i.task_family, i.provider_task_id
    FROM intent_context c JOIN intents i USING (credential_fp, request_id)
    WHERE c.origin_kind = 'retry'${binding === undefined ? '' : ' AND c.credential_fp = ?'}`);
  for (const row of contexts.iterate(
    ...(binding === undefined ? [] : [binding]),
  )) {
    if (
      row.parent_family !== row.task_family ||
      !providerTaskIdSchema.safeParse(row.parent_task_id).success ||
      typeof row.source_manifest_digest !== 'string' ||
      !sha256Pattern.test(row.source_manifest_digest) ||
      typeof row.plan_fingerprint !== 'string' ||
      !sha256Pattern.test(row.plan_fingerprint) ||
      row.parent_task_id === row.provider_task_id
    )
      fail('LedgerUnavailable');
  }
}

function verifySchema(database: Database): SchemaIdentity {
  const schema = verifySchemaShape(database);
  if (schema.version === 2) verifyV2Data(database);
  return schema;
}

function verifySchemaShape(database: Database): SchemaIdentity {
  const version = readUserVersion(database);
  if (version !== 1 && version !== 2) fail('LedgerUnavailable');
  const schemaObjects = versionedSchemaObjects[version];
  const actualRows = schemaRows(database);
  if (actualRows.length !== schemaObjects.size) fail('LedgerUnavailable');
  const actual = new Map(
    actualRows.map((row) => [`${row.type}:${row.name}`, row.sql]),
  );
  for (const [key, expectedSql] of schemaObjects) {
    const actualSql = actual.get(key);
    if (actualSql === undefined || actualSql === null)
      fail('LedgerUnavailable');
    if (normalizeSql(actualSql) !== normalizeSql(expectedSql))
      fail('LedgerUnavailable');
  }
  if (version === 2) {
    const ledgerId = readLedgerId(database);
    return { version, ledgerId };
  }
  return { version, ledgerId: null };
}

function configureConnection(database: Database) {
  database.run('PRAGMA foreign_keys = ON');
  const foreignKeys = database.query('PRAGMA foreign_keys').get() as {
    foreign_keys: number;
  } | null;
  if (foreignKeys?.foreign_keys !== 1) fail('LedgerUnavailable');

  const journalMode = database.query('PRAGMA journal_mode = WAL').get() as {
    journal_mode: string;
  } | null;
  if (journalMode?.journal_mode.toLowerCase() !== 'wal')
    fail('LedgerUnavailable');

  database.run('PRAGMA synchronous = FULL');
  const synchronous = database.query('PRAGMA synchronous').get() as {
    synchronous: number;
  } | null;
  if (synchronous?.synchronous !== 2) fail('LedgerUnavailable');

  database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const busyTimeout = database.query('PRAGMA busy_timeout').get() as {
    timeout: number;
  } | null;
  if (busyTimeout?.timeout !== busyTimeoutMs) fail('LedgerUnavailable');
}

function toLedgerError(
  error: unknown,
  fallback: LedgerErrorCode = 'LedgerUnavailable',
): SubmissionLedgerError {
  if (error instanceof SubmissionLedgerError) return error;
  if (error instanceof SQLiteError && error.code?.startsWith('SQLITE_BUSY'))
    return new SubmissionLedgerError('LedgerBusy');
  return new SubmissionLedgerError(fallback);
}

function withImmediateTransaction<T>(
  database: Database,
  operation: () => T,
  fallback: LedgerErrorCode = 'LedgerUnavailable',
): T {
  try {
    return database.transaction(operation).immediate();
  } catch (error) {
    throw toLedgerError(error, fallback);
  }
}

function safeIntegerFromText(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value))
    fail('LedgerUnavailable');
  let integer: bigint;
  try {
    integer = BigInt(value);
  } catch {
    fail('LedgerUnavailable');
  }
  if (integer > maxSafeInteger || integer < minSafeInteger)
    fail('LedgerUnavailable');
  return Number(integer);
}

interface PeriodStartRow {
  period_start_text: string;
}

interface PeriodIdRow {
  period_id: string;
}

function validateAndRecordPeriod(
  database: Database,
  budget: TrustedBudgetContext,
  now: number,
) {
  const existingId = database
    .query(
      `SELECT CAST(period_start_ms AS TEXT) AS period_start_text
       FROM budget_periods
       WHERE credential_fp = ? AND budget_scope = ? AND period_id = ?`,
    )
    .get(
      budget.credentialFingerprint,
      budget.budgetScope,
      budget.periodId,
    ) as PeriodStartRow | null;
  if (
    existingId &&
    safeIntegerFromText(existingId.period_start_text) !== budget.periodStartMs
  ) {
    fail('StalePeriodContext');
  }

  const existingStart = database
    .query(
      `SELECT period_id
       FROM budget_periods
       WHERE credential_fp = ? AND budget_scope = ? AND period_start_ms = ?`,
    )
    .get(
      budget.credentialFingerprint,
      budget.budgetScope,
      budget.periodStartMs,
    ) as PeriodIdRow | null;
  if (existingStart && existingStart.period_id !== budget.periodId)
    fail('StalePeriodContext');

  const latest = database
    .query(
      `SELECT CAST(MAX(period_start_ms) AS TEXT) AS period_start_text
       FROM budget_periods
       WHERE credential_fp = ? AND budget_scope = ?`,
    )
    .get(
      budget.credentialFingerprint,
      budget.budgetScope,
    ) as PeriodStartRow | null;
  const latestStart =
    latest?.period_start_text === null ||
    latest?.period_start_text === undefined
      ? undefined
      : safeIntegerFromText(latest.period_start_text);

  if (latestStart !== undefined && budget.periodStartMs < latestStart)
    fail('StalePeriodContext');
  if (
    existingId === null &&
    latestStart !== undefined &&
    budget.periodStartMs <= latestStart
  ) {
    fail('StalePeriodContext');
  }

  if (existingId === null) {
    database
      .query(
        `INSERT INTO budget_periods
          (credential_fp, budget_scope, period_id, period_start_ms, first_seen_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        budget.credentialFingerprint,
        budget.budgetScope,
        budget.periodId,
        budget.periodStartMs,
        now,
      );
  }
}

interface IntentRow {
  credential_fp: string;
  request_id: string;
  budget_scope: string;
  period_id: string;
  period_start_text: string;
  policy_revision: string;
  policy_digest: string;
  task_family: string;
  provider_route: string;
  payload_digest: string;
  quote_version: string;
  quote_fingerprint: string;
  reserved_tokens_text: string;
  reserved_indexer_text: string;
  reserved_checker_text: string;
  state: string;
  state_version_text: string;
  claim_token_digest: string | null;
  dispatch_outcome_token_digest: string | null;
  created_at_text: string;
  provider_task_id: string | null;
  provider_type: string | null;
  url_count_text: string;
}

const intentSelect = `SELECT
    i.credential_fp,
    i.request_id,
    i.budget_scope,
    i.period_id,
    CAST(i.period_start_ms AS TEXT) AS period_start_text,
    i.policy_revision,
    i.policy_digest,
    i.task_family,
    i.provider_route,
    i.payload_digest,
    i.quote_version,
    i.quote_fingerprint,
    CAST(i.reserved_tokens AS TEXT) AS reserved_tokens_text,
    CAST(i.reserved_indexer AS TEXT) AS reserved_indexer_text,
    CAST(i.reserved_checker AS TEXT) AS reserved_checker_text,
    i.state,
    CAST(i.state_version AS TEXT) AS state_version_text,
    i.claim_token_digest,
    i.dispatch_outcome_token_digest,
    CAST(i.created_at_ms AS TEXT) AS created_at_text,
    i.provider_task_id,
    i.provider_type,
    CAST((SELECT COUNT(*) FROM intent_urls u
          WHERE u.credential_fp = i.credential_fp AND u.request_id = i.request_id)
         AS TEXT) AS url_count_text
  FROM intents i`;

function rowToIntentView(row: IntentRow): IntentView {
  const family = taskFamilySchema.safeParse(row.task_family);
  if (
    !family.success ||
    row.provider_route !== `/v2/task/${row.task_family}/create`
  )
    fail('LedgerUnavailable');
  const states: readonly IntentState[] = [
    'prepared',
    'dispatching',
    'accepted',
    'rejected',
    'unknown',
    'cancelled',
  ];
  if (!states.includes(row.state as IntentState)) fail('LedgerUnavailable');
  const view: IntentView = {
    credentialFingerprint: row.credential_fp,
    requestId: row.request_id,
    budgetScope: row.budget_scope,
    periodId: row.period_id,
    periodStartMs: safeIntegerFromText(row.period_start_text),
    policyRevision: row.policy_revision,
    policyDigest: row.policy_digest,
    taskFamily: family.data,
    providerRoute: row.provider_route as ProviderRoute,
    payloadDigest: row.payload_digest,
    quoteVersion: row.quote_version,
    quoteFingerprint: row.quote_fingerprint,
    reservation: {
      tokens: safeIntegerFromText(row.reserved_tokens_text),
      indexer: safeIntegerFromText(row.reserved_indexer_text),
      checker: safeIntegerFromText(row.reserved_checker_text),
    },
    urlCount: safeIntegerFromText(row.url_count_text),
    state: row.state as IntentState,
    stateVersion: safeIntegerFromText(row.state_version_text),
    createdAtMs: safeIntegerFromText(row.created_at_text),
  };
  if (row.provider_task_id !== null) view.providerTaskId = row.provider_task_id;
  if (row.provider_type !== null) {
    const providerType = taskFamilySchema.safeParse(row.provider_type);
    if (!providerType.success) fail('LedgerUnavailable');
    view.providerType = providerType.data;
  }
  return view;
}

function selectIntent(
  database: Database,
  credentialFingerprint: string,
  requestId: string,
): IntentRow | null {
  return database
    .query(`${intentSelect} WHERE i.credential_fp = ? AND i.request_id = ?`)
    .get(credentialFingerprint, requestId) as IntentRow | null;
}

function exactUrlSequenceMatches(
  database: Database,
  credentialFingerprint: string,
  requestId: string,
  submittedUrls: readonly string[],
): boolean {
  const rows = database
    .query(
      `SELECT url_text
       FROM intent_urls
       WHERE credential_fp = ? AND request_id = ?
       ORDER BY ordinal`,
    )
    .all(credentialFingerprint, requestId) as { url_text: string }[];
  return (
    rows.length === submittedUrls.length &&
    rows.every((row, index) => row.url_text === submittedUrls[index])
  );
}

function isExactReplay(
  database: Database,
  row: IntentRow,
  input: PrepareIntentInput,
): boolean {
  const { budget } = input;
  return (
    row.budget_scope === budget.budgetScope &&
    row.policy_revision === budget.policyRevision &&
    row.policy_digest === budget.policyDigest &&
    row.task_family === input.taskFamily &&
    row.provider_route === input.providerRoute &&
    row.payload_digest === input.payloadDigest &&
    row.quote_version === input.quoteVersion &&
    row.quote_fingerprint === input.quoteFingerprint &&
    safeIntegerFromText(row.reserved_tokens_text) ===
      input.reservation.tokens &&
    safeIntegerFromText(row.reserved_indexer_text) ===
      input.reservation.indexer &&
    safeIntegerFromText(row.reserved_checker_text) ===
      input.reservation.checker &&
    exactUrlSequenceMatches(
      database,
      budget.credentialFingerprint,
      input.requestId,
      input.submittedUrls,
    )
  );
}

interface UsageRow {
  tokens_text: string;
  indexer_text: string;
  checker_text: string;
}

function assertWithinBudget(
  database: Database,
  input: PrepareIntentInput,
): void {
  const row = database
    .query(
      `SELECT
         CAST(COALESCE(SUM(CASE
           WHEN state IN ('prepared', 'dispatching', 'unknown')
             OR (state = 'accepted' AND period_id = ?)
           THEN reserved_tokens ELSE 0 END), 0) AS TEXT) AS tokens_text,
         CAST(COALESCE(SUM(CASE
           WHEN state IN ('prepared', 'dispatching', 'unknown')
             OR (state = 'accepted' AND period_id = ?)
           THEN reserved_indexer ELSE 0 END), 0) AS TEXT) AS indexer_text,
         CAST(COALESCE(SUM(CASE
           WHEN state IN ('prepared', 'dispatching', 'unknown')
             OR (state = 'accepted' AND period_id = ?)
           THEN reserved_checker ELSE 0 END), 0) AS TEXT) AS checker_text
       FROM intents
       WHERE credential_fp = ? AND budget_scope = ?`,
    )
    .get(
      input.budget.periodId,
      input.budget.periodId,
      input.budget.periodId,
      input.budget.credentialFingerprint,
      input.budget.budgetScope,
    ) as UsageRow | null;
  if (!row) fail('LedgerUnavailable');

  for (const unit of units) {
    const column = `${unit}_text` as keyof UsageRow;
    const usedText = row[column];
    if (typeof usedText !== 'string' || !/^\d+$/.test(usedText))
      fail('LedgerUnavailable');
    let used: bigint;
    try {
      used = BigInt(usedText);
    } catch {
      fail('LedgerUnavailable');
    }
    if (used > maxSafeInteger) fail('BudgetExceeded', unit);
    const requested = BigInt(input.reservation[unit]);
    if (used + requested > BigInt(input.budget.caps[unit]))
      fail('BudgetExceeded', unit);
  }
}

function validateRequestId(value: unknown) {
  requireVisibleAscii(value);
}

function checkToken(value: unknown) {
  if (typeof value !== 'string' || !tokenPattern.test(value))
    fail('InvalidLedgerInput');
  return value;
}

class LocalSubmissionLedger implements SubmissionLedger {
  private closed = false;
  private schemaInvalidated = false;

  constructor(
    private readonly database: Database,
    private readonly stateDirectory: string,
    private readonly openedSchema: SchemaIdentity,
  ) {}

  private ensureOpen() {
    if (this.closed || this.schemaInvalidated) fail('LedgerUnavailable');
  }

  private verifyMutationVersion() {
    // Called after BEGIN IMMEDIATE, before replay or any write. Old binaries
    // still require the operator's offline stop/restart discipline.
    if (
      readUserVersion(this.database) !== this.openedSchema.version ||
      (this.openedSchema.version === 2 &&
        readLedgerId(this.database) !== this.openedSchema.ledgerId)
    ) {
      this.schemaInvalidated = true;
      fail('LedgerUnavailable');
    }
  }

  prepareIntent(value: PrepareIntentInput): PrepareResult {
    this.ensureOpen();
    validatePrepareInput(value);
    const input = value;
    const now = Date.now();
    if (!Number.isSafeInteger(now)) fail('LedgerUnavailable');

    try {
      const result = withImmediateTransaction(this.database, () => {
        this.verifyMutationVersion();
        const existing = selectIntent(
          this.database,
          input.budget.credentialFingerprint,
          input.requestId,
        );
        if (existing) {
          if (this.openedSchema.version === 2) {
            const context = this.database
              .query(
                `SELECT origin_kind FROM intent_context
              WHERE credential_fp = ? AND request_id = ?`,
              )
              .get(input.budget.credentialFingerprint, input.requestId) as {
              origin_kind: string;
            } | null;
            if (!context) fail('LedgerUnavailable');
            if (context.origin_kind === 'retry') fail('RequestIdConflict');
            if (
              context.origin_kind !== 'standalone' &&
              context.origin_kind !== 'legacy_unattributed'
            )
              fail('LedgerUnavailable');
          }
          if (!isExactReplay(this.database, existing, input))
            fail('RequestIdConflict');
          return {
            kind: 'replay' as const,
            intent: rowToIntentView(existing),
          };
        }

        const overlap = this.database
          .query(
            `SELECT 1 AS found
             FROM intent_urls u
             JOIN intents i
               ON i.credential_fp = u.credential_fp AND i.request_id = u.request_id
             WHERE u.credential_fp = ?
               AND i.state IN ('prepared', 'dispatching', 'unknown')
               AND u.url_text IN (${input.submittedUrls.map(() => '?').join(', ')})
             LIMIT 1`,
          )
          .get(input.budget.credentialFingerprint, ...input.submittedUrls);
        if (overlap) fail('UrlOverlap');

        validateAndRecordPeriod(this.database, input.budget, now);
        assertWithinBudget(this.database, input);

        const capability = mintToken() as DispatchCapability;
        const capabilityDigest = digestToken(capability);
        this.database
          .query(
            `INSERT INTO intents (
              credential_fp, request_id, budget_scope, period_id, period_start_ms,
              policy_revision, policy_digest, task_family, provider_route,
              payload_digest, quote_version, quote_fingerprint,
              reserved_tokens, reserved_indexer, reserved_checker,
              state, state_version, claim_token_digest,
              dispatch_outcome_token_digest, created_at_ms, provider_task_id, provider_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, NULL, ?, NULL, NULL)`,
          )
          .run(
            input.budget.credentialFingerprint,
            input.requestId,
            input.budget.budgetScope,
            input.budget.periodId,
            input.budget.periodStartMs,
            input.budget.policyRevision,
            input.budget.policyDigest,
            input.taskFamily,
            input.providerRoute,
            input.payloadDigest,
            input.quoteVersion,
            input.quoteFingerprint,
            input.reservation.tokens,
            input.reservation.indexer,
            input.reservation.checker,
            capabilityDigest,
            now,
          );
        const insertUrl = this.database.query(
          `INSERT INTO intent_urls (credential_fp, request_id, ordinal, url_text)
           VALUES (?, ?, ?, ?)`,
        );
        for (const [ordinal, url] of input.submittedUrls.entries()) {
          insertUrl.run(
            input.budget.credentialFingerprint,
            input.requestId,
            ordinal,
            url,
          );
        }
        this.appendEvent(
          input.budget.credentialFingerprint,
          input.requestId,
          0,
          'prepared',
          now,
        );
        if (this.openedSchema.version === 2) {
          this.database
            .query(
              `INSERT INTO intent_context
            (credential_fp, request_id, origin_kind) VALUES (?, ?, 'standalone')`,
            )
            .run(input.budget.credentialFingerprint, input.requestId);
        }
        const created = selectIntent(
          this.database,
          input.budget.credentialFingerprint,
          input.requestId,
        );
        if (!created) fail('LedgerUnavailable');
        return {
          kind: 'created' as const,
          intent: rowToIntentView(created),
          dispatchCapability: capability,
        };
      });
      return result;
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  claimDispatch(
    capabilityValue: DispatchCapability,
    expectedStateVersion: number,
  ): DispatchClaimResult {
    this.ensureOpen();
    const capability = checkToken(capabilityValue);
    validateStateVersion(expectedStateVersion);

    try {
      const capabilityDigest = digestToken(capability);
      return withImmediateTransaction(this.database, () => {
        this.verifyMutationVersion();
        const row = this.database
          .query(
            `SELECT credential_fp, request_id, state_version, claim_token_digest
             FROM intents
             WHERE state = 'prepared' AND state_version = ?
               AND claim_token_digest = ?`,
          )
          .get(expectedStateVersion, capabilityDigest) as {
          credential_fp: string;
          request_id: string;
          state_version: number;
          claim_token_digest: string | null;
        } | null;
        if (
          !row ||
          row.state_version !== expectedStateVersion ||
          !tokenDigestMatches(row.claim_token_digest, capability)
        ) {
          return { kind: 'lost' };
        }

        const outcomeToken = mintToken() as DispatchOutcomeToken;
        const outcomeDigest = digestToken(outcomeToken);
        const updated = this.database
          .query(
            `UPDATE intents
             SET state = 'dispatching', state_version = 1,
                 claim_token_digest = NULL, dispatch_outcome_token_digest = ?
             WHERE credential_fp = ? AND request_id = ?
               AND state = 'prepared' AND state_version = ? AND claim_token_digest = ?`,
          )
          .run(
            outcomeDigest,
            row.credential_fp,
            row.request_id,
            expectedStateVersion,
            capabilityDigest,
          );
        if (updated.changes !== 1) return { kind: 'lost' };
        this.appendEvent(
          row.credential_fp,
          row.request_id,
          1,
          'dispatching',
          Date.now(),
        );
        return { kind: 'claimed', stateVersion: 1, outcomeToken };
      });
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  recordDispatchOutcome(input: {
    credentialFingerprint: string;
    requestId: string;
    expectedStateVersion: number;
    outcomeToken: DispatchOutcomeToken;
    outcome: DispatchOutcome;
  }): IntentView {
    this.ensureOpen();
    requireKeys(input, [
      'credentialFingerprint',
      'requestId',
      'expectedStateVersion',
      'outcomeToken',
      'outcome',
    ]);
    requireDigest(input.credentialFingerprint);
    validateRequestId(input.requestId);
    validateStateVersion(input.expectedStateVersion);
    const outcomeToken = checkToken(input.outcomeToken);
    validateOutcome(input.outcome);

    try {
      return withImmediateTransaction(
        this.database,
        () => {
          this.verifyMutationVersion();
          const row = this.database
            .query(
              `SELECT credential_fp, request_id, state, state_version,
                      task_family, dispatch_outcome_token_digest
               FROM intents WHERE credential_fp = ? AND request_id = ?`,
            )
            .get(input.credentialFingerprint, input.requestId) as {
            credential_fp: string;
            request_id: string;
            state: string;
            state_version: number;
            task_family: string;
            dispatch_outcome_token_digest: string | null;
          } | null;
          if (
            !row ||
            row.state !== 'dispatching' ||
            row.state_version !== input.expectedStateVersion ||
            !tokenDigestMatches(row.dispatch_outcome_token_digest, outcomeToken)
          ) {
            fail('DispatchOutcomeClaimLost');
          }

          if (
            input.outcome.kind === 'accepted' &&
            input.outcome.providerType !== row.task_family
          ) {
            fail('ProviderTypeMismatch');
          }

          const nextState = input.outcome.kind;
          const taskId =
            input.outcome.kind === 'accepted'
              ? input.outcome.providerTaskId
              : null;
          const providerType =
            input.outcome.kind === 'accepted'
              ? input.outcome.providerType
              : null;
          const updated = this.database
            .query(
              `UPDATE intents
               SET state = ?, state_version = 2,
                   provider_task_id = ?, provider_type = ?,
                   dispatch_outcome_token_digest = NULL
               WHERE credential_fp = ? AND request_id = ?
                 AND state = 'dispatching' AND state_version = ?
                 AND dispatch_outcome_token_digest = ?`,
            )
            .run(
              nextState,
              taskId,
              providerType,
              input.credentialFingerprint,
              input.requestId,
              input.expectedStateVersion,
              digestToken(outcomeToken),
            );
          if (updated.changes !== 1) fail('DispatchOutcomeClaimLost');
          this.appendEvent(
            input.credentialFingerprint,
            input.requestId,
            2,
            nextState,
            Date.now(),
            taskId,
            providerType,
          );
          const stored = selectIntent(
            this.database,
            input.credentialFingerprint,
            input.requestId,
          );
          if (!stored) fail('OutcomePersistenceFailed');
          return rowToIntentView(stored);
        },
        'OutcomePersistenceFailed',
      );
    } catch (error) {
      throw toLedgerError(error, 'OutcomePersistenceFailed');
    }
  }

  cancelPrepared(
    credentialFingerprint: string,
    requestId: string,
    expectedStateVersion: number,
  ): CancelResult {
    this.ensureOpen();
    requireDigest(credentialFingerprint);
    validateRequestId(requestId);
    validateStateVersion(expectedStateVersion);
    try {
      return withImmediateTransaction(this.database, () => {
        this.verifyMutationVersion();
        const updated = this.database
          .query(
            `UPDATE intents
             SET state = 'cancelled', state_version = 1, claim_token_digest = NULL
             WHERE credential_fp = ? AND request_id = ?
               AND state = 'prepared' AND state_version = ?`,
          )
          .run(credentialFingerprint, requestId, expectedStateVersion);
        if (updated.changes !== 1) return { kind: 'lost' };
        this.appendEvent(
          credentialFingerprint,
          requestId,
          1,
          'cancelled',
          Date.now(),
        );
        return { kind: 'cancelled', stateVersion: 1 };
      });
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  readIntent(
    credentialFingerprint: string,
    requestId: string,
  ): IntentView | null {
    this.ensureOpen();
    requireDigest(credentialFingerprint);
    validateRequestId(requestId);
    try {
      const row = selectIntent(this.database, credentialFingerprint, requestId);
      return row ? rowToIntentView(row) : null;
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  private appendEvent(
    credentialFingerprint: string,
    requestId: string,
    stateVersion: number,
    kind: IntentState,
    occurredAt: number,
    providerTaskId: string | null = null,
    providerType: TaskFamily | null = null,
  ) {
    this.database
      .query(
        `INSERT INTO intent_events (
          credential_fp, request_id, state_version, event_kind,
          occurred_at_ms, provider_task_id, provider_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credentialFingerprint,
        requestId,
        stateVersion,
        kind,
        occurredAt,
        providerTaskId,
        providerType,
      );
  }
}

function openDatabase(path: string): Database {
  const flags = openFlags();
  try {
    return new Database(path, flags.database);
  } catch (error) {
    throw toLedgerError(error);
  }
}

export function initializeLedger(options: LedgerPathOptions): SubmissionLedger {
  return initializeVersionedLedger(options, 1);
}

// Internal explicit new-only initializer. No CLI/startup migration or activation.
export function initializeLedgerV2(
  options: LedgerPathOptions,
): SubmissionLedger {
  return initializeVersionedLedger(options, 2);
}

function initializeVersionedLedger(
  options: LedgerPathOptions,
  version: SchemaVersion,
): SubmissionLedger {
  validatePathInput(options);
  const uid = ensurePosixRuntime();
  let database: Database | undefined;
  try {
    const path = createNewState(options.stateDirectory, uid);
    const identity = validateDatabaseFile(path, uid, false);
    database = openDatabase(path);
    if (!sameIdentity(identity, validateDatabaseFile(path, uid, false)))
      fail('LedgerUnavailable');
    configureConnection(database);
    validateSidecars(options.stateDirectory, uid);

    const openedSchema = withImmediateTransaction(database, () => {
      ensureEmptyVersionZero(database!);
      for (const sql of schemaStatements) database!.run(sql);
      if (version === 2) {
        for (const sql of v2SchemaStatements) database!.run(sql);
        database!
          .query(
            'INSERT INTO retry_ledger_meta (singleton, ledger_id) VALUES (1, ?)',
          )
          .run(randomBytes(32).toString('hex'));
      }
      database!.run(`PRAGMA user_version = ${version}`);
      return verifySchema(database!);
    });

    validateCanonicalPathComponents(options.stateDirectory, uid);
    validateDatabaseFile(path, uid, true);
    validateSidecars(options.stateDirectory, uid);
    const ledger = new LocalSubmissionLedger(
      database,
      options.stateDirectory,
      openedSchema,
    );
    database = undefined;
    return ledger;
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // The fixed public error below does not expose the SQLite failure.
      }
    }
    throw toLedgerError(error);
  }
}

export function openLedger(options: LedgerPathOptions): SubmissionLedger {
  validatePathInput(options);
  const uid = ensurePosixRuntime();
  let database: Database | undefined;
  try {
    validateCanonicalPathComponents(options.stateDirectory, uid);
    const path = join(options.stateDirectory, databaseFilename);
    validateSidecars(options.stateDirectory, uid);
    const identity = validateDatabaseFile(path, uid, true);
    database = openDatabase(path);
    if (!sameIdentity(identity, validateDatabaseFile(path, uid, true)))
      fail('LedgerUnavailable');

    const openedSchema = database
      .transaction(() => verifySchema(database!))
      .deferred();
    configureConnection(database);
    validateCanonicalPathComponents(options.stateDirectory, uid);
    if (!sameIdentity(identity, validateDatabaseFile(path, uid, true)))
      fail('LedgerUnavailable');
    validateSidecars(options.stateDirectory, uid);

    const ledger = new LocalSubmissionLedger(
      database,
      options.stateDirectory,
      openedSchema,
    );
    database = undefined;
    return ledger;
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // Keep state untouched and return only the fixed category.
      }
    }
    throw toLedgerError(error);
  }
}

// Trusted internal semantic reader. SQLite may update physical WAL bookkeeping;
// query_only and a single read transaction prohibit logical ledger mutation.
export function readRetrySnapshot(
  options: LedgerPathOptions,
  credentialFingerprint: string,
  hooks: SnapshotReadHooks = {},
): RetrySnapshot {
  let database: Database | undefined;
  let result: RetrySnapshot;
  try {
    validatePathInput(options);
    requireDigest(credentialFingerprint);
    const limits = snapshotLimits(hooks.limits);
    const uid = ensurePosixRuntime();
    if (!lstatOrMissing(options.stateDirectory))
      throw new SnapshotReadError('MissingState');
    const directoryIdentity = identityFrom(
      validateCanonicalPathComponents(options.stateDirectory, uid),
    );
    const path = join(options.stateDirectory, databaseFilename);
    validateSidecars(options.stateDirectory, uid);
    if (!lstatOrMissing(path)) throw new SnapshotReadError('MissingState');
    const identity = validateDatabaseFile(path, uid, true);
    database = new Database(path, openFlags().database);
    database.run('PRAGMA query_only = ON');
    database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.run('PRAGMA foreign_keys = ON');
    assertStorageIdentity(
      options.stateDirectory,
      uid,
      identity,
      directoryIdentity,
    );
    result = database
      .transaction((): RetrySnapshot => {
        // This schema SELECT, rather than BEGIN alone, pins the read snapshot.
        const schemaBytes = database!
          .query<{ n: number }, []>(
            'SELECT COALESCE(SUM(length(CAST(sql AS BLOB))), 0) AS n FROM sqlite_schema',
          )
          .get()!.n;
        signalSnapshotPhase(hooks, 'snapshot_fixed');
        if (
          !Number.isSafeInteger(schemaBytes) ||
          schemaBytes > 16 * 1024 * 1024
        )
          throw new SnapshotReadError('LimitExceeded');
        requireWal(database!);
        const schema = verifySchemaShape(database!);
        if (schema.version === 1)
          throw new SnapshotReadError('UpgradeRequired');
        checkSnapshotBounds(database!, credentialFingerprint, limits);
        verifyV2Data(database!, credentialFingerprint);
        signalSnapshotPhase(hooks, 'before_projection');
        return projectRetrySnapshot(
          database!,
          credentialFingerprint,
          schema.ledgerId!,
          limits,
        );
      })
      .deferred();
    assertStorageIdentity(
      options.stateDirectory,
      uid,
      identity,
      directoryIdentity,
    );
    signalSnapshotPhase(hooks, 'before_close');
    database.close(true);
    database = undefined;
    assertStorageIdentity(
      options.stateDirectory,
      uid,
      identity,
      directoryIdentity,
    );
  } catch (error) {
    const reason =
      error instanceof SnapshotReadError
        ? error.reason
        : error instanceof SubmissionLedgerError ||
            error instanceof LedgerMigrationError
          ? 'InvalidState'
          : error instanceof SQLiteError &&
              (error.code?.startsWith('SQLITE_BUSY') ||
                error.code?.startsWith('SQLITE_LOCKED'))
            ? 'Busy'
            : error instanceof SQLiteError &&
                (error.code?.startsWith('SQLITE_CORRUPT') ||
                  error.code === 'SQLITE_NOTADB')
              ? 'InvalidState'
              : 'ReadFailure';
    result = { availability: 'unavailable', reason };
  } finally {
    if (database) {
      try {
        database.close(true);
      } catch {
        result = { availability: 'unavailable', reason: 'ReadFailure' };
      }
    }
  }
  return freezeSnapshot(result);
}

export class LedgerMigrationError extends Error {
  constructor(
    readonly code:
      'InvalidState' | 'LedgerBusy' | 'BackupFailed' | 'MigrationFailed',
  ) {
    super(
      {
        InvalidState: 'Submission migration state is invalid.',
        LedgerBusy: 'Submission migration state is busy.',
        BackupFailed: 'Submission migration backup could not be verified.',
        MigrationFailed:
          'Submission migration could not be confirmed; inspect state before retrying.',
      }[code],
    );
    this.name = 'LedgerMigrationError';
  }
}

export type MigrationReceipt =
  | { migrated: true; schemaVersion: 2; backupVerified: true }
  | { migrated: false; schemaVersion: 2; reason: 'AlreadyV2' };

// Trusted in-process test wiring only; never supplied by CLI, MCP, policy or environment.
export type MigrationPhase =
  'backup_verified' | 'before_commit' | 'after_commit';

export interface MigrationTestHooks {
  afterCheckpoint?: () => void;
  onPhase?: (phase: MigrationPhase) => void;
  maxWriteBytes?: number;
  fault?: 'copy' | 'fileSync' | 'directorySync' | 'parentSync';
}

function signalMigrationPhase(
  hooks: MigrationTestHooks,
  phase: MigrationPhase,
) {
  if (!hooks.onPhase) return;
  if (hooks.onPhase.constructor.name === 'AsyncFunction')
    throw new LedgerMigrationError('MigrationFailed');
  const result = hooks.onPhase(phase);
  if (result !== undefined) throw new LedgerMigrationError('MigrationFailed');
}

const copyBufferBytes = 64 * 1024;
const coreTableOrder = {
  budget_periods:
    'credential_fp COLLATE BINARY, budget_scope COLLATE BINARY, period_id COLLATE BINARY',
  intents: 'credential_fp COLLATE BINARY, request_id COLLATE BINARY',
  intent_urls:
    'credential_fp COLLATE BINARY, request_id COLLATE BINARY, ordinal',
  intent_events: 'event_id',
  sqlite_sequence: 'name COLLATE BINARY, seq',
} as const;

function coreProjectionDigest(database: Database): string {
  const digest = createHash('sha256');
  const frame = (text: string) => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(Buffer.byteLength(text, 'utf8')));
    digest.update(length).update(text, 'utf8');
  };
  frame('speedyindex-core-preservation-v1');
  for (const [table, order] of Object.entries(coreTableOrder)) {
    frame(table);
    const columns = database.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    const projection = columns.flatMap(({ name }, index) => {
      // Names are from the exact allowlisted schema, never caller input.
      const column = `"${name}"`;
      return [
        `typeof(${column}) AS t${index}`,
        `CASE WHEN typeof(${column}) = 'integer' THEN CAST(${column} AS TEXT) WHEN typeof(${column}) = 'real' THEN ${column} ELSE hex(${column}) END AS v${index}`,
      ];
    });
    for (const column of columns) frame(column.name);
    const query = database.query<Record<string, string | number>, []>(
      `SELECT ${projection.join(', ')} FROM ${table} ORDER BY ${order}`,
    );
    for (const row of query.iterate()) {
      frame('row');
      for (const [index] of columns.entries()) {
        frame(row[`t${index}`] as string);
        const value = row[`v${index}`]!;
        if (typeof value === 'number') {
          const binary = Buffer.alloc(8);
          binary.writeDoubleBE(value);
          frame(binary.toString('hex'));
        } else frame(value);
      }
    }
    frame('end');
  }
  return digest.digest('hex');
}

function verifyMigrationCoreData(database: Database) {
  const check = database.query('PRAGMA integrity_check').get() as {
    integrity_check: string;
  } | null;
  if (check?.integrity_check !== 'ok') maintenanceFailure();
  verifyCoreData(database);
}

function maintenanceFailure(): never {
  throw new LedgerMigrationError('InvalidState');
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity) {
  // Directory link counts may change when SQLite creates WAL/SHM entries (APFS).
  // Files still require exactly one link through validateDatabaseFile.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function assertStorageIdentity(
  directory: string,
  uid: number,
  identity: FileIdentity,
  directoryIdentity: FileIdentity,
) {
  const currentDirectory = validateCanonicalPathComponents(directory, uid);
  if (
    !sameDirectoryIdentity(directoryIdentity, identityFrom(currentDirectory)) ||
    !sameIdentity(
      identity,
      validateDatabaseFile(join(directory, databaseFilename), uid, true),
    )
  )
    maintenanceFailure();
  validateSidecars(directory, uid);
}

function requireEmptyWal(directory: string) {
  const stats = lstatOrMissing(join(directory, `${databaseFilename}-wal`));
  if (stats && stats.size !== 0) maintenanceFailure();
}

function requireWal(database: Database) {
  const journal = database.query('PRAGMA journal_mode').get() as {
    journal_mode: string;
  } | null;
  if (journal?.journal_mode.toLowerCase() !== 'wal') maintenanceFailure();
}

function checkpointForMigration(database: Database, directory: string) {
  const result = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
    busy: number;
    log: number;
    checkpointed: number;
  } | null;
  if (result?.busy !== 0) throw new LedgerMigrationError('LedgerBusy');
  if (result.log !== 0 || result.checkpointed !== 0) maintenanceFailure();
  requireEmptyWal(directory);
}

function checkedFile<T>(
  path: string,
  uid: number,
  operation: (fd: number) => T,
): T {
  const identity = validateDatabaseFile(path, uid, false);
  const fd = openSync(path, fsConstants.O_RDONLY | openFlags().fileNoFollow);
  try {
    if (!sameIdentity(identity, identityFrom(fstatSync(fd))))
      maintenanceFailure();
    const result = operation(fd);
    if (
      !sameIdentity(identity, validateDatabaseFile(path, uid, false)) ||
      !sameIdentity(identity, identityFrom(fstatSync(fd)))
    )
      maintenanceFailure();
    return result;
  } finally {
    closeSync(fd);
  }
}

function hashFile(path: string, uid: number) {
  return checkedFile(path, uid, (fd) => {
    const before = fstatSync(fd, { bigint: true });
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(copyBufferBytes);
    let size = 0n;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      size += BigInt(count);
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      maintenanceFailure();
    return { size: size.toString(), sha256: digest.digest('hex') };
  });
}

function copyCheckpointedMain(
  source: string,
  backup: string,
  uid: number,
  hooks: MigrationTestHooks,
) {
  return checkedFile(source, uid, (sourceFd) => {
    const before = fstatSync(sourceFd, { bigint: true });
    const backupIdentity = validateDatabaseFile(backup, uid, false);
    const targetFd = openSync(
      backup,
      fsConstants.O_RDWR | openFlags().fileNoFollow,
    );
    try {
      if (
        fstatSync(targetFd).size !== 0 ||
        !sameIdentity(backupIdentity, identityFrom(fstatSync(targetFd)))
      )
        maintenanceFailure();
      const buffer = Buffer.alloc(copyBufferBytes);
      const digest = createHash('sha256');
      let copied = 0n;
      for (;;) {
        const read = readSync(sourceFd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        digest.update(buffer.subarray(0, read));
        let offset = 0;
        while (offset < read) {
          const count = writeSync(
            targetFd,
            buffer,
            offset,
            Math.min(read - offset, hooks.maxWriteBytes ?? buffer.length),
            null,
          );
          if (count <= 0 || count > read - offset)
            throw new LedgerMigrationError('BackupFailed');
          offset += count;
          if (hooks.fault === 'copy')
            throw new LedgerMigrationError('BackupFailed');
        }
        copied += BigInt(read);
      }
      const after = fstatSync(sourceFd, { bigint: true });
      if (
        copied !== before.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        fstatSync(targetFd, { bigint: true }).size !== copied ||
        !sameIdentity(backupIdentity, validateDatabaseFile(backup, uid, true))
      )
        maintenanceFailure();
      return { size: copied.toString(), sha256: digest.digest('hex') };
    } finally {
      closeSync(targetFd);
    }
  });
}

function syncDirectory(directory: string, uid: number, privateLeaf: boolean) {
  if (privateLeaf) validateCanonicalPathComponents(directory, uid);
  else validateCreationParent(directory, uid);
  const identity = identityFrom(lstatSync(directory));
  const fd = openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | openFlags().fileNoFollow,
  );
  try {
    if (!sameDirectoryIdentity(identity, identityFrom(fstatSync(fd))))
      maintenanceFailure();
    fsyncSync(fd);
    if (!sameDirectoryIdentity(identity, identityFrom(lstatSync(directory))))
      maintenanceFailure();
  } finally {
    closeSync(fd);
  }
}

function verifyBackup(
  source: Database,
  sourceDirectory: string,
  backupDirectory: string,
  uid: number,
  hooks: MigrationTestHooks,
) {
  const backupPath = createNewState(backupDirectory, uid);
  const directoryIdentity = identityFrom(
    validateCanonicalPathComponents(backupDirectory, uid),
  );
  const identity = validateDatabaseFile(backupPath, uid, false);
  const copied = copyCheckpointedMain(
    join(sourceDirectory, databaseFilename),
    backupPath,
    uid,
    hooks,
  );
  requireEmptyWal(sourceDirectory);
  const rawCopy = hashFile(backupPath, uid);
  if (rawCopy.size !== copied.size || rawCopy.sha256 !== copied.sha256)
    throw new LedgerMigrationError('BackupFailed');
  const coreDigest = coreProjectionDigest(source);
  let verifier: Database | undefined;
  try {
    assertStorageIdentity(backupDirectory, uid, identity, directoryIdentity);
    verifier = openDatabase(backupPath);
    assertStorageIdentity(backupDirectory, uid, identity, directoryIdentity);
    if (verifySchema(verifier).version !== 1) maintenanceFailure();
    requireWal(verifier);
    configureConnection(verifier);
    verifier.run('PRAGMA query_only = ON');
    verifier
      .transaction(() => {
        verifyMigrationCoreData(verifier!);
        if (coreProjectionDigest(verifier!) !== coreDigest)
          throw new LedgerMigrationError('BackupFailed');
      })
      .deferred();
    assertStorageIdentity(backupDirectory, uid, identity, directoryIdentity);
  } finally {
    verifier?.close();
  }

  // Closing/checkpointing the verifier may change main/sidecar bytes. Only these
  // final retained files, after verification and close, enter the recovery manifest.
  const files: Record<string, { size: string; sha256: string }> = {};
  assertStorageIdentity(backupDirectory, uid, identity, directoryIdentity);
  for (const name of [
    databaseFilename,
    `${databaseFilename}-wal`,
    `${databaseFilename}-shm`,
  ]) {
    const path = join(backupDirectory, name);
    if (lstatOrMissing(path) === undefined) continue;
    if (hooks.fault === 'fileSync')
      throw new LedgerMigrationError('BackupFailed');
    checkedFile(path, uid, (fd) => fsyncSync(fd));
    files[name] = hashFile(path, uid);
  }
  if (hooks.fault === 'directorySync')
    throw new LedgerMigrationError('BackupFailed');
  syncDirectory(backupDirectory, uid, true);
  if (hooks.fault === 'parentSync')
    throw new LedgerMigrationError('BackupFailed');
  syncDirectory(dirname(backupDirectory), uid, false);
  const manifestPath = join(backupDirectory, 'backup-manifest.json');
  const fd = openSync(
    manifestPath,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_RDWR |
      openFlags().fileNoFollow,
    0o600,
  );
  try {
    const manifestIdentity = validateDatabaseFile(manifestPath, uid, false);
    if (!sameIdentity(manifestIdentity, identityFrom(fstatSync(fd))))
      maintenanceFailure();
    const bytes = Buffer.from(
      JSON.stringify({
        format: 'speedyindex-backup-v1',
        schemaVersion: 1,
        coreDigest,
        initialImage: copied,
        files,
      }) + '\n',
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (count <= 0 || count > bytes.length - offset)
        throw new LedgerMigrationError('BackupFailed');
      offset += count;
    }
    fsyncSync(fd);
    if (
      !sameIdentity(
        manifestIdentity,
        validateDatabaseFile(manifestPath, uid, true),
      )
    )
      maintenanceFailure();
  } finally {
    closeSync(fd);
  }
  syncDirectory(backupDirectory, uid, true);
  syncDirectory(dirname(backupDirectory), uid, false);
  assertStorageIdentity(backupDirectory, uid, identity, directoryIdentity);
  for (const [name, expected] of Object.entries(files)) {
    const final = hashFile(join(backupDirectory, name), uid);
    if (final.sha256 !== expected.sha256 || final.size !== expected.size)
      throw new LedgerMigrationError('BackupFailed');
  }
  return coreDigest;
}

// Explicit offline maintenance only. Operators must drain in-flight work and stop
// every cooperating host; a lock/checkpoint cannot prove that or recover lost tokens.
export function migrateLedgerV2(
  options: { stateDirectory: string; backupDirectory: string },
  hooks: MigrationTestHooks = {},
): MigrationReceipt {
  let database: Database | undefined;
  let phase: 'audit' | 'backup' | 'migration' = 'audit';
  let receipt: MigrationReceipt | undefined;
  let failure: LedgerMigrationError | undefined;
  try {
    requireKeys(options, ['stateDirectory', 'backupDirectory']);
    validatePathInput({ stateDirectory: options.stateDirectory });
    validatePathInput({ stateDirectory: options.backupDirectory });
    if (
      hooks.maxWriteBytes !== undefined &&
      (!Number.isInteger(hooks.maxWriteBytes) ||
        hooks.maxWriteBytes < 0 ||
        hooks.maxWriteBytes > copyBufferBytes)
    )
      maintenanceFailure();
    const uid = ensurePosixRuntime();
    const directoryIdentity = identityFrom(
      validateCanonicalPathComponents(options.stateDirectory, uid),
    );
    validateSidecars(options.stateDirectory, uid);
    const path = join(options.stateDirectory, databaseFilename);
    const identity = validateDatabaseFile(path, uid, true);
    database = openDatabase(path);
    assertStorageIdentity(
      options.stateDirectory,
      uid,
      identity,
      directoryIdentity,
    );
    const initial = database
      .transaction(() => {
        const schema = verifySchema(database!);
        if (schema.version === 1) verifyMigrationCoreData(database!);
        return schema;
      })
      .deferred();
    requireWal(database);
    if (initial.version === 2) {
      receipt = { migrated: false, schemaVersion: 2, reason: 'AlreadyV2' };
    } else {
      configureConnection(database);
      checkpointForMigration(database, options.stateDirectory);
      if (hooks.afterCheckpoint) {
        if (hooks.afterCheckpoint.constructor.name === 'AsyncFunction')
          maintenanceFailure();
        const result = hooks.afterCheckpoint();
        if (result !== undefined) maintenanceFailure();
      }
      const coreDigest = database
        .transaction(() => {
          assertStorageIdentity(
            options.stateDirectory,
            uid,
            identity,
            directoryIdentity,
          );
          requireEmptyWal(options.stateDirectory);
          if (verifySchema(database!).version !== 1) maintenanceFailure();
          verifyMigrationCoreData(database!);
          phase = 'backup';
          const digest = verifyBackup(
            database!,
            options.stateDirectory,
            options.backupDirectory,
            uid,
            hooks,
          );
          assertStorageIdentity(
            options.stateDirectory,
            uid,
            identity,
            directoryIdentity,
          );
          requireEmptyWal(options.stateDirectory);
          signalMigrationPhase(hooks, 'backup_verified');
          phase = 'migration';
          for (const sql of v2SchemaStatements) database!.run(sql);
          database!
            .query(
              'INSERT INTO retry_ledger_meta (singleton, ledger_id) VALUES (1, ?)',
            )
            .run(randomBytes(32).toString('hex'));
          database!.run(
            "INSERT INTO intent_context (credential_fp, request_id, origin_kind) SELECT credential_fp, request_id, 'legacy_unattributed' FROM intents",
          );
          database!.run('PRAGMA user_version = 2');
          if (
            verifySchema(database!).version !== 2 ||
            coreProjectionDigest(database!) !== digest
          )
            throw new LedgerMigrationError('MigrationFailed');
          signalMigrationPhase(hooks, 'before_commit');
          return digest;
        })
        .immediate();
      signalMigrationPhase(hooks, 'after_commit');
      database.close();
      database = undefined;
      assertStorageIdentity(
        options.stateDirectory,
        uid,
        identity,
        directoryIdentity,
      );
      database = openDatabase(path);
      assertStorageIdentity(
        options.stateDirectory,
        uid,
        identity,
        directoryIdentity,
      );
      database
        .transaction(() => {
          if (
            verifySchema(database!).version !== 2 ||
            coreProjectionDigest(database!) !== coreDigest
          )
            throw new LedgerMigrationError('MigrationFailed');
        })
        .deferred();
      assertStorageIdentity(
        options.stateDirectory,
        uid,
        identity,
        directoryIdentity,
      );
      receipt = { migrated: true, schemaVersion: 2, backupVerified: true };
    }
  } catch (error) {
    if (error instanceof LedgerMigrationError) failure = error;
    else {
      if (
        (error instanceof SQLiteError &&
          error.code?.startsWith('SQLITE_BUSY')) ||
        (error instanceof SubmissionLedgerError && error.code === 'LedgerBusy')
      )
        failure = new LedgerMigrationError('LedgerBusy');
      else
        failure = new LedgerMigrationError(
          phase === 'audit'
            ? 'InvalidState'
            : phase === 'backup'
              ? 'BackupFailed'
              : 'MigrationFailed',
        );
    }
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        failure = new LedgerMigrationError('MigrationFailed');
      }
    }
  }
  if (failure) throw failure;
  if (!receipt) throw new LedgerMigrationError('MigrationFailed');
  return receipt;
}
