/** Pure, finite fixture IPC. Nothing here imports the server, SDK or storage. */
export const HISTORY_PHASE_PREFIX = 'HISTORY_PHASE ';
export const HISTORY_SANITY_PREFIX = 'HISTORY_SANITY ';
export const HISTORY_PROTOCOL_ERROR = 'Invalid history fixture protocol.';
export const historyProtocolLimits = Object.freeze({
  phaseLineBytes: 512,
  phaseBytes: 16_384,
  phaseEvents: 64,
  controlLineBytes: 128,
  controlBytes: 2_048,
  controlFrames: 16,
  operations: 32,
  sequences: 8,
});
const codes = [
  'InvalidInput',
  'CursorMismatch',
  'SnapshotChanged',
  'StateUnavailable',
  'HistoryBusy',
  'ResourceLimitExceeded',
  'Cancelled',
  'DeadlineExceeded',
  'InternalError',
] as const;
type Code = (typeof codes)[number];
export type HistoryPhase =
  | { readonly event: 'BOOT_READY' | 'FIXTURE_ERROR' | 'PROTOCOL_ERROR' }
  | {
      readonly event:
        | 'HANDLER_ENTER'
        | 'NATIVE_CLOSED'
        | 'READ_IO_HELD'
        | 'SIGNAL_ABORTED'
        | 'BUDGET_CLOSED';
      readonly operation: number;
    }
  | {
      readonly event: 'OWNER_SETTLED';
      readonly operation: number;
      readonly aborted: boolean;
      readonly status: 'ok' | 'blocked' | 'error';
      readonly code: Code | null;
    }
  | {
      readonly event: 'BARRIER';
      readonly sequence: number;
      readonly handlerEntries: number;
      readonly nativeReads: number;
      readonly nativeCloses: number;
      readonly budgetSettlements: number;
      readonly httpAttempts: number;
    };
export type HistoryControl =
  | { readonly event: 'BARRIER'; readonly sequence: number }
  | { readonly event: 'RELEASE_READ_IO'; readonly operation: 1 };

function invalid(): never {
  throw new Error(HISTORY_PROTOCOL_ERROR);
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
  return value;
}
function keys(value: Record<string, unknown>, names: readonly string[]) {
  const actual = Object.keys(value);
  if (actual.length !== names.length || actual.some((k) => !names.includes(k)))
    invalid();
}
function object(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  // JSON.parse alone silently accepts duplicate object keys. These flat grammars
  // forbid them, including differently escaped spellings of the same key.
  const seen = new Set<string>();
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!/^\s*:/.test(text.slice(token.index + token[0].length))) continue;
    const key: string = JSON.parse(token[0]);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  return value as Record<string, unknown>;
}
export function parseHistoryPhase(text: string): HistoryPhase {
  if (!text.startsWith(HISTORY_PHASE_PREFIX)) invalid();
  const v = object(text.slice(HISTORY_PHASE_PREFIX.length));
  switch (v.event) {
    case 'BOOT_READY':
    case 'FIXTURE_ERROR':
    case 'PROTOCOL_ERROR':
      keys(v, ['event']);
      return Object.freeze({ event: v.event });
    case 'HANDLER_ENTER':
    case 'NATIVE_CLOSED':
    case 'READ_IO_HELD':
    case 'SIGNAL_ABORTED':
    case 'BUDGET_CLOSED': {
      keys(v, ['event', 'operation']);
      const operation = integer(v.operation, 1, 32);
      if (v.event === 'READ_IO_HELD' && operation !== 1) invalid();
      return Object.freeze({ event: v.event, operation });
    }
    case 'OWNER_SETTLED': {
      keys(v, ['event', 'operation', 'aborted', 'status', 'code']);
      const operation = integer(v.operation, 1, 32);
      if (typeof v.aborted !== 'boolean') invalid();
      if (v.status !== 'ok' && v.status !== 'blocked' && v.status !== 'error')
        invalid();
      const code = v.code === null ? null : codes.find((c) => c === v.code);
      if (code === undefined || (v.status === 'error') !== (code !== null))
        invalid();
      return Object.freeze({
        event: v.event,
        operation,
        aborted: v.aborted,
        status: v.status,
        code,
      });
    }
    case 'BARRIER':
      keys(v, [
        'event',
        'sequence',
        'handlerEntries',
        'nativeReads',
        'nativeCloses',
        'budgetSettlements',
        'httpAttempts',
      ]);
      return Object.freeze({
        event: v.event,
        sequence: integer(v.sequence, 1, 8),
        handlerEntries: integer(v.handlerEntries, 0, 32),
        nativeReads: integer(v.nativeReads, 0, 32),
        nativeCloses: integer(v.nativeCloses, 0, 32),
        budgetSettlements: integer(v.budgetSettlements, 0, 32),
        httpAttempts: integer(v.httpAttempts, 0, 64),
      });
    default:
      invalid();
  }
}
export function parseHistoryControl(text: string): HistoryControl {
  const v = object(text);
  if (v.event === 'BARRIER') {
    keys(v, ['event', 'sequence']);
    return Object.freeze({
      event: v.event,
      sequence: integer(v.sequence, 1, 8),
    });
  }
  if (v.event === 'RELEASE_READ_IO') {
    keys(v, ['event', 'operation']);
    integer(v.operation, 1, 1);
    return Object.freeze({ event: v.event, operation: 1 });
  }
  invalid();
}

class FiniteLines<T> {
  private pending: number[] = [];
  private total = 0;
  private count = 0;
  private ended = false;
  private failed = false;
  constructor(
    private readonly lineBytes: number,
    private readonly totalBytes: number,
    private readonly frames: number,
    private readonly accept: (line: string) => T,
  ) {}
  push(chunk: Uint8Array): T[] {
    try {
      if (this.ended || this.failed || !(chunk instanceof Uint8Array))
        invalid();
      this.total += chunk.byteLength;
      if (this.total > this.totalBytes) invalid();
      const result: T[] = [];
      for (const byte of chunk) {
        if (this.pending.length + 1 > this.lineBytes) invalid();
        if (byte !== 10) {
          this.pending.push(byte);
          continue;
        }
        if (++this.count > this.frames) invalid();
        const line = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(new Uint8Array(this.pending));
        this.pending = [];
        if (line.includes('\r')) invalid();
        result.push(this.accept(line));
      }
      return result;
    } catch {
      this.failed = true;
      invalid();
    }
  }
  finish() {
    if (this.failed || this.ended || this.pending.length) {
      this.failed = true;
      invalid();
    }
    this.ended = true;
  }
}
type WaitTarget = {
  readonly event: HistoryPhase['event'];
  readonly operation?: number;
  readonly sequence?: number;
};
type Waiter = {
  target: WaitTarget;
  resolve: (event: HistoryPhase) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
function matches(event: HistoryPhase, target: WaitTarget) {
  return (
    event.event === target.event &&
    (target.operation === undefined ||
      ('operation' in event && event.operation === target.operation)) &&
    (target.sequence === undefined ||
      ('sequence' in event && event.sequence === target.sequence))
  );
}
export class HistoryPhaseDecoder {
  private readonly lines = new FiniteLines(512, 16_384, 64, (line) =>
    this.accept(parseHistoryPhase(line)),
  );
  private readonly received: HistoryPhase[] = [];
  private readonly waiters = new Set<Waiter>();
  private waits = 0;
  private boot = false;
  private ended = false;
  private failed = false;
  private terminal = false;
  private operation = 0;
  private active = false;
  private native = false;
  private held = false;
  private aborted = false;
  private budget = false;
  private closes = 0;
  private settlements = 0;
  private sequence = 0;
  private reads = 0;
  private http = 0;
  get events(): readonly HistoryPhase[] {
    return Object.freeze([...this.received]);
  }
  private fail(): never {
    this.failed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(HISTORY_PROTOCOL_ERROR));
    }
    this.waiters.clear();
    invalid();
  }
  push(chunk: Uint8Array): readonly HistoryPhase[] {
    if (this.failed || this.ended) return this.fail();
    try {
      return this.lines.push(chunk);
    } catch {
      return this.fail();
    }
  }
  finish() {
    try {
      this.lines.finish();
      if ((!this.boot && !this.terminal) || this.active || this.waiters.size)
        return this.fail();
      this.ended = true;
    } catch {
      return this.fail();
    }
  }
  async waitFor(target: WaitTarget, timeoutMs = 2_000): Promise<HistoryPhase> {
    integer(timeoutMs, 1, 10_000);
    if (
      ![
        'BOOT_READY',
        'HANDLER_ENTER',
        'NATIVE_CLOSED',
        'READ_IO_HELD',
        'SIGNAL_ABORTED',
        'BUDGET_CLOSED',
        'OWNER_SETTLED',
        'BARRIER',
        'FIXTURE_ERROR',
        'PROTOCOL_ERROR',
      ].includes(target.event)
    )
      invalid();
    if (target.operation !== undefined) integer(target.operation, 1, 32);
    if (target.sequence !== undefined) integer(target.sequence, 1, 8);
    if (++this.waits > 64 || this.failed) invalid();
    const prior = this.received.find((event) => matches(event, target));
    if (prior) return prior;
    if (this.ended || this.terminal || this.waiters.size >= 8) invalid();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        target: Object.freeze({ ...target }),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(HISTORY_PROTOCOL_ERROR));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
  private accept(event: HistoryPhase): HistoryPhase {
    if (this.terminal) invalid();
    if (event.event === 'FIXTURE_ERROR' || event.event === 'PROTOCOL_ERROR') {
      this.terminal = true;
      if (this.active) invalid();
    } else if (event.event === 'BOOT_READY') {
      if (this.boot || this.operation || this.sequence) invalid();
      this.boot = true;
    } else {
      if (!this.boot) invalid();
      if (event.event === 'BARRIER') {
        if (
          event.sequence !== this.sequence + 1 ||
          event.handlerEntries !== this.operation ||
          event.nativeCloses !== this.closes ||
          event.budgetSettlements !== this.settlements ||
          event.nativeReads < this.reads ||
          event.nativeReads < this.closes ||
          event.nativeReads > this.operation ||
          event.httpAttempts < this.http
        )
          invalid();
        this.sequence = event.sequence;
        this.reads = event.nativeReads;
        this.http = event.httpAttempts;
      } else if ('operation' in event) {
        if (event.event === 'HANDLER_ENTER') {
          if (this.active || event.operation !== this.operation + 1) invalid();
          this.operation = event.operation;
          this.active = true;
          this.native = this.held = this.aborted = this.budget = false;
        } else {
          if (!this.active || event.operation !== this.operation) invalid();
          switch (event.event) {
            case 'NATIVE_CLOSED':
              if (this.native || this.held || this.budget) invalid();
              this.native = true;
              this.closes++;
              break;
            case 'READ_IO_HELD':
              if (!this.native || this.held || this.budget) invalid();
              this.held = true;
              break;
            case 'SIGNAL_ABORTED':
              if (this.aborted) invalid();
              this.aborted = true;
              break;
            case 'BUDGET_CLOSED':
              if (this.budget || (this.held && !this.aborted)) invalid();
              this.budget = true;
              this.settlements++;
              break;
            case 'OWNER_SETTLED':
              if (
                ((this.native || this.held) && !this.budget) ||
                event.aborted !== this.aborted ||
                (event.code === 'Cancelled' && !this.aborted)
              )
                invalid();
              this.active = false;
              break;
          }
        }
      }
    }
    this.received.push(event);
    for (const waiter of this.waiters) {
      if (!matches(event, waiter.target)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
    return event;
  }
}
export class HistoryControlDecoder {
  private sequence = 0;
  private released = false;
  private readonly lines = new FiniteLines(128, 2_048, 16, (line) => {
    const command = parseHistoryControl(line);
    if (command.event === 'BARRIER') {
      if (command.sequence !== this.sequence + 1) invalid();
      this.sequence = command.sequence;
    } else {
      if (!this.sequence || this.released) invalid();
      this.released = true;
    }
    return command;
  });
  push(chunk: Uint8Array): readonly HistoryControl[] {
    return this.lines.push(chunk);
  }
  finish() {
    this.lines.finish();
  }
}
