/** Internal, trusted invocation meters. No MCP, policy or environment selectors. */
type ReadBudgetLimits = {
  maxAttempts: number;
  maxDecodedBytes: number;
  horizonMs: number;
  maxRequestMs: number;
};
const ceilings: Readonly<ReadBudgetLimits> = Object.freeze({
  maxAttempts: 64,
  maxDecodedBytes: 32 * 1024 * 1024,
  horizonMs: 60_000,
  maxRequestMs: 10_000,
});

type ReadBudgetCode =
  | 'Cancelled'
  | 'DeadlineExceeded'
  | 'ResourceLimitExceeded'
  | 'ReadInProgress'
  | 'CleanupFailed';
const messages: Record<ReadBudgetCode, string> = {
  Cancelled: 'Invocation read was cancelled.',
  DeadlineExceeded: 'Invocation read deadline exceeded.',
  ResourceLimitExceeded: 'Invocation read resource limit exceeded.',
  ReadInProgress: 'An invocation read is already in progress.',
  CleanupFailed: 'Invocation read cleanup failed.',
};

export class ReadBudgetError extends Error {
  constructor(readonly code: ReadBudgetCode) {
    super(messages[code]);
    this.name = 'ReadBudgetError';
  }
}

export interface ReadBudgetRuntime {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ReadLease {
  readonly signal: AbortSignal;
  enterFetch(): void;
  chargeDecodedBytes(bytes: number): void;
  checkpoint(): void;
  fail(fallback: Error): Error;
  /** Called only after the actual fetch/read/cancel/closed receipts settle. */
  finish(cleanupFailed: boolean): Error | undefined;
}

export interface InvocationReadBudget {
  checkpoint(): void;
  close(): Promise<void>;
  /** Client-only lease; the invocation owns no client/account/global guard. */
  acquire(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    timeoutError: Error,
    cancelOwned: () => void,
  ): ReadLease;
}

export function createInvocationReadBudget(
  input: { startedAtMs: number; signal?: AbortSignal },
  construction: {
    limits?: Partial<ReadBudgetLimits>;
    runtime?: ReadBudgetRuntime;
  } = {},
): InvocationReadBudget {
  const limits = { ...ceilings, ...construction.limits };
  for (const name of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] <= 0 ||
      limits[name] > ceilings[name]
    )
      throw new RangeError('Invalid invocation read limits.');
  }
  const startedAtMs = input.startedAtMs;
  if (!Number.isFinite(startedAtMs))
    throw new RangeError('Invalid invocation read start.');
  const invocationSignal = input.signal;
  const runtime = construction.runtime;
  if (
    runtime &&
    (typeof runtime.now !== 'function' ||
      typeof runtime.setTimeout !== 'function' ||
      typeof runtime.clearTimeout !== 'function')
  )
    throw new RangeError('Invalid invocation read runtime.');
  const now = runtime
    ? runtime.now.bind(runtime)
    : performance.now.bind(performance);
  const nativeArm = globalThis.setTimeout.bind(globalThis);
  const nativeDisarm = globalThis.clearTimeout.bind(globalThis);
  const arm = runtime
    ? runtime.setTimeout.bind(runtime)
    : (callback: () => void, delayMs: number) => nativeArm(callback, delayMs);
  const disarm = runtime
    ? runtime.clearTimeout.bind(runtime)
    : (handle: unknown) =>
        nativeDisarm(handle as ReturnType<typeof setTimeout>);
  let lastNow = startedAtMs;
  let deadlineFailed = false;
  let attempts = 0;
  let decodedBytes = 0;
  let closed = false;
  let poisoned = false;
  let active: { stop(): void; receipt: Promise<void> } | undefined;
  let closeReceipt: Promise<void> | undefined;

  function readClock(): number {
    let value: number;
    try {
      value = now();
    } catch {
      value = Number.NaN;
    }
    if (
      !Number.isFinite(value) ||
      value < lastNow ||
      value - startedAtMs >= limits.horizonMs
    )
      deadlineFailed = true;
    else lastNow = value;
    return value;
  }

  function terminal(signal?: AbortSignal): ReadBudgetError | undefined {
    if (poisoned) return new ReadBudgetError('CleanupFailed');
    if (closed || invocationSignal?.aborted || signal?.aborted)
      return new ReadBudgetError('Cancelled');
    readClock();
    if (deadlineFailed) return new ReadBudgetError('DeadlineExceeded');
    return undefined;
  }

  return Object.freeze<InvocationReadBudget>({
    checkpoint() {
      const error = terminal();
      if (error) throw error;
      if (decodedBytes > limits.maxDecodedBytes)
        throw new ReadBudgetError('ResourceLimitExceeded');
    },
    close() {
      if (!closeReceipt) {
        closed = true;
        active?.stop();
        closeReceipt =
          active?.receipt ??
          (poisoned
            ? Promise.reject(new ReadBudgetError('CleanupFailed'))
            : Promise.resolve());
        // The owner may call close before it awaits its returned receipt.
        void closeReceipt.catch(() => undefined);
      }
      return closeReceipt;
    },
    acquire(signal, timeoutMs, timeoutError, cancelOwned) {
      const error = terminal(signal);
      if (error) throw error;
      if (active) throw new ReadBudgetError('ReadInProgress');
      if (
        attempts >= limits.maxAttempts ||
        decodedBytes >= limits.maxDecodedBytes
      )
        throw new ReadBudgetError('ResourceLimitExceeded');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new RangeError('Invalid invocation read timeout.');

      const controller = new AbortController();
      const requestMs = Math.min(timeoutMs, limits.maxRequestMs);
      const remainingMs = limits.horizonMs - (lastNow - startedAtMs);
      const intervalMs = Math.min(requestMs, remainingMs);
      const requestDue = lastNow + intervalMs;
      const horizonFirst = remainingMs <= requestMs;
      let timerFired = false;
      let primary: Error | undefined;
      let cleanupBroken = false;
      let timer: unknown;
      let armed = false;
      const subscriptions: AbortSignal[] = [];
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const receipt = new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      void receipt.catch(() => undefined);

      function currentFailure(): Error | undefined {
        const error = terminal(signal);
        if (error) return error;
        if (timerFired || lastNow >= requestDue)
          return horizonFirst
            ? new ReadBudgetError('DeadlineExceeded')
            : timeoutError;
        if (decodedBytes > limits.maxDecodedBytes)
          return new ReadBudgetError('ResourceLimitExceeded');
        return undefined;
      }
      function latch(selected: Error): Error {
        if (!primary) {
          // Freeze the first classification before abort/cancel can reenter.
          primary = selected;
          try {
            controller.abort();
          } catch {
            cleanupBroken = true;
          }
          try {
            cancelOwned();
          } catch {
            cleanupBroken = true;
          }
        }
        return primary;
      }
      function fail(fallback: Error): Error {
        return primary ?? latch(currentFailure() ?? fallback);
      }
      function checkpoint() {
        if (primary) throw primary;
        const error = currentFailure();
        if (error) throw latch(error);
      }
      const stop = () => {
        fail(new ReadBudgetError('Cancelled'));
      };
      active = { stop, receipt };
      function finish(cleanupFailed: boolean) {
        if (armed) {
          try {
            disarm(timer);
          } catch {
            cleanupBroken = true;
          }
        }
        for (const subscribed of subscriptions) {
          try {
            subscribed.removeEventListener('abort', stop);
          } catch {
            cleanupBroken = true;
          }
        }
        if (cleanupFailed || cleanupBroken) poisoned = true;
        // The client has settled actual work; owned resources release before lease.
        active = undefined;
        if (poisoned) reject(new ReadBudgetError('CleanupFailed'));
        else resolve();
        return (
          primary ??
          (poisoned ? new ReadBudgetError('CleanupFailed') : undefined)
        );
      }
      try {
        for (const subscribed of new Set([invocationSignal, signal])) {
          if (!subscribed) continue;
          subscriptions.push(subscribed);
          subscribed.addEventListener('abort', stop);
        }
        timer = arm(() => {
          timerFired = true;
          fail(timeoutError);
        }, intervalMs);
        armed = true;
        checkpoint();
      } catch (error) {
        void error;
        fail(new RangeError('Invalid invocation read runtime.'));
        throw finish(false);
      }
      return {
        signal: controller.signal,
        enterFetch() {
          checkpoint();
          attempts += 1;
        },
        chargeDecodedBytes(bytes: number) {
          // Charge even when a callback latched cancellation in the same turn.
          decodedBytes += bytes;
          checkpoint();
        },
        checkpoint,
        fail,
        finish,
      };
    },
  });
}
