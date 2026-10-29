/** Finite synthetic observation/control grammar; imports no SDK or product. */
export const COMPARE_PHASE_PREFIX = 'COMPARE_PHASE ';
export const COMPARE_SANITY_PREFIX = 'COMPARE_SANITY ';
export const COMPARE_PROTOCOL_ERROR = 'Invalid comparison fixture protocol.';
export const compareProtocolLimits = Object.freeze({
  phaseLineBytes: 512,
  phaseBytes: 16_384,
  phaseEvents: 64,
  controlLineBytes: 128,
  controlBytes: 2_048,
  controlFrames: 16,
  operations: 32,
  sequences: 8,
});
const witnessNames = [
  'READ_PENDING',
  'SIGNAL_ABORTED',
  'READER_RELEASED',
  'AFTER_CLOSE',
] as const;
const outcomeNames = [
  'READ_SETTLED',
  'NATIVE_CANCEL',
  'NATIVE_CLOSED',
  'CLIENT_SETTLED',
] as const;
const errorCodes = [
  'InvalidInput',
  'MissingCredentials',
  'Cancelled',
  'DeadlineExceeded',
  'ResourceLimitExceeded',
  'ReadFailed',
  'CleanupFailed',
  'InternalError',
];
const blockerCodes = [
  'StatusUnavailable',
  'IncompatibleTaskType',
  'TargetScopeUnavailable',
  'IncompatibleTargetScope',
  'UnsupportedReportUrl',
  'UnkeyedDonorEvidence',
  'ConflictingEvidence',
  'EvidenceChanged',
];
export type ComparePhase =
  | { event: 'BOOT_READY' | 'FIXTURE_ERROR' | 'PROTOCOL_ERROR' }
  | {
      event: 'HANDLER_ENTER' | (typeof witnessNames)[number];
      operation: number;
    }
  | {
      event: (typeof outcomeNames)[number];
      operation: number;
      outcome: 'fulfilled' | 'rejected';
    }
  | {
      event: 'OWNER_SETTLED';
      operation: number;
      aborted: boolean;
      status: 'compared' | 'blocked' | 'error';
      code: string | null;
      cancelledEnvelope: boolean;
    }
  | {
      event: 'BARRIER';
      sequence: number;
      handlers: number;
      readsEntered: number;
      readsSettled: number;
      cancelsSettled: number;
      releases: number;
      clientsSettled: number;
      closes: number;
      ownersSettled: number;
      httpAttempts: number;
    };
export type CompareControl =
  | { event: 'BARRIER'; sequence: number }
  | { event: 'RELEASE_CANCEL'; operation: 1 };
export function invalidCompareProtocol(): never {
  throw new Error(COMPARE_PROTOCOL_ERROR);
}
function number(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalidCompareProtocol();
  return value;
}
function object(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalidCompareProtocol();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalidCompareProtocol();
  const seen = new Set<string>();
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!/^\s*:/.test(text.slice(token.index + token[0].length))) continue;
    const key: string = JSON.parse(token[0]);
    if (seen.has(key)) invalidCompareProtocol();
    seen.add(key);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((k) => !names.includes(k))
  )
    invalidCompareProtocol();
}
export function parseComparePhase(text: string): ComparePhase {
  if (!text.startsWith(COMPARE_PHASE_PREFIX)) invalidCompareProtocol();
  const v = object(text.slice(COMPARE_PHASE_PREFIX.length));
  if (typeof v.event !== 'string') invalidCompareProtocol();
  if (['BOOT_READY', 'FIXTURE_ERROR', 'PROTOCOL_ERROR'].includes(v.event)) {
    keys(v, ['event']);
    return v as unknown as ComparePhase;
  }
  if (v.event === 'BARRIER') {
    const counts = [
      'handlers',
      'readsEntered',
      'readsSettled',
      'cancelsSettled',
      'releases',
      'clientsSettled',
      'closes',
      'ownersSettled',
      'httpAttempts',
    ];
    keys(v, ['event', 'sequence', ...counts]);
    number(v.sequence, 8, 1);
    for (const name of counts) number(v[name]);
    for (const name of [
      'handlers',
      'ownersSettled',
      'closes',
      'clientsSettled',
      'releases',
      'cancelsSettled',
    ])
      number(v[name], 32);
    if (
      (v.readsSettled as number) > (v.readsEntered as number) ||
      (v.ownersSettled as number) > (v.handlers as number)
    )
      invalidCompareProtocol();
    return v as unknown as ComparePhase;
  }
  number(v.operation, 32, 1);
  if (v.event === 'HANDLER_ENTER' || witnessNames.some((n) => n === v.event))
    keys(v, ['event', 'operation']);
  else if (outcomeNames.some((n) => n === v.event)) {
    keys(v, ['event', 'operation', 'outcome']);
    if (v.outcome !== 'fulfilled' && v.outcome !== 'rejected')
      invalidCompareProtocol();
  } else if (v.event === 'OWNER_SETTLED') {
    keys(v, [
      'event',
      'operation',
      'aborted',
      'status',
      'code',
      'cancelledEnvelope',
    ]);
    if (
      typeof v.aborted !== 'boolean' ||
      typeof v.cancelledEnvelope !== 'boolean'
    )
      invalidCompareProtocol();
    if (
      !(v.status === 'compared' && v.code === null) &&
      !(
        v.status === 'error' &&
        typeof v.code === 'string' &&
        errorCodes.includes(v.code)
      ) &&
      !(
        v.status === 'blocked' &&
        typeof v.code === 'string' &&
        blockerCodes.includes(v.code)
      )
    )
      invalidCompareProtocol();
    if (v.cancelledEnvelope && (!v.aborted || v.code !== 'Cancelled'))
      invalidCompareProtocol();
  } else invalidCompareProtocol();
  return v as unknown as ComparePhase;
}
export function parseCompareControl(text: string): CompareControl {
  const v = object(text);
  if (v.event === 'BARRIER') {
    keys(v, ['event', 'sequence']);
    number(v.sequence, 8, 1);
  } else if (v.event === 'RELEASE_CANCEL') {
    keys(v, ['event', 'operation']);
    if (v.operation !== 1) invalidCompareProtocol();
  } else invalidCompareProtocol();
  return v as unknown as CompareControl;
}
export class CompareLines<T> {
  private pending: number[] = [];
  private total = 0;
  private frames = 0;
  private ended = false;
  private failed = false;
  constructor(
    private readonly lineBytes: number,
    private readonly totalBytes: number,
    private readonly count: number,
    private readonly parse: (s: string) => T,
  ) {}
  push(chunk: Uint8Array): T[] {
    try {
      if (this.ended || this.failed || !(chunk instanceof Uint8Array))
        invalidCompareProtocol();
      this.total += chunk.byteLength;
      if (this.total > this.totalBytes) invalidCompareProtocol();
      const values: T[] = [];
      for (const byte of chunk) {
        if (this.pending.length + 1 > this.lineBytes) invalidCompareProtocol();
        if (byte !== 10) {
          this.pending.push(byte);
          continue;
        }
        if (++this.frames > this.count) invalidCompareProtocol();
        const text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(new Uint8Array(this.pending));
        this.pending = [];
        if (text.includes('\r')) invalidCompareProtocol();
        values.push(this.parse(text));
      }
      return values;
    } catch {
      this.failed = true;
      invalidCompareProtocol();
    }
  }
  finish() {
    if (this.failed || this.ended || this.pending.length) {
      this.failed = true;
      invalidCompareProtocol();
    }
    this.ended = true;
  }
}
type Target = {
  event: ComparePhase['event'];
  operation?: number;
  sequence?: number;
};
export class ComparePhaseDecoder {
  private received: ComparePhase[] = [];
  private active = 0;
  private operation = 0;
  private boot = false;
  private sequence = 0;
  private terminal = false;
  private ended = false;
  private seen = new Set<string>();
  private previous: Extract<ComparePhase, { event: 'BARRIER' }> | undefined;
  private waiters = new Set<{
    target: Target;
    resolve: (p: ComparePhase) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private waits = 0;
  private lines = new CompareLines(512, 16_384, 64, (line) =>
    this.accept(parseComparePhase(line)),
  );
  get events(): readonly ComparePhase[] {
    return [...this.received];
  }
  private match(p: ComparePhase, t: Target) {
    return (
      p.event === t.event &&
      (t.operation === undefined ||
        ('operation' in p && p.operation === t.operation)) &&
      (t.sequence === undefined ||
        ('sequence' in p && p.sequence === t.sequence))
    );
  }
  private accept(p: ComparePhase): ComparePhase {
    if (this.terminal) invalidCompareProtocol();
    if (p.event === 'FIXTURE_ERROR' || p.event === 'PROTOCOL_ERROR')
      this.terminal = true;
    else if (p.event === 'BOOT_READY') {
      if (this.boot || this.received.length) invalidCompareProtocol();
      this.boot = true;
    } else {
      if (!this.boot) invalidCompareProtocol();
      if (p.event === 'BARRIER') {
        if (p.sequence !== ++this.sequence) invalidCompareProtocol();
        if (this.previous)
          for (const key of [
            'handlers',
            'readsEntered',
            'readsSettled',
            'cancelsSettled',
            'releases',
            'clientsSettled',
            'closes',
            'ownersSettled',
            'httpAttempts',
          ] as const)
            if (p[key] < this.previous[key]) invalidCompareProtocol();
        this.previous = p;
      } else if (p.event === 'HANDLER_ENTER') {
        if (this.active || p.operation !== this.operation + 1)
          invalidCompareProtocol();
        this.active = p.operation;
        this.operation = p.operation;
      } else if ('operation' in p) {
        if (p.operation !== this.active) invalidCompareProtocol();
        const key = p.operation + ':' + p.event;
        if (this.seen.has(key)) invalidCompareProtocol();
        this.seen.add(key);
        if (p.event === 'OWNER_SETTLED') {
          if (
            p.aborted &&
            [
              'SIGNAL_ABORTED',
              'NATIVE_CANCEL',
              'READER_RELEASED',
              'CLIENT_SETTLED',
              'AFTER_CLOSE',
            ].some((n) => !this.seen.has(p.operation + ':' + n))
          )
            invalidCompareProtocol();
          this.active = 0;
        }
      }
    }
    this.received.push(p);
    for (const waiter of this.waiters)
      if (this.match(p, waiter.target)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(p);
      }
    return p;
  }
  push(bytes: Uint8Array): readonly ComparePhase[] {
    try {
      if (this.ended) invalidCompareProtocol();
      return this.lines.push(bytes);
    } catch {
      this.abortWaiters();
      invalidCompareProtocol();
    }
  }
  finish() {
    this.lines.finish();
    if (!this.boot || this.active || this.waiters.size)
      invalidCompareProtocol();
    this.ended = true;
  }
  private abortWaiters() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(COMPARE_PROTOCOL_ERROR));
    }
    this.waiters.clear();
  }
  waitFor(target: Target): Promise<ComparePhase> {
    if (++this.waits > 64 || this.waiters.size >= 8) invalidCompareProtocol();
    const found = this.received.find((p) => this.match(p, target));
    if (found) return Promise.resolve(found);
    if (this.ended || this.terminal) invalidCompareProtocol();
    return new Promise((resolve, reject) => {
      const waiter = {
        target,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Comparison fixture phase deadline.'));
        }, 5000),
      };
      this.waiters.add(waiter);
    });
  }
}
export class CompareControlDecoder {
  private sequence = 0;
  private released = false;
  private lines = new CompareLines(128, 2_048, 16, (line) => {
    const p = parseCompareControl(line);
    if (p.event === 'BARRIER') {
      if (p.sequence !== ++this.sequence) invalidCompareProtocol();
    } else {
      if (!this.sequence || this.released) invalidCompareProtocol();
      this.released = true;
    }
    return p;
  });
  push(bytes: Uint8Array) {
    return this.lines.push(bytes);
  }
  finish() {
    this.lines.finish();
  }
}
