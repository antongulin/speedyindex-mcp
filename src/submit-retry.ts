/** Pure comparison/reconstruction only: no observation, admission or paid authority. */
import { z } from 'zod';
import {
  buildCreateIndexingRequest,
  createIndexingTaskInputSchema,
  createIndexingTaskResultSchema,
  indexingObservationSchema,
  indexingQuoteSchema,
  indexingRequestSchema,
} from './create-indexing-task';
import { retryPlanComparisonSchema } from './plan-retry-result';
import { freezeSnapshot } from './retry-ledger-snapshot';
import {
  acknowledgementSchema,
  digestSchema,
  submissionErrorCodeSchema,
  submissionUnitVectorSchema,
  visibleLabelSchema,
} from './submission-contract';
import {
  computeRetryPlanFingerprint,
  type RetryReplayIdentity,
} from './submission-ledger';
import { computeSubmissionAuthorizationFingerprint } from './submission-policy';

const units = ['tokens', 'indexer', 'checker'] as const;
const parentSchema = retryPlanComparisonSchema.shape.preimage.shape.parent;
const periodSchema = retryPlanComparisonSchema.shape.preimage.shape.period;
const phaseSchema = z.enum(['list', 'status', 'report', 'fence']);
const causeSchema = z.enum([
  'http',
  'provider',
  'response',
  'network',
  'timeout',
]);
const errorCodeSchema = z.enum([
  ...submissionErrorCodeSchema.options,
  'DeadlineExceeded',
  'ReadFailed',
  'ResourceLimitExceeded',
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
  'SnapshotConflict',
  'UpgradeRequired',
  'SnapshotLimitExceeded',
  'RetryAllowanceExceeded',
  'NoCandidates',
]);
export type SubmitRetryErrorCode = z.infer<typeof errorCodeSchema>;
const messages = Object.freeze({
  InvalidInput: 'Invalid retry-submission input.',
  InternalError: 'Retry submission failed internally.',
  WritesDisabled: 'Submissions are disabled by the operator policy.',
  InvalidPolicy: 'Submission policy is invalid or unavailable.',
  MissingCredentials: 'Submission credentials are missing or invalid.',
  CredentialMismatch:
    'Submission credentials do not match the configured policy.',
  AcknowledgementRequired: 'Submission acknowledgement is required.',
  AcknowledgementMismatch:
    'Submission acknowledgement does not match the current context.',
  StateUnavailable:
    'Required local retry state or configuration is unavailable.',
  SubmissionBusy: 'Another submission or retry plan is in progress.',
  RequestIdConflict: 'Submission request ID conflicts with its stored intent.',
  UrlOverlap: 'A submitted URL is held by another unresolved intent.',
  BudgetExceeded:
    'The proposed reservation exceeds at least one configured unit cap.',
  StalePeriodContext:
    'The reservation period changed. Start a new observation.',
  LedgerBusy: 'Submission ledger is busy.',
  DispatchClaimLost: 'Submission dispatch claim is no longer available.',
  OutcomePersistenceFailed: 'Retry submission outcome could not be persisted.',
  ProviderRejected: 'SpeedyIndex rejected the retry submission.',
  OutcomeUnknown: 'The retry submission outcome is unknown.',
  Cancelled: 'Retry submission was cancelled.',
  DeadlineExceeded: 'Retry submission exceeded its observation deadline.',
  ReadFailed: 'A required provider read failed.',
  ResourceLimitExceeded: 'Retry submission exceeded a resource limit.',
  UnprovenLatest:
    'A latest completed source could not be established. Inspect the source evidence.',
  AmbiguousLatest:
    'Latest-source chronology is ambiguous. Resolve the conflicting sources.',
  ConflictingEvidence:
    'Required observations conflict. Inspect the source evidence.',
  IncompleteScan:
    'The required provider scan is incomplete. Resolve the read gap.',
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
    'A retry dispatch has an unresolved outcome. Inspect it before submitting more work.',
  RetryPolicyRequired:
    'Retry submission requires an enabled private retry policy.',
  SnapshotConflict:
    'The expected retry plan no longer matches the required evidence.',
  UpgradeRequired:
    'The selected state requires the supported V2 upgrade before retry submission.',
  SnapshotLimitExceeded:
    'The complete local snapshot exceeds its technical limit.',
  RetryAllowanceExceeded:
    'The source has exhausted its configured retry allowance.',
  NoCandidates:
    'No eligible unindexed URLs remain after the safety exclusions.',
} satisfies Record<SubmitRetryErrorCode, string>);

function invalid(context: z.RefinementCtx) {
  context.addIssue({
    code: 'custom',
    message: 'Inconsistent retry-submission data.',
  });
}
function presentUndefined(value: object, keys: readonly string[]) {
  return keys.some(
    (key) =>
      Object.hasOwn(value, key) &&
      (value as Record<string, unknown>)[key] === undefined,
  );
}
export const submitRetryErrorSchema = z
  .strictObject({
    code: errorCodeSchema,
    message: z.string(),
    unit: z.enum(units).optional(),
    phase: phaseSchema.optional(),
    cause: causeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.message !== messages[value.code] ||
      presentUndefined(value, ['unit', 'phase', 'cause']) ||
      (value.unit !== undefined && value.code !== 'BudgetExceeded') ||
      ((value.phase !== undefined || value.cause !== undefined) &&
        value.code !== 'ReadFailed')
    )
      invalid(context);
  });
export function submitRetryError(
  code: SubmitRetryErrorCode,
  details: {
    unit?: (typeof units)[number];
    phase?: z.infer<typeof phaseSchema>;
    cause?: z.infer<typeof causeSchema>;
  } = {},
) {
  return freezeSnapshot(
    submitRetryErrorSchema.parse({ code, message: messages[code], ...details }),
  );
}
export class SubmitRetryError extends Error {
  constructor(readonly code: 'InvalidInput' | 'InternalError') {
    super(messages[code]);
    this.name = 'SubmitRetryError';
  }
}

export const submitRetryInputSchema = z
  .strictObject({
    requestId: visibleLabelSchema,
    expectedPlan: z.strictObject({
      searchEngine: z.enum(['google', 'yandex']),
      eligibleUrls: createIndexingTaskInputSchema.shape.urls,
      budgetScope: visibleLabelSchema,
      policyRevision: visibleLabelSchema,
      identity: retryPlanComparisonSchema,
    }),
    acknowledgement: acknowledgementSchema.optional(),
  })
  .superRefine((value, context) => {
    try {
      if (presentUndefined(value, ['acknowledgement'])) invalid(context);
      const { expectedPlan: expected } = value;
      const p = expected.identity.preimage;
      const built = regularRequest(value);
      if (
        p.parent.family !== built.request.family ||
        p.originalManifestKnown !==
          (p.provenance !== 'external_unattributed') ||
        p.manifestProvenance !==
          (p.provenance === 'external_unattributed'
            ? 'provider_report_observed_corpus'
            : 'durable_local_intent_ack')
      )
        invalid(context);
      for (const field of [
        'providerRoute',
        'urlCount',
        'providerBodyBytes',
        'payloadDigest',
      ] as const)
        if (p[field] !== built.request[field]) invalid(context);
      if (
        p.quoteVersion !== built.quote.version ||
        p.quoteFingerprint !== built.quote.fingerprint ||
        units.some(
          (unit) => p.reservation[unit] !== built.quote.maximumExposure[unit],
        ) ||
        computeRetryPlanFingerprint(p) !== expected.identity.fingerprint
      )
        invalid(context);
      // Opaque evidence digests and policyRevision are not authenticated here.
    } catch {
      invalid(context);
    }
  });
export type SubmitRetryInput = z.infer<typeof submitRetryInputSchema>;
function regularRequest(input: {
  requestId: string;
  expectedPlan: {
    searchEngine: 'google' | 'yandex';
    eligibleUrls: readonly string[];
  };
}) {
  return buildCreateIndexingRequest({
    mode: 'submit',
    requestId: input.requestId,
    searchEngine: input.expectedPlan.searchEngine,
    urls: input.expectedPlan.eligibleUrls,
  });
}
export function parseSubmitRetryInput(value: unknown): SubmitRetryInput {
  try {
    return freezeSnapshot(submitRetryInputSchema.parse(value));
  } catch {
    throw new SubmitRetryError('InvalidInput');
  }
}
const trustedReconstructionSchema = z.strictObject({
  credentialFingerprint: digestSchema,
  currentCaps: submissionUnitVectorSchema,
});
/** Current trusted caps only satisfy replay's validated DTO, not historical caps or admission.
 * This produces comparison data, never a proof or a replacement dispatch capability. */
export function reconstructSubmitRetry(
  value: unknown,
  trusted: z.infer<typeof trustedReconstructionSchema>,
) {
  const input = parseSubmitRetryInput(value);
  let captured: z.infer<typeof trustedReconstructionSchema>;
  try {
    captured = trustedReconstructionSchema.parse(trusted);
  } catch {
    throw new SubmitRetryError('InternalError');
  }
  const { expectedPlan: expected } = input;
  const p = expected.identity.preimage;
  if (
    computeSubmissionAuthorizationFingerprint({
      quoteFingerprint: p.quoteFingerprint,
      policyDigest: p.policyDigest,
      credentialFingerprint: captured.credentialFingerprint,
      budgetScope: expected.budgetScope,
      periodId: p.period.id,
      periodStartMs: p.period.startMs,
    }) !== p.authorizationFingerprint
  )
    throw new SubmitRetryError('InvalidInput');
  const request = regularRequest(input);
  const replay: RetryReplayIdentity = {
    intent: {
      requestId: input.requestId,
      budget: {
        credentialFingerprint: captured.credentialFingerprint,
        budgetScope: expected.budgetScope,
        periodId: p.period.id,
        periodStartMs: p.period.startMs,
        policyRevision: expected.policyRevision,
        policyDigest: p.policyDigest,
        caps: captured.currentCaps,
      },
      taskFamily: request.request.family,
      providerRoute: request.request.providerRoute,
      payloadDigest: request.request.payloadDigest,
      submittedUrls: request.input.urls,
      quoteVersion: request.quote.version,
      quoteFingerprint: request.quote.fingerprint,
      reservation: request.quote.maximumExposure,
    },
    parent: p.parent,
    sourceManifestDigest: p.sourceManifestDigest,
    planFingerprint: expected.identity.fingerprint,
  };
  return freezeSnapshot({ input, request, replay });
}

const retrySummarySchema = z.strictObject({
  parent: parentSchema,
  sourceManifestDigest: digestSchema,
  planFingerprint: digestSchema,
});
const intentSchema = createIndexingTaskResultSchema.shape.intent
  .unwrap()
  .superRefine((value, context) => {
    const version =
      value.state === 'prepared'
        ? 0
        : value.state === 'dispatching' || value.state === 'cancelled'
          ? 1
          : 2;
    if (
      value.stateVersion !== version ||
      presentUndefined(value, ['providerTaskId', 'providerType']) ||
      !periodSchema.safeParse({
        id: value.periodId,
        startMs: value.periodStartMs,
        endMs: value.periodStartMs + 86_400_000,
      }).success
    )
      invalid(context);
  });
const dataFields = {
  request: indexingRequestSchema,
  quote: indexingQuoteSchema,
  retry: retrySummarySchema,
};
type SubmissionData = {
  request: z.infer<typeof indexingRequestSchema>;
  quote: z.infer<typeof indexingQuoteSchema>;
  retry: z.infer<typeof retrySummarySchema>;
};
function checkData(value: SubmissionData, context: z.RefinementCtx) {
  // Existing pure preview validation owns summary/quote correlation. This inactive
  // validation view asserts no current or historical authorization.
  if (
    !createIndexingTaskResultSchema.safeParse({
      mode: 'preview',
      status: 'preview',
      request: value.request,
      quote: value.quote,
      authorization: { state: 'unconfigured', stateChecked: false },
    }).success ||
    value.retry.parent.family !== value.request.family
  )
    invalid(context);
}
function checkObservation(
  value: SubmissionData,
  intent: z.infer<typeof intentSchema> | undefined,
  observation: z.infer<typeof indexingObservationSchema> | undefined,
  context: z.RefinementCtx,
) {
  if (!observation) return;
  if (
    observation.kind === 'accepted_ack' &&
    (observation.type !== value.request.family ||
      (observation.recorded &&
        observation.taskId === value.retry.parent.taskId))
  )
    invalid(context);
  if (!observation.recorded) {
    if (intent && intent.state !== 'dispatching') invalid(context);
    return;
  }
  if (
    !intent ||
    intent.state !==
      (observation.kind === 'accepted_ack'
        ? 'accepted'
        : observation.kind === 'ambiguous'
          ? 'unknown'
          : 'rejected')
  )
    invalid(context);
  if (
    observation.kind === 'accepted_ack' &&
    (intent?.providerTaskId !== observation.taskId ||
      intent?.providerType !== observation.type)
  )
    invalid(context);
}
function checkDurable(
  value: SubmissionData & {
    intent: z.infer<typeof intentSchema>;
    observation?: z.infer<typeof indexingObservationSchema> | undefined;
  },
  context: z.RefinementCtx,
) {
  checkData(value, context);
  const { intent } = value;
  if (
    presentUndefined(value, ['observation']) ||
    units.some(
      (unit) => intent.reservation[unit] !== value.quote.maximumExposure[unit],
    ) ||
    (intent.state === 'accepted' &&
      (intent.providerType !== value.request.family ||
        intent.providerTaskId === value.retry.parent.taskId))
  )
    invalid(context);
  checkObservation(value, intent, value.observation, context);
}
const evidenceSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('durable'),
      ...dataFields,
      intent: intentSchema,
      observation: indexingObservationSchema.optional(),
    })
    .superRefine(checkDurable),
  z
    .strictObject({
      kind: z.literal('unrecorded'),
      ...dataFields,
      lastObservedState: z.literal('dispatching'),
      observation: indexingObservationSchema,
    })
    .superRefine((value, context) => {
      checkData(value, context);
      if (value.observation.recorded) invalid(context);
      checkObservation(value, undefined, value.observation, context);
    }),
]);
const durableFields = {
  requestId: visibleLabelSchema,
  replayed: z.boolean(),
  ...dataFields,
  intent: intentSchema,
  observation: indexingObservationSchema.optional(),
};
const runtimeCodes: readonly SubmitRetryErrorCode[] = [
  'InvalidInput',
  'Cancelled',
  'DeadlineExceeded',
  'ReadFailed',
  'ResourceLimitExceeded',
  'InternalError',
];
export const submitRetryResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), ...durableFields }),
    z.strictObject({
      status: z.literal('prepared'),
      ...durableFields,
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('dispatching'),
      ...durableFields,
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('rejected'),
      ...durableFields,
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('unknown'),
      ...durableFields,
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('cancelled'),
      ...durableFields,
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('blocked'),
      requestId: visibleLabelSchema.optional(),
      error: submitRetryErrorSchema,
    }),
    z.strictObject({
      status: z.literal('error'),
      requestId: visibleLabelSchema.optional(),
      error: submitRetryErrorSchema,
      evidence: evidenceSchema.optional(),
    }),
  ])
  .superRefine((value, context) => {
    if (presentUndefined(value, ['requestId', 'evidence'])) invalid(context);
    if (value.status === 'blocked') {
      if (runtimeCodes.includes(value.error.code)) invalid(context);
    } else if (value.status === 'error') {
      if (
        !runtimeCodes.includes(value.error.code) &&
        !(
          value.evidence &&
          ['StateUnavailable', 'OutcomePersistenceFailed'].includes(
            value.error.code,
          )
        )
      )
        invalid(context);
      if (
        value.evidence &&
        (!value.requestId ||
          (value.evidence.kind === 'durable' &&
            value.evidence.intent.requestId !== value.requestId))
      )
        invalid(context);
    } else {
      checkDurable(value, context);
      if (
        value.intent.state !== value.status ||
        value.intent.requestId !== value.requestId ||
        (value.replayed && value.observation)
      )
        invalid(context);
      if (value.status !== 'accepted') {
        if (
          value.replayed &&
          value.error.code !==
            (value.status === 'cancelled'
              ? 'Cancelled'
              : value.status === 'unknown'
                ? 'OutcomeUnknown'
                : 'DispatchClaimLost')
        )
          invalid(context);
        if (
          value.observation &&
          !value.observation.recorded &&
          value.error.code !== 'OutcomePersistenceFailed'
        )
          invalid(context);
      }
    }
  });
export type SubmitRetryResult = z.infer<typeof submitRetryResultSchema>;

const productionBytes = 2_097_152;
function envelope(value: SubmitRetryResult) {
  return freezeSnapshot({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: value.status !== 'accepted',
  });
}
export type SubmitRetryToolResult = ReturnType<typeof envelope>;
function fixedResult(code: 'InternalError' | 'ResourceLimitExceeded') {
  return envelope(
    submitRetryResultSchema.parse({
      status: 'error',
      error: submitRetryError(code),
    }),
  );
}
const fallbacks = {
  InternalError: fixedResult('InternalError'),
  ResourceLimitExceeded: fixedResult('ResourceLimitExceeded'),
};
function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
/** Trusted lower-only seam, never a public argument. Includes escaped text and structured duplication. */
export function lowerSubmitRetryResultByteLimit(lower?: number): number {
  const limit = lower ?? productionBytes;
  if (
    !Number.isSafeInteger(limit) ||
    limit > productionBytes ||
    limit <
      Math.max(
        bytes(fallbacks.InternalError),
        bytes(fallbacks.ResourceLimitExceeded),
      )
  )
    throw new RangeError('Invalid retry-submission result limit.');
  return limit;
}
function overflowEvidence(value: SubmitRetryResult) {
  if (value.status === 'blocked') return undefined;
  if (value.status === 'error') return value.evidence;
  return {
    kind: 'durable' as const,
    request: value.request,
    quote: value.quote,
    retry: value.retry,
    intent: value.intent,
    ...(value.observation ? { observation: value.observation } : {}),
  };
}
/** All variants are locally validated; the SDK skips output validation for isError.
 * Preserve observed durable/unrecorded evidence whenever it fits the inclusive bound.
 * No SDK framing, RSS or hard whole-tool latency claim is made. */
export function submitRetryToolResult(
  value: unknown,
  construction: { maxBytes?: number } = {},
): SubmitRetryToolResult {
  const maxBytes = lowerSubmitRetryResultByteLimit(construction.maxBytes);
  try {
    const parsed = submitRetryResultSchema.safeParse(value);
    if (!parsed.success) return fallbacks.InternalError;
    const result = envelope(parsed.data);
    if (bytes(result) <= maxBytes) return result;
    const evidence = overflowEvidence(parsed.data);
    if (evidence) {
      const reduced = submitRetryResultSchema.parse({
        status: 'error',
        requestId: parsed.data.requestId,
        error: submitRetryError('ResourceLimitExceeded'),
        evidence,
      });
      const retained = envelope(reduced);
      if (bytes(retained) <= maxBytes) return retained;
    }
    return fallbacks.ResourceLimitExceeded;
  } catch {
    return fallbacks.InternalError;
  }
}
