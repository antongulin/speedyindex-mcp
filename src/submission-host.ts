import { version } from '../package.json';
import {
  buildCreateIndexingRequest,
  createIndexingTaskError,
  createIndexingTaskToolResult,
  normalizeCreateIndexingOutcome,
  type CreateIndexingTaskResult,
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
  SubmissionLedgerError,
  type DispatchOutcome,
  type DispatchOutcomeToken,
  type IntentView,
  type LedgerPathOptions,
  type PrepareIntentInput,
  type SubmissionLedger,
} from './submission-ledger';

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

export interface SubmissionHostOptions {
  fetchRequest?: typeof fetch;
  clock?: () => number;
  openLedger?: (options: LedgerPathOptions) => SubmissionLedger;
  timeoutMs?: number;
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

function projectIntent(intent: IntentView) {
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

  constructor(
    private readonly configuration: SubmissionConfiguration = loadSubmissionConfiguration(),
    options: SubmissionHostOptions = {},
  ) {
    this.fetchRequest = options.fetchRequest ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
    this.open = options.openLedger ?? openLedger;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10_000
    )
      throw new Error('Invalid submission HTTP deadline.');
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
