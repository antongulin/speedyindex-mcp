/** Internal comparison/proposal data. This module issues no admission authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  buildCreateIndexingRequest,
  type PreparedCreateIndexingRequest,
} from './create-indexing-task';
import { ReadBudgetError } from './read-budget';
import {
  freezeSnapshot,
  type AvailableRetrySnapshot,
} from './retry-ledger-snapshot';
import {
  providerTaskIdSchema,
  submittedUrlSchema,
} from './submission-contract';
import {
  computeRetryPlanFingerprint,
  type RetryPlanFingerprintInput,
  type RetryPlanningState,
  type RetryReadUnavailable,
  type RetrySourceProvenance,
} from './submission-ledger';
import type { SubmissionContext, SubmissionPolicy } from './submission-policy';

export const retryPlanInputSchema = z.strictObject({
  searchEngine: z.enum(['google', 'yandex']).default('google'),
});
export type RetryPlanInput = z.infer<typeof retryPlanInputSchema>;
export type RetryFamily = 'google/indexer' | 'yandex/indexer';
export type RetryReference = readonly [family: RetryFamily, id: string];
export type RetryBlocker =
  | 'UnprovenLatest'
  | 'AmbiguousLatest'
  | 'ConflictingEvidence'
  | 'IncompleteScan'
  | 'SourceReportIncomplete'
  | 'SourceManifestConflict'
  | 'UnattributedParentPermissionRequired'
  | 'ActiveCoverageUnknown'
  | 'PriorRetryEvidenceUnknown'
  | 'AmbiguousLocalReference'
  | 'UnknownRetryDispatch'
  | 'RetryPolicyRequired'
  | 'WritesDisabled'
  | 'SnapshotConflict'
  | 'StateUnavailable'
  | 'UpgradeRequired'
  | 'SnapshotLimitExceeded'
  | 'RetryAllowanceExceeded'
  | 'BudgetExceeded'
  | 'StalePeriodContext'
  | 'NoCandidates';
export class RetrySemanticError extends Error {
  constructor(readonly code: RetryBlocker) {
    super('Retry observation cannot establish a complete proposal.');
    this.name = 'RetrySemanticError';
  }
}
function refuse(code: RetryBlocker): never {
  throw new RetrySemanticError(code);
}
export function parseRetryPlanInput(input: unknown): RetryPlanInput {
  const parsed = retryPlanInputSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid retry-plan input.');
  return Object.freeze(parsed.data);
}

export interface RetryTaskFields {
  id: string;
  size?: number | undefined;
  processedCount?: number | undefined;
  indexedCount?: number | undefined;
  isCompleted?: boolean | undefined;
  status?: string | undefined;
  createdAt?: string | undefined;
  payPerIndexed?: boolean | undefined;
  checkAfter?: string | undefined;
  dripFeed?: boolean | undefined;
  days?: number | undefined;
  daysPassed?: number | undefined;
  isStopped?: boolean | undefined;
  awaitingResult?: boolean | undefined;
  childTaskIds?: readonly string[] | undefined;
  children?:
    readonly (RetryTaskFields & { day?: number | undefined })[] | undefined;
}
/** Versioned safety tuple; null means absent, never false/zero. */
export type RetryInstantValue = readonly [
  wholeSecondMs: number,
  fractionDigits: string,
];
export type RetryFact = readonly [
  family: RetryFamily,
  id: string,
  size: number | null,
  processed: number | null,
  indexed: number | null,
  completed: boolean | null,
  status: string | null,
  created: RetryInstantValue | null,
  ppr: boolean | null,
  checkAfter: RetryInstantValue | null,
  drip: boolean | null,
  days: number | null,
  daysPassed: number | null,
  stopped: boolean | null,
  awaiting: boolean | null,
  childIds: readonly string[] | null,
  children: readonly RetryChildFact[] | null,
];
export type RetryChildFact = readonly [...RetryFact, day: number | null];
export type RetryStream = readonly [
  family: RetryFamily,
  scope: 'regular' | 'drip',
  lastPage: number,
  pages: readonly (readonly [page: number, roots: readonly RetryReference[]])[],
];
export type RetryReportFact = readonly [
  family: RetryFamily,
  id: string,
  size: number,
  processed: number,
  indexedCount: number | null,
  indexed: readonly string[],
  unindexed: readonly string[],
  finality: RetryFact,
];
export type RetryPass = readonly [
  streams: readonly RetryStream[],
  statuses: readonly RetryFact[],
  relations: readonly (readonly [
    parent: RetryReference,
    child: RetryReference,
  ])[],
  selectedReport: RetryReportFact | null,
  childReports: readonly RetryReportFact[],
];
export interface RetryObservations {
  readonly facts: RetryPass;
  readonly initialLedgerId: string;
  readonly initialRevision: string;
  readonly observedUtcMs: number;
  readonly nonAtomic: true;
  readonly finality: 'provider_observed';
}
export const retrySemanticCeilings = Object.freeze({
  providerBytes: 8 * 1024 * 1024,
  combinedBytes: 24 * 1024 * 1024,
});
export function lowerRetryByteLimit(
  name: keyof typeof retrySemanticCeilings,
  lower?: number,
) {
  const value = lower ?? retrySemanticCeilings[name];
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > retrySemanticCeilings[name]
  )
    throw new RangeError('Invalid retry logical limit.');
  return value;
}
export function retryLogicalBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
export function assertRetryProviderBytes(
  retainedPasses: readonly RetryPass[],
  lower?: number,
) {
  if (
    retryLogicalBytes(retainedPasses) >
    lowerRetryByteLimit('providerBytes', lower)
  )
    throw new ReadBudgetError('ResourceLimitExceeded');
}
export function assertRetryCombinedBytes(
  local: AvailableRetrySnapshot,
  retainedProviderFacts: RetryPass,
  proposalAndIdentity: unknown,
  lower?: number,
) {
  if (
    retryLogicalBytes([local, retainedProviderFacts, proposalAndIdentity]) >
    lowerRetryByteLimit('combinedBytes', lower)
  )
    throw new ReadBudgetError('ResourceLimitExceeded');
}
export function retryDigest(domain: string, tuple: readonly unknown[]): string {
  return createHash('sha256')
    .update(domain + '\0' + JSON.stringify(tuple), 'utf8')
    .digest('hex');
}
type ReferenceLike = Readonly<{ 0: RetryFamily; 1: string }>;
export const retryReferenceKey = (ref: ReferenceLike) =>
  JSON.stringify([ref[0], ref[1]]);
export function compareRetryReferences(
  a: ReferenceLike,
  b: ReferenceLike,
): number {
  return a[0] < b[0]
    ? -1
    : a[0] > b[0]
      ? 1
      : a[1] < b[1]
        ? -1
        : a[1] > b[1]
          ? 1
          : 0;
}
export function requireRetryId(id: string) {
  if (!providerTaskIdSchema.safeParse(id).success)
    refuse('ConflictingEvidence');
  return id;
}
/** Calendar validation precedes Date.parse; JS rollover is not chronology. */
export function retryInstant(text: string): RetryInstantValue {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!m) return refuse('ConflictingEvidence');
  const y = Number(m[1]),
    month = Number(m[2]),
    d = Number(m[3]);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = m[8]!;
  if (
    month < 1 ||
    month > 12 ||
    d < 1 ||
    d > days[month - 1]! ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59 ||
    Number(m[6]) > 59 ||
    (zone.length > 1 &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    return refuse('ConflictingEvidence');
  const value = Date.parse(text.slice(0, 19) + zone);
  if (!Number.isFinite(value)) return refuse('ConflictingEvidence');
  // Preserve sub-millisecond chronology instead of Date.parse truncation.
  return [value, (m[7]?.slice(1) ?? '').replace(/0+$/, '')];
}
function compareInstants(a: RetryInstantValue, b: RetryInstantValue) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const width = Math.max(a[1].length, b[1].length);
  const aa = a[1].padEnd(width, '0'),
    bb = b[1].padEnd(width, '0');
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}
function clockInstant(utcMs: number): RetryInstantValue {
  const whole = Math.floor(utcMs / 1000) * 1000;
  return [
    whole,
    String(utcMs - whole)
      .padStart(3, '0')
      .replace(/0+$/, ''),
  ];
}
function uniqueIds(ids: readonly string[]) {
  for (const id of ids) requireRetryId(id);
  if (new Set(ids).size !== ids.length) refuse('ConflictingEvidence');
  return [...ids];
}
export function projectRetryFact(
  family: RetryFamily,
  task: RetryTaskFields,
): RetryFact {
  requireRetryId(task.id);
  const childIds =
    task.childTaskIds === undefined ? null : uniqueIds(task.childTaskIds);
  const children =
    task.children === undefined
      ? null
      : task.children
          .map(
            (child) =>
              [
                ...projectRetryFact(family, {
                  ...child,
                  children: undefined,
                } as RetryTaskFields),
                child.day ?? null,
              ] as RetryChildFact,
          )
          .sort(compareRetryReferences);
  if (
    children &&
    new Set(children.map((child) => child[1])).size !== children.length
  )
    refuse('ConflictingEvidence');
  if (
    childIds &&
    children &&
    (childIds.length !== children.length ||
      children.some((child) => !childIds.includes(child[1])))
  )
    refuse('ConflictingEvidence');
  return [
    family,
    task.id,
    task.size ?? null,
    task.processedCount ?? null,
    task.indexedCount ?? null,
    task.isCompleted ?? null,
    task.status ?? null,
    task.createdAt === undefined ? null : retryInstant(task.createdAt),
    task.payPerIndexed ?? null,
    task.checkAfter === undefined ? null : retryInstant(task.checkAfter),
    task.dripFeed ?? null,
    task.days ?? null,
    task.daysPassed ?? null,
    task.isStopped ?? null,
    task.awaitingResult ?? null,
    childIds,
    children,
  ];
}
export function mergeRetryFacts(a: RetryFact, b: RetryFact): RetryFact {
  if (a[0] !== b[0] || a[1] !== b[1]) return refuse('ConflictingEvidence');
  const merged = a.map((value, index) => {
    const other = b[index];
    if (value === null) return other;
    if (other !== null && JSON.stringify(value) !== JSON.stringify(other))
      refuse('ConflictingEvidence');
    return value;
  }) as unknown as RetryFact;
  if (
    (merged[2] !== null &&
      ((merged[3] !== null && merged[3] > merged[2]) ||
        (merged[4] !== null && merged[4] > merged[2]))) ||
    (merged[11] !== null && merged[12] !== null && merged[12] > merged[11]) ||
    (merged[5] === false && merged[6] === 'completed')
  )
    refuse('ConflictingEvidence');
  return merged;
}
export function retryFactFinality(
  fact: RetryFact,
  utcMs: number,
  drip = false,
): 'final' | 'unfinished' | 'uncertain' {
  if (!Number.isSafeInteger(utcMs)) return refuse('ConflictingEvidence');
  drip ||= fact[10] === true;
  if (drip && fact[10] === false) return refuse('ConflictingEvidence');
  if (fact[0] === 'yandex/indexer' && fact[8] === false)
    return refuse('ConflictingEvidence');
  if (fact[5] === false && fact[6] === 'completed')
    return refuse('ConflictingEvidence');
  const ordinary = fact[0] === 'google/indexer' && fact[8] === false;
  if (ordinary && fact[5] === true && !drip) return 'final';
  if (fact[5] === false && fact[6] === null) return 'unfinished';
  if (
    fact[5] !== true ||
    fact[6] !== 'completed' ||
    fact[9] === null ||
    compareInstants(fact[9], clockInstant(utcMs)) > 0 ||
    fact[14] === true ||
    (!ordinary && fact[0] === 'google/indexer' && fact[8] !== true)
  )
    return 'uncertain';
  if (drip) {
    if (
      fact[14] !== false ||
      fact[15] === null ||
      fact[16] === null ||
      fact[11] === null ||
      fact[12] === null ||
      (fact[12] < fact[11] && fact[13] !== true)
    )
      return 'uncertain';
    if (
      fact[16].some(
        (child) =>
          retryFactFinality(
            child.slice(0, 17) as unknown as RetryFact,
            utcMs,
          ) !== 'final',
      )
    )
      return 'uncertain';
  }
  return 'final';
}
export function retryRelations(facts: readonly RetryFact[]): RetryPass[2] {
  const parents = new Map<string, RetryReference>();
  const result: (readonly [RetryReference, RetryReference])[] = [];
  for (const fact of facts) {
    const ids = fact[15],
      children = fact[16];
    if (
      ids &&
      children &&
      (ids.length !== children.length ||
        children.some((child) => !ids.includes(child[1])))
    )
      refuse('ConflictingEvidence');
    const all = ids ?? children?.map((child) => child[1]) ?? [];
    uniqueIds(all);
    for (const id of all) {
      const parent: RetryReference = [fact[0], fact[1]],
        child: RetryReference = [fact[0], id];
      const key = retryReferenceKey(child);
      if (id === fact[1] || parents.has(key)) refuse('ConflictingEvidence');
      parents.set(key, parent);
      result.push([parent, child]);
    }
  }
  for (const [parent, child] of result) {
    const seen = new Set([retryReferenceKey(child)]);
    let cursor: RetryReference | undefined = parent;
    while (cursor) {
      const key = retryReferenceKey(cursor);
      if (seen.has(key)) refuse('ConflictingEvidence');
      seen.add(key);
      cursor = parents.get(key);
    }
  }
  return result.sort(
    (a, b) =>
      compareRetryReferences(a[0], b[0]) || compareRetryReferences(a[1], b[1]),
  );
}
export function retryDripReferences(pass: RetryPass) {
  return new Set([
    ...pass[0]
      .filter((stream) => stream[1] === 'drip')
      .flatMap((stream) =>
        stream[3].flatMap((page) => page[1].map(retryReferenceKey)),
      ),
    ...pass[1].filter((fact) => fact[10] === true).map(retryReferenceKey),
  ]);
}
function byRef(facts: readonly RetryFact[], ref: RetryReference) {
  return facts.find((fact) => fact[0] === ref[0] && fact[1] === ref[1]);
}
export type RetrySelection =
  { kind: 'none' } | { kind: 'selected'; reference: RetryReference };
export function classifyRetryPass(
  pass: RetryPass,
  local: AvailableRetrySnapshot,
  engine: RetryPlanInput['searchEngine'],
  utcMs: number,
): RetrySelection {
  const childRefs = new Set(pass[2].map((pair) => retryReferenceKey(pair[1])));
  for (const manifest of local.acceptedManifests)
    if (manifest.originKind === 'retry')
      childRefs.add(
        JSON.stringify([manifest.taskFamily, manifest.providerTaskId]),
      );
  for (const child of local.retryChildren)
    if (child.state === 'accepted' && child.providerTaskId !== null)
      childRefs.add(JSON.stringify([child.taskFamily, child.providerTaskId]));
  const drips = retryDripReferences(pass);
  const candidates: RetryFact[] = [];
  for (const fact of pass[1]) {
    if (fact[0] === 'yandex/indexer' && fact[8] === false)
      refuse('ConflictingEvidence');
    if (
      fact[0] !== `${engine}/indexer` ||
      childRefs.has(retryReferenceKey(fact)) ||
      (fact[0] === 'google/indexer' && fact[8] === false)
    )
      continue;
    if (
      retryFactFinality(fact, utcMs, drips.has(retryReferenceKey(fact))) ===
      'unfinished'
    )
      continue;
    if (fact[7] === null) refuse('UnprovenLatest');
    candidates.push(fact);
  }
  if (!candidates.length) return { kind: 'none' };
  const latest = candidates.reduce((best, fact) =>
    compareInstants(fact[7]!, best[7]!) > 0 ? fact : best,
  )[7]!;
  const winners = candidates.filter(
    (fact) => compareInstants(fact[7]!, latest) === 0,
  );
  if (winners.length !== 1) return refuse('AmbiguousLatest');
  return { kind: 'selected', reference: [winners[0]![0], winners[0]![1]] };
}
/** Correlate report-only safety fields without inventing newly required lineage work. */
export function correlateRetryReportSafety(
  pass: RetryPass,
  report: RetryReportFact,
) {
  const ref: RetryReference = [report[0], report[1]];
  const status = byRef(pass[1], ref);
  if (!status) refuse('IncompleteScan');
  const merged = mergeRetryFacts(status, report[7]);
  if (
    JSON.stringify(merged) !== JSON.stringify(report[7]) ||
    report[2] !== merged[2] ||
    report[3] !== merged[3] ||
    (report[4] !== null && report[4] !== merged[4])
  )
    refuse('ConflictingEvidence');
  const drip = retryDripReferences(pass).has(retryReferenceKey(ref));
  if ((merged[10] === true && !drip) || (merged[10] === false && drip))
    refuse('ConflictingEvidence');
  const related = pass[2]
    .filter((pair) => compareRetryReferences(pair[0], ref) === 0)
    .map((pair) => pair[1][1]);
  const declared = merged[15] ?? merged[16]?.map((child) => child[1]) ?? [];
  if (
    declared.length !== related.length ||
    declared.some((id) => !related.includes(id))
  )
    refuse('ConflictingEvidence');
}
export function requiredRetryChildReports(
  pass: RetryPass,
  local: AvailableRetrySnapshot,
  parent: RetryReference,
  utcMs: number,
): RetryReference[] {
  const reports: RetryReference[] = [];
  for (const child of local.retryChildren) {
    if (
      child.parentFamily !== parent[0] ||
      child.parentTaskId !== parent[1] ||
      child.state !== 'accepted'
    )
      continue;
    if (
      (child.taskFamily !== 'google/indexer' &&
        child.taskFamily !== 'yandex/indexer') ||
      !child.providerTaskId
    )
      refuse('PriorRetryEvidenceUnknown');
    const ref: RetryReference = [child.taskFamily, child.providerTaskId];
    const fact = byRef(pass[1], ref);
    if (!fact) refuse('PriorRetryEvidenceUnknown');
    if (retryFactFinality(fact, utcMs) !== 'unfinished') reports.push(ref);
  }
  return reports.sort(compareRetryReferences);
}

export type RetryExcluded = Readonly<{
  url: string;
  reasons: readonly (
    | 'LocalUnresolvedHold'
    | 'ActiveIndexing'
    | 'ActiveDrip'
    | 'PriorRetryIndexed'
  )[];
  references: readonly RetryReference[];
}>;
export interface RetryProposal {
  readonly status: 'proposal';
  readonly source: Readonly<{
    reference: RetryReference;
    provenance: RetrySourceProvenance;
    originalManifestKnown: boolean;
    manifestProvenance: RetryPlanFingerprintInput['manifestProvenance'];
    manifestDigest: string;
  }>;
  readonly eligibleUrls: readonly string[];
  readonly excluded: readonly RetryExcluded[];
  readonly counts: Readonly<{
    indexed: number;
    unindexed: number;
    eligible: number;
    excluded: number;
    unknown: 0;
  }>;
  readonly request: PreparedCreateIndexingRequest;
  readonly safetyEvidenceDigests: readonly string[];
  readonly partitionDigest: string;
  readonly preimages: Readonly<{
    observation: RetryPass;
    local: readonly unknown[];
    partition: readonly unknown[];
  }>;
  readonly initialLedgerId: string;
  readonly initialRevision: string;
  readonly maxAttemptsPerSource: number;
}
export type RetryAssessment =
  | RetryProposal
  | Readonly<{ status: 'no_source' }>
  | Readonly<{
      status: 'blocked';
      blockers: readonly RetryBlocker[];
      unknownUrlCount?: number;
      knownMissingLocalUrls?: readonly string[] | null;
    }>;
function blocked(code: RetryBlocker): RetryAssessment {
  return Object.freeze({ status: 'blocked', blockers: Object.freeze([code]) });
}
function manifestFor(local: AvailableRetrySnapshot, ref: RetryReference) {
  if (
    local.ambiguousProviderRefs.some(
      (value) => value.taskFamily === ref[0] && value.providerTaskId === ref[1],
    )
  )
    refuse('AmbiguousLocalReference');
  return local.acceptedManifests.find(
    (value) => value.taskFamily === ref[0] && value.providerTaskId === ref[1],
  );
}
function reportCorpus(report: RetryReportFact, manifest?: readonly string[]) {
  const indexed = report[5],
    unindexed = report[6];
  if (
    new Set(indexed).size !== indexed.length ||
    new Set(unindexed).size !== unindexed.length ||
    indexed.some((url) => unindexed.includes(url)) ||
    [...indexed, ...unindexed].some(
      (url) => !submittedUrlSchema.safeParse(url).success,
    )
  )
    refuse('SourceManifestConflict');
  if (
    report[2] < indexed.length + unindexed.length ||
    report[3] > report[2] ||
    ((report[4] ?? report[7][4]) !== null &&
      (report[4] ?? report[7][4]) !== indexed.length)
  )
    refuse('SourceManifestConflict');
  const union = new Set([...indexed, ...unindexed]);
  if (
    manifest &&
    (new Set(manifest).size !== manifest.length ||
      [...union].some((url) => !manifest.includes(url)) ||
      report[2] !== manifest.length)
  )
    refuse('SourceManifestConflict');
  const missing = manifest ? manifest.filter((url) => !union.has(url)) : null;
  const unknown = manifest ? missing!.length : report[2] - union.size;
  return {
    indexed,
    unindexed,
    unknown,
    missing,
    complete: unknown === 0 && report[3] === report[2],
  };
}
export function assessRetryObservations(
  input: unknown,
  observations: RetryObservations,
  local: AvailableRetrySnapshot,
  policy: Readonly<SubmissionPolicy>,
  construction: { combinedBytes?: number } = {},
): RetryAssessment {
  const args = parseRetryPlanInput(input);
  const limit = lowerRetryByteLimit(
    'combinedBytes',
    construction.combinedBytes,
  );
  try {
    if (
      observations.initialLedgerId !== local.ledgerId ||
      observations.initialRevision !== local.revision
    )
      refuse('SnapshotConflict');
    const pass = observations.facts;
    assertRetryCombinedBytes(local, pass, null, limit);
    const selection = classifyRetryPass(
      pass,
      local,
      args.searchEngine,
      observations.observedUtcMs,
    );
    if (selection.kind === 'none') {
      if (pass[3]) refuse('UnprovenLatest');
      assertRetryCombinedBytes(local, pass, { status: 'no_source' }, limit);
      return Object.freeze({ status: 'no_source' });
    }
    const ref = selection.reference,
      selected = pass[3];
    if (!selected || selected[0] !== ref[0] || selected[1] !== ref[1])
      refuse('SourceReportIncomplete');
    correlateRetryReportSafety(pass, selected);
    if (selected[0] === 'google/indexer' && selected[7][8] !== true)
      refuse('UnprovenLatest');
    if (
      retryFactFinality(
        selected[7],
        observations.observedUtcMs,
        retryDripReferences(pass).has(retryReferenceKey(ref)),
      ) !== 'final'
    )
      refuse('UnprovenLatest');
    const manifest = manifestFor(local, ref);
    if (manifest?.originKind === 'retry') refuse('ConflictingEvidence');
    const corpus = reportCorpus(selected, manifest?.submittedUrls);
    if (!corpus.complete)
      return freezeSnapshot({
        status: 'blocked',
        blockers: ['SourceReportIncomplete'],
        unknownUrlCount: corpus.unknown,
        knownMissingLocalUrls: corpus.missing,
      });
    if (!policy.enabled) refuse('WritesDisabled');
    if (!policy.retry?.enabled) refuse('RetryPolicyRequired');
    const provenance: RetrySourceProvenance = !manifest
      ? 'external_unattributed'
      : manifest.originKind === 'legacy_unattributed'
        ? 'legacy_unattributed'
        : 'local_standalone';
    if (
      provenance !== 'local_standalone' &&
      !policy.retry.allowUnattributedParents
    )
      refuse('UnattributedParentPermissionRequired');
    if (
      local.retryChildren.some(
        (child) =>
          ['dispatching', 'unknown'].includes(child.state) &&
          child.providerTaskId === null,
      )
    )
      refuse('UnknownRetryDispatch');
    const exclusions = new Map<
      string,
      {
        reasons: Set<RetryExcluded['reasons'][number]>;
        references: Map<string, RetryReference>;
      }
    >();
    const add = (
      urls: readonly string[],
      reason: RetryExcluded['reasons'][number],
      reference?: RetryReference,
    ) => {
      for (const url of urls) {
        if (!corpus.unindexed.includes(url)) continue;
        const entry = exclusions.get(url) ?? {
          reasons: new Set<RetryExcluded['reasons'][number]>(),
          references: new Map<string, RetryReference>(),
        };
        entry.reasons.add(reason);
        if (reference)
          entry.references.set(retryReferenceKey(reference), reference);
        exclusions.set(url, entry);
      }
    };
    for (const hold of local.holds)
      add(
        hold.urls.map((row) => row.url),
        'LocalUnresolvedHold',
      );
    const drips = retryDripReferences(pass);
    const effectiveFacts = pass[1].map(
      (fact) =>
        [pass[3], ...pass[4]].find(
          (report) => report?.[0] === fact[0] && report[1] === fact[1],
        )?.[7] ?? fact,
    );
    const coveredChildren = new Set<string>();
    for (const fact of effectiveFacts) {
      const taskRef: RetryReference = [fact[0], fact[1]],
        key = retryReferenceKey(taskRef);
      if (
        !drips.has(key) ||
        retryFactFinality(fact, observations.observedUtcMs, true) === 'final'
      )
        continue;
      const parentManifest = manifestFor(local, taskRef);
      if (!parentManifest) refuse('ActiveCoverageUnknown');
      add(parentManifest.submittedUrls, 'ActiveDrip', taskRef);
      for (const pair of pass[2])
        if (retryReferenceKey(pair[0]) === key)
          coveredChildren.add(retryReferenceKey(pair[1]));
    }
    for (const fact of effectiveFacts) {
      const taskRef: RetryReference = [fact[0], fact[1]],
        key = retryReferenceKey(taskRef);
      if (
        coveredChildren.has(key) ||
        retryFactFinality(fact, observations.observedUtcMs, drips.has(key)) ===
          'final'
      )
        continue;
      const activeManifest = manifestFor(local, taskRef);
      if (!activeManifest) refuse('ActiveCoverageUnknown');
      add(
        activeManifest.submittedUrls,
        drips.has(key) ? 'ActiveDrip' : 'ActiveIndexing',
        taskRef,
      );
    }
    for (const childRef of requiredRetryChildReports(
      pass,
      local,
      ref,
      observations.observedUtcMs,
    )) {
      const childReport = pass[4].find(
        (report) => report[0] === childRef[0] && report[1] === childRef[1],
      );
      const childManifest = manifestFor(local, childRef);
      if (
        !childReport ||
        !childManifest ||
        retryFactFinality(childReport[7], observations.observedUtcMs) !==
          'final'
      )
        refuse('PriorRetryEvidenceUnknown');
      let childComplete = false;
      try {
        correlateRetryReportSafety(pass, childReport);
        childComplete = reportCorpus(
          childReport,
          childManifest.submittedUrls,
        ).complete;
      } catch (error) {
        if (!(error instanceof RetrySemanticError)) throw error;
      }
      if (!childComplete) refuse('PriorRetryEvidenceUnknown');
      add(childReport[5], 'PriorRetryIndexed', childRef);
    }
    const eligible = corpus.unindexed.filter((url) => !exclusions.has(url));
    const excluded: RetryExcluded[] = corpus.unindexed
      .filter((url) => exclusions.has(url))
      .map((url) => {
        const entry = exclusions.get(url)!;
        return {
          url,
          reasons: [...entry.reasons].sort(),
          references: [...entry.references.values()].sort(
            compareRetryReferences,
          ),
        };
      });
    if (!eligible.length) refuse('NoCandidates');
    let request: PreparedCreateIndexingRequest;
    try {
      request = buildCreateIndexingRequest({
        mode: 'preview',
        searchEngine: args.searchEngine,
        urls: eligible,
      });
    } catch {
      throw new ReadBudgetError('ResourceLimitExceeded');
    }
    const manifestDigest =
      manifest?.manifestDigest ??
      retryDigest('speedyindex-provider-report-url-manifest-v1', [
        ref[0],
        ref[1],
        [...corpus.indexed, ...corpus.unindexed],
      ]);
    const localPreimage = [
      local.revision,
      ref[0],
      ref[1],
      provenance,
      manifestDigest,
    ];
    const partitionPreimage = [
      corpus.unindexed,
      eligible,
      excluded.map((entry) => [entry.url, entry.reasons, entry.references]),
      [0, corpus.missing],
    ];
    const proposal: RetryProposal = {
      status: 'proposal',
      source: {
        reference: ref,
        provenance,
        originalManifestKnown: !!manifest,
        manifestProvenance: manifest
          ? 'durable_local_intent_ack'
          : 'provider_report_observed_corpus',
        manifestDigest,
      },
      eligibleUrls: eligible,
      excluded,
      counts: {
        indexed: corpus.indexed.length,
        unindexed: corpus.unindexed.length,
        eligible: eligible.length,
        excluded: excluded.length,
        unknown: 0,
      },
      request,
      safetyEvidenceDigests: [
        retryDigest('speedyindex-retry-observation-safety-v1', pass),
        retryDigest('speedyindex-retry-local-safety-v1', localPreimage),
      ],
      partitionDigest: retryDigest(
        'speedyindex-retry-partition-v1',
        partitionPreimage,
      ),
      preimages: {
        observation: pass,
        local: localPreimage,
        partition: partitionPreimage,
      },
      initialLedgerId: local.ledgerId,
      initialRevision: local.revision,
      maxAttemptsPerSource: policy.retry.maxAttemptsPerSource,
    };
    assertRetryCombinedBytes(local, pass, proposal, limit);
    return freezeSnapshot(proposal);
  } catch (error) {
    if (error instanceof RetrySemanticError) return blocked(error.code);
    throw error;
  }
}
export type RetryComparison =
  | Readonly<{
      status: 'comparison';
      preimage: RetryPlanFingerprintInput;
      fingerprint: string;
    }>
  | Readonly<{ status: 'blocked'; blockers: readonly RetryBlocker[] }>;
export function buildRetrySemanticIdentity(
  proposal: RetryProposal,
  final: RetryPlanningState | RetryReadUnavailable,
  context: SubmissionContext,
  local: AvailableRetrySnapshot,
  construction: { combinedBytes?: number } = {},
): RetryComparison {
  const limit = lowerRetryByteLimit(
    'combinedBytes',
    construction.combinedBytes,
  );
  try {
    if (final.availability !== 'available')
      refuse(
        final.reason === 'UpgradeRequired'
          ? 'UpgradeRequired'
          : final.reason === 'LimitExceeded'
            ? 'SnapshotLimitExceeded'
            : 'StateUnavailable',
      );
    if (
      local.ledgerId !== proposal.initialLedgerId ||
      local.revision !== proposal.initialRevision ||
      final.snapshot.ledgerId !== proposal.initialLedgerId ||
      final.snapshot.revision !== proposal.initialRevision
    )
      refuse('SnapshotConflict');
    if (!final.decision.periodCompatible) refuse('StalePeriodContext');
    if (
      !final.decision.attempts.canCreate ||
      final.decision.attempts.limit !== proposal.maxAttemptsPerSource ||
      final.decision.attempts.count >= proposal.maxAttemptsPerSource
    )
      refuse('RetryAllowanceExceeded');
    if (!Object.values(final.decision.withinCaps).every(Boolean))
      refuse('BudgetExceeded');
    const authorization = context.authorization;
    if (
      authorization.state !== 'configured' ||
      !authorization.period ||
      !authorization.fingerprint ||
      !authorization.policyDigest
    )
      refuse('StateUnavailable');
    const preimage: RetryPlanFingerprintInput = {
      parent: {
        family: proposal.source.reference[0],
        taskId: proposal.source.reference[1],
      },
      provenance: proposal.source.provenance,
      originalManifestKnown: proposal.source.originalManifestKnown,
      manifestProvenance: proposal.source.manifestProvenance,
      sourceManifestDigest: proposal.source.manifestDigest,
      safetyEvidenceDigests: proposal.safetyEvidenceDigests,
      partitionDigest: proposal.partitionDigest,
      revision: proposal.initialRevision,
      policyDigest: authorization.policyDigest,
      authorizationFingerprint: authorization.fingerprint,
      payloadDigest: proposal.request.request.payloadDigest,
      quoteVersion: proposal.request.quote.version,
      quoteFingerprint: proposal.request.quote.fingerprint,
      period: authorization.period,
      providerRoute: proposal.request.request.providerRoute,
      urlCount: proposal.eligibleUrls.length,
      providerBodyBytes: proposal.request.request.providerBodyBytes,
      reservation: proposal.request.quote.maximumExposure,
    };
    const result = {
      status: 'comparison' as const,
      preimage,
      fingerprint: computeRetryPlanFingerprint(preimage),
    };
    assertRetryCombinedBytes(
      local,
      proposal.preimages.observation,
      [proposal, result],
      limit,
    );
    return freezeSnapshot(result);
  } catch (error) {
    if (error instanceof RetrySemanticError)
      return freezeSnapshot({ status: 'blocked', blockers: [error.code] });
    throw error;
  }
}
