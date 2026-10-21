import { z } from 'zod';
import type { TaskFamily } from './task-status';

export const submissionLimits = Object.freeze({
  urls: 10_000,
  urlBytes: 8_192,
  titleBytes: 1_024,
  taskIdBytes: 4_096,
  providerBodyBytes: 2_097_152,
  responseBytes: 65_536,
});

export const modeSchema = z.enum(['preview', 'submit']);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const visibleLabelSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
export const safeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const safeNonnegativeInteger = safeInteger.nonnegative();
export function validText(value: string, maxBytes: number) {
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

export const submittedUrlSchema = z.string().refine((value) => {
  if (
    !validText(value, submissionLimits.urlBytes) ||
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
export const titleSchema = z
  .string()
  .refine(
    (value) => validText(value, submissionLimits.titleBytes),
    'Invalid submission title.',
  );
export const providerTaskIdSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 && validText(value, submissionLimits.taskIdBytes),
    'Invalid provider task ID.',
  );
export const acknowledgementSchema = z.strictObject({
  quoteFingerprint: digestSchema,
  authorizationFingerprint: digestSchema,
});

export const submissionUnitVectorSchema = z.strictObject({
  tokens: safeNonnegativeInteger,
  indexer: safeNonnegativeInteger,
  checker: safeNonnegativeInteger,
});
export type SubmissionUnitVector = z.infer<typeof submissionUnitVectorSchema>;

export type IndexCheckEngine = 'google' | 'yandex' | 'bing';
export type IndexCheckReservationProfiles = Readonly<
  Partial<Record<IndexCheckEngine, Readonly<SubmissionUnitVector> | undefined>>
>;
export type IndexCheckReservationSource =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'invalid' }
  | {
      readonly state: 'loaded';
      readonly profiles?: IndexCheckReservationProfiles;
    };
export type BacklinkCheckReservationSource =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'invalid' }
  | {
      readonly state: 'loaded';
      readonly profile?: Readonly<SubmissionUnitVector>;
    };

export const submissionErrorCodeSchema = z.enum([
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
export type SubmissionErrorCode = z.infer<typeof submissionErrorCodeSchema>;
export const submissionAuthorizationSchema = z
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
export type SubmissionAuthorization = z.infer<
  typeof submissionAuthorizationSchema
>;
// Pure transport/coordinator DTOs. Strategies are private trusted host wiring;
// none of these values chooses a route or authority from public MCP input.
export interface SubmissionRequestSummary {
  readonly family: TaskFamily;
  readonly providerRoute: `/v2/task/${TaskFamily}/create`;
  readonly urlCount: number;
  readonly providerBodyBytes: number;
  readonly payloadDigest: string;
}

export type NormalizedSubmissionOutcome =
  | { kind: 'accepted'; taskId: string; type: TaskFamily }
  | { kind: 'rejected'; code: 1 | 2 }
  | { kind: 'unknown'; cause: 'invalid_ack' | 'http' };

export interface PreparedSubmission {
  readonly input: {
    readonly mode: 'preview' | 'submit';
    readonly requestId?: string | undefined;
    readonly urls: readonly string[];
    readonly acknowledgement?:
      Readonly<z.infer<typeof acknowledgementSchema>> | undefined;
  };
  readonly body: string;
  readonly request: SubmissionRequestSummary;
  readonly quote: Readonly<{ version: string; fingerprint?: string }>;
  readonly reservation?: Readonly<SubmissionUnitVector>;
  readonly unavailableError?: SubmissionError<
    SubmissionErrorCode | 'ReservationProfileRequired' | 'ReservationOverflow'
  >;
  normalizeOutcome(
    status: number,
    decoded: unknown,
  ): NormalizedSubmissionOutcome;
}

export interface SubmissionError<Code extends string = SubmissionErrorCode> {
  code: Code;
  message: string;
  unit?: 'tokens' | 'indexer' | 'checker';
  lastObservedState?: 'dispatching';
}

export type SubmissionObservation =
  | {
      kind: 'accepted_ack';
      recorded: boolean;
      taskId: string;
      type: TaskFamily;
    }
  | { kind: 'provider_rejection'; recorded: boolean; code: 1 | 2 }
  | {
      kind: 'not_sent';
      recorded: boolean;
      cause: 'cancelled' | 'local_validation';
    }
  | {
      kind: 'ambiguous';
      recorded: boolean;
      cause: 'cancelled' | 'timeout' | 'transport' | 'invalid_ack' | 'http';
    };
