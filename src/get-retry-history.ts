/** Pure local-history comparison data. No state access, provider calls or authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AvailableRetrySnapshot } from './retry-ledger-snapshot';
import { digestSchema, providerTaskIdSchema } from './submission-contract';

const engineSchema = z.enum(['google', 'yandex']);
const familySchema = z.enum(['google/indexer', 'yandex/indexer']);
const stateSchema = z.enum([
  'prepared',
  'dispatching',
  'accepted',
  'rejected',
  'unknown',
  'cancelled',
]);
const countSchema = z.number().int().min(0).max(2_000);
const limitSchema = z.number().int().min(1).max(25);
const cursorTextSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursorSchema = z.strictObject({
  v: z.literal(1),
  revision: digestSchema,
  query: digestSchema,
  offset: z.number().int().min(1).max(2_000),
});
type Cursor = Readonly<z.infer<typeof cursorSchema>>;
type State = z.infer<typeof stateSchema>;
type Child = AvailableRetrySnapshot['retryChildren'][number];
type History = AvailableRetrySnapshot['unresolvedHistory'][number];
type Manifest = AvailableRetrySnapshot['acceptedManifests'][number];
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

const errorMessages = Object.freeze({
  InvalidInput: 'Invalid retry-history input.',
  CursorMismatch: 'The cursor does not match this history query.',
  SnapshotChanged: 'Local history changed. Start a new history query.',
  StateUnavailable: 'The complete local retry history is unavailable.',
  HistoryBusy:
    'Another history read or incompatible state operation is active.',
  ResourceLimitExceeded: 'Retry history exceeded a resource limit.',
  Cancelled: 'Retry history was cancelled.',
  DeadlineExceeded: 'Retry history exceeded its observation deadline.',
  InternalError: 'Retry history failed internally.',
} as const);
const errorCodeSchema = z.enum([
  'InvalidInput',
  'CursorMismatch',
  'SnapshotChanged',
  'StateUnavailable',
  'HistoryBusy',
  'ResourceLimitExceeded',
  'Cancelled',
  'DeadlineExceeded',
  'InternalError',
]);
export type RetryHistoryErrorCode = z.infer<typeof errorCodeSchema>;
const blockerMessages = Object.freeze({
  ReadConfigurationUnavailable:
    'Retry history requires configured local state.',
  StateMissing: 'The configured local state does not exist.',
  V2Required: 'Retry history requires existing V2 local state.',
} as const);
const blockerCodeSchema = z.enum([
  'ReadConfigurationUnavailable',
  'StateMissing',
  'V2Required',
]);

export class RetryHistoryError extends Error {
  constructor(readonly code: RetryHistoryErrorCode) {
    super(errorMessages[code]);
    this.name = 'RetryHistoryError';
  }
}
function unavailable(): never {
  throw new RetryHistoryError('StateUnavailable');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function digest(domain: string, tuple: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(tuple))
    .digest('hex');
}
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeCursor(value: string): Cursor {
  cursorTextSchema.parse(value);
  const bytes = Buffer.from(value, 'base64url');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const cursor = cursorSchema.parse(JSON.parse(text));
  if (
    JSON.stringify(cursor) !== text ||
    !Buffer.from(text, 'utf8').equals(bytes) ||
    encodeCursor(cursor) !== value
  )
    throw new TypeError();
  return freeze(cursor);
}

export const retryHistoryInputSchema = z
  .strictObject({
    searchEngine: engineSchema.optional(),
    parentTaskId: providerTaskIdSchema.optional(),
    state: stateSchema.optional(),
    limit: limitSchema.optional(),
    cursor: cursorTextSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.parentTaskId !== undefined && value.searchEngine === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Invalid history selectors.',
      });
  });
export interface RetryHistoryInput {
  readonly searchEngine: 'google' | 'yandex' | null;
  readonly parentTaskId: string | null;
  readonly state: State | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
}
/** Omission selects both engines. Parsing neither opens state nor supplies authority. */
export function parseRetryHistoryInput(value: unknown): RetryHistoryInput {
  try {
    const parsed = retryHistoryInputSchema.parse(value);
    return freeze({
      searchEngine: parsed.searchEngine ?? null,
      parentTaskId: parsed.parentTaskId ?? null,
      state: parsed.state ?? null,
      limit: parsed.limit ?? 25,
      cursor: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor),
    });
  } catch {
    throw new RetryHistoryError('InvalidInput');
  }
}
function queryDigest(input: RetryHistoryInput): string {
  return digest('speedyindex-retry-history-query-v1', [
    input.searchEngine,
    input.parentTaskId,
    input.state,
    input.limit,
  ]);
}

const signedMillisecondsSchema = z.string().refine((value) => {
  if (value.length > 20 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return false;
  const integer = BigInt(value);
  return (
    integer >= -9_223_372_036_854_775_808n &&
    integer <= 9_223_372_036_854_775_807n
  );
});
const reservationUnitSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= 19 &&
      /^(0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) <= 9_223_372_036_854_775_807n,
  );
const reservationSchema = z.strictObject({
  tokens: reservationUnitSchema,
  indexer: reservationUnitSchema,
  checker: reservationUnitSchema,
});
const urlCountSchema = z.number().int().min(1).max(20_000);
const attributionSchema = z.enum([
  'local_standalone_manifest',
  'local_legacy_manifest',
  'local_retry_manifest',
  'ambiguous_local_reference',
  'unattributed_manifest',
]);
const entrySchema = z.strictObject({
  attemptRef: digestSchema,
  family: familySchema,
  state: stateSchema,
  stateVersion: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  providerTaskId: providerTaskIdSchema.nullable(),
  providerReferenceAmbiguous: z.boolean(),
  source: z.strictObject({
    family: familySchema,
    taskId: providerTaskIdSchema,
    attribution: attributionSchema,
    originalAncestry: z.literal('unknown'),
    recordedAttempts: countSchema.min(1),
  }),
  createdAtMs: signedMillisecondsSchema.nullable(),
  latestStateAtMs: signedMillisecondsSchema.nullable(),
  reservation: reservationSchema.nullable(),
  submittedUrlCount: urlCountSchema.nullable(),
  unresolvedHold: z.boolean(),
});
type Entry = z.infer<typeof entrySchema>;
const coverageSchema = z.strictObject({
  scope: z.literal('selected_key_local_v2'),
  validated: z.literal('all_local_families_scopes_policies_periods'),
  returned: z.literal('recorded_v2_retry_contexts_only'),
  providerCoverage: z.literal('unknown'),
  originalAncestry: z.literal('unknown'),
  earlierDiscardedHistory: z.literal('unknown'),
  coverageInception: z.literal('unknown'),
});
const okSchema = z.strictObject({
  status: z.literal('ok'),
  snapshot: z.strictObject({
    revision: digestSchema,
    capturedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  }),
  coverage: coverageSchema,
  counts: z.strictObject({
    localRetryAttempts: countSchema,
    matchingRetryAttempts: countSchema,
    legacyUnattributedLocalRecords: countSchema,
    ambiguousLocalProviderReferences: countSchema,
  }),
  page: z.strictObject({
    limit: limitSchema,
    returnedCount: z.number().int().min(0).max(25),
    nextCursor: cursorTextSchema.nullable(),
  }),
  entries: z.array(entrySchema).max(25),
});
const errorSchema = z.strictObject({
  status: z.literal('error'),
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});
const blockedSchema = z.strictObject({
  status: z.literal('blocked'),
  reason: z.strictObject({ code: blockerCodeSchema, message: z.string() }),
});
function versionFor(state: State): 0 | 1 | 2 {
  return state === 'prepared'
    ? 0
    : state === 'dispatching' || state === 'cancelled'
      ? 1
      : 2;
}
function unresolved(state: State): boolean {
  return state === 'prepared' || state === 'dispatching' || state === 'unknown';
}
const reference = (family: string, id: string) => JSON.stringify([family, id]);

/** Check semantic relationships as well as closed structures, including error branches. */
export const retryHistoryResultSchema = z
  .discriminatedUnion('status', [okSchema, blockedSchema, errorSchema])
  .superRefine((value, context) => {
    const invalid = () =>
      context.addIssue({ code: 'custom', message: 'Invalid history result.' });
    if (value.status === 'error') {
      if (value.error.message !== errorMessages[value.error.code]) invalid();
      return;
    }
    if (value.status === 'blocked') {
      if (value.reason.message !== blockerMessages[value.reason.code])
        invalid();
      return;
    }
    const { counts, page, entries } = value;
    if (
      page.returnedCount !== entries.length ||
      entries.length > page.limit ||
      counts.matchingRetryAttempts > counts.localRetryAttempts ||
      entries.length > counts.matchingRetryAttempts ||
      (entries.length === 0 && counts.matchingRetryAttempts !== 0)
    )
      invalid();
    const groups = new Map<string, { count: number; seen: number }>();
    let previous = '';
    for (const entry of entries) {
      if (entry.attemptRef <= previous) invalid();
      previous = entry.attemptRef;
      const hasDetail = entry.createdAtMs !== null;
      const needsDetail =
        unresolved(entry.state) || entry.providerReferenceAmbiguous;
      if (
        entry.family !== entry.source.family ||
        entry.stateVersion !== versionFor(entry.state) ||
        (entry.providerTaskId !== null) !== (entry.state === 'accepted') ||
        (entry.providerReferenceAmbiguous && entry.state !== 'accepted') ||
        entry.unresolvedHold !== unresolved(entry.state) ||
        hasDetail !== (entry.latestStateAtMs !== null) ||
        hasDetail !== (entry.reservation !== null) ||
        hasDetail !== needsDetail ||
        (entry.submittedUrlCount !== null) !==
          (needsDetail || entry.state === 'accepted') ||
        entry.source.recordedAttempts > counts.localRetryAttempts
      )
        invalid();
      const key = reference(entry.source.family, entry.source.taskId);
      const group = groups.get(key) ?? {
        count: entry.source.recordedAttempts,
        seen: 0,
      };
      group.seen++;
      if (
        group.count !== entry.source.recordedAttempts ||
        group.seen > group.count
      )
        invalid();
      groups.set(key, group);
    }
    if (
      [...groups.values()].reduce((sum, group) => sum + group.count, 0) >
      counts.localRetryAttempts
    )
      invalid();
    if (page.nextCursor !== null) {
      try {
        const cursor = decodeCursor(page.nextCursor);
        if (
          cursor.revision !== value.snapshot.revision ||
          cursor.offset < entries.length ||
          cursor.offset >= counts.matchingRetryAttempts ||
          entries.length !== page.limit
        )
          invalid();
      } catch {
        invalid();
      }
    }
  });
export type RetryHistoryResult = DeepReadonly<
  z.infer<typeof retryHistoryResultSchema>
>;
export function retryHistoryError(
  code: RetryHistoryErrorCode,
): RetryHistoryResult {
  return freeze(
    retryHistoryResultSchema.parse({
      status: 'error',
      error: { code, message: errorMessages[code] },
    }),
  );
}
export function retryHistoryBlocked(
  code: z.infer<typeof blockerCodeSchema>,
): RetryHistoryResult {
  return freeze(
    retryHistoryResultSchema.parse({
      status: 'blocked',
      reason: { code, message: blockerMessages[code] },
    }),
  );
}

function safeId(value: string): void {
  if (!providerTaskIdSchema.safeParse(value).success) unavailable();
}
function checkState(
  row: Pick<Child, 'state' | 'stateVersion' | 'providerTaskId'>,
): void {
  if (
    !stateSchema.safeParse(row.state).success ||
    row.stateVersion !== String(versionFor(row.state)) ||
    (row.providerTaskId !== null) !== (row.state === 'accepted')
  )
    unavailable();
  if (row.providerTaskId !== null) safeId(row.providerTaskId);
}
function checkDetail(row: History): void {
  checkState(row);
  signedMillisecondsSchema.parse(row.createdAtMs);
  reservationSchema.parse(row.reservation);
  urlCountSchema.parse(row.urls.length);
  if (row.events.length !== versionFor(row.state) + 1) unavailable();
  for (const [index, event] of row.events.entries()) {
    signedMillisecondsSchema.parse(event.occurredAtMs);
    const kind =
      index === 0
        ? 'prepared'
        : index === 1 && row.state !== 'cancelled'
          ? 'dispatching'
          : row.state;
    if (
      event.stateVersion !== String(index) ||
      event.kind !== kind ||
      event.providerTaskId !==
        (index === versionFor(row.state) ? row.providerTaskId : null)
    )
      unavailable();
    if (event.providerTaskId !== null) safeId(event.providerTaskId);
  }
  if (row.context.originKind === 'retry') {
    if (
      row.context.parentFamily !== row.taskFamily ||
      row.context.parentTaskId === null
    )
      unavailable();
    safeId(row.context.parentTaskId);
  } else if (
    row.context.originKind !== 'standalone' &&
    row.context.originKind !== 'legacy_unattributed'
  )
    unavailable();
}
function matchesDetail(child: Child, row: History): boolean {
  return (
    row.taskFamily === child.taskFamily &&
    row.state === child.state &&
    row.stateVersion === child.stateVersion &&
    row.providerTaskId === child.providerTaskId &&
    row.context.originKind === 'retry' &&
    row.context.parentFamily === child.parentFamily &&
    row.context.parentTaskId === child.parentTaskId &&
    row.context.sourceManifestDigest === child.sourceManifestDigest &&
    row.context.planFingerprint === child.planFingerprint
  );
}
function attribution(
  parent: Manifest | undefined,
  sourceDigest: string,
): Entry['source']['attribution'] {
  if (parent === undefined || parent.manifestDigest !== sourceDigest)
    return 'unattributed_manifest';
  switch (parent.originKind) {
    case 'standalone':
      return 'local_standalone_manifest';
    case 'legacy_unattributed':
      return 'local_legacy_manifest';
    case 'retry':
      return 'local_retry_manifest';
    default:
      return unavailable();
  }
}

/** Consume one complete, already validated selected-key V2 snapshot; never narrow its read. */
export function retryHistoryFromSnapshot(
  snapshot: AvailableRetrySnapshot,
  privateSelectedKeyBinding: string,
  selectors: unknown = {},
): RetryHistoryResult {
  try {
    const input = parseRetryHistoryInput(selectors);
    if (
      !snapshot.ledgerId ||
      !privateSelectedKeyBinding ||
      snapshot.schemaVersion !== 2 ||
      snapshot.availability !== 'available'
    )
      unavailable();
    const manifestsByRequest = new Map<string, Manifest>();
    const manifestsByReference = new Map<string, Manifest>();
    for (const manifest of snapshot.acceptedManifests) {
      safeId(manifest.providerTaskId);
      digestSchema.parse(manifest.manifestDigest);
      urlCountSchema.parse(manifest.submittedUrls.length);
      if (
        !['standalone', 'legacy_unattributed', 'retry'].includes(
          manifest.originKind,
        )
      )
        unavailable();
      const key = reference(manifest.taskFamily, manifest.providerTaskId);
      if (
        manifestsByRequest.has(manifest.requestId) ||
        manifestsByReference.has(key)
      )
        unavailable();
      manifestsByRequest.set(manifest.requestId, manifest);
      manifestsByReference.set(key, manifest);
    }
    const details = new Map<string, History>();
    const addDetail = (row: History) => {
      checkDetail(row);
      if (details.has(row.requestId) || manifestsByRequest.has(row.requestId))
        unavailable();
      details.set(row.requestId, row);
    };
    for (const row of snapshot.unresolvedHistory) {
      if (!unresolved(row.state)) unavailable();
      addDetail(row);
    }
    const ambiguous = new Map<string, ReadonlySet<string>>();
    for (const group of snapshot.ambiguousProviderRefs) {
      safeId(group.providerTaskId);
      const key = reference(group.taskFamily, group.providerTaskId);
      const ids = new Set(group.requestIds);
      if (
        ambiguous.has(key) ||
        manifestsByReference.has(key) ||
        ids.size < 2 ||
        ids.size !== group.requestIds.length ||
        ids.size !== group.records.length
      )
        unavailable();
      const seen = new Set<string>();
      for (const row of group.records) {
        if (
          row.taskFamily !== group.taskFamily ||
          row.providerTaskId !== group.providerTaskId ||
          row.state !== 'accepted' ||
          !ids.has(row.requestId) ||
          seen.has(row.requestId)
        )
          unavailable();
        seen.add(row.requestId);
        addDetail(row);
      }
      ambiguous.set(key, ids);
    }
    const children = new Map<string, Child>();
    const parentCounts = new Map<string, number>();
    for (const child of snapshot.retryChildren) {
      familySchema.parse(child.taskFamily);
      if (
        child.parentFamily !== child.taskFamily ||
        children.has(child.requestId)
      )
        unavailable();
      safeId(child.parentTaskId);
      checkState(child);
      digestSchema.parse(child.sourceManifestDigest);
      digestSchema.parse(child.planFingerprint);
      children.set(child.requestId, child);
      const key = reference(child.parentFamily, child.parentTaskId);
      parentCounts.set(key, (parentCounts.get(key) ?? 0) + 1);
    }
    for (const row of details.values()) {
      const child = children.get(row.requestId);
      if (
        (row.context.originKind === 'retry') !== (child !== undefined) ||
        (child !== undefined && !matchesDetail(child, row))
      )
        unavailable();
    }
    for (const manifest of snapshot.acceptedManifests) {
      const child = children.get(manifest.requestId);
      if (
        (manifest.originKind === 'retry') !== (child !== undefined) ||
        (child !== undefined &&
          (child.state !== 'accepted' ||
            child.taskFamily !== manifest.taskFamily ||
            child.providerTaskId !== manifest.providerTaskId))
      )
        unavailable();
    }
    const refs = new Set<string>();
    const entries: Entry[] = [];
    for (const child of snapshot.retryChildren) {
      const family = familySchema.parse(child.taskFamily);
      const row = details.get(child.requestId);
      const manifest = manifestsByRequest.get(child.requestId);
      const ambiguousIds =
        child.providerTaskId === null
          ? undefined
          : ambiguous.get(reference(family, child.providerTaskId));
      if (
        (row !== undefined && !matchesDetail(child, row)) ||
        (unresolved(child.state) && row === undefined) ||
        (child.state === 'accepted' &&
          manifest === undefined &&
          ambiguousIds === undefined) ||
        (ambiguousIds !== undefined &&
          (!ambiguousIds.has(child.requestId) || row === undefined))
      )
        unavailable();
      const attemptRef = digest('speedyindex-retry-history-attempt-v1', [
        snapshot.ledgerId,
        privateSelectedKeyBinding,
        child.requestId,
      ]);
      if (refs.has(attemptRef)) unavailable();
      refs.add(attemptRef);
      const parentKey = reference(family, child.parentTaskId);
      const parent = manifestsByReference.get(parentKey);
      const current = row?.events.find(
        (event) => event.stateVersion === child.stateVersion,
      );
      entries.push({
        attemptRef,
        family,
        state: child.state,
        stateVersion: versionFor(child.state),
        providerTaskId: child.providerTaskId,
        providerReferenceAmbiguous: ambiguousIds !== undefined,
        source: {
          family,
          taskId: child.parentTaskId,
          attribution: ambiguous.has(parentKey)
            ? 'ambiguous_local_reference'
            : attribution(parent, child.sourceManifestDigest),
          originalAncestry: 'unknown',
          recordedAttempts: parentCounts.get(parentKey) ?? 0,
        },
        createdAtMs: row?.createdAtMs ?? null,
        latestStateAtMs: current?.occurredAtMs ?? null,
        reservation:
          row === undefined
            ? null
            : {
                tokens: row.reservation.tokens,
                indexer: row.reservation.indexer,
                checker: row.reservation.checker,
              },
        submittedUrlCount:
          row?.urls.length ?? manifest?.submittedUrls.length ?? null,
        unresolvedHold: unresolved(child.state),
      });
    }
    // Validate the complete projection, including records outside every requested slice.
    for (const entry of entries) entrySchema.parse(entry);
    countSchema.parse(entries.length);
    countSchema.parse(snapshot.attributionGaps.length);
    countSchema.parse(ambiguous.size);
    digestSchema.parse(snapshot.revision);
    const query = queryDigest(input);
    if (input.cursor !== null) {
      if (input.cursor.query !== query)
        throw new RetryHistoryError('CursorMismatch');
      if (input.cursor.revision !== snapshot.revision)
        throw new RetryHistoryError('SnapshotChanged');
    }
    const matching = entries
      .filter(
        (entry) =>
          (input.searchEngine === null ||
            entry.family === input.searchEngine + '/indexer') &&
          (input.parentTaskId === null ||
            entry.source.taskId === input.parentTaskId) &&
          (input.state === null || entry.state === input.state),
      )
      .sort((a, b) =>
        a.attemptRef < b.attemptRef ? -1 : a.attemptRef > b.attemptRef ? 1 : 0,
      );
    const offset = input.cursor?.offset ?? 0;
    if (input.cursor !== null && offset >= matching.length)
      throw new RetryHistoryError('CursorMismatch');
    const page = matching.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return freeze(
      retryHistoryResultSchema.parse({
        status: 'ok',
        snapshot: {
          revision: snapshot.revision,
          capturedAt: snapshot.capturedAt,
        },
        coverage: {
          scope: 'selected_key_local_v2',
          validated: 'all_local_families_scopes_policies_periods',
          returned: 'recorded_v2_retry_contexts_only',
          providerCoverage: 'unknown',
          originalAncestry: 'unknown',
          earlierDiscardedHistory: 'unknown',
          coverageInception: 'unknown',
        },
        counts: {
          localRetryAttempts: entries.length,
          matchingRetryAttempts: matching.length,
          legacyUnattributedLocalRecords: snapshot.attributionGaps.length,
          ambiguousLocalProviderReferences: ambiguous.size,
        },
        page: {
          limit: input.limit,
          returnedCount: page.length,
          nextCursor:
            nextOffset < matching.length
              ? encodeCursor({
                  v: 1,
                  revision: snapshot.revision,
                  query,
                  offset: nextOffset,
                })
              : null,
        },
        entries: page,
      }),
    );
  } catch (error) {
    return retryHistoryError(
      error instanceof RetryHistoryError ? error.code : 'StateUnavailable',
    );
  }
}

export interface RetryHistoryToolResult {
  readonly isError: boolean;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent: RetryHistoryResult;
}
const productionBytes = 2_097_152;
function envelope(value: RetryHistoryResult): RetryHistoryToolResult {
  return freeze({
    isError: value.status === 'error',
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
}
const fallbacks = {
  InternalError: envelope(retryHistoryError('InternalError')),
  ResourceLimitExceeded: envelope(retryHistoryError('ResourceLimitExceeded')),
};
/** A trusted constructor can lower this ceiling; it is never a public selector. */
export function lowerRetryHistoryResultByteLimit(lower?: number): number {
  const limit = lower ?? productionBytes;
  const minimum = Math.max(
    ...[
      ...errorCodeSchema.options.map((code) =>
        envelope(retryHistoryError(code)),
      ),
      ...blockerCodeSchema.options.map((code) =>
        envelope(retryHistoryBlocked(code)),
      ),
    ].map((value) => Buffer.byteLength(JSON.stringify(value), 'utf8')),
  );
  if (
    !Number.isSafeInteger(limit) ||
    limit < minimum ||
    limit > productionBytes
  )
    throw new RangeError('Invalid retry-history result limit.');
  return limit;
}
/** Copy, validate, freeze and measure the complete escaped/duplicated application envelope. */
export function retryHistoryToolResult(
  value: unknown,
  construction: { maxBytes?: number } = {},
): RetryHistoryToolResult {
  const limit = lowerRetryHistoryResultByteLimit(construction.maxBytes);
  try {
    const parsed = retryHistoryResultSchema.safeParse(value);
    if (!parsed.success) return fallbacks.InternalError;
    const result = envelope(parsed.data);
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= limit
      ? result
      : fallbacks.ResourceLimitExceeded;
  } catch {
    return fallbacks.InternalError;
  }
}
