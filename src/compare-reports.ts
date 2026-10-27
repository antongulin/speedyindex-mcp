/** Pure report evidence only. No collection, historical snapshot or paid authority. */
import { z } from 'zod';
import type { ComparePrivateMeasurements } from './compare-reports-owner';
import {
  providerTaskIdSchema,
  safeNonnegativeInteger as count,
  submittedUrlSchema,
  validText,
} from './submission-contract';
import { taskFamilySchema, type TaskFamily } from './task-status';

export const compareReportsInputSchema = z
  .strictObject({
    family: taskFamilySchema,
    beforeTaskId: providerTaskIdSchema,
    afterTaskId: providerTaskIdSchema,
  })
  .refine((value) => value.beforeTaskId !== value.afterTaskId, {
    message: 'Comparison requires distinct task IDs.',
  });
export type CompareReportsInput = z.infer<typeof compareReportsInputSchema>;

const genericFamily = taskFamilySchema.exclude(['backlink/checker']);
const text = z.string().refine((value) => validText(value, 8_192));
const target = text.refine((value) => value.trim().length > 0);
const targets = z.array(target).min(1).max(50);
const observationFields = {
  size: count.nullable(),
  processedCount: count.nullable(),
  indexedCount: count.nullable(),
  isCompleted: z.boolean().nullable(),
  status: text.nullable(),
  checkAfter: text.nullable(),
  awaitingResult: z.boolean().nullable(),
  dripFeed: z.boolean().nullable(),
  days: count.nullable(),
  daysPassed: count.nullable(),
  isStopped: z.boolean().nullable(),
};
const statusSchema = z.strictObject({
  id: providerTaskIdSchema,
  type: text.nullable(),
  ...observationFields,
  targetDomains: targets.nullable(),
  providerCreatedAt: text.nullable(),
});
export type CompareStatusProjection = z.infer<typeof statusSchema>;
const reportMetadataSchema = z.strictObject({
  ...observationFields,
  size: count,
  processedCount: count,
  type: text.nullable(),
  providerCreatedAt: text.nullable(),
});
type ReportMetadata = z.infer<typeof reportMetadataSchema>;
const linksProjectionSchema = z.strictObject({
  family: genericFamily,
  reportKind: z.literal('links'),
  taskId: providerTaskIdSchema,
  metadata: reportMetadataSchema,
  indexedLinks: z.array(submittedUrlSchema).max(10_000),
  unindexedLinks: z.array(submittedUrlSchema).max(10_000),
  indexedDuplicateCount: count,
  unindexedDuplicateCount: count,
});
export type CompareLinksProjection = z.infer<typeof linksProjectionSchema>;
const targetLinkSchema = z.strictObject({
  url: submittedUrlSchema,
  anchor: text,
  nofollow: z.boolean(),
});
type TargetLink = z.infer<typeof targetLinkSchema>;
const donorReasonSchema = z.enum([
  'not_reported',
  'not_processed',
  'target_links_unavailable',
  'invalid_target_link',
  'conflicting_donor_rows',
]);
const donorSideSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('reported'),
    targetLinks: z.array(targetLinkSchema).max(1_000),
  }),
  z.strictObject({ state: z.literal('unknown'), reason: donorReasonSchema }),
]);
type DonorSide = z.infer<typeof donorSideSchema>;
const donorProjectionSchema = z.strictObject({
  donorUrl: submittedUrlSchema,
  processedWitness: z.boolean(),
  evidence: donorSideSchema,
});
const backlinkProjectionSchema = z.strictObject({
  family: z.literal('backlink/checker'),
  reportKind: z.literal('backlink'),
  taskId: providerTaskIdSchema,
  size: count,
  processedCount: count,
  isCompleted: z.boolean().nullable(),
  page: count,
  lastPage: count.max(14),
  donors: z.array(donorProjectionSchema).max(100),
  rawTargetLinkCount: count,
  duplicateTargetLinkCount: count,
});
export type CompareBacklinkProjection = z.infer<
  typeof backlinkProjectionSchema
>;
export type CompareReportProjection =
  CompareLinksProjection | CompareBacklinkProjection;
export interface CompareSideEvidence {
  readonly status: CompareStatusProjection;
  readonly reports: readonly CompareReportProjection[];
}

export const compareReportsBlockerCodeSchema = z.enum([
  'StatusUnavailable',
  'IncompatibleTaskType',
  'TargetScopeUnavailable',
  'IncompatibleTargetScope',
  'UnsupportedReportUrl',
  'UnkeyedDonorEvidence',
  'ConflictingEvidence',
  'EvidenceChanged',
]);
export const compareReportsErrorCodeSchema = z.enum([
  'InvalidInput',
  'MissingCredentials',
  'Cancelled',
  'DeadlineExceeded',
  'ResourceLimitExceeded',
  'ReadFailed',
  'CleanupFailed',
  'InternalError',
]);
type BlockerCode = z.infer<typeof compareReportsBlockerCodeSchema>;
type ErrorCode = z.infer<typeof compareReportsErrorCodeSchema>;
const blockerMessages: Record<BlockerCode, string> = {
  StatusUnavailable: 'A required task status was not returned.',
  IncompatibleTaskType:
    'The observed task types do not match the selected family.',
  TargetScopeUnavailable: 'Safe current backlink target scope is unavailable.',
  IncompatibleTargetScope:
    'Current backlink target scopes do not match exactly.',
  UnsupportedReportUrl: 'A report contains an unsupported URL.',
  UnkeyedDonorEvidence: 'A donor row has no safe exact identity.',
  ConflictingEvidence: 'Required report observations conflict.',
  EvidenceChanged: 'Required evidence changed between observations.',
};
const errorMessages: Record<ErrorCode, string> = {
  InvalidInput: 'Invalid report-comparison input.',
  MissingCredentials: 'Report comparison requires configured credentials.',
  Cancelled: 'Report comparison was cancelled.',
  DeadlineExceeded: 'Report comparison exceeded its observation deadline.',
  ResourceLimitExceeded: 'Report comparison exceeded a resource limit.',
  ReadFailed: 'A required provider read failed.',
  CleanupFailed: 'Report comparison cleanup failed.',
  InternalError: 'Report comparison failed internally.',
};
const phaseSchema = z.enum(['status', 'report', 'fence']);
const causeSchema = z.enum([
  'http',
  'provider',
  'response',
  'network',
  'timeout',
]);
type FailureDetails = {
  phase?: z.infer<typeof phaseSchema>;
  cause?: z.infer<typeof causeSchema>;
  cleanup?: 'failed';
};

/** Internal fixed classification; never stores a provider value or exception. */
export class CompareReportsFault extends Error {
  constructor(readonly code: BlockerCode | ErrorCode) {
    super('Report-comparison evidence is unavailable.');
    this.name = 'CompareReportsFault';
  }
}
const refuse = (code: BlockerCode | ErrorCode): never => {
  throw new CompareReportsFault(code);
};
type Checkpoint = () => void;
const noCheckpoint: Checkpoint = () => {};

/** Notifications only: callbacks observe/check, never supply data or authority. */
export type CompareWorkRootsObserver = (
  roots: readonly unknown[],
  completedOwned?: object,
) => void;
type Work = ((...roots: unknown[]) => void) & {
  completeOwned?: (value: object, ...roots: unknown[]) => void;
  measurements?: ComparePrivateMeasurements;
  checkpoint?: Checkpoint;
};
function observingWork(
  check: Checkpoint,
  observer?: CompareWorkRootsObserver,
  failed?: () => void,
  measurements?: ComparePrivateMeasurements,
): Work | undefined {
  if (!observer) return undefined;
  const notify = (roots: readonly unknown[], completedOwned?: object) => {
    try {
      check();
      observer(roots, completedOwned);
      check();
    } catch (error) {
      failed?.();
      throw error;
    }
  };
  const work: Work = (...roots) => notify(roots);
  work.completeOwned = (value, ...roots) => notify(roots, value);
  work.checkpoint = check;
  if (measurements) work.measurements = measurements;
  return work;
}
const scopeWork = (
  parent: Work | undefined,
  roots: () => readonly unknown[],
): Work | undefined => {
  if (!parent) return undefined;
  const work: Work = (...extra) => parent(...roots(), ...extra);
  work.completeOwned = (value, ...extra) =>
    parent.completeOwned?.(value, ...roots(), ...extra);
  if (parent.measurements) work.measurements = parent.measurements;
  if (parent.checkpoint) work.checkpoint = parent.checkpoint;
  return work;
};
function freeze<T>(
  value: T,
  work?: Work,
  parents: readonly unknown[] = [],
  privatelyCompleted?: WeakSet<object>,
  certify = true,
): T {
  if (value !== null && typeof value === 'object') {
    if (!certify && privatelyCompleted?.has(value)) return value;
    const values = work?.measurements
      ? work.measurements.privateValues(value, work.checkpoint)
      : Object.values(value);
    work?.(...parents, values);
    for (const item of values)
      freeze(item, work, [...parents, values], privatelyCompleted, certify);
    Object.freeze(value);
    if (certify) {
      work?.completeOwned?.(value, ...parents, values);
      privatelyCompleted?.add(value);
    }
  }
  return value;
}
/** Only copied/private allocations enter here; caller graphs never do. */
function closeOwned<T>(
  value: T,
  work?: Work,
  parents: readonly unknown[] = [],
): T {
  if (value !== null && typeof value === 'object') {
    work?.(...parents, value);
    const keys = work?.measurements
      ? work.measurements.privateKeys(value, work.checkpoint)
      : Object.keys(value);
    work?.(...parents, value, keys);
    for (const key of keys)
      closeOwned((value as Record<string, unknown>)[key], work, [
        ...parents,
        value,
        keys,
      ]);
    Object.freeze(value);
    work?.completeOwned?.(value, ...parents, value, keys);
  }
  return value;
}
function same(a: unknown, b: unknown, work?: Work) {
  const left = JSON.stringify(a),
    right = JSON.stringify(b);
  work?.(a, b, left, right);
  return left === right;
}
/** Fresh private construction only; unsupported children retain native fallback. */
function arrayFrom<T>(values: Iterable<T>, work?: Work): T[] {
  const writer = work?.measurements?.array<T>();
  if (!writer) return [...values];
  for (const value of values) writer.append(value);
  writer.seal();
  return writer.value;
}
function joined<T>(
  left: () => Iterable<T>,
  right: () => Iterable<T>,
  work?: Work,
): T[] {
  const writer = work?.measurements?.array<T>();
  if (!writer) return [...left(), ...right()];
  for (const value of left()) writer.append(value);
  for (const value of right()) writer.append(value);
  writer.seal();
  return writer.value;
}
function unique<T>(values: readonly T[], work?: Work) {
  const keyWriter = work?.measurements?.set<T>();
  const keys = keyWriter?.value ?? new Set(values);
  if (keyWriter) {
    for (const value of values) keyWriter.add(value);
    keyWriter.seal();
  }
  const result = arrayFrom(keys, work);
  work?.(values, keys, result);
  return result;
}
function tupleKey(link: TargetLink, work?: Work) {
  const tuple = [link.url, link.anchor, link.nofollow];
  const key = JSON.stringify(tuple);
  work?.(tuple, key);
  return key;
}
function observations(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(observationFields).map((key) => [key, value[key] ?? null]),
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return refuse('ConflictingEvidence');
  return value as Record<string, unknown>;
}
function numericContradiction(value: {
  size: number | null;
  processedCount: number | null;
  indexedCount?: number | null;
}) {
  return (
    (value.size !== null &&
      ((value.processedCount !== null && value.processedCount > value.size) ||
        (value.indexedCount != null && value.indexedCount > value.size))) ||
    (value.processedCount !== null &&
      value.indexedCount != null &&
      value.indexedCount > value.processedCount)
  );
}
/** Unindexed-only identities consume size slots, without proving processing. */
function indexedTotalContradiction(
  report: { size: number; processedCount: number },
  indexedCount: number | null,
  observedIndexed: number,
  unindexedOnly: number,
) {
  return (
    indexedCount !== null &&
    (indexedCount > report.processedCount ||
      indexedCount < observedIndexed ||
      indexedCount > report.size - unindexedOnly)
  );
}
/** Whitelist the existing normalized status. Missing optional facts stay null. */
export function projectCompareStatus(
  value: unknown,
  construction: {
    checkpoint?: Checkpoint;
    observeWork?: CompareWorkRootsObserver;
  } = {},
): CompareStatusProjection {
  const check = construction.checkpoint ?? noCheckpoint;
  const observeWork = construction.observeWork;
  const work = observingWork(check, observeWork);
  check();
  if (value === undefined || value === null) return refuse('StatusUnavailable');
  const source = record(value);
  if (
    source.createdAt !== undefined &&
    !text.safeParse(source.createdAt).success
  )
    return refuse('ConflictingEvidence');
  if (
    source.targetDomains !== undefined &&
    !targets.safeParse(source.targetDomains).success
  )
    return refuse('TargetScopeUnavailable');
  const parsed = (() => {
    const candidate = {
      id: source.id,
      type: source.type ?? null,
      ...observations(source),
      targetDomains: source.targetDomains ?? null,
      providerCreatedAt:
        source.createdAt === undefined ? null : source.createdAt,
    };
    work?.(candidate, candidate);
    const parsed = statusSchema.safeParse(candidate);
    work?.(candidate, parsed);
    return parsed;
  })();
  if (!parsed.success || numericContradiction(parsed.data))
    return refuse('ConflictingEvidence');
  const result = freeze(
    parsed.data,
    scopeWork(work, () => [parsed]),
  );
  check();
  return result;
}

/** Safe exact strings are retained; URL parser output is never returned. */
export function projectCompareLinksReport(
  value: unknown,
  checkpoint: Checkpoint = noCheckpoint,
  observeWork?: CompareWorkRootsObserver,
): CompareLinksProjection {
  const work = observingWork(checkpoint, observeWork);
  checkpoint();
  const source = record(value);
  if (
    source.createdAt !== undefined &&
    !text.safeParse(source.createdAt).success
  )
    return refuse('ConflictingEvidence');
  const indexed = source.indexedLinks,
    unindexed = source.unindexedLinks;
  if (!Array.isArray(indexed) || !Array.isArray(unindexed))
    return refuse('ConflictingEvidence');
  if (indexed.length + unindexed.length > 10_000)
    return refuse('ResourceLimitExceeded');
  {
    const validation = [...indexed, ...unindexed];
    work?.(validation);
    for (const url of validation) {
      checkpoint();
      if (!submittedUrlSchema.safeParse(url).success)
        return refuse('UnsupportedReportUrl');
    }
  }
  const parsed = (() => {
    const candidate = {
      family: source.family,
      reportKind: source.reportKind,
      taskId: source.taskId,
      metadata: {
        ...observations(source),
        type: source.type,
        providerCreatedAt:
          source.createdAt === undefined ? null : source.createdAt,
      },
    };
    const indexedCandidate = Object.assign(candidate, {
      indexedLinks: unique(
        indexed,
        scopeWork(work, () => [candidate]),
      ),
    });
    const partial = Object.assign(indexedCandidate, {
      unindexedLinks: unique(
        unindexed,
        scopeWork(work, () => [indexedCandidate]),
      ),
    });
    const duplicates = (values: unknown[]) => {
      const set = new Set(values);
      work?.(partial, set);
      return values.length - set.size;
    };
    const complete = Object.assign(partial, {
      indexedDuplicateCount: duplicates(indexed),
      unindexedDuplicateCount: duplicates(unindexed),
    });
    work?.(complete, complete);
    const parsed = linksProjectionSchema.safeParse(complete);
    work?.(complete, parsed);
    return parsed;
  })();
  if (!parsed.success) return refuse('ConflictingEvidence');
  const p = parsed.data;
  const union = new Set(
    unique(
      [...p.indexedLinks, ...p.unindexedLinks],
      scopeWork(work, () => [parsed]),
    ),
  );
  work?.(parsed, union);
  if (
    numericContradiction(p.metadata) ||
    union.size > p.metadata.size ||
    p.indexedLinks.length > p.metadata.processedCount ||
    indexedTotalContradiction(
      p.metadata,
      p.metadata.indexedCount,
      p.indexedLinks.length,
      union.size - p.indexedLinks.length,
    )
  )
    return refuse('ConflictingEvidence');
  const result = freeze(
    p,
    scopeWork(work, () => [parsed, union]),
  );
  checkpoint();
  return result;
}

/** Dated cabinet grammar only; malformed link data never becomes an empty set. */
export function projectCompareBacklinkPage(
  value: unknown,
  checkpoint: Checkpoint = noCheckpoint,
  observeWork?: CompareWorkRootsObserver,
): CompareBacklinkProjection {
  const work = observingWork(checkpoint, observeWork);
  checkpoint();
  const source = record(value);
  if (!Array.isArray(source.donors) || source.donors.length > 100)
    return refuse('ConflictingEvidence');
  if (typeof source.lastPage === 'number' && source.lastPage > 14)
    return refuse('ResourceLimitExceeded');
  let rawTargetLinkCount = 0,
    duplicateTargetLinkCount = 0;
  const donors: z.infer<typeof donorProjectionSchema>[] = [];
  for (const raw of source.donors) {
    checkpoint();
    const donor =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const id = submittedUrlSchema.safeParse(donor.donor_url);
    if (!id.success) return refuse('UnkeyedDonorEvidence');
    if (Array.isArray(donor.target_links)) {
      if (donor.target_links.length > 1_000)
        return refuse('ResourceLimitExceeded');
      rawTargetLinkCount += donor.target_links.length;
    }
    const project = (): z.infer<typeof donorProjectionSchema> => {
      const unknown = (reason: z.infer<typeof donorReasonSchema>) => ({
        donorUrl: id.data,
        processedWitness: donor.processed === true,
        evidence: { state: 'unknown' as const, reason },
      });
      if (donor.processed !== true) return unknown('not_processed');
      if (!Array.isArray(donor.target_links))
        return unknown('target_links_unavailable');
      const links: TargetLink[] = [],
        seen = new Set<string>();
      const linkWork = scopeWork(work, () => [donors, id, links, seen]);
      let duplicates = 0;
      for (const rawLink of donor.target_links) {
        checkpoint();
        const link =
          rawLink && typeof rawLink === 'object' && !Array.isArray(rawLink)
            ? (rawLink as Record<string, unknown>)
            : {};
        const parsed = targetLinkSchema.safeParse({
          url: link.url,
          anchor: link.anchor,
          nofollow: link.nofollow,
        });
        if (!parsed.success) return unknown('invalid_target_link');
        linkWork?.(parsed);
        const key = tupleKey(
          parsed.data,
          scopeWork(linkWork, () => [parsed]),
        );
        if (seen.has(key)) duplicates++;
        else links.push(parsed.data);
        seen.add(key);
        linkWork?.(parsed);
      }
      duplicateTargetLinkCount += duplicates;
      const result = {
        donorUrl: id.data,
        processedWitness: true,
        evidence: { state: 'reported' as const, targetLinks: links },
      };
      linkWork?.(result);
      return result;
    };
    const result = project();
    work?.(donors, id, result);
    donors.push(result);
  }
  if (rawTargetLinkCount > 10_000) return refuse('ResourceLimitExceeded');
  const parsed = (() => {
    const candidate = {
      family: source.family,
      reportKind: source.reportKind,
      taskId: source.taskId,
      size: source.size,
      processedCount: source.processedCount,
      isCompleted: source.isCompleted ?? null,
      page: source.page,
      lastPage: source.lastPage,
      donors,
      rawTargetLinkCount,
      duplicateTargetLinkCount,
    };
    work?.(donors, candidate, candidate);
    const parsed = backlinkProjectionSchema.safeParse(candidate);
    work?.(donors, candidate, parsed);
    return parsed;
  })();
  if (!parsed.success || numericContradiction(parsed.data))
    return refuse('ConflictingEvidence');
  const result = freeze(
    parsed.data,
    scopeWork(work, () => [donors, parsed]),
  );
  checkpoint();
  return result;
}

const genericSideSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('indexed'),
    membership: z.literal('indexed'),
  }),
  z.strictObject({
    state: z.literal('unindexed'),
    membership: z.literal('unindexed'),
  }),
  z.strictObject({
    state: z.literal('unknown'),
    membership: z.enum(['indexed', 'unindexed', 'both', 'omitted']),
    reason: z.enum([
      'not_reported',
      'processing_unsettled',
      'conflicting_partitions',
    ]),
  }),
]);
type GenericSide = z.infer<typeof genericSideSchema>;
type Membership = GenericSide['membership'];
const changeSchema = z.enum([
  'reported_unindexed_to_indexed',
  'reported_indexed_to_unindexed',
  'unchanged_indexed',
  'unchanged_unindexed',
  'unknown',
]);
const genericRowSchema = z.strictObject({
  url: submittedUrlSchema,
  before: genericSideSchema,
  after: genericSideSchema,
  change: changeSchema,
});
type GenericRow = z.infer<typeof genericRowSchema>;
const linksSummarySchema = z.strictObject({
  status: statusSchema,
  report: reportMetadataSchema,
  settled: z.boolean(),
  coverage: z.strictObject({
    observedIndexedCount: count,
    observedUnindexedCount: count,
    observedUniqueUrlCount: count,
    indexedDuplicateCount: count,
    unindexedDuplicateCount: count,
    conflictingUrlCount: count,
    reportedSlotGap: count,
    indexedEnumerationGap: count.nullable(),
  }),
});
const donorComparisonSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('compared'),
    newlyReportedTargetUrls: z.array(submittedUrlSchema),
    noLongerReportedTargetUrls: z.array(submittedUrlSchema),
    attributeChangedTargetUrls: z.array(submittedUrlSchema),
    unchangedTargetUrls: z.array(submittedUrlSchema),
  }),
  z.strictObject({ state: z.literal('unknown') }),
]);
const backlinkRowSchema = z.strictObject({
  donorUrl: submittedUrlSchema,
  before: donorSideSchema,
  after: donorSideSchema,
  comparison: donorComparisonSchema,
});
type BacklinkRow = z.infer<typeof backlinkRowSchema>;
const backlinkSummarySchema = z.strictObject({
  status: statusSchema,
  report: z.strictObject({
    size: count,
    processedCount: count,
    isCompleted: z.boolean().nullable(),
    lastPage: count.max(14),
    pagesVisited: count.min(1).max(15),
  }),
  coverage: z.strictObject({
    rawDonorCount: count.max(1_500),
    observedUniqueDonorCount: count.max(1_500),
    duplicateDonorCount: count,
    conflictingDonorCount: count,
    rawTargetLinkCount: count.max(10_000),
    duplicateTargetLinkCount: count,
    reportedSlotGap: count,
  }),
});
const scope = {
  basis: 'observed_union',
  direction: 'caller_selected',
  observations: 'non_atomic_provider_reports',
  originalCorpusEquality: 'unknown',
  originalHistory: 'unknown',
  liveState: 'not_observed',
} as const;
const scopeSchema = z.strictObject({
  basis: z.literal(scope.basis),
  direction: z.literal(scope.direction),
  observations: z.literal(scope.observations),
  originalCorpusEquality: z.literal(scope.originalCorpusEquality),
  originalHistory: z.literal(scope.originalHistory),
  liveState: z.literal(scope.liveState),
});
const linksResultSchema = z.strictObject({
  status: z.literal('compared'),
  reportKind: z.literal('links'),
  family: genericFamily,
  beforeTaskId: providerTaskIdSchema,
  afterTaskId: providerTaskIdSchema,
  scope: scopeSchema,
  before: linksSummarySchema,
  after: linksSummarySchema,
  rows: z.array(genericRowSchema).max(20_000),
  counts: z.strictObject({
    reportedUnindexedToIndexed: count,
    reportedIndexedToUnindexed: count,
    unchangedIndexed: count,
    unchangedUnindexed: count,
    unknown: count,
    total: count,
  }),
});
type LinksResult = z.infer<typeof linksResultSchema>;
const backlinkResultSchema = z.strictObject({
  status: z.literal('compared'),
  reportKind: z.literal('backlink'),
  family: z.literal('backlink/checker'),
  beforeTaskId: providerTaskIdSchema,
  afterTaskId: providerTaskIdSchema,
  scope: scopeSchema,
  targetScope: z.strictObject({
    provenance: z.literal('matching_current_provider_status'),
    targetDomains: targets,
    originalTargets: z.literal('unknown'),
  }),
  before: backlinkSummarySchema,
  after: backlinkSummarySchema,
  rows: z.array(backlinkRowSchema).max(3_000),
  counts: z.strictObject({
    comparedDonors: count,
    unknownDonors: count,
    totalDonors: count,
    newlyReportedTargetUrls: count,
    noLongerReportedTargetUrls: count,
    attributeChangedTargetUrls: count,
    unchangedTargetUrls: count,
  }),
});
type BacklinkResult = z.infer<typeof backlinkResultSchema>;
const blockedSchema = z.strictObject({
  status: z.literal('blocked'),
  blocker: z.strictObject({
    code: compareReportsBlockerCodeSchema,
    message: text,
  }),
  cleanup: z.literal('failed').optional(),
});
const errorSchema = z.strictObject({
  status: z.literal('error'),
  error: z.strictObject({
    code: compareReportsErrorCodeSchema,
    message: text,
    phase: phaseSchema.optional(),
    cause: causeSchema.optional(),
  }),
  cleanup: z.literal('failed').optional(),
});

function settled(status: CompareStatusProjection, report: ReportMetadata) {
  const unfinished = (v: CompareStatusProjection | ReportMetadata) =>
    v.awaitingResult === true ||
    (v.days !== null && v.daysPassed !== null && v.daysPassed < v.days) ||
    (v.dripFeed === true && (v.days === null || v.daysPassed === null));
  return (
    status.isCompleted === true &&
    report.isCompleted !== false &&
    report.processedCount === report.size &&
    !unfinished(status) &&
    !unfinished(report)
  );
}
function sideFor(membership: Membership, isSettled: boolean): GenericSide {
  if (membership === 'omitted')
    return { state: 'unknown', membership, reason: 'not_reported' };
  if (membership === 'both')
    return { state: 'unknown', membership, reason: 'conflicting_partitions' };
  if (!isSettled)
    return { state: 'unknown', membership, reason: 'processing_unsettled' };
  return membership === 'indexed'
    ? { state: 'indexed', membership: 'indexed' }
    : { state: 'unindexed', membership: 'unindexed' };
}
function changeFor(
  before: GenericSide,
  after: GenericSide,
): GenericRow['change'] {
  if (before.state === 'unknown' || after.state === 'unknown') return 'unknown';
  if (before.state === after.state)
    return before.state === 'indexed'
      ? 'unchanged_indexed'
      : 'unchanged_unindexed';
  return before.state === 'indexed'
    ? 'reported_indexed_to_unindexed'
    : 'reported_unindexed_to_indexed';
}
function selectedCount<T>(
  rows: readonly T[],
  predicate: (row: T) => boolean,
  work?: Work,
) {
  const selected = work?.measurements
    ? work.measurements.privateFilter(rows, predicate, work.checkpoint)
    : rows.filter(predicate);
  work?.(selected);
  return selected.length;
}
function linkCounts(
  rows: readonly GenericRow[],
  work?: Work,
): LinksResult['counts'] {
  const counts = {};
  const observe = scopeWork(work, () => [counts]);
  const c1 = Object.assign(counts, {
    reportedUnindexedToIndexed: selectedCount(
      rows,
      (r) => r.change === 'reported_unindexed_to_indexed',
      observe,
    ),
  });
  const c2 = Object.assign(c1, {
    reportedIndexedToUnindexed: selectedCount(
      rows,
      (r) => r.change === 'reported_indexed_to_unindexed',
      observe,
    ),
  });
  const c3 = Object.assign(c2, {
    unchangedIndexed: selectedCount(
      rows,
      (r) => r.change === 'unchanged_indexed',
      observe,
    ),
  });
  const c4 = Object.assign(c3, {
    unchangedUnindexed: selectedCount(
      rows,
      (r) => r.change === 'unchanged_unindexed',
      observe,
    ),
  });
  const c5 = Object.assign(c4, {
    unknown: selectedCount(rows, (r) => r.change === 'unknown', observe),
  });
  return Object.assign(c5, { total: rows.length });
}
function donorComparison(
  before: DonorSide,
  after: DonorSide,
  work?: Work,
): BacklinkRow['comparison'] {
  if (before.state !== 'reported' || after.state !== 'reported')
    return { state: 'unknown' };
  const attributes = (links: TargetLink[], parent?: Work) => {
    const map = new Map<string, Set<string>>();
    for (const link of links) {
      const values = map.get(link.url) ?? new Set<string>();
      {
        const tuple = [link.anchor, link.nofollow];
        const key = JSON.stringify(tuple);
        parent?.(map, values, tuple, key);
        values.add(key);
      }
      map.set(link.url, values);
      parent?.(map, values);
    }
    return map;
  };
  const b = attributes(before.targetLinks, work),
    a = attributes(
      after.targetLinks,
      scopeWork(work, () => [b]),
    );
  const result: Extract<BacklinkRow['comparison'], { state: 'compared' }> = {
    state: 'compared',
    newlyReportedTargetUrls: [],
    noLongerReportedTargetUrls: [],
    attributeChangedTargetUrls: [],
    unchangedTargetUrls: [],
  };
  const roots = scopeWork(work, () => [b, a, result]);
  {
    const union = unique(
      joined(
        () => b.keys(),
        () => a.keys(),
        roots,
      ),
      roots,
    );
    const loop = scopeWork(roots, () => [union]);
    for (const url of union) {
      loop?.();
      if (!b.has(url)) result.newlyReportedTargetUrls.push(url);
      else if (!a.has(url)) result.noLongerReportedTargetUrls.push(url);
      else if (same([...b.get(url)!].sort(), [...a.get(url)!].sort(), loop))
        result.unchangedTargetUrls.push(url);
      else result.attributeChangedTargetUrls.push(url);
      loop?.();
    }
  }
  roots?.();
  return result;
}
function backlinkCounts(
  rows: readonly BacklinkRow[],
  work?: Work,
): BacklinkResult['counts'] {
  const result = {
    comparedDonors: 0,
    unknownDonors: 0,
    totalDonors: rows.length,
    newlyReportedTargetUrls: 0,
    noLongerReportedTargetUrls: 0,
    attributeChangedTargetUrls: 0,
    unchangedTargetUrls: 0,
  };
  for (const row of rows) {
    work?.(result);
    if (row.comparison.state === 'unknown') result.unknownDonors++;
    else {
      result.comparedDonors++;
      for (const key of [
        'newlyReportedTargetUrls',
        'noLongerReportedTargetUrls',
        'attributeChangedTargetUrls',
        'unchangedTargetUrls',
      ] as const)
        result[key] += row.comparison[key].length;
    }
  }
  work?.(result);
  return result;
}
function matchingCounters(
  status: CompareStatusProjection,
  report: {
    size: number;
    processedCount: number;
    indexedCount?: number | null;
  },
) {
  return (
    !numericContradiction(status) &&
    !numericContradiction(report) &&
    (status.size === null || status.size === report.size) &&
    (status.processedCount === null ||
      status.processedCount === report.processedCount) &&
    (status.indexedCount === null ||
      report.indexedCount == null ||
      status.indexedCount === report.indexedCount)
  );
}
function compatibleType(status: CompareStatusProjection, family: TaskFamily) {
  return status.type === null || status.type === family;
}
function linksSemantics(value: LinksResult, work?: Work) {
  if (!same(linkCounts(value.rows, work), value.counts, work)) return false;
  for (const key of ['before', 'after'] as const) {
    const s = value[key],
      c = s.coverage;
    const indexed = selectedCount(
      value.rows,
      (r) => r[key].membership === 'indexed' || r[key].membership === 'both',
      work,
    );
    const unindexed = selectedCount(
      value.rows,
      (r) => r[key].membership === 'unindexed' || r[key].membership === 'both',
      work,
    );
    const conflicts = selectedCount(
      value.rows,
      (r) => r[key].membership === 'both',
      work,
    );
    const observed = indexed + unindexed - conflicts;
    if (
      s.status.id !==
        value[key === 'before' ? 'beforeTaskId' : 'afterTaskId'] ||
      !compatibleType(s.status, value.family) ||
      s.report.type !== value.family ||
      !matchingCounters(s.status, s.report) ||
      s.settled !== settled(s.status, s.report) ||
      c.observedIndexedCount !== indexed ||
      c.observedUnindexedCount !== unindexed ||
      c.conflictingUrlCount !== conflicts ||
      c.observedUniqueUrlCount !== observed ||
      c.reportedSlotGap !== s.report.size - observed ||
      indexed > s.report.processedCount ||
      indexedTotalContradiction(
        s.report,
        s.report.indexedCount ?? s.status.indexedCount,
        indexed,
        unindexed - conflicts,
      ) ||
      (s.report.indexedCount !== null && s.report.indexedCount < indexed) ||
      (s.status.indexedCount !== null && s.status.indexedCount < indexed) ||
      c.indexedEnumerationGap !==
        ((s.report.indexedCount ?? s.status.indexedCount) === null
          ? null
          : (s.report.indexedCount ?? s.status.indexedCount)! - indexed) ||
      indexed +
        unindexed +
        c.indexedDuplicateCount +
        c.unindexedDuplicateCount >
        10_000
    )
      return false;
    for (const row of value.rows)
      if (!same(row[key], sideFor(row[key].membership, s.settled), work))
        return false;
  }
  return value.rows.every(
    (r) =>
      !(
        r.before.membership === 'omitted' && r.after.membership === 'omitted'
      ) && r.change === changeFor(r.before, r.after),
  );
}
function backlinkSemantics(value: BacklinkResult, work?: Work) {
  if (!same(value.counts, backlinkCounts(value.rows, work), work)) return false;
  for (const key of ['before', 'after'] as const) {
    const s = value[key],
      c = s.coverage;
    const present = work?.measurements
      ? work.measurements.privateFilter(
          value.rows,
          (r) =>
            !(r[key].state === 'unknown' && r[key].reason === 'not_reported'),
          work.checkpoint,
        )
      : value.rows.filter(
          (r) =>
            !(r[key].state === 'unknown' && r[key].reason === 'not_reported'),
        );
    const presentWork = scopeWork(work, () => [present]);
    presentWork?.();
    const conflicts = selectedCount(
      present,
      (r) =>
        r[key].state === 'unknown' &&
        r[key].reason === 'conflicting_donor_rows',
      presentWork,
    );
    const links = present.reduce(
      (n, r) =>
        n + (r[key].state === 'reported' ? r[key].targetLinks.length : 0),
      0,
    );
    const processedLowerBound = selectedCount(
      present,
      (r) => {
        const side = r[key];
        return (
          side.state === 'reported' ||
          side.reason === 'target_links_unavailable' ||
          side.reason === 'invalid_target_link'
        );
      },
      presentWork,
    );
    if (
      s.status.id !==
        value[key === 'before' ? 'beforeTaskId' : 'afterTaskId'] ||
      !compatibleType(s.status, value.family) ||
      !same(
        s.status.targetDomains,
        value.targetScope.targetDomains,
        presentWork,
      ) ||
      !matchingCounters(s.status, s.report) ||
      (s.status.isCompleted !== null &&
        s.report.isCompleted !== null &&
        s.status.isCompleted !== s.report.isCompleted) ||
      s.report.pagesVisited !== s.report.lastPage + 1 ||
      c.rawDonorCount > s.report.pagesVisited * 100 ||
      c.observedUniqueDonorCount !== present.length ||
      c.conflictingDonorCount !== conflicts ||
      c.conflictingDonorCount > c.duplicateDonorCount ||
      c.duplicateDonorCount !== c.rawDonorCount - present.length ||
      c.rawTargetLinkCount > c.rawDonorCount * 1_000 ||
      c.reportedSlotGap !== s.report.size - present.length ||
      processedLowerBound > s.report.processedCount ||
      links + c.duplicateTargetLinkCount > c.rawTargetLinkCount
    )
      return false;
  }
  return value.rows.every((row) => {
    for (const side of [row.before, row.after]) {
      work?.(side);
      if (side.state === 'reported') {
        const keys = side.targetLinks.map((link) => tupleKey(link, work));
        const seen = new Set(keys);
        work?.(keys, seen);
        if (seen.size !== side.targetLinks.length) return false;
      }
    }
    return (
      !(
        row.before.state === 'unknown' &&
        row.before.reason === 'not_reported' &&
        row.after.state === 'unknown' &&
        row.after.reason === 'not_reported'
      ) &&
      same(row.comparison, donorComparison(row.before, row.after, work), work)
    );
  });
}

/** Closed structure plus derived partition/count checks, including application errors. */
const resultShape = z.union([
  linksResultSchema,
  backlinkResultSchema,
  blockedSchema,
  errorSchema,
]);
function resultSchema(work?: Work) {
  return resultShape.superRefine((value, context) => {
    // Closed Zod structural output, once per actual fresh allocation. Read-only
    // proof lasts through the original semantic checks and recursive completion.
    work?.measurements?.privateRead(value, work.checkpoint);
    const validating = scopeWork(work, () => [value]);
    validating?.();
    let valid: boolean;
    if (value.status === 'blocked')
      valid = value.blocker.message === blockerMessages[value.blocker.code];
    else if (value.status === 'error') {
      valid =
        value.error.message === errorMessages[value.error.code] &&
        (value.error.code === 'ReadFailed' ||
          (!Object.hasOwn(value.error, 'phase') &&
            !Object.hasOwn(value.error, 'cause'))) &&
        (!Object.hasOwn(value.error, 'phase') ||
          value.error.phase !== undefined) &&
        (!Object.hasOwn(value.error, 'cause') ||
          value.error.cause !== undefined);
    } else {
      const idWriter = work?.measurements?.array<string>();
      const ids = idWriter
        ? (() => {
            if (value.reportKind === 'links') {
              for (const row of value.rows) idWriter.append(row.url);
            } else {
              for (const row of value.rows) idWriter.append(row.donorUrl);
            }
            idWriter.seal();
            return idWriter.value;
          })()
        : value.reportKind === 'links'
          ? value.rows.map((r) => r.url)
          : value.rows.map((r) => r.donorUrl);
      const identity = scopeWork(validating, () => [ids]);
      const distinct = (() => {
        const seenWriter = work?.measurements?.set<string>();
        const seen = seenWriter?.value ?? new Set(ids);
        if (seenWriter) {
          for (const id of ids) seenWriter.add(id);
          seenWriter.seal();
        }
        identity?.(seen);
        return seen.size === ids.length;
      })();
      valid =
        value.beforeTaskId !== value.afterTaskId &&
        distinct &&
        (value.reportKind === 'links'
          ? linksSemantics(value, identity)
          : backlinkSemantics(value, identity));
    }
    if ('cleanup' in value && value.cleanup === undefined) valid = false;
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent report-comparison result.',
      });
  });
}
export const compareReportsResultSchema = resultSchema();
export type CompareReportsResult = z.infer<typeof compareReportsResultSchema>;

export function compareReportsBlocked(
  code: BlockerCode,
  cleanup?: 'failed',
): CompareReportsResult {
  return freeze(
    compareReportsResultSchema.parse({
      status: 'blocked',
      blocker: { code, message: blockerMessages[code] },
      ...(cleanup === undefined ? {} : { cleanup }),
    }),
  );
}
export function compareReportsError(
  code: ErrorCode,
  details: FailureDetails = {},
): CompareReportsResult {
  const { cleanup, ...errorDetails } = details;
  return freeze(
    compareReportsResultSchema.parse({
      status: 'error',
      error: { code, message: errorMessages[code], ...errorDetails },
      ...(cleanup === undefined ? {} : { cleanup }),
    }),
  );
}
export function compareReportsFailure(error: unknown): CompareReportsResult {
  if (!(error instanceof CompareReportsFault))
    return compareReportsError('InternalError');
  const blocked = compareReportsBlockerCodeSchema.safeParse(error.code);
  return blocked.success
    ? compareReportsBlocked(blocked.data)
    : compareReportsError(compareReportsErrorCodeSchema.parse(error.code));
}

function linksSummary(
  status: CompareStatusProjection,
  report: CompareLinksProjection,
  work?: Work,
) {
  const unindexed = new Set(report.unindexedLinks);
  const roots = scopeWork(work, () => [unindexed]);
  const conflicts = selectedCount(
    report.indexedLinks,
    (url) => unindexed.has(url),
    roots,
  );
  const observed =
    report.indexedLinks.length + report.unindexedLinks.length - conflicts;
  const indexedCount = report.metadata.indexedCount ?? status.indexedCount;
  const summary = {
    status,
    report: report.metadata,
    settled: settled(status, report.metadata),
    coverage: {
      observedIndexedCount: report.indexedLinks.length,
      observedUnindexedCount: report.unindexedLinks.length,
      observedUniqueUrlCount: observed,
      indexedDuplicateCount: report.indexedDuplicateCount,
      unindexedDuplicateCount: report.unindexedDuplicateCount,
      conflictingUrlCount: conflicts,
      reportedSlotGap: report.metadata.size - observed,
      indexedEnumerationGap:
        indexedCount === null
          ? null
          : indexedCount - report.indexedLinks.length,
    },
  };
  roots?.(summary);
  return summary;
}
function compareLinks(
  input: CompareReportsInput,
  before: CompareSideEvidence,
  after: CompareSideEvidence,
  checkpoint: Checkpoint,
  work?: Work,
): LinksResult {
  const read = (side: CompareSideEvidence, parent?: Work) => {
    if (side.reports.length !== 1) return refuse('ConflictingEvidence');
    parent?.(side.reports[0], side.reports[0]);
    const parsed = linksProjectionSchema.safeParse(side.reports[0]);
    if (!parsed.success) return refuse('ConflictingEvidence');
    const p = parsed.data;
    const roots = scopeWork(parent, () => [parsed]);
    roots?.();
    if (p.family !== input.family || p.metadata.type !== input.family)
      return refuse('IncompatibleTaskType');
    if (
      p.taskId !== side.status.id ||
      !matchingCounters(side.status, p.metadata)
    )
      return refuse('ConflictingEvidence');
    const size = (values: readonly string[]) => {
      const set = new Set(values);
      roots?.(set);
      return set.size;
    };
    if (
      indexedTotalContradiction(
        p.metadata,
        p.metadata.indexedCount ?? side.status.indexedCount,
        p.indexedLinks.length,
        size(unique([...p.indexedLinks, ...p.unindexedLinks], roots)) -
          p.indexedLinks.length,
      ) ||
      size(p.indexedLinks) !== p.indexedLinks.length ||
      size(p.unindexedLinks) !== p.unindexedLinks.length
    )
      return refuse('ConflictingEvidence');
    return closeOwned(p, roots);
  };
  const b = read(before, work),
    a = read(
      after,
      scopeWork(work, () => [b]),
    );
  const reports = scopeWork(work, () => [b, a]);
  const bs = linksSummary(before.status, b, reports),
    as = linksSummary(
      after.status,
      a,
      scopeWork(reports, () => [bs]),
    );
  const summaries = scopeWork(reports, () => [bs, as]);
  closeOwned(bs, summaries);
  closeOwned(as, summaries);
  const membership = (p: CompareLinksProjection, parent?: Work) => {
    const map = new Map<string, Membership>();
    for (const url of p.indexedLinks) {
      checkpoint();
      map.set(url, 'indexed');
      parent?.(map);
    }
    for (const url of p.unindexedLinks) {
      checkpoint();
      map.set(url, map.has(url) ? 'both' : 'unindexed');
      parent?.(map);
    }
    return map;
  };
  const bm = membership(b, summaries),
    am = membership(
      a,
      scopeWork(summaries, () => [bm]),
    );
  const maps = scopeWork(summaries, () => [bm, am]);
  const rows: GenericRow[] = [];
  {
    const union = unique([...bm.keys(), ...am.keys()], maps);
    const loop = scopeWork(maps, () => [union, rows]);
    for (const url of union) {
      checkpoint();
      const before = sideFor(bm.get(url) ?? 'omitted', bs.settled),
        after = sideFor(am.get(url) ?? 'omitted', as.settled);
      const row = { url, before, after, change: changeFor(before, after) };
      loop?.(before, after, row);
      closeOwned(
        row,
        scopeWork(loop, () => [before, after, row]),
      );
      rows.push(row);
    }
  }
  closeOwned(
    rows,
    scopeWork(maps, () => [rows]),
  );
  const draft = {
    status: 'compared' as const,
    reportKind: 'links' as const,
    family: genericFamily.parse(input.family),
    beforeTaskId: input.beforeTaskId,
    afterTaskId: input.afterTaskId,
    scope: { ...scope },
    before: bs,
    after: as,
    rows,
  };
  const result = Object.assign(draft, {
    counts: linkCounts(
      rows,
      scopeWork(maps, () => [rows, draft]),
    ),
  });
  maps?.(rows, result);
  return closeOwned(
    result,
    scopeWork(maps, () => [rows, result]),
  );
}
function compareBacklinks(
  input: CompareReportsInput,
  before: CompareSideEvidence,
  after: CompareSideEvidence,
  checkpoint: Checkpoint,
  work?: Work,
): BacklinkResult {
  if (!before.status.targetDomains || !after.status.targetDomains)
    return refuse('TargetScopeUnavailable');
  if (!same(before.status.targetDomains, after.status.targetDomains, work))
    return refuse('IncompatibleTargetScope');
  const read = (side: CompareSideEvidence, parent?: Work) => {
    if (side.reports.length === 0 || side.reports.length > 15)
      return refuse('ConflictingEvidence');
    const pageWriter = parent?.measurements?.array<CompareBacklinkProjection>();
    const pages: CompareBacklinkProjection[] = pageWriter?.value ?? [];
    for (const value of side.reports) {
      checkpoint();
      parent?.(pages, value, value);
      const parsed = backlinkProjectionSchema.safeParse(value);
      if (!parsed.success) return refuse('ConflictingEvidence');
      parent?.measurements?.privateRead(parsed.data, parent.checkpoint);
      parent?.(pages, parsed);
      closeOwned(
        parsed.data,
        scopeWork(parent, () => [pages, parsed]),
      );
      if (pageWriter) pageWriter.append(parsed.data);
      else pages.push(parsed.data);
    }
    pageWriter?.seal();
    const first = pages[0]!;
    const roots = scopeWork(parent, () => [pages]);
    const header = (p: CompareBacklinkProjection) => [
      p.taskId,
      p.size,
      p.processedCount,
      p.isCompleted,
      p.lastPage,
    ];
    if (
      first.taskId !== side.status.id ||
      pages.length !== first.lastPage + 1 ||
      pages.some(
        (p, i) => p.page !== i || !same(header(p), header(first), roots),
      ) ||
      !matchingCounters(side.status, first) ||
      (side.status.isCompleted !== null &&
        first.isCompleted !== null &&
        side.status.isCompleted !== first.isCompleted)
    )
      return refuse('ConflictingEvidence');
    const donorWriter = parent?.measurements?.map<DonorSide>();
    const witnessWriter = parent?.measurements?.set<string>();
    const donors = donorWriter?.value ?? new Map<string, DonorSide>(),
      processedWitnesses = witnessWriter?.value ?? new Set<string>();
    const indexed = scopeWork(roots, () => [donors, processedWitnesses]);
    let rawDonorCount = 0,
      rawTargetLinkCount = 0,
      duplicateTargetLinkCount = 0;
    const canonical = (side: DonorSide, parent?: Work) => {
      if (side.state === 'unknown') return side;
      const mappedWriter = parent?.measurements?.array<string>();
      const mapped: string[] = mappedWriter?.value ?? [];
      for (const link of side.targetLinks) {
        const key = tupleKey(
          link,
          scopeWork(parent, () => [mapped]),
        );
        if (mappedWriter) mappedWriter.append(key);
        else mapped.push(key);
      }
      mappedWriter?.seal();
      const spread = [...mapped];
      parent?.(mapped, spread);
      const sorted = spread.sort();
      return sorted;
    };
    for (const page of pages) {
      rawDonorCount += page.donors.length;
      rawTargetLinkCount += page.rawTargetLinkCount;
      duplicateTargetLinkCount += page.duplicateTargetLinkCount;
      for (const donor of page.donors) {
        checkpoint();
        if (donor.processedWitness) {
          if (witnessWriter) witnessWriter.add(donor.donorUrl);
          else processedWitnesses.add(donor.donorUrl);
        }
        const previous = donors.get(donor.donorUrl);
        let equal = false;
        if (previous) {
          const old = canonical(previous, indexed),
            current = canonical(
              donor.evidence,
              scopeWork(indexed, () => [old]),
            );
          equal = same(old, current, indexed);
        }
        const selected: DonorSide =
          !previous || equal
            ? (previous ?? donor.evidence)
            : { state: 'unknown', reason: 'conflicting_donor_rows' };
        if (donorWriter) donorWriter.put(donor.donorUrl, selected);
        else donors.set(donor.donorUrl, selected);
        indexed?.();
      }
    }
    donorWriter?.seal();
    witnessWriter?.seal();
    if (rawDonorCount > 1_500 || rawTargetLinkCount > 10_000)
      return refuse('ResourceLimitExceeded');
    if (
      donors.size > first.size ||
      processedWitnesses.size > first.processedCount
    )
      return refuse('ConflictingEvidence');
    const summary = {
      status: side.status,
      report: {
        size: first.size,
        processedCount: first.processedCount,
        isCompleted: first.isCompleted,
        lastPage: first.lastPage,
        pagesVisited: pages.length,
      },
    };
    const coverage = {
      rawDonorCount,
      observedUniqueDonorCount: donors.size,
      duplicateDonorCount: rawDonorCount - donors.size,
    };
    const conflictingDonorCount = selectedCount(
      arrayFrom(donors.values(), indexed),
      (s) => s.state === 'unknown' && s.reason === 'conflicting_donor_rows',
      scopeWork(indexed, () => [summary, coverage]),
    );
    const result = {
      donors,
      summary: Object.assign(summary, {
        coverage: Object.assign(coverage, {
          conflictingDonorCount,
          rawTargetLinkCount,
          duplicateTargetLinkCount,
          reportedSlotGap: first.size - donors.size,
        }),
      }),
    };
    indexed?.(result);
    closeOwned(
      result.summary,
      scopeWork(indexed, () => [result]),
    );
    return result;
  };
  const b = read(before, work),
    a = read(
      after,
      scopeWork(work, () => [b]),
    );
  const outer = scopeWork(work, () => [b, a]);
  const missing: DonorSide = { state: 'unknown', reason: 'not_reported' };
  closeOwned(
    missing,
    scopeWork(outer, () => [missing]),
  );
  const rowWriter = work?.measurements?.array<BacklinkRow>();
  const rows: BacklinkRow[] = rowWriter?.value ?? [];
  {
    const union = unique(
      joined(
        () => b.donors.keys(),
        () => a.donors.keys(),
        outer,
      ),
      outer,
    );
    const loop = scopeWork(outer, () => [union, rows]);
    for (const donorUrl of union) {
      checkpoint();
      const before = b.donors.get(donorUrl) ?? missing,
        after = a.donors.get(donorUrl) ?? missing;
      const partial = { donorUrl, before, after };
      const row = Object.assign(partial, {
        comparison: donorComparison(
          before,
          after,
          scopeWork(loop, () => [partial]),
        ),
      });
      loop?.(row);
      closeOwned(
        row,
        scopeWork(loop, () => [row]),
      );
      if (rowWriter) rowWriter.append(row);
      else rows.push(row);
    }
  }
  rowWriter?.seal();
  closeOwned(
    rows,
    scopeWork(outer, () => [rows]),
  );
  const draft = {
    status: 'compared' as const,
    reportKind: 'backlink' as const,
    family: 'backlink/checker' as const,
    beforeTaskId: input.beforeTaskId,
    afterTaskId: input.afterTaskId,
    scope: { ...scope },
    targetScope: {
      provenance: 'matching_current_provider_status' as const,
      targetDomains: [...before.status.targetDomains],
      originalTargets: 'unknown' as const,
    },
    before: b.summary,
    after: a.summary,
    rows,
  };
  const result = Object.assign(draft, {
    counts: backlinkCounts(
      rows,
      scopeWork(outer, () => [rows, draft]),
    ),
  });
  outer?.(rows, result);
  return closeOwned(
    result,
    scopeWork(outer, () => [rows, result]),
  );
}
/** Consume copied leaf evidence; callers still owe collection/coherence/owner gates. */
export function compareProjectedReports(
  input: unknown,
  before: CompareSideEvidence,
  after: CompareSideEvidence,
  checkpoint: Checkpoint = noCheckpoint,
  observeWork?: CompareWorkRootsObserver,
  measurements?: ComparePrivateMeasurements,
): CompareReportsResult {
  const parsed = compareReportsInputSchema.safeParse(input);
  if (!parsed.success) return compareReportsError('InvalidInput');
  let checkpointFailed = false;
  const check = () => {
    try {
      checkpoint();
    } catch (error) {
      checkpointFailed = true;
      throw error;
    }
  };
  const work = observingWork(
    check,
    observeWork,
    () => {
      checkpointFailed = true;
    },
    measurements,
  );
  try {
    check();
    work?.(before, after, parsed, before.status, after.status);
    const b = statusSchema.safeParse(before.status),
      a = statusSchema.safeParse(after.status);
    const caller = scopeWork(work, () => [before, after, parsed, b, a]);
    caller?.();
    if (!b.success || !a.success) return refuse('ConflictingEvidence');
    if (
      b.data.id !== parsed.data.beforeTaskId ||
      a.data.id !== parsed.data.afterTaskId
    )
      return refuse('ConflictingEvidence');
    if (
      !compatibleType(b.data, parsed.data.family) ||
      !compatibleType(a.data, parsed.data.family)
    )
      return refuse('IncompatibleTaskType');
    closeOwned(b.data, caller);
    closeOwned(a.data, caller);
    const value = (() => {
      const helperBefore = { status: b.data, reports: before.reports },
        helperAfter = { status: a.data, reports: after.reports };
      const helper = scopeWork(caller, () => [helperBefore, helperAfter]);
      return parsed.data.family === 'backlink/checker'
        ? compareBacklinks(
            parsed.data,
            helperBefore,
            helperAfter,
            check,
            helper,
          )
        : compareLinks(parsed.data, helperBefore, helperAfter, check, helper);
    })();
    check();
    const validation = scopeWork(caller, () => [value]);
    validation?.(value);
    const result = resultSchema(validation).safeParse(value);
    if (!result.success) return refuse('ConflictingEvidence');
    const resultWork = scopeWork(validation, () => [result]);
    resultWork?.();
    const frozen = freeze(result.data, resultWork);
    check();
    return frozen;
  } catch (error) {
    if (checkpointFailed) throw error;
    return compareReportsFailure(error);
  }
}

export const compareReportsEnvelopeSchema = z
  .strictObject({
    isError: z.boolean(),
    content: z
      .array(z.strictObject({ type: z.literal('text'), text: z.string() }))
      .length(1),
    structuredContent: compareReportsResultSchema,
  })
  .superRefine((value, context) => {
    if (
      value.isError !== (value.structuredContent.status === 'error') ||
      value.content[0]!.text !== JSON.stringify(value.structuredContent)
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent report-comparison envelope.',
      });
  });
const productionBytes = 2_097_152;
function envelope(
  value: CompareReportsResult,
  work?: Work,
  privatelyCompleted?: WeakSet<object>,
) {
  const result = {
    isError: value.status === 'error',
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
  const roots = scopeWork(work, () => [result]);
  roots?.();
  return freeze(
    result,
    roots,
    [],
    privatelyCompleted,
    privatelyCompleted === undefined,
  );
}
export type CompareReportsToolResult = ReturnType<typeof envelope>;
const fallbacks = {
  InternalError: envelope(compareReportsError('InternalError')),
  ResourceLimitExceeded: envelope(compareReportsError('ResourceLimitExceeded')),
};
/** Trusted lower-only seam, never a public input field. Both fixed fallbacks must fit. */
export function lowerCompareReportsResultByteLimit(lower?: number) {
  const minimum = Math.max(
    ...Object.values(fallbacks).map((v) =>
      Buffer.byteLength(JSON.stringify(v), 'utf8'),
    ),
  );
  const limit = lower ?? productionBytes;
  if (
    !Number.isSafeInteger(limit) ||
    limit < minimum ||
    limit > productionBytes
  )
    throw new RangeError('Invalid report-comparison result limit.');
  return limit;
}
/** Deep copy/validate/freeze and measure the full escaped, duplicated application envelope. */
export function compareReportsToolResult(
  value: unknown,
  construction: {
    maxBytes?: number;
    checkpoint?: Checkpoint;
    observeWork?: CompareWorkRootsObserver;
    measurements?: ComparePrivateMeasurements;
  } = {},
): CompareReportsToolResult {
  const maxBytes = lowerCompareReportsResultByteLimit(construction.maxBytes);
  const checkpoint = construction.checkpoint ?? noCheckpoint;
  let checkpointFailed = false;
  const check = () => {
    try {
      checkpoint();
    } catch (error) {
      checkpointFailed = true;
      throw error;
    }
  };
  const observeWork = construction.observeWork;
  const measurements = construction.measurements;
  const work = observingWork(
    check,
    observeWork,
    () => {
      checkpointFailed = true;
    },
    measurements,
  );
  const original = scopeWork(work, () => [value]);
  check();
  try {
    original?.(value);
    const parsed = resultSchema(original).safeParse(value);
    if (!parsed.success) return fallbacks.InternalError;
    check();
    const roots = scopeWork(original, () => [parsed]);
    roots?.();
    const privatelyCompleted = new WeakSet<object>();
    freeze(parsed.data, roots, [], privatelyCompleted);
    const result = envelope(parsed.data, roots, privatelyCompleted);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    check();
    return bytes <= maxBytes ? result : fallbacks.ResourceLimitExceeded;
  } catch (error) {
    if (checkpointFailed) throw error;
    return fallbacks.InternalError;
  }
}
