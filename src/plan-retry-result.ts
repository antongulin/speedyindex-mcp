/** Pure public comparison data. Validation never authenticates evidence or grants authority. */
import { z } from 'zod';
import {
  buildCreateIndexingRequest,
  indexingRequestSchema,
  indexingQuoteSchema,
} from './create-indexing-task';
import {
  compareRetryReferences,
  type RetryBlocker,
  type RetryPlanInput,
} from './plan-retry';
import { freezeSnapshot } from './retry-ledger-snapshot';
import {
  digestSchema,
  providerTaskIdSchema,
  safeNonnegativeInteger,
  submissionAuthorizationSchema,
  submissionLimits,
  submissionUnitVectorSchema,
  submittedUrlSchema,
} from './submission-contract';
import { computeRetryPlanFingerprint } from './submission-ledger';

const searchEngineSchema = z.enum(['google', 'yandex']);
const familySchema = z.enum(['google/indexer', 'yandex/indexer']);
const referenceSchema = z.tuple([familySchema, providerTaskIdSchema]);
const phaseSchema = z.enum(['list', 'status', 'report', 'fence']);
const causeSchema = z.enum([
  'http',
  'provider',
  'response',
  'network',
  'timeout',
]);
const errorCodeSchema = z.enum([
  'InvalidInput',
  'MissingCredentials',
  'SubmissionBusy',
  'Cancelled',
  'DeadlineExceeded',
  'ReadFailed',
  'ResourceLimitExceeded',
  'InternalError',
]);
const errorMessages = Object.freeze({
  InvalidInput: 'Invalid retry-plan input.',
  MissingCredentials: 'Retry planning requires configured credentials.',
  SubmissionBusy: 'Another submission or retry plan is in progress.',
  Cancelled: 'Retry planning was cancelled.',
  DeadlineExceeded: 'Retry planning exceeded its observation deadline.',
  ReadFailed: 'A required provider read failed.',
  ResourceLimitExceeded: 'Retry planning exceeded a resource limit.',
  InternalError: 'Retry planning failed internally.',
} as const);
const blockerCodeSchema = z.enum([
  'UnprovenLatest',
  'AmbiguousLatest',
  'ConflictingEvidence',
  'IncompleteScan',
  'SourceReportIncomplete',
  'SourceManifestConflict',
  'UnattributedParentPermissionRequired',
  'ActiveCoverageUnknown',
  'PriorRetryEvidenceUnknown',
  'AmbiguousLocalReference',
  'UnknownRetryDispatch',
  'RetryPolicyRequired',
  'WritesDisabled',
  'SnapshotConflict',
  'StateUnavailable',
  'UpgradeRequired',
  'SnapshotLimitExceeded',
  'RetryAllowanceExceeded',
  'BudgetExceeded',
  'StalePeriodContext',
  'NoCandidates',
]);
const blockerMessages = Object.freeze({
  UnprovenLatest:
    'A latest completed source could not be established. Inspect the source evidence.',
  AmbiguousLatest:
    'Latest-source chronology is ambiguous. Resolve the conflicting sources.',
  ConflictingEvidence:
    'Required observations conflict. Inspect the source evidence.',
  IncompleteScan:
    'The required provider scan is incomplete. Try again after resolving the read gap.',
  SourceReportIncomplete:
    'The selected source report is incomplete. Obtain complete source evidence.',
  SourceManifestConflict:
    'The source report conflicts with its manifest. Inspect the source and local history.',
  UnattributedParentPermissionRequired:
    'The source requires explicit private permission for unattributed parents.',
  ActiveCoverageUnknown:
    'An active task has no proven complete manifest. Resolve its coverage first.',
  PriorRetryEvidenceUnknown:
    'A prior retry has incomplete safety evidence. Resolve its outcome first.',
  AmbiguousLocalReference:
    'Local history maps this provider reference ambiguously. Inspect the local history.',
  UnknownRetryDispatch:
    'A retry dispatch has an unresolved outcome. Inspect it before planning more work.',
  RetryPolicyRequired:
    'Retry planning requires an enabled private retry policy.',
  WritesDisabled: 'Submissions are disabled by the operator policy.',
  SnapshotConflict:
    'Local state changed during planning. Start a new observation.',
  StateUnavailable:
    'Required local retry state or configuration is unavailable.',
  UpgradeRequired:
    'The selected state requires the supported V2 upgrade before planning.',
  SnapshotLimitExceeded:
    'The complete local snapshot exceeds its technical limit.',
  RetryAllowanceExceeded:
    'The source has exhausted its configured retry allowance.',
  BudgetExceeded:
    'The proposed reservation exceeds at least one configured unit cap.',
  StalePeriodContext:
    'The reservation period changed. Start a new observation.',
  NoCandidates:
    'No eligible unindexed URLs remain after the safety exclusions.',
} satisfies Record<RetryBlocker, string>);

function invalid(context: z.RefinementCtx) {
  context.addIssue({
    code: 'custom',
    message: 'Inconsistent retry-plan result.',
  });
}
function strictlyOrdered<T>(
  values: readonly T[],
  compare: (a: T, b: T) => number,
) {
  return values.every(
    (value, index) => index === 0 || compare(values[index - 1]!, value) < 0,
  );
}
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fixedErrorSchema<
  C extends Exclude<z.infer<typeof errorCodeSchema>, 'ReadFailed'>,
>(code: C) {
  return z.strictObject({
    code: z.literal(code),
    message: z.literal(errorMessages[code]),
    phase: phaseSchema.optional(),
  });
}
const errorSchema = z
  .discriminatedUnion('code', [
    fixedErrorSchema('InvalidInput'),
    fixedErrorSchema('MissingCredentials'),
    fixedErrorSchema('SubmissionBusy'),
    fixedErrorSchema('Cancelled'),
    fixedErrorSchema('DeadlineExceeded'),
    fixedErrorSchema('ResourceLimitExceeded'),
    fixedErrorSchema('InternalError'),
    z.strictObject({
      code: z.literal('ReadFailed'),
      message: z.literal(errorMessages.ReadFailed),
      phase: phaseSchema.optional(),
      cause: causeSchema.optional(),
    }),
  ])
  .superRefine((value, context) => {
    if (
      (Object.hasOwn(value, 'phase') && value.phase === undefined) ||
      ('cause' in value && value.cause === undefined)
    )
      invalid(context);
  });
const blockerSchema = z
  .strictObject({
    code: blockerCodeSchema,
    message: z.string(),
  })
  .superRefine((value, context) => {
    if (value.message !== blockerMessages[value.code]) invalid(context);
  });
const missingUrlsSchema = z
  .array(submittedUrlSchema)
  .max(submissionLimits.urls)
  .nullable();
const blockedFields = {
  unknownUrlCount: safeNonnegativeInteger.optional(),
  knownMissingLocalUrls: missingUrlsSchema.optional(),
};
const blockedSchema = z
  .strictObject({
    status: z.literal('blocked'),
    searchEngine: searchEngineSchema,
    blockers: z
      .array(blockerSchema)
      .min(1)
      .max(blockerCodeSchema.options.length),
    ...blockedFields,
  })
  .superRefine((value, context) => {
    if (
      !strictlyOrdered(
        value.blockers.map((b) => b.code),
        compareText,
      )
    )
      invalid(context);
    const hasUnknown = Object.hasOwn(value, 'unknownUrlCount');
    const hasMissing = Object.hasOwn(value, 'knownMissingLocalUrls');
    if (
      hasUnknown !== hasMissing ||
      (hasUnknown &&
        (!value.blockers.some((b) => b.code === 'SourceReportIncomplete') ||
          value.unknownUrlCount === undefined ||
          value.knownMissingLocalUrls === undefined))
    )
      invalid(context);
    if (
      value.knownMissingLocalUrls !== undefined &&
      value.knownMissingLocalUrls !== null &&
      (value.unknownUrlCount !== value.knownMissingLocalUrls.length ||
        new Set(value.knownMissingLocalUrls).size !==
          value.knownMissingLocalUrls.length)
    )
      invalid(context);
  });
const sourceFields = {
  reference: referenceSchema,
  manifestDigest: digestSchema,
};
const sourceSchema = z.discriminatedUnion('provenance', [
  z.strictObject({
    ...sourceFields,
    provenance: z.literal('local_standalone'),
    originalManifestKnown: z.literal(true),
    manifestProvenance: z.literal('durable_local_intent_ack'),
  }),
  z.strictObject({
    ...sourceFields,
    provenance: z.literal('legacy_unattributed'),
    originalManifestKnown: z.literal(true),
    manifestProvenance: z.literal('durable_local_intent_ack'),
  }),
  z.strictObject({
    ...sourceFields,
    provenance: z.literal('external_unattributed'),
    originalManifestKnown: z.literal(false),
    manifestProvenance: z.literal('provider_report_observed_corpus'),
  }),
]);
const periodSchema = submissionAuthorizationSchema.shape.period
  .unwrap()
  .superRefine((value, context) => {
    const day = 86_400_000;
    if (
      value.startMs % day !== 0 ||
      value.endMs - value.startMs !== day ||
      !Number.isFinite(new Date(value.startMs).getTime()) ||
      !Number.isFinite(new Date(value.endMs).getTime())
    ) {
      invalid(context);
      return;
    }
    if (
      value.id !==
      'utc-day:' + new Date(value.startMs).toISOString().split('T')[0]
    )
      invalid(context);
  });
const authorizationSchema = submissionAuthorizationSchema.safeExtend({
  state: z.literal('configured'),
  stateChecked: z.literal(true),
  mode: submissionAuthorizationSchema.shape.mode.unwrap(),
  policyRevision: submissionAuthorizationSchema.shape.policyRevision.unwrap(),
  policyDigest: digestSchema,
  budgetScope: submissionAuthorizationSchema.shape.budgetScope.unwrap(),
  caps: submissionUnitVectorSchema,
  period: periodSchema,
  fingerprint: digestSchema,
});
export const retryPlanPreimageSchema = z.strictObject({
  parent: z.strictObject({
    family: familySchema,
    taskId: providerTaskIdSchema,
  }),
  provenance: z.enum([
    'local_standalone',
    'legacy_unattributed',
    'external_unattributed',
  ]),
  originalManifestKnown: z.boolean(),
  manifestProvenance: z.enum([
    'durable_local_intent_ack',
    'provider_report_observed_corpus',
  ]),
  sourceManifestDigest: digestSchema,
  safetyEvidenceDigests: z.array(digestSchema).min(1).max(64),
  partitionDigest: digestSchema,
  revision: digestSchema,
  policyDigest: digestSchema,
  authorizationFingerprint: digestSchema,
  payloadDigest: digestSchema,
  quoteVersion: indexingQuoteSchema.shape.version,
  quoteFingerprint: digestSchema,
  period: periodSchema,
  providerRoute: indexingRequestSchema.shape.providerRoute,
  urlCount: indexingRequestSchema.shape.urlCount,
  providerBodyBytes: indexingRequestSchema.shape.providerBodyBytes,
  reservation: submissionUnitVectorSchema,
});
export const retryPlanComparisonSchema = z.strictObject({
  status: z.literal('comparison'),
  preimage: retryPlanPreimageSchema,
  fingerprint: digestSchema,
});
const reasonSchema = z.enum([
  'LocalUnresolvedHold',
  'ActiveIndexing',
  'ActiveDrip',
  'PriorRetryIndexed',
]);
// The collector bounds distinct roots at 2,000 and children at 4,000 across both passes.
const maxReferences = 2_000 + 4_000;
const excludedSchema = z.strictObject({
  url: submittedUrlSchema,
  reasons: z.array(reasonSchema).min(1).max(reasonSchema.options.length),
  references: z.array(referenceSchema).max(maxReferences),
});
const readySchema = z
  .strictObject({
    status: z.literal('ready'),
    searchEngine: searchEngineSchema,
    source: sourceSchema,
    eligibleUrls: z.array(submittedUrlSchema).min(1).max(submissionLimits.urls),
    excluded: z.array(excludedSchema).max(submissionLimits.urls),
    counts: z.strictObject({
      indexed: safeNonnegativeInteger,
      unindexed: safeNonnegativeInteger,
      eligible: safeNonnegativeInteger,
      excluded: safeNonnegativeInteger,
      unknown: z.literal(0),
    }),
    request: indexingRequestSchema,
    quote: indexingQuoteSchema,
    authorization: authorizationSchema,
    identity: retryPlanComparisonSchema,
  })
  .superRefine((value, context) => {
    try {
      const { source, counts, authorization: auth, identity } = value;
      if (source.reference[0] !== `${value.searchEngine}/indexer`)
        invalid(context);
      const urls = new Set(value.eligibleUrls);
      if (urls.size !== value.eligibleUrls.length) invalid(context);
      const references = new Set([JSON.stringify(source.reference)]);
      for (const entry of value.excluded) {
        if (urls.has(entry.url)) invalid(context);
        urls.add(entry.url);
        if (
          !strictlyOrdered(entry.reasons, compareText) ||
          !strictlyOrdered(entry.references, compareRetryReferences) ||
          entry.references.length > 0 !==
            entry.reasons.some((reason) => reason !== 'LocalUnresolvedHold')
        )
          invalid(context);
        for (const ref of entry.references) references.add(JSON.stringify(ref));
      }
      if (
        references.size > maxReferences ||
        counts.eligible !== value.eligibleUrls.length ||
        counts.excluded !== value.excluded.length ||
        counts.eligible + counts.excluded !== counts.unindexed ||
        counts.indexed + counts.unindexed > submissionLimits.urls
      )
        invalid(context);
      const built = buildCreateIndexingRequest({
        mode: 'preview',
        searchEngine: value.searchEngine,
        urls: value.eligibleUrls,
      });
      for (const key of [
        'family',
        'providerRoute',
        'urlCount',
        'providerBodyBytes',
        'payloadDigest',
      ] as const)
        if (value.request[key] !== built.request[key]) invalid(context);
      for (const key of [
        'version',
        'fingerprint',
        'basis',
        'providerEnforced',
      ] as const)
        if (value.quote[key] !== built.quote[key]) invalid(context);
      for (const unit of ['tokens', 'indexer', 'checker'] as const)
        if (
          value.quote.maximumExposure[unit] !==
            built.quote.maximumExposure[unit] ||
          auth.caps[unit] < built.quote.maximumExposure[unit] ||
          identity.preimage.reservation[unit] !==
            built.quote.maximumExposure[unit]
        )
          invalid(context);
      const p = identity.preimage;
      if (
        p.parent.family !== source.reference[0] ||
        p.parent.taskId !== source.reference[1] ||
        p.provenance !== source.provenance ||
        p.originalManifestKnown !== source.originalManifestKnown ||
        p.manifestProvenance !== source.manifestProvenance ||
        p.sourceManifestDigest !== source.manifestDigest ||
        p.policyDigest !== auth.policyDigest ||
        p.authorizationFingerprint !== auth.fingerprint ||
        p.period.id !== auth.period.id ||
        p.period.startMs !== auth.period.startMs ||
        p.period.endMs !== auth.period.endMs ||
        p.payloadDigest !== value.request.payloadDigest ||
        p.providerRoute !== value.request.providerRoute ||
        p.urlCount !== value.request.urlCount ||
        p.providerBodyBytes !== value.request.providerBodyBytes ||
        p.quoteVersion !== value.quote.version ||
        p.quoteFingerprint !== value.quote.fingerprint ||
        computeRetryPlanFingerprint(p) !== identity.fingerprint
      )
        invalid(context);
      // Safety/local/partition commitments and discarded report order remain opaque.
    } catch {
      invalid(context);
    }
  });

export const planRetryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('error'), error: errorSchema }),
  z.strictObject({
    status: z.literal('no_source'),
    searchEngine: searchEngineSchema,
  }),
  blockedSchema,
  readySchema,
]);
export type PlanRetryResult = z.infer<typeof planRetryResultSchema>;

const internalErrorSchema = z.strictObject({
  status: z.literal('error'),
  code: errorCodeSchema,
  phase: phaseSchema.optional(),
  cause: causeSchema.optional(),
});
const internalBlockedSchema = z.strictObject({
  status: z.literal('blocked'),
  blockers: z
    .array(blockerCodeSchema)
    .min(1)
    .max(blockerCodeSchema.options.length),
  ...blockedFields,
});
/** Fixed projection for an owner-held view; no caller facts, I/O or proof mint. */
export function retryPlanResultFromView(
  searchEngine: RetryPlanInput['searchEngine'],
  view: unknown,
): PlanRetryResult {
  try {
    let value: unknown;
    if (typeof view !== 'object' || view === null || Array.isArray(view))
      throw new TypeError();
    if (Object.hasOwn(view, 'searchEngine')) throw new TypeError();
    if ('status' in view && view.status === 'error') {
      const { code, phase, cause } = internalErrorSchema.parse(view);
      value = {
        status: 'error',
        error: {
          code,
          message: errorMessages[code],
          ...(Object.hasOwn(view, 'phase') ? { phase } : {}),
          ...(Object.hasOwn(view, 'cause') ? { cause } : {}),
        },
      };
    } else if ('status' in view && view.status === 'blocked') {
      const parsed = internalBlockedSchema.parse(view);
      value = {
        ...parsed,
        searchEngine,
        blockers: parsed.blockers
          .map((code) => ({ code, message: blockerMessages[code] }))
          .sort((a, b) => compareText(a.code, b.code)),
      };
    } else {
      value = { ...view, searchEngine };
    }
    return freezeSnapshot(planRetryResultSchema.parse(value));
  } catch {
    return fixedFallbacks().InternalError.result.structuredContent;
  }
}

const productionBytes = 2_097_152;
const intrinsicStringify = JSON.stringify;
function envelope(value: PlanRetryResult) {
  return freezeSnapshot({
    isError: value.status === 'error',
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
}
export type PlanRetryToolResult = ReturnType<typeof envelope>;
let cachedFallbacks: ReturnType<typeof createFallbacks> | undefined;
function createFallbacks() {
  const make = (code: 'InternalError' | 'ResourceLimitExceeded') => {
    const value = planRetryResultSchema.parse({
      status: 'error',
      error: { code, message: errorMessages[code] },
    });
    const result = freezeSnapshot({
      isError: true,
      content: [{ type: 'text' as const, text: intrinsicStringify(value) }],
      structuredContent: value,
    });
    const bytes = Buffer.byteLength(intrinsicStringify(result), 'utf8');
    if (bytes > productionBytes)
      throw new RangeError('Invalid retry-plan fallback.');
    return { result, bytes };
  };
  return {
    InternalError: make('InternalError'),
    ResourceLimitExceeded: make('ResourceLimitExceeded'),
  };
}
function fixedFallbacks() {
  return (cachedFallbacks ??= createFallbacks());
}
/** Capture the unchanged lower-only limit once in a trusted owner constructor. */
export function lowerPlanRetryResultByteLimit(lower?: number): number {
  const fallbacks = fixedFallbacks();
  const maxBytes = lower ?? productionBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes > productionBytes ||
    maxBytes <
      Math.max(
        fallbacks.InternalError.bytes,
        fallbacks.ResourceLimitExceeded.bytes,
      )
  )
    throw new RangeError('Invalid retry-plan result limit.');
  return maxBytes;
}
/** Trusted lower-only construction seam. Measure the actual duplicated application envelope. */
export function planRetryToolResult(
  value: unknown,
  construction: { maxBytes?: number } = {},
): PlanRetryToolResult {
  const fallbacks = fixedFallbacks();
  const maxBytes = lowerPlanRetryResultByteLimit(construction.maxBytes);
  try {
    const parsed = planRetryResultSchema.safeParse(value);
    if (!parsed.success) return fallbacks.InternalError.result;
    const result = envelope(parsed.data);
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes
      ? result
      : fallbacks.ResourceLimitExceeded.result;
  } catch {
    return fallbacks.InternalError.result;
  }
}
