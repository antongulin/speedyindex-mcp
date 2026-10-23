/** Private query-only owner. Constructor callbacks cannot supply data or authority. */
import {
  lowerRetryHistoryResultByteLimit,
  parseRetryHistoryInput,
  RetryHistoryError,
  retryHistoryBlocked,
  retryHistoryError,
  retryHistoryFromSnapshot,
  retryHistoryToolResult,
  type RetryHistoryErrorCode,
  type RetryHistoryToolResult,
} from './get-retry-history';
import {
  createInvocationReadBudget,
  ReadBudgetError,
  type InvocationReadBudget,
  type ReadBudgetRuntime,
} from './read-budget';
import {
  freezeSnapshot,
  snapshotLimits,
  type SnapshotReadHooks,
} from './retry-ledger-snapshot';
import { readRetrySnapshot } from './submission-ledger';
import type { SubmissionConfiguration } from './submission-policy';

export type HistoryOwnerPhase =
  | 'before_read'
  | 'after_read'
  | 'after_read_io'
  | 'after_projection'
  | 'after_envelope'
  | 'before_budget_close'
  | 'after_budget_close'
  | 'before_publish';
export interface RetryHistoryOwnerOptions {
  readonly runtime?: ReadBudgetRuntime;
  readonly horizonMs?: number;
  readonly resultBytes?: number;
  readonly onPhase?: (phase: HistoryOwnerPhase) => void;
  readonly afterReadIO?: () => Promise<void>;
  readonly afterBudgetClose?: () => Promise<void>;
  readonly snapshotHooks?: SnapshotReadHooks;
}
export interface RetryHistoryOwner {
  read(value: unknown, signal?: AbortSignal): Promise<RetryHistoryToolResult>;
}

/** Captured native I/O always runs; fixture decorators can only delay/reject afterwards. */
function ioOpportunity() {
  const arm = globalThis.setTimeout.bind(globalThis);
  const immediate = globalThis.setImmediate.bind(globalThis);
  return () => new Promise<void>((resolve) => arm(() => immediate(resolve), 0));
}
function synchronousVoid(value: unknown) {
  if (value === undefined) return;
  // Observe an invalid asynchronous callback's rejection without awaiting inside SQL.
  void Promise.resolve(value).catch(() => undefined);
  throw new RetryHistoryError('InternalError');
}

/** Capture configuration/runtime/finite limits and fixed envelopes without opening state. */
export function createRetryHistoryOwner(
  configuration: SubmissionConfiguration,
  options: RetryHistoryOwnerOptions = {},
): RetryHistoryOwner {
  const config = freezeSnapshot(structuredClone(configuration));
  const horizon = options.horizonMs ?? 60_000;
  if (!Number.isSafeInteger(horizon) || horizon <= 0 || horizon > 60_000)
    throw new RangeError('Invalid retry-history construction.');
  const runtime = options.runtime;
  if (
    runtime &&
    (typeof runtime.now !== 'function' ||
      typeof runtime.setTimeout !== 'function' ||
      typeof runtime.clearTimeout !== 'function')
  )
    throw new RangeError('Invalid retry-history construction.');
  const now = runtime
    ? runtime.now.bind(runtime)
    : performance.now.bind(performance);
  const arm = runtime
    ? runtime.setTimeout.bind(runtime)
    : globalThis.setTimeout.bind(globalThis);
  const nativeClear = globalThis.clearTimeout.bind(globalThis);
  const disarm = runtime
    ? runtime.clearTimeout.bind(runtime)
    : (handle: unknown) => {
        Reflect.apply(nativeClear, undefined, [handle]);
      };
  const phase = options.onPhase?.bind(options);
  const afterReadIO = options.afterReadIO?.bind(options);
  const afterBudgetClose = options.afterBudgetClose?.bind(options);
  const sourceHooks = options.snapshotHooks;
  const hooks: SnapshotReadHooks = Object.freeze({
    ...(sourceHooks?.limits === undefined
      ? {}
      : { limits: Object.freeze(snapshotLimits(sourceHooks.limits)) }),
    ...(sourceHooks?.onPhase === undefined
      ? {}
      : { onPhase: sourceHooks.onPhase.bind(sourceHooks) }),
    ...(sourceHooks?.afterNativeClose === undefined
      ? {}
      : { afterNativeClose: sourceHooks.afterNativeClose.bind(sourceHooks) }),
  });
  const yieldIO = ioOpportunity();
  const bytes = lowerRetryHistoryResultByteLimit(options.resultBytes);
  const fixedError = (code: RetryHistoryErrorCode) =>
    retryHistoryToolResult(retryHistoryError(code), { maxBytes: bytes });
  const errors = Object.freeze({
    InvalidInput: fixedError('InvalidInput'),
    CursorMismatch: fixedError('CursorMismatch'),
    SnapshotChanged: fixedError('SnapshotChanged'),
    StateUnavailable: fixedError('StateUnavailable'),
    HistoryBusy: fixedError('HistoryBusy'),
    ResourceLimitExceeded: fixedError('ResourceLimitExceeded'),
    Cancelled: fixedError('Cancelled'),
    DeadlineExceeded: fixedError('DeadlineExceeded'),
    InternalError: fixedError('InternalError'),
  });
  const blocked = Object.freeze({
    ReadConfigurationUnavailable: retryHistoryToolResult(
      retryHistoryBlocked('ReadConfigurationUnavailable'),
      { maxBytes: bytes },
    ),
    StateMissing: retryHistoryToolResult(retryHistoryBlocked('StateMissing'), {
      maxBytes: bytes,
    }),
    V2Required: retryHistoryToolResult(retryHistoryBlocked('V2Required'), {
      maxBytes: bytes,
    }),
  });
  const notify = (name: HistoryOwnerPhase) => synchronousVoid(phase?.(name));
  let busy = false;
  let unavailable = false;

  return Object.freeze({
    async read(
      value: unknown,
      signal?: AbortSignal,
    ): Promise<RetryHistoryToolResult> {
      let selectors: unknown;
      try {
        selectors = structuredClone(value);
        parseRetryHistoryInput(selectors);
      } catch {
        return errors.InvalidInput;
      }
      if (signal?.aborted) return errors.Cancelled;
      if (config.state !== 'configured')
        return blocked.ReadConfigurationUnavailable;
      if (busy) return errors.HistoryBusy;
      if (unavailable) return errors.StateUnavailable;
      busy = true;
      let result = errors.InternalError;
      let firstFailure: RetryHistoryToolResult | undefined;
      let budget: InvocationReadBudget | undefined;
      let origin: number | undefined;
      let last = Number.NEGATIVE_INFINITY;
      let clockFailed = false;
      const monotonic = () => {
        let current = Number.NaN;
        try {
          current = now();
        } catch {
          clockFailed = true;
        }
        if (
          !Number.isFinite(current) ||
          current < last ||
          (origin !== undefined && current - origin >= horizon)
        )
          clockFailed = true;
        if (clockFailed) return Number.NaN;
        last = current;
        return current;
      };
      const fence = () => {
        if (signal?.aborted) throw new RetryHistoryError('Cancelled');
        if (!Number.isFinite(monotonic()))
          throw new RetryHistoryError('DeadlineExceeded');
      };
      const checkpoint = () => {
        fence();
        budget?.checkpoint();
      };
      const fail = (error: unknown) => {
        const code =
          error instanceof RetryHistoryError
            ? error.code
            : error instanceof ReadBudgetError &&
                (error.code === 'Cancelled' ||
                  error.code === 'DeadlineExceeded' ||
                  error.code === 'ResourceLimitExceeded')
              ? error.code
              : 'InternalError';
        firstFailure ??= errors[code];
        result = firstFailure;
      };
      try {
        origin = monotonic();
        if (!Number.isFinite(origin))
          throw new RetryHistoryError('DeadlineExceeded');
        budget = createInvocationReadBudget(
          { startedAtMs: origin, ...(signal === undefined ? {} : { signal }) },
          {
            limits: { horizonMs: horizon },
            runtime: { now: monotonic, setTimeout: arm, clearTimeout: disarm },
          },
        );
        notify('before_read');
        checkpoint();
        const snapshot = readRetrySnapshot(
          { stateDirectory: config.stateDirectory },
          config.credential.fingerprint,
          hooks,
        );
        if (
          snapshot.availability === 'unavailable' &&
          snapshot.reason === 'ReadFailure'
        )
          unavailable = true;
        notify('after_read');
        checkpoint();
        await yieldIO();
        if (afterReadIO !== undefined) synchronousVoid(await afterReadIO());
        notify('after_read_io');
        checkpoint();
        if (snapshot.availability === 'available') {
          const projection = retryHistoryFromSnapshot(
            snapshot,
            config.credential.fingerprint,
            selectors,
          );
          notify('after_projection');
          checkpoint();
          result = retryHistoryToolResult(projection, { maxBytes: bytes });
          notify('after_envelope');
          checkpoint();
        } else {
          switch (snapshot.reason) {
            case 'MissingState':
              result = blocked.StateMissing;
              break;
            case 'UpgradeRequired':
              result = blocked.V2Required;
              break;
            case 'Busy':
              result = errors.HistoryBusy;
              break;
            case 'LimitExceeded':
              result = errors.ResourceLimitExceeded;
              break;
            default:
              result = errors.StateUnavailable;
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        if (budget !== undefined) {
          try {
            notify('before_budget_close');
          } catch (error) {
            fail(error);
          }
          try {
            await budget.close();
          } catch {
            unavailable = true;
          }
          try {
            notify('after_budget_close');
          } catch (error) {
            fail(error);
          }
          try {
            if (afterBudgetClose !== undefined)
              synchronousVoid(await afterBudgetClose());
          } catch {
            unavailable = true;
          }
        }
        try {
          notify('before_publish');
          fence();
        } catch (error) {
          fail(error);
        }
        if (unavailable) result = errors.StateUnavailable;
        busy = false;
      }
      return result;
    },
  });
}
