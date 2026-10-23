import { version } from '../package.json';
import {
  buildCreateIndexingRequest,
  createIndexingTaskError,
  createIndexingTaskToolResult,
  normalizeCreateIndexingOutcome,
  type CreateIndexingTaskResult,
  type PreparedCreateIndexingRequest,
} from './create-indexing-task';
import {
  buildCreateIndexCheckRequest,
  createIndexCheckError,
  createIndexCheckToolResult,
  normalizeCreateIndexCheckOutcome,
  quoteIndexCheckRequest,
  type CreateIndexCheckResult,
  type CreateIndexCheckErrorCode,
  type IndexCheckAuthorization,
} from './create-index-check';
import {
  buildCreateBacklinkCheckRequest,
  createBacklinkCheckError,
  createBacklinkCheckToolResult,
  normalizeCreateBacklinkCheckOutcome,
  quoteBacklinkCheckRequest,
  type CreateBacklinkCheckResult,
} from './create-backlink-check';
import {
  submissionLimits,
  type PreparedSubmission,
  type SubmissionAuthorization,
  type SubmissionError,
  type SubmissionErrorCode,
  type SubmissionObservation,
} from './submission-contract';
import {
  createSubmissionContext,
  loadSubmissionConfiguration,
  type ConfiguredSubmission,
  type SubmissionConfiguration,
  type SubmissionContext,
} from './submission-policy';
import {
  openLedger,
  composeVerifiedRetryAdmission,
  type ProductionRetryComposition,
  type RetryCreatedOwner,
  type RetryOwnerIntent,
  type RetryOwnerWriter,
  type RetryPrepareHooks,
  type RetryLatestCollection,
  type RetryOwnerOptions,
  type RetryPlanView,
  SubmissionLedgerError,
  RetryLedgerError,
  readRetryReplay,
  computeRetryPlanFingerprint,
  type DispatchOutcome,
  type DispatchOutcomeToken,
  type IntentView,
  type LedgerPathOptions,
  type PrepareIntentInput,
  type SubmissionLedger,
} from './submission-ledger';

import { parseRetryPlanInput } from './plan-retry';
import {
  lowerPlanRetryResultByteLimit,
  planRetryToolResult,
  retryPlanResultFromView,
  type PlanRetryToolResult,
} from './plan-retry-result';
import { freezeSnapshot } from './retry-ledger-snapshot';
import {
  createRetryHistoryOwner,
  type RetryHistoryOwner,
  type RetryHistoryOwnerOptions,
} from './retry-history-owner';
import type { RetryHistoryToolResult } from './get-retry-history';
import {
  parseSubmitRetryInput,
  reconstructSubmitRetry,
  SubmitRetryError,
  submitRetryError,
  submitRetryResultSchema,
  submitRetryToolResult,
  type SubmitRetryInput,
  type SubmitRetryErrorCode,
  type SubmitRetryResult,
  type SubmitRetryToolResult,
} from './submit-retry';

type RetryCandidate = Extract<RetryLatestCollection, { kind: 'candidate' }>;
type RetryReconstruction = ReturnType<typeof reconstructSubmitRetry>;
type RetryFailure = Readonly<{
  status: 'blocked' | 'error';
  error: ReturnType<typeof submitRetryError>;
}>;
type CreatedRetryWork = Readonly<{
  owner: RetryCreatedOwner;
  request: PreparedCreateIndexingRequest;
  retry: Pick<
    RetryReconstruction['replay'],
    'parent' | 'sourceManifestDigest' | 'planFingerprint'
  >;
}>;

// Both operands are closed parsed/frozen JSON data. Array order is significant;
// object key insertion order is not. This compares values, not authority hashes.
function sameRetryData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => sameRetryData(value, right[i]))
    );
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameRetryData(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}
function retryFailure(
  status: RetryFailure['status'],
  code: SubmitRetryErrorCode,
): RetryFailure {
  return { status, error: submitRetryError(code) };
}
function collectionRetryFailure(
  view: Exclude<RetryLatestCollection, RetryCandidate>,
): RetryFailure {
  if (view.status === 'no_source')
    return retryFailure('blocked', 'SnapshotConflict');
  if (view.status === 'blocked') {
    if (view.blockers.length !== 1)
      return retryFailure('error', 'InternalError');
    const code = view.blockers[0];
    if (!code) return retryFailure('error', 'InternalError');
    return { status: 'blocked', error: submitRetryError(code) };
  }
  if (view.code === 'ReadFailed')
    return {
      status: 'error',
      error: submitRetryError('ReadFailed', {
        ...(view.phase === undefined ? {} : { phase: view.phase }),
        ...('cause' in view && view.cause !== undefined
          ? { cause: view.cause }
          : {}),
      }),
    };
  if (view.code === 'MissingCredentials' || view.code === 'SubmissionBusy')
    return retryFailure('blocked', view.code);
  if (
    [
      'InvalidInput',
      'Cancelled',
      'DeadlineExceeded',
      'ResourceLimitExceeded',
      'InternalError',
    ].includes(view.code)
  )
    return { status: 'error', error: submitRetryError(view.code) };
  return retryFailure('error', 'InternalError');
}
function preparationRetryFailure(
  error: unknown,
  config: ConfiguredSubmission,
  candidate: RetryCandidate | undefined,
  admissionAttempted: boolean,
): RetryFailure {
  if (error instanceof SubmitRetryError)
    return retryFailure('error', error.code);
  if (error instanceof RetryLedgerError) {
    switch (error.code) {
      case 'RetryCancelled':
        return retryFailure('error', 'Cancelled');
      case 'RetryProofExpired':
        return retryFailure('error', 'DeadlineExceeded');
      case 'SnapshotConflict':
      case 'RetryLineageConflict':
        return retryFailure('blocked', 'SnapshotConflict');
      case 'UnknownRetryDispatch':
      case 'UpgradeRequired':
      case 'SnapshotLimitExceeded':
        return retryFailure('blocked', error.code);
      case 'SnapshotUnavailable':
        return retryFailure(
          'blocked',
          error.reason === 'LimitExceeded'
            ? 'SnapshotLimitExceeded'
            : error.reason === 'UpgradeRequired'
              ? 'UpgradeRequired'
              : 'StateUnavailable',
        );
      case 'RetryPermissionDenied': {
        const policy = config.snapshot.policy.retry;
        if (!policy?.enabled)
          return retryFailure('blocked', 'RetryPolicyRequired');
        if (!candidate || !admissionAttempted)
          return retryFailure('error', 'InternalError');
        const provenance = candidate.view.source.provenance;
        if (
          (provenance === 'legacy_unattributed' ||
            provenance === 'external_unattributed') &&
          !policy.allowUnattributedParents
        )
          return retryFailure(
            'blocked',
            'UnattributedParentPermissionRequired',
          );
        if (
          provenance === 'local_standalone' ||
          ((provenance === 'legacy_unattributed' ||
            provenance === 'external_unattributed') &&
            policy.allowUnattributedParents)
        )
          return retryFailure('blocked', 'RetryAllowanceExceeded');
        return retryFailure('error', 'InternalError');
      }
      default:
        return retryFailure('error', 'InternalError');
    }
  }
  if (error instanceof SubmissionLedgerError) {
    switch (error.code) {
      case 'RequestIdConflict':
      case 'UrlOverlap':
      case 'StalePeriodContext':
      case 'LedgerBusy':
        return retryFailure('blocked', error.code);
      case 'BudgetExceeded':
        return {
          status: 'blocked',
          error: submitRetryError(
            'BudgetExceeded',
            error.unit === undefined ? {} : { unit: error.unit },
          ),
        };
      case 'LedgerUnavailable':
        return retryFailure('blocked', 'StateUnavailable');
      default:
        return retryFailure('error', 'InternalError');
    }
  }
  return retryFailure('error', 'InternalError');
}
function retryStoredResult(
  reconstruction: RetryReconstruction,
  intent: RetryOwnerIntent,
): SubmitRetryResult {
  const p = reconstruction.input.expectedPlan.identity.preimage;
  if (
    intent.periodId !== p.period.id ||
    intent.periodStartMs !== p.period.startMs
  )
    return submitRetryResultSchema.parse({
      status: 'blocked',
      requestId: reconstruction.input.requestId,
      error: submitRetryError('RequestIdConflict'),
    });
  return submitRetryResultSchema.parse({
    status: intent.state,
    requestId: reconstruction.input.requestId,
    replayed: true,
    request: reconstruction.request.request,
    quote: reconstruction.request.quote,
    retry: {
      parent: reconstruction.replay.parent,
      sourceManifestDigest: reconstruction.replay.sourceManifestDigest,
      planFingerprint: reconstruction.replay.planFingerprint,
    },
    intent: projectIntent(intent),
    ...(intent.state === 'accepted'
      ? {}
      : {
          error: submitRetryError(
            intent.state === 'cancelled'
              ? 'Cancelled'
              : intent.state === 'unknown'
                ? 'OutcomeUnknown'
                : 'DispatchClaimLost',
          ),
        }),
  });
}
function retryDurableEvidence(
  reconstruction: RetryReconstruction,
  intent: RetryOwnerIntent,
) {
  return {
    kind: 'durable' as const,
    request: reconstruction.request.request,
    quote: reconstruction.request.quote,
    retry: {
      parent: reconstruction.replay.parent,
      sourceManifestDigest: reconstruction.replay.sourceManifestDigest,
      planFingerprint: reconstruction.replay.planFingerprint,
    },
    intent: projectIntent(intent),
  };
}

type PublicError = SubmissionError<CreateIndexCheckErrorCode>;
interface BaseResult {
  mode: 'preview' | 'submit';
  request: PreparedSubmission['request'];
  quote: PreparedSubmission['quote'];
  authorization: Readonly<SubmissionAuthorization | IndexCheckAuthorization>;
}

// Internal operation wiring only. Execution ordering, state and transport belong
// to the one coordinator below; a strategy cannot choose acknowledgement timing.
interface SubmissionStrategy<Result> {
  build(
    value: unknown,
    configuration: SubmissionConfiguration,
  ): PreparedSubmission;
  permitted(configuration: ConfiguredSubmission): boolean;
  checked(value: unknown): Result;
  error(code: SubmissionErrorCode): PublicError;
}

const indexingStrategy: SubmissionStrategy<CreateIndexingTaskResult> =
  Object.freeze({
    build(value: unknown) {
      const prepared = buildCreateIndexingRequest(value);
      return Object.freeze({
        ...prepared,
        reservation: prepared.quote.maximumExposure,
        normalizeOutcome: (status: number, decoded: unknown) =>
          normalizeCreateIndexingOutcome(prepared, status, decoded),
      });
    },
    checked,
    error: createIndexingTaskError,
    permitted: () => true,
  });

const checkerStrategy: SubmissionStrategy<CreateIndexCheckResult> =
  Object.freeze({
    build(value: unknown, configuration: SubmissionConfiguration) {
      const prepared = buildCreateIndexCheckRequest(value);
      // An active host always quotes its admitted policy snapshot. A separate
      // key-free preview view cannot replace that authority or its profile.
      const source =
        configuration.state === 'configured'
          ? {
              state: 'loaded' as const,
              ...(configuration.snapshot.policy.indexCheckReservations ===
              undefined
                ? {}
                : {
                    profiles:
                      configuration.snapshot.policy.indexCheckReservations,
                  }),
            }
          : configuration.indexCheckReservationSource;
      const quote = quoteIndexCheckRequest(prepared, source);
      return Object.freeze({
        ...prepared,
        quote,
        ...(quote.availability === 'available'
          ? { reservation: quote.reservation }
          : {
              unavailableError: createIndexCheckError(
                quote.reason === 'reservation_overflow'
                  ? 'ReservationOverflow'
                  : quote.reason === 'policy_invalid'
                    ? 'InvalidPolicy'
                    : 'ReservationProfileRequired',
              ),
            }),
        normalizeOutcome: (status: number, decoded: unknown) =>
          normalizeCreateIndexCheckOutcome(prepared, status, decoded),
      });
    },
    permitted: (configuration: ConfiguredSubmission) =>
      configuration.snapshot.policy.allowIndexChecks === true,
    checked: (value: unknown) =>
      createIndexCheckToolResult(value).structuredContent,
    error: createIndexCheckError,
  });

const backlinkStrategy: SubmissionStrategy<CreateBacklinkCheckResult> =
  Object.freeze({
    build(value: unknown, configuration: SubmissionConfiguration) {
      const prepared = buildCreateBacklinkCheckRequest(value);
      const source =
        configuration.state === 'configured'
          ? {
              state: 'loaded' as const,
              ...(configuration.snapshot.policy.backlinkCheckReservations ===
              undefined
                ? {}
                : {
                    profile:
                      configuration.snapshot.policy.backlinkCheckReservations,
                  }),
            }
          : (configuration.backlinkCheckReservationSource ?? {
              state: 'unconfigured' as const,
            });
      const quote = quoteBacklinkCheckRequest(prepared, source);
      return Object.freeze({
        ...prepared,
        quote,
        ...(quote.availability === 'available'
          ? { reservation: quote.reservation }
          : {
              unavailableError: createBacklinkCheckError(
                quote.reason === 'reservation_overflow'
                  ? 'ReservationOverflow'
                  : quote.reason === 'policy_invalid'
                    ? 'InvalidPolicy'
                    : 'ReservationProfileRequired',
              ),
            }),
        normalizeOutcome: (status: number, decoded: unknown) =>
          normalizeCreateBacklinkCheckOutcome(prepared, status, decoded),
      });
    },
    permitted: (configuration: ConfiguredSubmission) =>
      configuration.snapshot.policy.allowBacklinkChecks === true,
    checked: (value: unknown) =>
      createBacklinkCheckToolResult(value).structuredContent,
    error: createBacklinkCheckError,
  });

export interface SubmissionHostOptions {
  /** Captured diagnostic-only wiring; no public selector or paid guard. */
  history?: RetryHistoryOwnerOptions;
  fetchRequest?: typeof fetch;
  clock?: () => number;
  openLedger?: (options: LedgerPathOptions) => SubmissionLedger;
  timeoutMs?: number;
  /** Trusted internal retry construction, never a tool or environment selector. */
  retry?: RetryOwnerOptions &
    Readonly<{
      monotonicMs?: () => number;
      preparationHooks?: RetryPrepareHooks;
    }>;
}

function checked(value: unknown): CreateIndexingTaskResult {
  return createIndexingTaskToolResult(value).structuredContent;
}

function safeLedgerError<Result>(
  strategy: SubmissionStrategy<Result>,
  error: unknown,
): PublicError {
  if (error instanceof SubmissionLedgerError) {
    switch (error.code) {
      case 'RequestIdConflict':
      case 'UrlOverlap':
      case 'BudgetExceeded':
      case 'StalePeriodContext':
      case 'LedgerBusy':
      case 'DispatchClaimLost':
      case 'OutcomePersistenceFailed':
        return {
          ...strategy.error(error.code),
          ...(error.code === 'BudgetExceeded' && error.unit
            ? { unit: error.unit }
            : {}),
        };
    }
  }
  return strategy.error('StateUnavailable');
}

function projectIntent(intent: IntentView | RetryOwnerIntent) {
  return {
    requestId: intent.requestId,
    state: intent.state,
    stateVersion: intent.stateVersion,
    createdAtMs: intent.createdAtMs,
    periodId: intent.periodId,
    periodStartMs: intent.periodStartMs,
    policyRevision: intent.policyRevision,
    policyDigest: intent.policyDigest,
    reservation: intent.reservation,
    ...(intent.state === 'accepted'
      ? {
          providerTaskId: intent.providerTaskId!,
          providerType: intent.providerType!,
        }
      : {}),
  };
}

function stateError<Result>(
  strategy: SubmissionStrategy<Result>,
  intent: IntentView,
): PublicError | undefined {
  if (intent.state === 'accepted') return undefined;
  const code =
    intent.state === 'cancelled'
      ? 'Cancelled'
      : intent.state === 'unknown'
        ? 'OutcomeUnknown'
        : 'DispatchClaimLost';
  // V1 does not retain the reason for rejected. A replay must not invent a
  // provider rejection when this could have been a local proven no-send.
  return strategy.error(code);
}

function withIntent<Result>(
  strategy: SubmissionStrategy<Result>,
  base: BaseResult,
  intent: IntentView,
  options: {
    error?: PublicError;
    observation?: SubmissionObservation;
    replayed?: boolean;
  } = {},
) {
  const error =
    intent.state === 'accepted'
      ? undefined
      : (options.error ?? stateError(strategy, intent));
  return strategy.checked({
    ...base,
    status: intent.state,
    intent: projectIntent(intent),
    ...(error ? { error } : {}),
    ...(options.observation ? { observation: options.observation } : {}),
    ...(options.replayed ? { replayed: true } : {}),
  });
}

function blocked<Result>(
  strategy: SubmissionStrategy<Result>,
  base: BaseResult,
  error: PublicError,
) {
  return strategy.checked({ ...base, status: 'blocked', error });
}

function reread<Result>(
  strategy: SubmissionStrategy<Result>,
  ledger: SubmissionLedger,
  fp: string,
  id: string,
  base: BaseResult,
  error: PublicError,
) {
  try {
    const intent = ledger.readIntent(fp, id);
    if (intent) return withIntent(strategy, base, intent, { error });
  } catch {
    /* No current durable state can be asserted. */
  }
  return blocked(strategy, base, strategy.error('StateUnavailable'));
}

// Bun's immediate queue precedes I/O polling. A timer followed by an immediate
// lets polled I/O tasks run before the next immediate pass and dispatch claim.
function yieldForPendingIO() {
  return new Promise<void>((resolve) =>
    setTimeout(() => setImmediate(resolve), 0),
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

const invalidAck = Symbol('invalid create response');
async function readCreateResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw invalidAck;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(submissionLimits.responseBytes);
  let length = 0;
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      if (length + value.byteLength > bytes.byteLength) throw invalidAck;
      bytes.set(value, length);
      length += value.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ) as unknown;
    } catch {
      throw invalidAck;
    }
  } finally {
    if (!complete) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* Preserve observation. */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* A pending native read may still be aborting. */
    }
  }
}

function matchesOutcome(intent: IntentView, outcome: DispatchOutcome) {
  return (
    intent.state === outcome.kind &&
    (outcome.kind !== 'accepted' ||
      (intent.providerTaskId === outcome.providerTaskId &&
        intent.providerType === outcome.providerType))
  );
}

/** One configured snapshot, one new in-flight submission, no implicit state
 * initialization. Transport/clock/ledger injection is trusted host wiring only. */
export class SubmissionHost {
  private busy = false;
  private readonly fetchRequest: typeof fetch;
  private readonly clock: () => number;
  private readonly open: (options: LedgerPathOptions) => SubmissionLedger;
  private readonly timeoutMs: number;
  private readonly configuration: SubmissionConfiguration;
  private readonly retry: Readonly<ProductionRetryComposition> | undefined;
  private readonly publicResultBytes: number;
  private readonly history: RetryHistoryOwner;

  constructor(
    configuration: SubmissionConfiguration = loadSubmissionConfiguration(),
    options: SubmissionHostOptions = {},
  ) {
    this.configuration = freezeSnapshot(structuredClone(configuration));
    this.history = createRetryHistoryOwner(this.configuration, options.history);
    this.fetchRequest = options.fetchRequest?.bind(options) ?? globalThis.fetch;
    this.clock = options.clock?.bind(options) ?? Date.now;
    this.open = options.openLedger?.bind(options) ?? openLedger;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.publicResultBytes = lowerPlanRetryResultByteLimit(
      options.retry?.publicResultBytes,
    );
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10_000
    )
      throw new Error('Invalid submission HTTP deadline.');
    const captured = this.configuration;
    // Construction captures authority and functions only; no state or network.
    // Existing inactive and non-retry hosts retain their original create path.
    if (
      captured.state === 'configured' &&
      captured.snapshot.policy.enabled &&
      captured.snapshot.policy.retry?.enabled
    ) {
      try {
        this.retry = composeVerifiedRetryAdmission({
          configuration: captured,
          transport: { fetch: this.fetchRequest },
          clock: {
            utcMs: this.clock,
            monotonicMs:
              options.retry?.monotonicMs?.bind(options.retry) ??
              performance.now.bind(performance),
          },
          owner: {
            ...options.retry,
            publicResultBytes: this.publicResultBytes,
          },
          ...(options.retry?.preparationHooks === undefined
            ? {}
            : { hooks: options.retry.preparationHooks }),
        });
      } catch {
        // Invalid retry wiring blocks planning, without breaking pure previews.
        this.retry = undefined;
      }
    }
  }

  /** Internal no-write inspection. Public registration and result schemas are separate. */
  async getRetryHistoryToolResult(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<RetryHistoryToolResult> {
    return this.history.read(value, signal);
  }

  /** Internal no-write inspection. Public registration and result schemas are separate. */
  async planRetry(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<RetryPlanView> {
    return this.planRetryOwned(value, signal, 'view');
  }

  async planRetryToolResult(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<PlanRetryToolResult> {
    return this.planRetryOwned(value, signal, 'public');
  }

  private planRetryOwned(
    value: unknown,
    signal: AbortSignal | undefined,
    output: 'view',
  ): Promise<RetryPlanView>;
  private planRetryOwned(
    value: unknown,
    signal: AbortSignal | undefined,
    output: 'public',
  ): Promise<PlanRetryToolResult>;
  private async planRetryOwned(
    value: unknown,
    signal: AbortSignal | undefined,
    output: 'view' | 'public',
  ): Promise<RetryPlanView | PlanRetryToolResult> {
    let engine: 'google' | 'yandex' = 'google';
    const early = (view: RetryPlanView) =>
      output === 'public'
        ? planRetryToolResult(retryPlanResultFromView(engine, view), {
            maxBytes: this.publicResultBytes,
          })
        : view;
    let args: ReturnType<typeof parseRetryPlanInput>;
    try {
      args = parseRetryPlanInput(value);
      engine = args.searchEngine;
    } catch {
      return early(Object.freeze({ status: 'error', code: 'InvalidInput' }));
    }
    if (signal?.aborted)
      return early(Object.freeze({ status: 'error', code: 'Cancelled' }));
    const config = this.configuration;
    if (config.state !== 'configured')
      return early(
        freezeSnapshot({
          status: 'blocked',
          blockers: ['StateUnavailable'],
        }),
      );
    if (!config.snapshot.policy.enabled)
      return early(
        freezeSnapshot({
          status: 'blocked',
          blockers: ['WritesDisabled'],
        }),
      );
    if (!config.snapshot.policy.retry?.enabled)
      return early(
        freezeSnapshot({
          status: 'blocked',
          blockers: ['RetryPolicyRequired'],
        }),
      );
    if (this.busy)
      return early(Object.freeze({ status: 'error', code: 'SubmissionBusy' }));
    if (!this.retry || !this.retry.isNewWorkAvailable())
      return early(Object.freeze({ status: 'error', code: 'InternalError' }));
    this.busy = true;
    try {
      return output === 'public'
        ? await this.retry.planLatestToolResult(args, signal)
        : await this.retry.planLatest(args, signal);
    } catch {
      return early(Object.freeze({ status: 'error', code: 'InternalError' }));
    } finally {
      this.busy = false;
    }
  }

  /** Trusted owning preparation only. No public entry or paid consumer yet. */
  protected async withRetryPreparation(
    value: unknown,
    signal: AbortSignal | undefined,
    consumeCreated: (work: CreatedRetryWork) => Promise<SubmitRetryResult>,
  ): Promise<SubmitRetryToolResult> {
    let input: SubmitRetryInput;
    try {
      input = parseSubmitRetryInput(value);
    } catch {
      return submitRetryToolResult({
        status: 'error',
        error: submitRetryError('InvalidInput'),
      });
    }
    const id = input.requestId;
    const refusal = (failure: RetryFailure) =>
      submitRetryToolResult({ ...failure, requestId: id });
    if (signal?.aborted) return refusal(retryFailure('error', 'Cancelled'));
    const config = this.configuration;
    if (config.state !== 'configured')
      return refusal(retryFailure('blocked', config.error.code));
    if (!config.snapshot.policy.enabled)
      return refusal(retryFailure('blocked', 'WritesDisabled'));
    let reconstruction: RetryReconstruction;
    try {
      reconstruction = reconstructSubmitRetry(input, {
        credentialFingerprint: config.credential.fingerprint,
        currentCaps: config.snapshot.policy.caps,
      });
    } catch (error) {
      return refusal(
        error instanceof SubmitRetryError
          ? retryFailure('error', error.code)
          : retryFailure('error', 'InternalError'),
      );
    }
    const fp = config.credential.fingerprint;
    const path = { stateDirectory: config.stateDirectory };
    const historical = readRetryReplay(path, fp, reconstruction.replay);
    if (historical.availability === 'unavailable')
      return refusal(
        retryFailure(
          'blocked',
          historical.reason === 'UpgradeRequired'
            ? 'UpgradeRequired'
            : historical.reason === 'LimitExceeded'
              ? 'SnapshotLimitExceeded'
              : 'StateUnavailable',
        ),
      );
    if (historical.kind === 'conflict')
      return refusal(retryFailure('blocked', 'RequestIdConflict'));
    if (historical.kind === 'replay')
      return submitRetryToolResult(
        retryStoredResult(reconstruction, historical.intent),
      );
    // Everything above is historical comparison outside the new-work meter.
    if (!config.snapshot.policy.retry?.enabled)
      return refusal(retryFailure('blocked', 'RetryPolicyRequired'));
    if (this.busy) return refusal(retryFailure('blocked', 'SubmissionBusy'));
    const composition = this.retry;
    if (!composition || !composition.isNewWorkAvailable())
      return refusal(retryFailure('blocked', 'StateUnavailable'));
    this.busy = true;
    let candidate: RetryCandidate | undefined;
    let writer: RetryOwnerWriter | undefined;
    let owner: RetryCreatedOwner | undefined;
    let observed: RetryOwnerIntent | undefined;
    let admissionAttempted = false;
    let result: SubmitRetryResult | undefined;
    let publication: SubmitRetryToolResult | undefined;
    const failureResult = (failure: RetryFailure): SubmitRetryResult => {
      if (observed) {
        const code =
          failure.status === 'error' ||
          failure.error.code === 'StalePeriodContext'
            ? failure.error.code
            : 'StateUnavailable';
        return submitRetryResultSchema.parse({
          status: 'error',
          requestId: id,
          error: submitRetryError(
            code,
            code === 'ReadFailed'
              ? {
                  ...(failure.error.phase === undefined
                    ? {}
                    : { phase: failure.error.phase }),
                  ...(failure.error.cause === undefined
                    ? {}
                    : { cause: failure.error.cause }),
                }
              : {},
          ),
          evidence: retryDurableEvidence(reconstruction, observed),
        });
      }
      return submitRetryResultSchema.parse({ ...failure, requestId: id });
    };
    try {
      const collected = await composition.collectLatest(
        { searchEngine: input.expectedPlan.searchEngine },
        id,
        signal,
      );
      if (!('kind' in collected))
        result = failureResult(collectionRetryFailure(collected));
      else {
        candidate = collected;
        composition.checkpointCandidate(candidate.proof);
        const expected = input.expectedPlan,
          p = expected.identity.preimage;
        const current = createSubmissionContext(
          config,
          candidate.request.quote.fingerprint,
          this.clock(),
        );
        const candidateReplay = {
          intent: candidate.input.intent,
          parent: candidate.input.parent,
          sourceManifestDigest: candidate.input.sourceManifestDigest,
          planFingerprint: candidate.input.planFingerprint,
        };
        const matches =
          sameRetryData(expected.identity, candidate.view.identity) &&
          computeRetryPlanFingerprint(candidate.view.identity.preimage) ===
            expected.identity.fingerprint &&
          sameRetryData(expected.eligibleUrls, candidate.view.eligibleUrls) &&
          sameRetryData(expected.eligibleUrls, candidate.request.input.urls) &&
          candidate.request.body === reconstruction.request.body &&
          sameRetryData(
            candidate.request.request,
            reconstruction.request.request,
          ) &&
          sameRetryData(
            candidate.request.quote,
            reconstruction.request.quote,
          ) &&
          sameRetryData(candidate.view.request, candidate.request.request) &&
          sameRetryData(candidate.view.quote, candidate.request.quote) &&
          sameRetryData(candidateReplay, reconstruction.replay) &&
          candidate.input.expectedRevision === p.revision &&
          sameRetryData(candidate.input.intent.budget, current.budget) &&
          sameRetryData(candidate.view.authorization, {
            ...current.authorization,
            stateChecked: true,
          }) &&
          sameRetryData(candidate.view.source, {
            reference: [p.parent.family, p.parent.taskId],
            provenance: p.provenance,
            originalManifestKnown: p.originalManifestKnown,
            manifestProvenance: p.manifestProvenance,
            manifestDigest: p.sourceManifestDigest,
          });
        composition.checkpointCandidate(candidate.proof);
        if (!matches)
          result = failureResult(retryFailure('blocked', 'SnapshotConflict'));
        else {
          const ack = input.acknowledgement;
          if (!ack && config.snapshot.policy.mode === 'caller_acknowledgement')
            result = failureResult(
              retryFailure('blocked', 'AcknowledgementRequired'),
            );
          else if (
            ack &&
            (ack.quoteFingerprint !== candidate.request.quote.fingerprint ||
              ack.authorizationFingerprint !==
                candidate.view.authorization.fingerprint)
          )
            result = failureResult(
              retryFailure('blocked', 'AcknowledgementMismatch'),
            );
          else {
            composition.checkpointCandidate(candidate.proof);
            writer = composition.openForSubmission();
            admissionAttempted = true;
            const prepared = writer.prepare(candidate.input, candidate.proof);
            if (prepared.kind === 'replay') {
              observed = prepared.intent;
              result = retryStoredResult(reconstruction, prepared.intent);
            } else {
              owner = prepared.owner; // Retain actual ownership before any late fence.
              observed = owner.lastObservedIntent();
              owner.checkpoint();
              await yieldForPendingIO();
              owner.checkpoint();
              result = await consumeCreated(
                Object.freeze({
                  owner,
                  request: candidate.request,
                  retry: Object.freeze({
                    parent: candidate.input.parent,
                    sourceManifestDigest: candidate.input.sourceManifestDigest,
                    planFingerprint: candidate.input.planFingerprint,
                  }),
                }),
              );
              observed = owner.refreshIntent() ?? owner.lastObservedIntent();
              owner.checkpoint();
            }
          }
        }
      }
    } catch (error) {
      const failure = preparationRetryFailure(
        error,
        config,
        candidate,
        admissionAttempted,
      );
      if (owner) {
        // The actual owner, never a cached/read row, permits this atomic cancel.
        // Claimed work/outcome settlement belongs to the later paid consumer.
        try {
          const current = owner.refreshIntent();
          if (current?.state === 'prepared') owner.cancelPrepared();
          observed = owner.refreshIntent() ?? owner.lastObservedIntent();
        } catch {
          observed = owner.lastObservedIntent();
        }
      } else if (admissionAttempted && candidate) {
        // Prepare can throw after a possible commit. Close before confirming;
        // matching historical evidence supplies no replacement ownership.
        try {
          writer?.close();
        } catch {
          /* Owned close already poisoned admission. */
        }
        const exact = {
          intent: candidate.input.intent,
          parent: candidate.input.parent,
          sourceManifestDigest: candidate.input.sourceManifestDigest,
          planFingerprint: candidate.input.planFingerprint,
        };
        const confirmed = readRetryReplay(path, fp, exact);
        if (
          confirmed.availability === 'available' &&
          confirmed.kind === 'replay'
        )
          observed = confirmed.intent;
      }
      result = failureResult(failure);
    } finally {
      try {
        if (candidate) composition.discardCandidate(candidate.proof);
        // Validate/freeze/serialize while the original owner is still live.
        publication = submitRetryToolResult(
          result ?? {
            status: 'error',
            requestId: id,
            error: submitRetryError('InternalError'),
          },
        );
        if (owner && result?.status !== 'error') owner.checkpoint();
      } catch (error) {
        result = failureResult(
          preparationRetryFailure(error, config, candidate, admissionAttempted),
        );
        publication = submitRetryToolResult(result);
      } finally {
        try {
          if (owner) owner.finish();
          else writer?.close();
        } catch (error) {
          const failure = preparationRetryFailure(
            error,
            config,
            candidate,
            admissionAttempted,
          );
          if (
            !result ||
            result.status !== 'error' ||
            failure.error.code === 'StateUnavailable'
          ) {
            if (owner) observed = owner.lastObservedIntent();
            result = failureResult(failure);
            publication = submitRetryToolResult(result);
          }
        } finally {
          this.busy = false;
        }
      }
    }
    return (
      publication ??
      submitRetryToolResult({
        status: 'error',
        requestId: id,
        error: submitRetryError('InternalError'),
      })
    );
  }

  async createIndexingTask(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<CreateIndexingTaskResult> {
    return this.execute(indexingStrategy, value, signal);
  }

  async createIndexCheck(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<CreateIndexCheckResult> {
    return this.execute(checkerStrategy, value, signal);
  }

  async createBacklinkCheck(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<CreateBacklinkCheckResult> {
    return this.execute(backlinkStrategy, value, signal);
  }

  private async execute<Result>(
    strategy: SubmissionStrategy<Result>,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    let prepared: PreparedSubmission;
    try {
      prepared = strategy.build(value, this.configuration);
    } catch {
      let mode: 'preview' | 'submit' | undefined;
      try {
        const candidate = (value as { mode?: unknown } | null)?.mode;
        if (candidate === 'preview' || candidate === 'submit') mode = candidate;
      } catch {
        /* Input rejection never reflects arbitrary input. */
      }
      return strategy.checked({
        ...(mode ? { mode } : {}),
        status: 'blocked',
        error: strategy.error('InvalidInput'),
      });
    }
    const config = this.configuration;
    let context: SubmissionContext | undefined;
    let authorization: Readonly<
      SubmissionAuthorization | IndexCheckAuthorization
    >;
    const permitted =
      config.state === 'configured' && strategy.permitted(config);
    try {
      if (config.state === 'configured') {
        if (!permitted)
          authorization = { state: 'disabled', stateChecked: false };
        else if (!prepared.quote.fingerprint || !prepared.reservation)
          authorization = {
            state: 'reservation_unavailable',
            stateChecked: false,
          };
        else {
          context = createSubmissionContext(
            config,
            prepared.quote.fingerprint,
            this.clock(),
          );
          authorization = context.authorization;
        }
      } else {
        authorization = Object.freeze({
          state: config.state,
          stateChecked: false,
        });
      }
    } catch {
      authorization = { state: 'invalid', stateChecked: false };
    }
    const base: BaseResult = {
      mode: prepared.input.mode,
      request: prepared.request,
      quote: prepared.quote,
      authorization,
    };
    if (prepared.input.mode === 'preview')
      return strategy.checked({ ...base, status: 'preview' });
    if (config.state !== 'configured')
      return blocked(strategy, base, strategy.error(config.error.code));
    if (!permitted)
      return blocked(strategy, base, strategy.error('WritesDisabled'));
    if (prepared.unavailableError)
      return blocked(strategy, base, prepared.unavailableError);
    if (!context || !prepared.quote.fingerprint || !prepared.reservation)
      return blocked(strategy, base, strategy.error('StateUnavailable'));
    if (signal?.aborted)
      return blocked(strategy, base, strategy.error('Cancelled'));

    let ledger: SubmissionLedger | undefined;
    let ownsGuard = false;
    const fp = config.credential.fingerprint;
    const id = prepared.input.requestId!;
    const input: PrepareIntentInput = {
      requestId: id,
      budget: context.budget,
      taskFamily: prepared.request.family,
      providerRoute: prepared.request.providerRoute,
      payloadDigest: prepared.request.payloadDigest,
      submittedUrls: prepared.input.urls,
      quoteVersion: prepared.quote.version,
      quoteFingerprint: prepared.quote.fingerprint,
      reservation: prepared.reservation,
    };
    try {
      ledger = this.open({ stateDirectory: config.stateDirectory });
      base.authorization = { ...authorization, stateChecked: true };
      if (ledger.readIntent(fp, id)) {
        const replay = ledger.prepareIntent(input);
        // An observed existing identity never grants a fresh dispatch here.
        return withIntent(strategy, base, replay.intent, { replayed: true });
      }
      if (this.busy)
        return blocked(strategy, base, strategy.error('SubmissionBusy'));
      if (this.retry && !this.retry.isNewWorkAvailable())
        return blocked(strategy, base, strategy.error('StateUnavailable'));
      this.busy = true;
      ownsGuard = true;
      const ack = prepared.input.acknowledgement;
      if (!ack && config.snapshot.policy.mode === 'caller_acknowledgement')
        return blocked(
          strategy,
          base,
          strategy.error('AcknowledgementRequired'),
        );
      if (
        ack &&
        (ack.quoteFingerprint !== prepared.quote.fingerprint ||
          ack.authorizationFingerprint !== authorization.fingerprint)
      )
        return blocked(
          strategy,
          base,
          strategy.error('AcknowledgementMismatch'),
        );
      if (signal?.aborted)
        return blocked(strategy, base, strategy.error('Cancelled'));
      const result = ledger.prepareIntent(input);
      if (result.kind === 'replay')
        return withIntent(strategy, base, result.intent, { replayed: true });
      await yieldForPendingIO();
      if (signal?.aborted) {
        try {
          const cancelled = ledger.cancelPrepared(fp, id, 0);
          if (cancelled.kind === 'cancelled')
            return withIntent(strategy, base, {
              ...result.intent,
              state: 'cancelled',
              stateVersion: cancelled.stateVersion,
            });
          return reread(
            strategy,
            ledger,
            fp,
            id,
            base,
            strategy.error('DispatchClaimLost'),
          );
        } catch (error) {
          return reread(
            strategy,
            ledger,
            fp,
            id,
            base,
            safeLedgerError(strategy, error),
          );
        }
      }
      try {
        const claim = ledger.claimDispatch(result.dispatchCapability, 0);
        if (claim.kind === 'lost')
          return reread(
            strategy,
            ledger,
            fp,
            id,
            base,
            strategy.error('DispatchClaimLost'),
          );
        // A synchronous claim can also leave cancellation queued in I/O.
        await yieldForPendingIO();
        return await this.dispatch(
          strategy,
          config,
          prepared,
          ledger,
          base,
          claim.outcomeToken,
          claim.stateVersion,
          signal,
        );
      } catch (error) {
        return reread(
          strategy,
          ledger,
          fp,
          id,
          base,
          safeLedgerError(strategy, error),
        );
      }
    } catch (error) {
      return blocked(strategy, base, safeLedgerError(strategy, error));
    } finally {
      try {
        ledger?.close();
      } catch {
        /* Cannot undo an observed durable outcome or authorize a resend. */
      }
      if (ownsGuard) this.busy = false;
    }
  }

  private async dispatch<Result>(
    strategy: SubmissionStrategy<Result>,
    config: ConfiguredSubmission,
    prepared: PreparedSubmission,
    ledger: SubmissionLedger,
    base: BaseResult,
    outcomeToken: DispatchOutcomeToken,
    stateVersion: number,
    signal?: AbortSignal,
  ) {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempted = false;
    let responseStatus: number | undefined;
    let outcome: DispatchOutcome;
    let observation: SubmissionObservation;
    let errorCode: SubmissionErrorCode | undefined;
    try {
      const headers = new Headers({
        Authorization: config.credential.effectiveKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `speedyindex-mcp/${version}`,
      });
      const combined = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
      timer = setTimeout(() => deadline.abort(), this.timeoutMs);
      combined.throwIfAborted();
      const endpoint =
        'https://api.speedyindex.com' + prepared.request.providerRoute;
      const init: RequestInit = {
        method: 'POST',
        headers,
        body: prepared.body,
        redirect: 'error',
        signal: combined,
      };
      attempted = true;
      const response = await abortable(
        this.fetchRequest(endpoint, init),
        combined,
      );
      responseStatus = response.status;
      const decoded = await readCreateResponse(response, combined);
      const normalized = prepared.normalizeOutcome(response.status, decoded);
      if (normalized.kind === 'accepted') {
        outcome = {
          kind: 'accepted',
          providerTaskId: normalized.taskId,
          providerType: normalized.type,
        };
        observation = {
          kind: 'accepted_ack',
          recorded: false,
          taskId: normalized.taskId,
          type: normalized.type,
        };
      } else if (normalized.kind === 'rejected') {
        outcome = { kind: 'rejected' };
        observation = {
          kind: 'provider_rejection',
          recorded: false,
          code: normalized.code,
        };
        errorCode = 'ProviderRejected';
      } else {
        outcome = { kind: 'unknown' };
        observation = {
          kind: 'ambiguous',
          recorded: false,
          cause: normalized.cause,
        };
        errorCode = 'OutcomeUnknown';
      }
    } catch (error) {
      if (!attempted) {
        outcome = { kind: 'rejected' };
        observation = {
          kind: 'not_sent',
          recorded: false,
          cause: signal?.aborted ? 'cancelled' : 'local_validation',
        };
        errorCode = signal?.aborted ? 'Cancelled' : 'StateUnavailable';
      } else {
        outcome = { kind: 'unknown' };
        const cause = signal?.aborted
          ? 'cancelled'
          : deadline.signal.aborted
            ? 'timeout'
            : error === invalidAck
              ? responseStatus === 200
                ? 'invalid_ack'
                : 'http'
              : 'transport';
        observation = { kind: 'ambiguous', recorded: false, cause };
        errorCode = 'OutcomeUnknown';
      }
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
    const fp = config.credential.fingerprint;
    const id = prepared.input.requestId!;
    try {
      const stored = ledger.recordDispatchOutcome({
        credentialFingerprint: fp,
        requestId: id,
        expectedStateVersion: stateVersion,
        outcomeToken,
        outcome,
      });
      if (!matchesOutcome(stored, outcome))
        throw new Error('Inconsistent durable submission outcome.');
      return withIntent(strategy, base, stored, {
        observation: { ...observation, recorded: true },
        ...(errorCode ? { error: strategy.error(errorCode) } : {}),
      });
    } catch {
      // Exactly one write attempt; a read may confirm an uncertain commit.
      try {
        const current = ledger.readIntent(fp, id);
        if (current && matchesOutcome(current, outcome))
          return withIntent(strategy, base, current, {
            observation: { ...observation, recorded: true },
            ...(errorCode ? { error: strategy.error(errorCode) } : {}),
          });
        if (current?.state === 'dispatching')
          return withIntent(strategy, base, current, {
            observation,
            error: strategy.error('OutcomePersistenceFailed'),
          });
      } catch {
        /* Preserve the last observed claim, without asserting current state. */
      }
      return strategy.checked({
        ...base,
        status: 'blocked',
        observation,
        error: {
          ...strategy.error('StateUnavailable'),
          lastObservedState: 'dispatching',
        },
      });
    }
  }
}
