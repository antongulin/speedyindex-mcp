import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IntentState } from './submission-ledger';
import type { TaskFamily } from './task-status';

export type SnapshotUnavailableReason =
  | 'MissingState'
  | 'UpgradeRequired'
  | 'InvalidState'
  | 'Busy'
  | 'ReadFailure'
  | 'LimitExceeded';

export class SnapshotReadError extends Error {
  constructor(readonly reason: SnapshotUnavailableReason) {
    super('Retry snapshot unavailable.');
  }
}

export interface SnapshotLimits {
  intents: number;
  events: number;
  urls: number;
  bytes: number;
}
const ceilings: Readonly<SnapshotLimits> = Object.freeze({
  intents: 2000,
  events: 6000,
  urls: 20000,
  bytes: 16 * 1024 * 1024,
});

// Trusted in-process wiring only. Callbacks receive a fixed phase, never a handle/data.
export interface SnapshotReadHooks {
  limits?: Partial<SnapshotLimits>;
  /** Trusted no-argument receipt, only after actual native close and handle clearing. */
  afterNativeClose?: () => void;
  onPhase?: (
    phase: 'snapshot_fixed' | 'before_projection' | 'before_close',
  ) => void;
}
export function snapshotLimits(
  lower?: Partial<SnapshotLimits>,
): SnapshotLimits {
  const result = { ...ceilings, ...lower };
  for (const key of Object.keys(result) as (keyof SnapshotLimits)[]) {
    if (
      !Object.hasOwn(ceilings, key) ||
      !Number.isSafeInteger(result[key]) ||
      result[key] < 0 ||
      result[key] > ceilings[key]
    )
      throw new SnapshotReadError('InvalidState');
  }
  return result;
}
export function signalSnapshotPhase(
  hooks: SnapshotReadHooks,
  phase: Parameters<NonNullable<SnapshotReadHooks['onPhase']>>[0],
) {
  if (hooks.onPhase?.(phase) !== undefined)
    throw new SnapshotReadError('ReadFailure');
}

// Explicit revision tuple column order. Every INTEGER is selected as decimal TEXT.
const coreColumns = [
  'credential_fp',
  'request_id',
  'budget_scope',
  'period_id',
  'period_start_ms',
  'policy_revision',
  'policy_digest',
  'task_family',
  'provider_route',
  'payload_digest',
  'quote_version',
  'quote_fingerprint',
  'reserved_tokens',
  'reserved_indexer',
  'reserved_checker',
  'state',
  'state_version',
  'claim_token_digest',
  'dispatch_outcome_token_digest',
  'created_at_ms',
  'provider_task_id',
  'provider_type',
] as const;
const contextColumns = [
  'credential_fp',
  'request_id',
  'origin_kind',
  'parent_family',
  'parent_task_id',
  'source_manifest_digest',
  'plan_fingerprint',
] as const;
const urlColumns = [
  'credential_fp',
  'request_id',
  'ordinal',
  'url_text',
] as const;
const eventColumns = [
  'event_id',
  'credential_fp',
  'request_id',
  'state_version',
  'event_kind',
  'occurred_at_ms',
  'provider_task_id',
  'provider_type',
] as const;
const integers = new Set([
  'period_start_ms',
  'reserved_tokens',
  'reserved_indexer',
  'reserved_checker',
  'state_version',
  'created_at_ms',
  'ordinal',
  'event_id',
  'occurred_at_ms',
]);
type Cell = string | null;
type Row = Record<string, Cell>;
const projections = [
  {
    table: 'intents',
    columns: coreColumns,
    order: 'request_id COLLATE BINARY',
    cap: 'intents',
  },
  {
    table: 'intent_context',
    columns: contextColumns,
    order: 'request_id COLLATE BINARY',
    cap: 'intents',
  },
  {
    table: 'intent_urls',
    columns: urlColumns,
    order: 'request_id COLLATE BINARY, intent_urls.ordinal',
    cap: 'urls',
  },
  {
    table: 'intent_events',
    columns: eventColumns,
    order: 'intent_events.event_id',
    cap: 'events',
  },
] as const;

// Count and UTF-8 size queries return only bounded scalar values, not legacy TEXT.
// Private fixed-size ownership/binding columns are excluded from the retained-data
// floor; all other source values must fit before any projection is materialized.
export function checkSnapshotBounds(
  database: Database,
  binding: string,
  requestedLimits: SnapshotLimits,
) {
  const limits = snapshotLimits(requestedLimits);
  let bytes = 0;
  for (const { table, columns, cap } of projections) {
    const count = database
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE credential_fp = ? LIMIT ${limits[cap] + 1})`,
      )
      .get(binding)!.n;
    if (count > limits[cap]) throw new SnapshotReadError('LimitExceeded');
    const retained = columns.filter(
      (column) =>
        column !== 'credential_fp' &&
        column !== 'claim_token_digest' &&
        column !== 'dispatch_outcome_token_digest',
    );
    const size = database
      .query<{ n: number }, [string]>(
        `SELECT COALESCE(SUM(${retained.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')}), 0) AS n FROM ${table} WHERE credential_fp = ?`,
      )
      .get(binding)!.n;
    bytes += size;
    if (!Number.isSafeInteger(bytes) || bytes > limits.bytes)
      throw new SnapshotReadError('LimitExceeded');
  }
}

interface SnapshotUrl {
  readonly ordinal: string;
  readonly url: string;
}
interface SnapshotEvent {
  readonly eventId: string;
  readonly stateVersion: string;
  readonly kind: string;
  readonly occurredAtMs: string;
  readonly providerTaskId: string | null;
  readonly providerType: string | null;
}
interface SnapshotContext {
  readonly originKind: string;
  readonly parentFamily: string | null;
  readonly parentTaskId: string | null;
  readonly sourceManifestDigest: string | null;
  readonly planFingerprint: string | null;
}
interface SnapshotHistory {
  readonly requestId: string;
  readonly taskFamily: TaskFamily;
  readonly state: IntentState;
  readonly stateVersion: string;
  readonly budgetScope: string;
  readonly periodId: string;
  readonly periodStartMs: string;
  readonly policyRevision: string;
  readonly policyDigest: string;
  readonly providerRoute: string;
  readonly payloadDigest: string;
  readonly quoteVersion: string;
  readonly quoteFingerprint: string;
  readonly reservation: {
    readonly tokens: string;
    readonly indexer: string;
    readonly checker: string;
  };
  readonly createdAtMs: string;
  readonly providerTaskId: string | null;
  readonly providerType: string | null;
  readonly context: SnapshotContext;
  readonly urls: readonly SnapshotUrl[];
  readonly events: readonly SnapshotEvent[];
}
interface AcceptedManifest {
  readonly taskFamily: TaskFamily;
  readonly providerTaskId: string;
  readonly requestId: string;
  readonly originKind: string;
  readonly payloadDigest: string;
  readonly manifestDigest: string;
  readonly submittedUrls: readonly string[];
  readonly provenance: 'durable_local_intent_ack';
}
interface RetryChild {
  readonly requestId: string;
  readonly taskFamily: TaskFamily;
  readonly parentFamily: string;
  readonly parentTaskId: string;
  readonly sourceManifestDigest: string;
  readonly planFingerprint: string;
  readonly state: IntentState;
  readonly stateVersion: string;
  readonly providerTaskId: string | null;
}
export interface AvailableRetrySnapshot {
  readonly availability: 'available';
  readonly schemaVersion: 2;
  readonly ledgerId: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly coverage: {
    readonly localStore: true;
    readonly keyBindingOnly: true;
    readonly allBudgetScopes: true;
    readonly allFamilies: true;
    readonly globalProviderAccount: false;
    readonly ancestry: 'cooperating_v2_retry_contexts_only';
  };
  readonly holds: readonly {
    readonly requestId: string;
    readonly taskFamily: TaskFamily;
    readonly state: IntentState;
    readonly stateVersion: string;
    readonly urls: readonly SnapshotUrl[];
  }[];
  readonly acceptedManifests: readonly AcceptedManifest[];
  readonly retryChildren: readonly RetryChild[];
  readonly unresolvedHistory: readonly SnapshotHistory[];
  readonly attributionGaps: readonly {
    readonly requestId: string;
    readonly taskFamily: TaskFamily;
    readonly reason: 'legacy_unattributed';
  }[];
  readonly ambiguousProviderRefs: readonly {
    readonly taskFamily: TaskFamily;
    readonly providerTaskId: string;
    readonly requestIds: readonly string[];
    readonly records: readonly SnapshotHistory[];
  }[];
}
export type RetrySnapshot =
  | AvailableRetrySnapshot
  | Readonly<{
      availability: 'unavailable';
      reason: SnapshotUnavailableReason;
    }>;

function digest(domain: string, tuple: unknown) {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(tuple))
    .digest('hex');
}
export function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

// Caller owns the already validated connection and transaction. No connection is
// opened here: a future writer must call this in its own admission transaction.
export function projectRetrySnapshot(
  database: Database,
  binding: string,
  ledgerId: string,
  requestedLimits: SnapshotLimits,
): AvailableRetrySnapshot {
  if (!database.inTransaction) throw new SnapshotReadError('ReadFailure');
  const limits = snapshotLimits(requestedLimits);
  checkSnapshotBounds(database, binding, limits);
  const rows = projections.map(({ table, columns, order }) =>
    database
      .query<Row, [string]>(
        `SELECT ${columns.map((column) => (integers.has(column) ? `CAST(${column} AS TEXT) AS ${column}` : column)).join(', ')} FROM ${table} WHERE credential_fp = ? ORDER BY ${order}`,
      )
      .all(binding),
  );
  const [core, contexts, urls, events] = rows as [Row[], Row[], Row[], Row[]];
  for (const table of rows) {
    for (const row of table) {
      if (
        Object.values(row).some(
          (cell) => cell !== null && typeof cell !== 'string',
        )
      )
        throw new SnapshotReadError('InvalidState');
    }
  }
  const revision = digest('speedyindex-retry-ledger-snapshot-v2', [
    ledgerId,
    binding,
    ...rows.map((table, index) =>
      table.map((row) =>
        projections[index]!.columns.map((column) => row[column]),
      ),
    ),
  ]);
  const contextMap = new Map(contexts.map((row) => [row.request_id!, row]));
  const urlMap = new Map<string, SnapshotUrl[]>();
  const eventMap = new Map<string, SnapshotEvent[]>();
  for (const row of urls) {
    const list = urlMap.get(row.request_id!) ?? [];
    list.push({ ordinal: row.ordinal!, url: row.url_text! });
    urlMap.set(row.request_id!, list);
  }
  for (const row of events) {
    const list = eventMap.get(row.request_id!) ?? [];
    list.push({
      eventId: row.event_id!,
      stateVersion: row.state_version!,
      kind: row.event_kind!,
      occurredAtMs: row.occurred_at_ms!,
      providerTaskId: row.provider_task_id!,
      providerType: row.provider_type!,
    });
    eventMap.set(row.request_id!, list);
  }
  const histories: SnapshotHistory[] = core.map((row) => {
    const context = contextMap.get(row.request_id!)!;
    return {
      requestId: row.request_id!,
      taskFamily: row.task_family as TaskFamily,
      state: row.state as IntentState,
      stateVersion: row.state_version!,
      budgetScope: row.budget_scope!,
      periodId: row.period_id!,
      periodStartMs: row.period_start_ms!,
      policyRevision: row.policy_revision!,
      policyDigest: row.policy_digest!,
      providerRoute: row.provider_route!,
      payloadDigest: row.payload_digest!,
      quoteVersion: row.quote_version!,
      quoteFingerprint: row.quote_fingerprint!,
      reservation: {
        tokens: row.reserved_tokens!,
        indexer: row.reserved_indexer!,
        checker: row.reserved_checker!,
      },
      createdAtMs: row.created_at_ms!,
      providerTaskId: row.provider_task_id!,
      providerType: row.provider_type!,
      context: {
        originKind: context.origin_kind!,
        parentFamily: context.parent_family!,
        parentTaskId: context.parent_task_id!,
        sourceManifestDigest: context.source_manifest_digest!,
        planFingerprint: context.plan_fingerprint!,
      },
      urls: urlMap.get(row.request_id!)!,
      events: eventMap.get(row.request_id!)!,
    };
  });
  const acceptedGroups = new Map<string, SnapshotHistory[]>();
  for (const row of histories.filter((row) => row.state === 'accepted')) {
    const key = JSON.stringify([row.taskFamily, row.providerTaskId]);
    const list = acceptedGroups.get(key) ?? [];
    list.push(row);
    acceptedGroups.set(key, list);
  }
  const unresolved = histories.filter((row) =>
    ['prepared', 'dispatching', 'unknown'].includes(row.state),
  );
  const result: AvailableRetrySnapshot = {
    availability: 'available',
    schemaVersion: 2,
    ledgerId,
    revision,
    capturedAt: new Date().toISOString(),
    coverage: {
      localStore: true,
      keyBindingOnly: true,
      allBudgetScopes: true,
      allFamilies: true,
      globalProviderAccount: false,
      ancestry: 'cooperating_v2_retry_contexts_only',
    },
    holds: unresolved.map((row) => ({
      requestId: row.requestId,
      taskFamily: row.taskFamily,
      state: row.state,
      stateVersion: row.stateVersion,
      urls: row.urls,
    })),
    acceptedManifests: [...acceptedGroups.values()]
      .filter((group) => group.length === 1)
      .map(([row]) => ({
        taskFamily: row!.taskFamily,
        providerTaskId: row!.providerTaskId!,
        requestId: row!.requestId,
        originKind: row!.context.originKind,
        payloadDigest: row!.payloadDigest,
        manifestDigest: digest('speedyindex-intent-url-manifest-v1', [
          row!.taskFamily,
          row!.urls.map((url) => url.url),
        ]),
        submittedUrls: row!.urls.map((url) => url.url),
        provenance: 'durable_local_intent_ack',
      })),
    retryChildren: histories
      .filter((row) => row.context.originKind === 'retry')
      .map((row) => ({
        requestId: row.requestId,
        taskFamily: row.taskFamily,
        parentFamily: row.context.parentFamily!,
        parentTaskId: row.context.parentTaskId!,
        sourceManifestDigest: row.context.sourceManifestDigest!,
        planFingerprint: row.context.planFingerprint!,
        state: row.state,
        stateVersion: row.stateVersion,
        providerTaskId: row.providerTaskId,
      })),
    unresolvedHistory: unresolved,
    attributionGaps: histories
      .filter((row) => row.context.originKind === 'legacy_unattributed')
      .map((row) => ({
        requestId: row.requestId,
        taskFamily: row.taskFamily,
        reason: 'legacy_unattributed',
      })),
    ambiguousProviderRefs: [...acceptedGroups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        taskFamily: group[0]!.taskFamily,
        providerTaskId: group[0]!.providerTaskId!,
        requestIds: group.map((row) => row.requestId),
        records: group,
      })),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.bytes)
    throw new SnapshotReadError('LimitExceeded');
  return freezeSnapshot(result);
}
