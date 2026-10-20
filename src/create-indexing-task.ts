import { createHash } from 'node:crypto';
import { z } from 'zod';

export const indexingQuoteVersion = 'speedyindex-indexing-batch-2026-10-20-v1';
export const indexingLimits = Object.freeze({
  urls: 10_000,
  urlBytes: 8_192,
  titleBytes: 1_024,
  taskIdBytes: 4_096,
  providerBodyBytes: 2_097_152,
  responseBytes: 65_536,
});

const modeSchema = z.enum(['preview', 'submit']);
const indexingFamilySchema = z.enum(['google/indexer', 'yandex/indexer']);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const visibleLabelSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
const safeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const safeNonnegativeInteger = safeInteger.nonnegative();
const routes = {
  'google/indexer': '/v2/task/google/indexer/create',
  'yandex/indexer': '/v2/task/yandex/indexer/create',
} as const;

function validText(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const submittedUrlSchema = z.string().refine((value) => {
  if (
    !validText(value, indexingLimits.urlBytes) ||
    value.includes(' ') ||
    value.trim() !== value ||
    !/^https?:\/\//i.test(value)
  )
    return false;
  try {
    const parsed = new URL(value);
    const authority = value
      .slice(value.indexOf('//') + 2)
      .split(/[/?#\\]/, 1)[0]!;
    return (
      parsed.host.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      !authority.includes('@')
    );
  } catch {
    return false;
  }
}, 'Invalid submitted URL.');
const titleSchema = z
  .string()
  .refine(
    (value) => validText(value, indexingLimits.titleBytes),
    'Invalid submission title.',
  );
const providerTaskIdSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 && validText(value, indexingLimits.taskIdBytes),
    'Invalid provider task ID.',
  );
const acknowledgementSchema = z.strictObject({
  quoteFingerprint: digestSchema,
  authorizationFingerprint: digestSchema,
});

function serializeProviderBody(input: {
  searchEngine: 'google' | 'yandex';
  urls: readonly string[];
  title?: string | undefined;
  dripFeedDays?: number | undefined;
}) {
  return JSON.stringify({
    ...(input.title === undefined ? {} : { title: input.title }),
    urls: input.urls,
    ...(input.searchEngine === 'google'
      ? {
          pay_per_indexed: true,
          drip_feed: input.dripFeedDays !== undefined,
          ...(input.dripFeedDays === undefined
            ? {}
            : { drip_feed_days: input.dripFeedDays }),
        }
      : {}),
  });
}

const requestFieldsSchema = z
  .strictObject({
    mode: modeSchema,
    searchEngine: z.enum(['google', 'yandex']),
    urls: z.array(submittedUrlSchema).min(1).max(indexingLimits.urls),
    title: titleSchema.optional(),
    dripFeedDays: z.number().int().min(2).max(30).optional(),
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
    if (
      input.dripFeedDays !== undefined &&
      (input.searchEngine !== 'google' ||
        input.dripFeedDays > input.urls.length)
    )
      issue('dripFeedDays', 'Invalid drip-feed selection.');
    if (new Set(input.urls).size !== input.urls.length)
      issue('urls', 'Submitted URLs must be unique.');
  });

export const createIndexingTaskInputSchema = requestFieldsSchema.refine(
  (input) =>
    Buffer.byteLength(serializeProviderBody(input), 'utf8') <=
    indexingLimits.providerBodyBytes,
  { path: ['urls'], message: 'Serialized provider request is too large.' },
);

export type CreateIndexingTaskInput = z.infer<
  typeof createIndexingTaskInputSchema
>;
export type IndexingFamily = z.infer<typeof indexingFamilySchema>;
export const indexingUnitVectorSchema = z.strictObject({
  tokens: safeNonnegativeInteger,
  indexer: safeNonnegativeInteger,
  checker: safeNonnegativeInteger,
});
export type IndexingUnitVector = z.infer<typeof indexingUnitVectorSchema>;
const requestSchema = z.strictObject({
  family: indexingFamilySchema,
  providerRoute: z.enum([routes['google/indexer'], routes['yandex/indexer']]),
  urlCount: z.number().int().min(1).max(indexingLimits.urls),
  providerBodyBytes: z
    .number()
    .int()
    .min(1)
    .max(indexingLimits.providerBodyBytes),
  payloadDigest: digestSchema,
});
const quoteSchema = z.strictObject({
  version: z.literal(indexingQuoteVersion),
  fingerprint: digestSchema,
  maximumExposure: indexingUnitVectorSchema,
  basis: z.literal('documented_independent_maxima'),
  providerEnforced: z.literal(false),
});
export type IndexingRequestSummary = z.infer<typeof requestSchema>;
export type IndexingQuote = z.infer<typeof quoteSchema>;

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function maximumExposure(
  family: IndexingFamily,
  count: number,
): IndexingUnitVector {
  return family === 'google/indexer'
    ? { tokens: 100 * count, indexer: 0, checker: 0 }
    : { tokens: 20 * count, indexer: count, checker: 0 };
}

function quoteFingerprint(
  request: IndexingRequestSummary,
  exposure: IndexingUnitVector,
) {
  return hash(
    'speedyindex-create-quote-v1\0' +
      JSON.stringify({
        version: indexingQuoteVersion,
        family: request.family,
        providerRoute: request.providerRoute,
        payloadDigest: request.payloadDigest,
        urlCount: request.urlCount,
        maximumExposure: {
          tokens: exposure.tokens,
          indexer: exposure.indexer,
          checker: exposure.checker,
        },
      }),
  );
}

type FrozenInput = Readonly<
  Omit<CreateIndexingTaskInput, 'urls' | 'acknowledgement'>
> & {
  readonly urls: readonly string[];
  readonly acknowledgement?:
    Readonly<z.infer<typeof acknowledgementSchema>> | undefined;
};
export interface PreparedCreateIndexingRequest {
  readonly input: FrozenInput;
  readonly body: string;
  readonly request: Readonly<IndexingRequestSummary>;
  readonly quote: Readonly<Omit<IndexingQuote, 'maximumExposure'>> & {
    readonly maximumExposure: Readonly<IndexingUnitVector>;
  };
}

export function buildCreateIndexingRequest(
  value: unknown,
): PreparedCreateIndexingRequest {
  // Check the same public fields, then serialize the frozen copy once. The
  // public schema separately checks aggregate bytes for SDK input validation.
  const parsed = requestFieldsSchema.safeParse(value);
  if (!parsed.success) throw new CreateIndexingTaskError('InvalidInput');
  const input = Object.freeze({
    ...parsed.data,
    urls: Object.freeze(parsed.data.urls),
    ...(parsed.data.acknowledgement === undefined
      ? {}
      : { acknowledgement: Object.freeze(parsed.data.acknowledgement) }),
  });
  const body = serializeProviderBody(input);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > indexingLimits.providerBodyBytes)
    throw new CreateIndexingTaskError('InvalidInput');
  const family = `${input.searchEngine}/indexer` as IndexingFamily;
  const request = Object.freeze({
    family,
    providerRoute: routes[family],
    urlCount: input.urls.length,
    providerBodyBytes: bodyBytes,
    payloadDigest: hash(body),
  });
  const exposure = Object.freeze(maximumExposure(family, request.urlCount));
  const quote = Object.freeze({
    version: indexingQuoteVersion,
    fingerprint: quoteFingerprint(request, exposure),
    maximumExposure: exposure,
    basis: 'documented_independent_maxima' as const,
    providerEnforced: false as const,
  });
  return Object.freeze({ input, body, request, quote });
}

export const createIndexingTaskErrorCodeSchema = z.enum([
  'InvalidInput',
  'InternalError',
  'WritesDisabled',
  'InvalidPolicy',
  'MissingCredentials',
  'CredentialMismatch',
  'AcknowledgementRequired',
  'AcknowledgementMismatch',
  'StateUnavailable',
  'SubmissionBusy',
  'RequestIdConflict',
  'UrlOverlap',
  'BudgetExceeded',
  'StalePeriodContext',
  'LedgerBusy',
  'DispatchClaimLost',
  'OutcomePersistenceFailed',
  'ProviderRejected',
  'OutcomeUnknown',
  'Cancelled',
]);
export type CreateIndexingTaskErrorCode = z.infer<
  typeof createIndexingTaskErrorCodeSchema
>;
const errorMessages: Record<CreateIndexingTaskErrorCode, string> = {
  InvalidInput: 'Invalid create-indexing request.',
  InternalError: 'Could not produce a valid create-indexing result.',
  WritesDisabled: 'Indexing submissions are disabled.',
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
  ProviderRejected: 'SpeedyIndex rejected the indexing submission.',
  OutcomeUnknown: 'The indexing submission outcome is unknown.',
  Cancelled: 'The indexing submission was cancelled.',
};
export class CreateIndexingTaskError extends Error {
  constructor(readonly code: CreateIndexingTaskErrorCode) {
    super(errorMessages[code]);
    this.name = 'CreateIndexingTaskError';
  }
}
export function createIndexingTaskError(code: CreateIndexingTaskErrorCode) {
  return { code, message: errorMessages[code] };
}

const errorSchema = z
  .strictObject({
    code: createIndexingTaskErrorCodeSchema,
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
export const indexingAuthorizationSchema = z
  .strictObject({
    state: z.enum([
      'unconfigured',
      'disabled',
      'invalid',
      'credential_missing',
      'credential_mismatch',
      'configured',
    ]),
    stateChecked: z.boolean(),
    mode: z.enum(['caller_acknowledgement', 'operator_policy']).optional(),
    policyRevision: visibleLabelSchema.optional(),
    policyDigest: digestSchema.optional(),
    budgetScope: visibleLabelSchema.optional(),
    caps: indexingUnitVectorSchema.optional(),
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
      ((authorization.state === 'configured' ||
        metadata.some((v) => v !== undefined)) &&
        metadata.some((v) => v === undefined)) ||
      (authorization.stateChecked && authorization.state !== 'configured')
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid authorization summary.',
      });
  });
export type IndexingAuthorization = z.infer<typeof indexingAuthorizationSchema>;
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
    reservation: indexingUnitVectorSchema,
    providerTaskId: providerTaskIdSchema.optional(),
    providerType: indexingFamilySchema.optional(),
  })
  .refine((intent) =>
    intent.state === 'accepted'
      ? intent.providerTaskId !== undefined && intent.providerType !== undefined
      : intent.providerTaskId === undefined &&
        intent.providerType === undefined,
  );
export const indexingObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accepted_ack'),
    recorded: z.boolean(),
    taskId: providerTaskIdSchema,
    type: indexingFamilySchema,
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
export type IndexingObservation = z.infer<typeof indexingObservationSchema>;

export const createIndexingTaskResultSchema = z
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
    quote: quoteSchema.optional(),
    authorization: indexingAuthorizationSchema.optional(),
    replayed: z.boolean().optional(),
    intent: intentSchema.optional(),
    observation: indexingObservationSchema.optional(),
    error: errorSchema.optional(),
  })
  .superRefine((result, context) => {
    const invalid = () =>
      context.addIssue({
        code: 'custom',
        message: 'Invalid create-indexing result.',
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
        error.lastObservedState !== undefined ||
        error.unit !== undefined
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
    const exposure = maximumExposure(request.family, request.urlCount);
    if (
      request.providerRoute !== routes[request.family] ||
      quote.maximumExposure.tokens !== exposure.tokens ||
      quote.maximumExposure.indexer !== exposure.indexer ||
      quote.maximumExposure.checker !== exposure.checker ||
      quote.fingerprint !== quoteFingerprint(request, exposure)
    )
      invalid();
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
    if (
      intent &&
      (intent.state !== result.status ||
        !authorization.stateChecked ||
        (intent.providerType !== undefined &&
          intent.providerType !== request.family) ||
        intent.reservation.tokens !== exposure.tokens ||
        intent.reservation.indexer !== exposure.indexer ||
        intent.reservation.checker !== exposure.checker)
    )
      invalid();
    if (
      (result.replayed !== undefined && !intent) ||
      (result.replayed && observation)
    )
      invalid();
    if (
      observation?.kind === 'accepted_ack' &&
      (observation.type !== request.family ||
        (observation.recorded &&
          (intent?.state !== 'accepted' ||
            intent.providerTaskId !== observation.taskId ||
            intent.providerType !== observation.type)))
    )
      invalid();
    if (
      observation?.recorded &&
      observation.kind !== 'accepted_ack' &&
      intent?.state !==
        (observation.kind === 'ambiguous' ? 'unknown' : 'rejected')
    )
      invalid();
    if (
      error?.lastObservedState &&
      (result.status !== 'blocked' || !authorization.stateChecked || intent)
    )
      invalid();
  });
export type CreateIndexingTaskResult = z.infer<
  typeof createIndexingTaskResultSchema
>;

// The SDK may reject input before the callback. This adapter validates only
// application results, including isError results the SDK does not validate.
export function createIndexingTaskToolResult(value: unknown) {
  const parsed = createIndexingTaskResultSchema.safeParse(value);
  const result: CreateIndexingTaskResult = parsed.success
    ? parsed.data
    : {
        status: 'blocked',
        error: createIndexingTaskError('InternalError'),
      };
  return {
    isError: result.status !== 'preview' && result.status !== 'accepted',
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export type NormalizedCreateIndexingOutcome =
  | { kind: 'accepted'; taskId: string; type: IndexingFamily }
  | { kind: 'rejected'; code: 1 | 2 }
  | { kind: 'unknown'; cause: 'invalid_ack' | 'http' };

// A decoded root observation is not a durable ledger outcome. Stream reading,
// UTF-8/JSON decoding and recording belong to the later guarded host.
export function normalizeCreateIndexingOutcome(
  prepared: PreparedCreateIndexingRequest,
  httpStatus: number,
  response: unknown,
): NormalizedCreateIndexingOutcome {
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
  const taskId = providerTaskIdSchema.safeParse(root.task_id);
  if (!taskId.success) return unknown;
  const dripDays = prepared.input.dripFeedDays;
  if (
    (Object.hasOwn(root, 'pay_per_indexed') && root.pay_per_indexed !== true) ||
    (Object.hasOwn(root, 'drip_feed') &&
      root.drip_feed !== (dripDays !== undefined)) ||
    (Object.hasOwn(root, 'drip_feed_days') &&
      (dripDays === undefined ||
        !Number.isInteger(root.drip_feed_days) ||
        root.drip_feed_days !== dripDays))
  )
    return unknown;
  return {
    kind: 'accepted',
    taskId: taskId.data,
    type: prepared.request.family,
  };
}
