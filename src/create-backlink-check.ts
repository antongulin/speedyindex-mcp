import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  acknowledgementSchema,
  digestSchema,
  modeSchema,
  providerTaskIdSchema,
  safeInteger,
  safeNonnegativeInteger,
  submissionErrorCodeSchema,
  submissionLimits,
  submissionUnitVectorSchema,
  submittedUrlSchema,
  titleSchema,
  validText,
  visibleLabelSchema,
  type BacklinkCheckReservationSource,
  type SubmissionUnitVector,
} from './submission-contract';

export const backlinkCheckQuoteVersion =
  'speedyindex-backlink-check-reservation-2026-10-21-v1';
const family = 'backlink/checker' as const;
const providerRoute = '/v2/task/backlink/checker/create' as const;
const targetDomainCountLimit = 50;
const targetDomainBytesLimit = 8_192;

const targetDomainSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 && validText(value, targetDomainBytesLimit),
    'Invalid backlink target domain.',
  );

function bodyFor(input: {
  readonly urls: readonly string[];
  readonly targetDomains: readonly string[];
  readonly title?: string | undefined;
}) {
  return JSON.stringify({
    ...(input.title === undefined ? {} : { title: input.title }),
    urls: input.urls,
    target_domains: input.targetDomains,
  });
}

const requestFieldsSchema = z
  .strictObject({
    mode: modeSchema,
    urls: z.array(submittedUrlSchema).min(1).max(submissionLimits.urls),
    targetDomains: z
      .array(targetDomainSchema)
      .min(1)
      .max(targetDomainCountLimit),
    title: titleSchema.optional(),
    requestId: visibleLabelSchema.optional(),
    acknowledgement: acknowledgementSchema.optional(),
  })
  .superRefine((input, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (input.mode === 'submit' && input.requestId === undefined)
      issue('requestId', 'Submit requires a request ID.');
    if (
      input.mode === 'preview' &&
      (Object.hasOwn(input, 'requestId') ||
        Object.hasOwn(input, 'acknowledgement'))
    )
      issue('mode', 'Preview forbids submission authority fields.');
    if (new Set(input.urls).size !== input.urls.length)
      issue('urls', 'Submitted URLs must be unique.');
  });

export const createBacklinkCheckInputSchema = requestFieldsSchema.refine(
  (input) =>
    Buffer.byteLength(bodyFor(input), 'utf8') <=
    submissionLimits.providerBodyBytes,
  {
    path: ['urls'],
    message: 'Serialized provider request is too large.',
  },
);
export type CreateBacklinkCheckInput = z.infer<
  typeof createBacklinkCheckInputSchema
>;

const requestSchema = z.strictObject({
  family: z.literal(family),
  providerRoute: z.literal(providerRoute),
  urlCount: z.number().int().min(1).max(submissionLimits.urls),
  targetDomainCount: z.number().int().min(1).max(targetDomainCountLimit),
  providerBodyBytes: z
    .number()
    .int()
    .min(1)
    .max(submissionLimits.providerBodyBytes),
  payloadDigest: digestSchema,
});
export type BacklinkCheckRequestSummary = z.infer<typeof requestSchema>;

type FrozenInput = Readonly<
  Omit<CreateBacklinkCheckInput, 'urls' | 'targetDomains' | 'acknowledgement'>
> & {
  readonly urls: readonly string[];
  readonly targetDomains: readonly string[];
  readonly acknowledgement?:
    Readonly<z.infer<typeof acknowledgementSchema>> | undefined;
};

export interface PreparedCreateBacklinkCheckRequest {
  readonly input: FrozenInput;
  readonly body: string;
  readonly request: Readonly<BacklinkCheckRequestSummary>;
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildCreateBacklinkCheckRequest(
  value: unknown,
): PreparedCreateBacklinkCheckRequest {
  const parsed = requestFieldsSchema.safeParse(value);
  if (!parsed.success) throw new CreateBacklinkCheckError('InvalidInput');
  const input = Object.freeze({
    ...parsed.data,
    urls: Object.freeze(parsed.data.urls),
    targetDomains: Object.freeze(parsed.data.targetDomains),
    ...(parsed.data.acknowledgement === undefined
      ? {}
      : {
          acknowledgement: Object.freeze(parsed.data.acknowledgement),
        }),
  });
  const body = bodyFor(input);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > submissionLimits.providerBodyBytes)
    throw new CreateBacklinkCheckError('InvalidInput');
  return Object.freeze({
    input,
    body,
    request: Object.freeze({
      family,
      providerRoute,
      urlCount: input.urls.length,
      targetDomainCount: input.targetDomains.length,
      providerBodyBytes: bytes,
      payloadDigest: hash(body),
    }),
  });
}

const unavailableReasonSchema = z.enum([
  'policy_unconfigured',
  'policy_invalid',
  'profile_missing',
  'reservation_overflow',
]);
const quoteFields = {
  version: z.literal(backlinkCheckQuoteVersion),
  basis: z.literal('operator_configured_reservation'),
  providerEnforced: z.literal(false),
  providerFeesKnown: z.literal(false),
};
export const backlinkCheckQuoteSchema = z.discriminatedUnion('availability', [
  z.strictObject({
    ...quoteFields,
    availability: z.literal('unavailable'),
    reason: unavailableReasonSchema,
  }),
  z.strictObject({
    ...quoteFields,
    availability: z.literal('available'),
    perUrlReservation: submissionUnitVectorSchema,
    reservation: submissionUnitVectorSchema,
    fingerprint: digestSchema,
  }),
]);
export type BacklinkCheckQuote = z.infer<typeof backlinkCheckQuoteSchema>;

function totalReservation(
  perUrl: Readonly<SubmissionUnitVector>,
  count: number,
): SubmissionUnitVector | undefined {
  const totals = [perUrl.tokens, perUrl.indexer, perUrl.checker].map(
    (value) => BigInt(value) * BigInt(count),
  );
  if (totals.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER)))
    return undefined;
  return {
    tokens: Number(totals[0]!),
    indexer: Number(totals[1]!),
    checker: Number(totals[2]!),
  };
}

function quoteFingerprint(
  request: Readonly<BacklinkCheckRequestSummary>,
  perUrl: Readonly<SubmissionUnitVector>,
  reservation: Readonly<SubmissionUnitVector>,
) {
  return hash(
    'speedyindex-create-backlink-check-reservation-v1\0' +
      JSON.stringify({
        version: backlinkCheckQuoteVersion,
        family: request.family,
        providerRoute: request.providerRoute,
        payloadDigest: request.payloadDigest,
        urlCount: request.urlCount,
        targetDomainCount: request.targetDomainCount,
        perUrlReservation: {
          tokens: perUrl.tokens,
          indexer: perUrl.indexer,
          checker: perUrl.checker,
        },
        reservation: {
          tokens: reservation.tokens,
          indexer: reservation.indexer,
          checker: reservation.checker,
        },
      }),
  );
}

export function quoteBacklinkCheckRequest(
  prepared: PreparedCreateBacklinkCheckRequest,
  source: BacklinkCheckReservationSource,
): Readonly<BacklinkCheckQuote> {
  const common = {
    version: backlinkCheckQuoteVersion,
    basis: 'operator_configured_reservation' as const,
    providerEnforced: false as const,
    providerFeesKnown: false as const,
  } as const;
  const unavailable = (
    reason: z.infer<typeof unavailableReasonSchema>,
  ): Readonly<BacklinkCheckQuote> =>
    Object.freeze({ ...common, availability: 'unavailable', reason });
  if (source.state === 'unconfigured')
    return unavailable('policy_unconfigured');
  if (source.state === 'invalid') return unavailable('policy_invalid');
  if (source.profile === undefined) return unavailable('profile_missing');
  const parsedProfile = submissionUnitVectorSchema.safeParse(source.profile);
  if (!parsedProfile.success || parsedProfile.data.tokens < 2)
    return unavailable('policy_invalid');
  const perUrlReservation = Object.freeze({
    tokens: parsedProfile.data.tokens,
    indexer: parsedProfile.data.indexer,
    checker: parsedProfile.data.checker,
  });
  const reservation = totalReservation(
    perUrlReservation,
    prepared.request.urlCount,
  );
  if (!reservation) return unavailable('reservation_overflow');
  return Object.freeze({
    ...common,
    availability: 'available',
    perUrlReservation,
    reservation: Object.freeze(reservation),
    fingerprint: quoteFingerprint(
      prepared.request,
      perUrlReservation,
      reservation,
    ),
  });
}

export const createBacklinkCheckErrorCodeSchema = z.union([
  submissionErrorCodeSchema,
  z.enum(['ReservationProfileRequired', 'ReservationOverflow']),
]);
export type CreateBacklinkCheckErrorCode = z.infer<
  typeof createBacklinkCheckErrorCodeSchema
>;

const errorMessages: Record<CreateBacklinkCheckErrorCode, string> = {
  InvalidInput: 'Invalid create-backlink-check request.',
  InternalError: 'Could not produce a valid create-backlink-check result.',
  WritesDisabled: 'Backlink-check submissions are disabled.',
  InvalidPolicy: 'Submission policy is invalid or unavailable.',
  MissingCredentials: 'Submission credentials are missing or invalid.',
  CredentialMismatch:
    'Submission credentials do not match the configured policy.',
  AcknowledgementRequired: 'Submission acknowledgement is required.',
  AcknowledgementMismatch:
    'Submission acknowledgement does not match the current context.',
  StateUnavailable: 'Submission state is unavailable.',
  SubmissionBusy: 'Another new submission is in progress in this host.',
  RequestIdConflict: 'Submission request ID conflicts with its stored intent.',
  UrlOverlap: 'A submitted URL is held by another unresolved intent.',
  BudgetExceeded: 'Submission unit allowance would be exceeded.',
  StalePeriodContext: 'Submission period context is stale or inconsistent.',
  LedgerBusy: 'Submission ledger is busy.',
  DispatchClaimLost: 'Submission dispatch claim is no longer available.',
  OutcomePersistenceFailed: 'Submission outcome could not be persisted.',
  ProviderRejected: 'SpeedyIndex rejected the backlink-check submission.',
  OutcomeUnknown: 'The backlink-check submission outcome is unknown.',
  Cancelled: 'The backlink-check submission was cancelled.',
  ReservationProfileRequired:
    'Configure a trusted backlink-check reservation profile.',
  ReservationOverflow:
    'The configured backlink-check reservation exceeds supported integer bounds.',
};

export class CreateBacklinkCheckError extends Error {
  constructor(readonly code: CreateBacklinkCheckErrorCode) {
    super(errorMessages[code]);
    this.name = 'CreateBacklinkCheckError';
  }
}

export function createBacklinkCheckError(code: CreateBacklinkCheckErrorCode) {
  return { code, message: errorMessages[code] };
}

const errorSchema = z
  .strictObject({
    code: createBacklinkCheckErrorCodeSchema,
    message: z.string(),
    unit: z.enum(['tokens', 'indexer', 'checker']).optional(),
    lastObservedState: z.literal('dispatching').optional(),
  })
  .refine(
    (error) =>
      error.message === errorMessages[error.code] &&
      (error.unit === undefined || error.code === 'BudgetExceeded') &&
      (error.lastObservedState === undefined ||
        error.code === 'StateUnavailable'),
  );

export const backlinkCheckAuthorizationSchema = z
  .strictObject({
    state: z.enum([
      'unconfigured',
      'disabled',
      'invalid',
      'credential_missing',
      'credential_mismatch',
      'configured',
      'reservation_unavailable',
    ]),
    stateChecked: z.boolean(),
    mode: z.enum(['caller_acknowledgement', 'operator_policy']).optional(),
    policyRevision: visibleLabelSchema.optional(),
    policyDigest: digestSchema.optional(),
    budgetScope: visibleLabelSchema.optional(),
    caps: submissionUnitVectorSchema.optional(),
    period: z
      .strictObject({
        id: visibleLabelSchema,
        startMs: safeInteger,
        endMs: safeInteger,
      })
      .refine((value) => value.endMs > value.startMs)
      .optional(),
    fingerprint: digestSchema.optional(),
  })
  .superRefine((authorization, context) => {
    const metadata = [
      authorization.mode,
      authorization.policyRevision,
      authorization.policyDigest,
      authorization.budgetScope,
      authorization.caps,
      authorization.period,
      authorization.fingerprint,
    ];
    if (
      authorization.state === 'configured'
        ? metadata.some((value) => value === undefined)
        : authorization.stateChecked ||
          metadata.some((value) => value !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid authorization summary.',
      });
  });
export type BacklinkCheckAuthorization = z.infer<
  typeof backlinkCheckAuthorizationSchema
>;

const intentSchema = z
  .strictObject({
    requestId: visibleLabelSchema,
    state: z.enum([
      'prepared',
      'dispatching',
      'accepted',
      'rejected',
      'unknown',
      'cancelled',
    ]),
    stateVersion: safeNonnegativeInteger,
    createdAtMs: safeInteger,
    periodId: visibleLabelSchema,
    periodStartMs: safeInteger,
    policyRevision: visibleLabelSchema,
    policyDigest: digestSchema,
    reservation: submissionUnitVectorSchema,
    providerTaskId: providerTaskIdSchema.optional(),
    providerType: z.literal(family).optional(),
  })
  .refine((intent) =>
    intent.state === 'accepted'
      ? intent.providerTaskId !== undefined && intent.providerType !== undefined
      : intent.providerTaskId === undefined &&
        intent.providerType === undefined,
  );

const observationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accepted_ack'),
    recorded: z.boolean(),
    taskId: providerTaskIdSchema,
    type: z.literal(family),
  }),
  z.strictObject({
    kind: z.literal('provider_rejection'),
    recorded: z.boolean(),
    code: z.union([z.literal(1), z.literal(2)]),
  }),
  z.strictObject({
    kind: z.literal('not_sent'),
    recorded: z.boolean(),
    cause: z.enum(['cancelled', 'local_validation']),
  }),
  z.strictObject({
    kind: z.literal('ambiguous'),
    recorded: z.boolean(),
    cause: z.enum(['cancelled', 'timeout', 'transport', 'invalid_ack', 'http']),
  }),
]);
export type BacklinkCheckObservation = z.infer<typeof observationSchema>;

function equalUnits(
  left: Readonly<SubmissionUnitVector>,
  right: Readonly<SubmissionUnitVector>,
) {
  return (
    left.tokens === right.tokens &&
    left.indexer === right.indexer &&
    left.checker === right.checker
  );
}

export const createBacklinkCheckResultSchema = z
  .strictObject({
    mode: modeSchema.optional(),
    status: z.enum([
      'preview',
      'blocked',
      'prepared',
      'dispatching',
      'accepted',
      'rejected',
      'unknown',
      'cancelled',
    ]),
    request: requestSchema.optional(),
    quote: backlinkCheckQuoteSchema.optional(),
    authorization: backlinkCheckAuthorizationSchema.optional(),
    replayed: z.literal(true).optional(),
    intent: intentSchema.optional(),
    observation: observationSchema.optional(),
    error: errorSchema.optional(),
  })
  .superRefine((result, context) => {
    const invalid = () =>
      context.addIssue({
        code: 'custom',
        message: 'Invalid create-backlink-check result.',
      });
    const { request, quote, authorization, intent, observation, error } =
      result;
    if (
      request === undefined &&
      quote === undefined &&
      authorization === undefined
    ) {
      if (
        result.status !== 'blocked' ||
        !error ||
        !['InvalidInput', 'InternalError'].includes(error.code) ||
        intent !== undefined ||
        observation !== undefined ||
        result.replayed !== undefined ||
        error.unit !== undefined ||
        error.lastObservedState !== undefined
      )
        invalid();
      return;
    }
    if (!result.mode || !request || !quote || !authorization) {
      invalid();
      return;
    }
    if (error && ['InvalidInput', 'InternalError'].includes(error.code))
      invalid();
    if (request.family !== family || request.providerRoute !== providerRoute)
      invalid();
    if (quote.availability === 'available') {
      const expected = totalReservation(
        quote.perUrlReservation,
        request.urlCount,
      );
      if (
        !expected ||
        !equalUnits(expected, quote.reservation) ||
        quote.perUrlReservation.tokens < 2 ||
        quote.fingerprint !==
          quoteFingerprint(
            request,
            quote.perUrlReservation,
            quote.reservation,
          ) ||
        authorization.state === 'reservation_unavailable'
      )
        invalid();
    } else if (
      authorization.state === 'configured' ||
      authorization.stateChecked ||
      intent ||
      observation ||
      result.replayed !== undefined
    ) {
      invalid();
    }
    if (result.mode === 'preview') {
      if (
        result.status !== 'preview' ||
        authorization.stateChecked ||
        intent ||
        observation ||
        error ||
        result.replayed !== undefined
      )
        invalid();
      return;
    }
    if (
      result.status === 'preview' ||
      (result.status === 'accepted' ? error !== undefined : error === undefined)
    )
      invalid();
    if ((result.status !== 'blocked') !== (intent !== undefined)) invalid();
    if (intent) {
      if (
        quote.availability !== 'available' ||
        authorization.state !== 'configured' ||
        !authorization.stateChecked ||
        intent.state !== result.status ||
        intent.policyRevision !== authorization.policyRevision ||
        intent.policyDigest !== authorization.policyDigest ||
        (intent.providerType !== undefined && intent.providerType !== family) ||
        !equalUnits(intent.reservation, quote.reservation)
      )
        invalid();
    }
    if (result.replayed && (!intent || observation)) invalid();
    if (
      result.status === 'accepted' &&
      observation !== undefined &&
      (observation.kind !== 'accepted_ack' || !observation.recorded)
    )
      invalid();
    if (observation) {
      if (
        quote.availability !== 'available' ||
        authorization.state !== 'configured' ||
        !authorization.stateChecked
      )
        invalid();
      if (
        observation.kind === 'accepted_ack' &&
        (observation.type !== family ||
          (observation.recorded &&
            (intent?.state !== 'accepted' ||
              intent.providerTaskId !== observation.taskId ||
              intent.providerType !== observation.type)))
      )
        invalid();
      if (observation.recorded) {
        const state =
          observation.kind === 'accepted_ack'
            ? 'accepted'
            : observation.kind === 'ambiguous'
              ? 'unknown'
              : 'rejected';
        if (intent?.state !== state) invalid();
      } else if (
        !(
          result.status === 'dispatching' &&
          error?.code === 'OutcomePersistenceFailed'
        ) &&
        !(
          result.status === 'blocked' &&
          error?.code === 'StateUnavailable' &&
          error.lastObservedState === 'dispatching'
        )
      )
        invalid();
    }
    if (
      error?.lastObservedState &&
      (result.status !== 'blocked' ||
        !authorization.stateChecked ||
        intent ||
        !observation ||
        observation.recorded)
    )
      invalid();
  });
export type CreateBacklinkCheckResult = z.infer<
  typeof createBacklinkCheckResultSchema
>;

// Validate application errors locally too; the SDK skips isError output checks.
export function createBacklinkCheckToolResult(value: unknown) {
  const parsed = createBacklinkCheckResultSchema.safeParse(value);
  const result: CreateBacklinkCheckResult = parsed.success
    ? parsed.data
    : {
        status: 'blocked',
        error: createBacklinkCheckError('InternalError'),
      };
  return {
    isError: result.status !== 'preview' && result.status !== 'accepted',
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export type NormalizedCreateBacklinkCheckOutcome =
  | { kind: 'accepted'; taskId: string; type: typeof family }
  | { kind: 'rejected'; code: 1 | 2 }
  | { kind: 'unknown'; cause: 'invalid_ack' | 'http' };

export function normalizeCreateBacklinkCheckOutcome(
  prepared: PreparedCreateBacklinkCheckRequest,
  httpStatus: number,
  response: unknown,
): NormalizedCreateBacklinkCheckOutcome {
  const unknown = {
    kind: 'unknown',
    cause: httpStatus === 200 ? 'invalid_ack' : 'http',
  } as const;
  if (
    typeof response !== 'object' ||
    response === null ||
    Array.isArray(response) ||
    !Object.hasOwn(response, 'code')
  )
    return unknown;
  const root = response as Record<string, unknown>;
  if (
    [200, 401, 402, 413].includes(httpStatus) &&
    (root.code === 1 || root.code === 2) &&
    !Object.hasOwn(root, 'task_id')
  )
    return { kind: 'rejected', code: root.code };
  if (
    httpStatus !== 200 ||
    root.code !== 0 ||
    !Object.hasOwn(root, 'task_id') ||
    !Object.hasOwn(root, 'type') ||
    root.type !== prepared.request.family
  )
    return unknown;
  const id = providerTaskIdSchema.safeParse(root.task_id);
  if (!id.success) return unknown;
  if (
    (Object.hasOwn(root, 'pay_per_indexed') &&
      root.pay_per_indexed !== false) ||
    (Object.hasOwn(root, 'drip_feed') && root.drip_feed !== false) ||
    Object.hasOwn(root, 'drip_feed_days')
  )
    return unknown;
  return { kind: 'accepted', taskId: id.data, type: family };
}
