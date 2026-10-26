import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import type {
  BacklinkCheckReservationSource,
  IndexCheckReservationProfiles,
  IndexCheckReservationSource,
} from './submission-contract';
import {
  CreateIndexingTaskError,
  createIndexingTaskError,
  indexingAuthorizationSchema,
  indexingUnitVectorSchema,
  type CreateIndexingTaskErrorCode,
  type IndexingAuthorization,
  type IndexingUnitVector,
} from './create-indexing-task';

const maxPolicyBytes = 16_384;
const dayMs = 86_400_000;
const digestPattern = /^[0-9a-f]{64}$/;
const visibleLabel = z.string().regex(/^[\x21-\x7e]{1,128}$/);

// Dated local admission floors, not a provider fee or wallet-spend guarantee.
const indexCheckReservationsSchema = z.strictObject({
  google: indexingUnitVectorSchema.refine((v) => v.tokens >= 3).optional(),
  yandex: indexingUnitVectorSchema.refine((v) => v.tokens >= 2).optional(),
  bing: indexingUnitVectorSchema.refine((v) => v.tokens >= 2).optional(),
});
const backlinkCheckReservationsSchema = indexingUnitVectorSchema.refine(
  (v) => v.tokens >= 2,
);
const retryPolicySchema = z.strictObject({
  enabled: z.boolean(),
  allowUnattributedParents: z.boolean(),
  maxAttemptsPerSource: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export const submissionPolicySchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(['caller_acknowledgement', 'operator_policy']),
  policyRevision: visibleLabel,
  budgetScope: visibleLabel,
  credentialFingerprint: z.string().regex(digestPattern),
  period: z.strictObject({ kind: z.literal('utc_day') }),
  caps: indexingUnitVectorSchema,
  allowIndexChecks: z.boolean().optional(),
  indexCheckReservations: indexCheckReservationsSchema.optional(),
  allowBacklinkChecks: z.boolean().optional(),
  backlinkCheckReservations: backlinkCheckReservationsSchema.optional(),
  retry: retryPolicySchema.optional(),
});
export type SubmissionPolicy = z.infer<typeof submissionPolicySchema>;
type FrozenPolicy = Readonly<
  Omit<
    SubmissionPolicy,
    | 'caps'
    | 'period'
    | 'indexCheckReservations'
    | 'backlinkCheckReservations'
    | 'retry'
  >
> & {
  readonly caps: Readonly<IndexingUnitVector>;
  readonly period: Readonly<SubmissionPolicy['period']>;
  readonly indexCheckReservations?: IndexCheckReservationProfiles | undefined;
  readonly backlinkCheckReservations?: Readonly<IndexingUnitVector> | undefined;
  readonly retry?: Readonly<NonNullable<SubmissionPolicy['retry']>> | undefined;
};
export interface LoadedSubmissionPolicy {
  readonly policy: FrozenPolicy;
  readonly digest: string;
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidPolicy(): never {
  throw new CreateIndexingTaskError('InvalidPolicy');
}

function canonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    posix.isAbsolute(value) &&
    posix.resolve(value) === value &&
    posix.basename(value) !== ''
  );
}

function sameNode(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    sameNode(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function trustedAncestor(path: string, stats: BigIntStats, uid: bigint) {
  const mode = stats.mode & 0o7777n;
  const rootStickyTemporary = stats.uid === 0n && (mode & 0o1000n) !== 0n;
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.uid !== 0n && stats.uid !== uid) ||
    ((mode & 0o022n) !== 0n && !rootStickyTemporary) ||
    (path === '/' && stats.uid !== 0n)
  )
    invalidPolicy();
}

function policyFile(stats: BigIntStats, uid: bigint) {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== uid ||
    (stats.mode & 0o7777n) !== 0o600n ||
    stats.nlink !== 1n ||
    stats.size < 0n ||
    stats.size > BigInt(maxPolicyBytes)
  )
    invalidPolicy();
}

function readPrivatePolicy(path: string) {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    typeof process.geteuid !== 'function' ||
    !(fsConstants.O_NOFOLLOW > 0) ||
    !(fsConstants.O_NONBLOCK > 0)
  )
    invalidPolicy();
  const uid = BigInt(process.geteuid());
  const ancestors: { path: string; stats: BigIntStats }[] = [];
  let current = '/';
  const parent = posix.dirname(path);
  for (const component of ['', ...parent.split('/').filter(Boolean)]) {
    if (component) current = posix.join(current, component);
    const stats = lstatSync(current, { bigint: true });
    trustedAncestor(current, stats, uid);
    ancestors.push({ path: current, stats });
  }
  if (realpathSync(parent) !== parent) invalidPolicy();
  const before = lstatSync(path, { bigint: true });
  policyFile(before, uid);
  if (realpathSync(path) !== path) invalidPolicy();
  // Nonblocking also prevents a replacement special file from hanging open.
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    policyFile(opened, uid);
    if (!sameFile(before, opened)) invalidPolicy();
    const bytes = Buffer.alloc(maxPolicyBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxPolicyBytes) invalidPolicy();
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    policyFile(after, uid);
    policyFile(named, uid);
    if (
      !sameFile(opened, after) ||
      !sameFile(after, named) ||
      BigInt(length) !== after.size ||
      realpathSync(path) !== path
    )
      invalidPolicy();
    for (const ancestor of ancestors) {
      const stats = lstatSync(ancestor.path, { bigint: true });
      trustedAncestor(ancestor.path, stats, uid);
      if (!sameNode(ancestor.stats, stats)) invalidPolicy();
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** One immutable snapshot. Restart all cooperating hosts after a policy change;
 * neither this loader nor a preview reloads policy or opens submission state. */
export function loadSubmissionPolicy(path: unknown): LoadedSubmissionPolicy {
  try {
    if (!canonicalPath(path)) invalidPolicy();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      readPrivatePolicy(path),
    );
    const parsed = submissionPolicySchema.safeParse(JSON.parse(text));
    if (!parsed.success) invalidPolicy();
    const value = parsed.data;
    const policy = Object.freeze({
      version: value.version,
      enabled: value.enabled,
      mode: value.mode,
      policyRevision: value.policyRevision,
      budgetScope: value.budgetScope,
      credentialFingerprint: value.credentialFingerprint,
      period: Object.freeze({ kind: value.period.kind }),
      caps: Object.freeze({
        tokens: value.caps.tokens,
        indexer: value.caps.indexer,
        checker: value.caps.checker,
      }),
      ...(value.allowIndexChecks === undefined
        ? {}
        : { allowIndexChecks: value.allowIndexChecks }),
      ...(value.indexCheckReservations === undefined
        ? {}
        : {
            indexCheckReservations: Object.freeze(
              Object.fromEntries(
                (['google', 'yandex', 'bing'] as const).flatMap((engine) => {
                  const vector = value.indexCheckReservations![engine];
                  return vector === undefined
                    ? []
                    : [
                        [
                          engine,
                          Object.freeze({
                            tokens: vector.tokens,
                            indexer: vector.indexer,
                            checker: vector.checker,
                          }),
                        ],
                      ];
                }),
              ),
            ),
          }),
      ...(value.allowBacklinkChecks === undefined
        ? {}
        : { allowBacklinkChecks: value.allowBacklinkChecks }),
      ...(value.backlinkCheckReservations === undefined
        ? {}
        : {
            backlinkCheckReservations: Object.freeze({
              tokens: value.backlinkCheckReservations.tokens,
              indexer: value.backlinkCheckReservations.indexer,
              checker: value.backlinkCheckReservations.checker,
            }),
          }),
      ...(value.retry === undefined
        ? {}
        : {
            retry: Object.freeze({
              enabled: value.retry.enabled,
              allowUnattributedParents: value.retry.allowUnattributedParents,
              maxAttemptsPerSource: value.retry.maxAttemptsPerSource,
            }),
          }),
    });
    return Object.freeze({
      policy,
      digest: hash(
        'speedyindex-submission-policy-v1\0' + JSON.stringify(policy),
      ),
    });
  } catch {
    return invalidPolicy();
  }
}

function normalizeCredential(value: unknown) {
  if (typeof value !== 'string')
    throw new CreateIndexingTaskError('MissingCredentials');
  const effectiveKey = value.trim();
  if (effectiveKey.length > 8_192 || !/^[\x21-\x7e]+$/.test(effectiveKey))
    throw new CreateIndexingTaskError('MissingCredentials');
  return Object.freeze({
    effectiveKey,
    fingerprint: hash('speedyindex-credential-v1\0' + effectiveKey),
  });
}

/** Explicit value only; this helper never reads process.env or an env file. */
export function submissionCredentialFingerprint(value: unknown) {
  return normalizeCredential(value).fingerprint;
}

type InactiveState =
  | 'unconfigured'
  | 'disabled'
  | 'invalid'
  | 'credential_missing'
  | 'credential_mismatch';
interface InactiveConfiguration {
  readonly state: InactiveState;
  readonly error: Readonly<ReturnType<typeof createIndexingTaskError>>;
  readonly indexCheckReservationSource: IndexCheckReservationSource;
  readonly backlinkCheckReservationSource?: BacklinkCheckReservationSource;
}
export interface ConfiguredSubmission {
  readonly state: 'configured';
  readonly snapshot: LoadedSubmissionPolicy;
  readonly credential: Readonly<{ effectiveKey: string; fingerprint: string }>;
  readonly stateDirectory: string;
  readonly indexCheckReservationSource: IndexCheckReservationSource;
  readonly backlinkCheckReservationSource?: BacklinkCheckReservationSource;
}
export type SubmissionConfiguration =
  InactiveConfiguration | ConfiguredSubmission;
export interface SubmissionConfigurationOptions {
  policyPath?: string | undefined;
  stateDirectory?: string | undefined;
  apiKey?: unknown;
}

function inactive(
  state: InactiveState,
  code: CreateIndexingTaskErrorCode,
  indexCheckReservationSource: IndexCheckReservationSource,
  backlinkCheckReservationSource: BacklinkCheckReservationSource,
): InactiveConfiguration {
  return Object.freeze({
    state,
    error: Object.freeze(createIndexingTaskError(code)),
    indexCheckReservationSource,
    backlinkCheckReservationSource,
  });
}

/** Trusted startup inputs only, loaded once. The state reference receives lexical
 * checks only: no stat/open/create/repair of a ledger or its directory occurs. */
export function loadSubmissionConfiguration(
  options: SubmissionConfigurationOptions = {},
): SubmissionConfiguration {
  let snapshot: LoadedSubmissionPolicy | undefined;
  let source: IndexCheckReservationSource = Object.freeze({
    state: 'unconfigured',
  });
  let backlinkSource: BacklinkCheckReservationSource = Object.freeze({
    state: 'unconfigured',
  });
  if (options.policyPath !== undefined) {
    try {
      snapshot = loadSubmissionPolicy(options.policyPath);
      source = Object.freeze({
        state: 'loaded',
        ...(snapshot.policy.indexCheckReservations === undefined
          ? {}
          : { profiles: snapshot.policy.indexCheckReservations }),
      });
      backlinkSource = Object.freeze({
        state: 'loaded',
        ...(snapshot.policy.backlinkCheckReservations === undefined
          ? {}
          : { profile: snapshot.policy.backlinkCheckReservations }),
      });
    } catch {
      source = Object.freeze({ state: 'invalid' });
      backlinkSource = Object.freeze({ state: 'invalid' });
    }
  }
  if (options.policyPath === undefined && options.stateDirectory === undefined)
    return inactive('unconfigured', 'WritesDisabled', source, backlinkSource);
  if (
    !canonicalPath(options.policyPath) ||
    !canonicalPath(options.stateDirectory)
  )
    return inactive('invalid', 'InvalidPolicy', source, backlinkSource);
  if (!snapshot)
    return inactive('invalid', 'InvalidPolicy', source, backlinkSource);
  if (!snapshot.policy.enabled)
    return inactive('disabled', 'WritesDisabled', source, backlinkSource);
  let credential: ConfiguredSubmission['credential'];
  try {
    credential = normalizeCredential(options.apiKey);
  } catch {
    return inactive(
      'credential_missing',
      'MissingCredentials',
      source,
      backlinkSource,
    );
  }
  if (credential.fingerprint !== snapshot.policy.credentialFingerprint)
    return inactive(
      'credential_mismatch',
      'CredentialMismatch',
      source,
      backlinkSource,
    );
  return Object.freeze({
    state: 'configured',
    snapshot,
    credential,
    stateDirectory: options.stateDirectory,
    indexCheckReservationSource: source,
    backlinkCheckReservationSource: backlinkSource,
  });
}

export interface SubmissionBudgetContext {
  readonly credentialFingerprint: string;
  readonly budgetScope: string;
  readonly periodId: string;
  readonly periodStartMs: number;
  readonly policyRevision: string;
  readonly policyDigest: string;
  readonly caps: Readonly<IndexingUnitVector>;
}
export interface SubmissionContext {
  readonly quoteFingerprint: string;
  readonly budget: SubmissionBudgetContext;
  readonly authorization: Readonly<IndexingAuthorization>;
}

/** Pure comparison commitment. The binding is trusted host data, never public input.
 * The exact ordered preimage is shared with historical replay reconstruction. */
export function computeSubmissionAuthorizationFingerprint(value: {
  readonly quoteFingerprint: string;
  readonly policyDigest: string;
  readonly credentialFingerprint: string;
  readonly budgetScope: string;
  readonly periodId: string;
  readonly periodStartMs: number;
}): string {
  return hash(
    'speedyindex-submission-authorization-v1\0' +
      JSON.stringify({
        quoteFingerprint: value.quoteFingerprint,
        policyDigest: value.policyDigest,
        credentialFingerprint: value.credentialFingerprint,
        budgetScope: value.budgetScope,
        periodId: value.periodId,
        periodStartMs: value.periodStartMs,
      }),
  );
}

/** nowMs comes from the trusted host clock, never MCP arguments. This is a
 * reservation day, not observed provider billing or authenticated human consent. */
export function createSubmissionContext(
  configuration: ConfiguredSubmission,
  quoteFingerprint: string,
  nowMs: unknown,
): SubmissionContext {
  if (!digestPattern.test(quoteFingerprint))
    throw new CreateIndexingTaskError('InvalidInput');
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs))
    throw new CreateIndexingTaskError('StateUnavailable');
  const startMs = Math.floor(nowMs / dayMs) * dayMs;
  const endMs = startMs + dayMs;
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    !Number.isFinite(new Date(nowMs).getTime()) ||
    !Number.isFinite(new Date(startMs).getTime()) ||
    !Number.isFinite(new Date(endMs).getTime())
  )
    throw new CreateIndexingTaskError('StateUnavailable');
  const periodId = 'utc-day:' + new Date(startMs).toISOString().split('T')[0];
  const { policy, digest: policyDigest } = configuration.snapshot;
  const credentialFingerprint = configuration.credential.fingerprint;
  const fingerprint = computeSubmissionAuthorizationFingerprint({
    quoteFingerprint,
    policyDigest,
    credentialFingerprint,
    budgetScope: policy.budgetScope,
    periodId,
    periodStartMs: startMs,
  });
  const budget = Object.freeze({
    credentialFingerprint,
    budgetScope: policy.budgetScope,
    periodId,
    periodStartMs: startMs,
    policyRevision: policy.policyRevision,
    policyDigest,
    caps: policy.caps,
  });
  const authorization = Object.freeze({
    state: 'configured' as const,
    stateChecked: false,
    mode: policy.mode,
    policyRevision: policy.policyRevision,
    policyDigest,
    budgetScope: policy.budgetScope,
    caps: policy.caps,
    period: Object.freeze({ id: periodId, startMs, endMs }),
    fingerprint,
  });
  if (!indexingAuthorizationSchema.safeParse(authorization).success)
    throw new CreateIndexingTaskError('StateUnavailable');
  return Object.freeze({ quoteFingerprint, budget, authorization });
}

/** Only whitelisted public fields; keys, credential fingerprints and paths stay
 * in the trusted configuration. Hash echoes acknowledge context, not a human. */
export function getSubmissionAuthorization(
  configuration: SubmissionConfiguration,
  quoteFingerprint: string,
  nowMs: unknown,
): Readonly<IndexingAuthorization> {
  return configuration.state === 'configured'
    ? createSubmissionContext(configuration, quoteFingerprint, nowMs)
        .authorization
    : Object.freeze({ state: configuration.state, stateChecked: false });
}
