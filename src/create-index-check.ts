import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  submissionLimits,
  modeSchema,
  digestSchema,
  visibleLabelSchema,
  safeInteger,
  safeNonnegativeInteger,
  submittedUrlSchema,
  titleSchema,
  providerTaskIdSchema,
  acknowledgementSchema,
  submissionUnitVectorSchema,
  submissionErrorCodeSchema,
  type IndexCheckReservationSource,
  type SubmissionUnitVector,
} from './submission-contract';

export const indexCheckQuoteVersion =
  'speedyindex-index-check-reservation-2026-10-21-v1';
const familySchema = z.enum([
  'google/checker',
  'yandex/checker',
  'bing/checker',
]);
export type IndexCheckFamily = z.infer<typeof familySchema>;
const routes = {
  'google/checker': '/v2/task/google/checker/create',
  'yandex/checker': '/v2/task/yandex/checker/create',
  'bing/checker': '/v2/task/bing/checker/create',
} as const;

function bodyFor(input: {
  readonly urls: readonly string[];
  readonly title?: string | undefined;
}) {
  return JSON.stringify({
    ...(input.title === undefined ? {} : { title: input.title }),
    urls: input.urls,
  });
}
const requestFieldsSchema = z
  .strictObject({
    mode: modeSchema,
    searchEngine: z.enum(['google', 'yandex', 'bing']),
    urls: z.array(submittedUrlSchema).min(1).max(submissionLimits.urls),
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
export const createIndexCheckInputSchema = requestFieldsSchema.refine(
  (input) =>
    Buffer.byteLength(bodyFor(input), 'utf8') <=
    submissionLimits.providerBodyBytes,
  { path: ['urls'], message: 'Serialized provider request is too large.' },
);
export type CreateIndexCheckInput = z.infer<typeof createIndexCheckInputSchema>;
const requestSchema = z.strictObject({
  family: familySchema,
  providerRoute: z.enum([
    routes['google/checker'],
    routes['yandex/checker'],
    routes['bing/checker'],
  ]),
  urlCount: z.number().int().min(1).max(submissionLimits.urls),
  providerBodyBytes: z
    .number()
    .int()
    .min(1)
    .max(submissionLimits.providerBodyBytes),
  payloadDigest: digestSchema,
});
export type IndexCheckRequestSummary = z.infer<typeof requestSchema>;
type FrozenInput = Readonly<
  Omit<CreateIndexCheckInput, 'urls' | 'acknowledgement'>
> & {
  readonly urls: readonly string[];
  readonly acknowledgement?:
    Readonly<z.infer<typeof acknowledgementSchema>> | undefined;
};
export interface PreparedCreateIndexCheckRequest {
  readonly input: FrozenInput;
  readonly body: string;
  readonly request: Readonly<IndexCheckRequestSummary>;
}
function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function buildCreateIndexCheckRequest(
  value: unknown,
): PreparedCreateIndexCheckRequest {
  const parsed = requestFieldsSchema.safeParse(value);
  if (!parsed.success) throw new CreateIndexCheckError('InvalidInput');
  const input = Object.freeze({
    ...parsed.data,
    urls: Object.freeze(parsed.data.urls),
    ...(parsed.data.acknowledgement === undefined
      ? {}
      : {
          acknowledgement: Object.freeze(parsed.data.acknowledgement),
        }),
  });
  const body = bodyFor(input);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > submissionLimits.providerBodyBytes)
    throw new CreateIndexCheckError('InvalidInput');
  const family = `${input.searchEngine}/checker` as IndexCheckFamily;
  return Object.freeze({
    input,
    body,
    request: Object.freeze({
      family,
      providerRoute: routes[family],
      urlCount: input.urls.length,
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
  version: z.literal(indexCheckQuoteVersion),
  basis: z.literal('operator_configured_reservation'),
  providerEnforced: z.literal(false),
  providerFeesKnown: z.literal(false),
};
export const indexCheckQuoteSchema = z.discriminatedUnion('availability', [
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
export type IndexCheckQuote = z.infer<typeof indexCheckQuoteSchema>;
function totalReservation(
  perUrl: Readonly<SubmissionUnitVector>,
  count: number,
): SubmissionUnitVector | undefined {
  const totals = [perUrl.tokens, perUrl.indexer, perUrl.checker].map(
    (n) => BigInt(n) * BigInt(count),
  );
  if (totals.some((n) => n > BigInt(Number.MAX_SAFE_INTEGER))) return undefined;
  return {
    tokens: Number(totals[0]!),
    indexer: Number(totals[1]!),
    checker: Number(totals[2]!),
  };
}
function quoteFingerprint(
  request: Readonly<IndexCheckRequestSummary>,
  perUrl: Readonly<SubmissionUnitVector>,
  reservation: Readonly<SubmissionUnitVector>,
) {
  return hash(
    'speedyindex-create-index-check-reservation-v1\0' +
      JSON.stringify({
        version: indexCheckQuoteVersion,
        family: request.family,
        providerRoute: request.providerRoute,
        payloadDigest: request.payloadDigest,
        urlCount: request.urlCount,
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
export function quoteIndexCheckRequest(
  prepared: PreparedCreateIndexCheckRequest,
  source: IndexCheckReservationSource,
): Readonly<IndexCheckQuote> {
  const common = {
    version: indexCheckQuoteVersion,
    basis: 'operator_configured_reservation' as const,
    providerEnforced: false as const,
    providerFeesKnown: false as const,
  } as const;
  const unavailable = (
    reason: z.infer<typeof unavailableReasonSchema>,
  ): Readonly<IndexCheckQuote> =>
    Object.freeze({ ...common, availability: 'unavailable', reason });
  if (source.state === 'unconfigured')
    return unavailable('policy_unconfigured');
  if (source.state === 'invalid') return unavailable('policy_invalid');
  const profile = source.profiles?.[prepared.input.searchEngine];
  if (!profile) return unavailable('profile_missing');
  const reservation = totalReservation(profile, prepared.request.urlCount);
  if (!reservation) return unavailable('reservation_overflow');
  const perUrlReservation = Object.freeze({
    tokens: profile.tokens,
    indexer: profile.indexer,
    checker: profile.checker,
  });
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

export const createIndexCheckErrorCodeSchema = z.union([
  submissionErrorCodeSchema,
  z.enum(['ReservationProfileRequired', 'ReservationOverflow']),
]);
export type CreateIndexCheckErrorCode = z.infer<
  typeof createIndexCheckErrorCodeSchema
>;
const errorMessages: Record<CreateIndexCheckErrorCode, string> = {
  InvalidInput: 'Invalid create-index-check request.',
  InternalError: 'Could not produce a valid create-index-check result.',
  WritesDisabled: 'Index-check submissions are disabled.',
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
  ProviderRejected: 'SpeedyIndex rejected the index-check submission.',
  OutcomeUnknown: 'The index-check submission outcome is unknown.',
  Cancelled: 'The index-check submission was cancelled.',
  ReservationProfileRequired:
    'Configure a trusted reservation profile for this search engine.',
  ReservationOverflow:
    'The configured reservation exceeds supported integer bounds.',
};
export class CreateIndexCheckError extends Error {
  constructor(readonly code: CreateIndexCheckErrorCode) {
    super(errorMessages[code]);
    this.name = 'CreateIndexCheckError';
  }
}
export function createIndexCheckError(code: CreateIndexCheckErrorCode) {
  return { code, message: errorMessages[code] };
}
const errorSchema = z
  .strictObject({
    code: createIndexCheckErrorCodeSchema,
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

export const indexCheckAuthorizationSchema = z
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
      .refine((p) => p.endMs > p.startMs)
      .optional(),
    fingerprint: digestSchema.optional(),
  })
  .superRefine((auth, context) => {
    const metadata = [
      auth.mode,
      auth.policyRevision,
      auth.policyDigest,
      auth.budgetScope,
      auth.caps,
      auth.period,
      auth.fingerprint,
    ];
    if (
      auth.state === 'configured'
        ? metadata.some((v) => v === undefined)
        : auth.stateChecked || metadata.some((v) => v !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid authorization summary.',
      });
  });
export type IndexCheckAuthorization = z.infer<
  typeof indexCheckAuthorizationSchema
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
    providerType: familySchema.optional(),
  })
  .refine((intent) =>
    intent.state === 'accepted'
      ? intent.providerTaskId !== undefined && intent.providerType !== undefined
      : intent.providerTaskId === undefined &&
        intent.providerType === undefined,
  );
export const indexCheckObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accepted_ack'),
    recorded: z.boolean(),
    taskId: providerTaskIdSchema,
    type: familySchema,
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
export type IndexCheckObservation = z.infer<typeof indexCheckObservationSchema>;
function equalUnits(left: SubmissionUnitVector, right: SubmissionUnitVector) {
  return (
    left.tokens === right.tokens &&
    left.indexer === right.indexer &&
    left.checker === right.checker
  );
}
export const createIndexCheckResultSchema = z
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
    quote: indexCheckQuoteSchema.optional(),
    authorization: indexCheckAuthorizationSchema.optional(),
    replayed: z.literal(true).optional(),
    intent: intentSchema.optional(),
    observation: indexCheckObservationSchema.optional(),
    error: errorSchema.optional(),
  })
  .superRefine((result, context) => {
    const invalid = () =>
      context.addIssue({
        code: 'custom',
        message: 'Invalid create-index-check result.',
      });
    const {
      request,
      quote,
      authorization: auth,
      intent,
      observation,
      error,
    } = result;
    if (request === undefined && quote === undefined && auth === undefined) {
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
    if (!result.mode || !request || !quote || !auth) {
      invalid();
      return;
    }
    if (error && ['InvalidInput', 'InternalError'].includes(error.code))
      invalid();
    if (request.providerRoute !== routes[request.family]) invalid();
    if (quote.availability === 'available') {
      const expected = totalReservation(
        quote.perUrlReservation,
        request.urlCount,
      );
      if (
        !expected ||
        !equalUnits(expected, quote.reservation) ||
        quote.perUrlReservation.tokens <
          (request.family === 'google/checker' ? 3 : 2) ||
        quote.fingerprint !==
          quoteFingerprint(
            request,
            quote.perUrlReservation,
            quote.reservation,
          ) ||
        auth.state === 'reservation_unavailable'
      )
        invalid();
    } else if (
      auth.state === 'configured' ||
      auth.stateChecked ||
      intent ||
      observation ||
      result.replayed !== undefined
    ) {
      invalid();
    }
    if (result.mode === 'preview') {
      if (
        result.status !== 'preview' ||
        auth.stateChecked ||
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
        auth.state !== 'configured' ||
        !auth.stateChecked ||
        intent.state !== result.status ||
        intent.policyRevision !== auth.policyRevision ||
        intent.policyDigest !== auth.policyDigest ||
        (intent.providerType !== undefined &&
          intent.providerType !== request.family) ||
        (quote.availability === 'available' &&
          !equalUnits(intent.reservation, quote.reservation))
      )
        invalid();
    }
    if (result.replayed && (!intent || observation)) invalid();
    if (
      result.status === 'accepted' &&
      observation &&
      (observation.kind !== 'accepted_ack' || !observation.recorded)
    )
      invalid();
    if (observation) {
      if (
        quote.availability !== 'available' ||
        auth.state !== 'configured' ||
        !auth.stateChecked
      )
        invalid();
      if (
        observation.kind === 'accepted_ack' &&
        (observation.type !== request.family ||
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
        !auth.stateChecked ||
        intent ||
        !observation ||
        observation.recorded)
    )
      invalid();
  });
export type CreateIndexCheckResult = z.infer<
  typeof createIndexCheckResultSchema
>;

// Validate application errors locally too; the SDK skips isError output checks.
export function createIndexCheckToolResult(value: unknown) {
  const parsed = createIndexCheckResultSchema.safeParse(value);
  const result: CreateIndexCheckResult = parsed.success
    ? parsed.data
    : {
        status: 'blocked',
        error: createIndexCheckError('InternalError'),
      };
  return {
    isError: result.status !== 'preview' && result.status !== 'accepted',
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export type NormalizedCreateIndexCheckOutcome =
  | { kind: 'accepted'; taskId: string; type: IndexCheckFamily }
  | { kind: 'rejected'; code: 1 | 2 }
  | { kind: 'unknown'; cause: 'invalid_ack' | 'http' };
export function normalizeCreateIndexCheckOutcome(
  prepared: PreparedCreateIndexCheckRequest,
  httpStatus: number,
  response: unknown,
): NormalizedCreateIndexCheckOutcome {
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
  return { kind: 'accepted', taskId: id.data, type: prepared.request.family };
}
