/** Narrow C2 fixture: real native transport only; no SDK, storage or source facts. */
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { version } from '../../package.json';
import { SpeedyIndexClient } from '../../src/client';
import {
  compareReportsEnvelopeSchema,
  compareReportsInputSchema,
  type CompareReportsInput,
} from '../../src/compare-reports';
import {
  compareLiteralFrameOracle,
  installCompareDefaultDeny,
} from './compare-reports-measurements';

export const compareFixtureKey = 'synthetic-compare-owner-key-do-not-use';
export const compareFixturePhases = [
  'READY',
  'ENV_OK',
  'SETTLED',
  'before_status0',
  'after_status0',
  'after_report_a',
  'after_status1',
  'after_report_b',
  'after_status2',
  'after_comparison',
  'after_serialization',
  'before_close',
  'after_close',
] as const;
type FixturePhase = (typeof compareFixturePhases)[number];
type FixtureEvent =
  | { kind: 'phase'; phase: FixturePhase }
  | {
      kind: 'result';
      envelope: ReturnType<typeof compareReportsEnvelopeSchema.parse>;
    };

const invalid: () => never = () => {
  throw new Error('Invalid compare fixture protocol.');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  )
    invalid();
}

/** One bounded newline protocol; fragmented input is never treated as a complete frame. */
export class CompareFixtureParser {
  private buffer = '';
  private events: FixtureEvent[] = [];
  private count = 0;
  constructor(private readonly maxBytes = 2_100_000) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 32 ||
      maxBytes > 2_100_000
    )
      invalid();
  }
  push(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) invalid();
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (++this.count > 128) invalid();
      const value = object(JSON.parse(line));
      if (value.kind === 'phase') {
        keys(value, ['kind', 'phase']);
        const phase = compareFixturePhases.find(
          (candidate) => candidate === value.phase,
        );
        if (phase === undefined) invalid();
        this.events.push({ kind: 'phase', phase });
      } else if (value.kind === 'result') {
        keys(value, ['kind', 'envelope']);
        const parsed = compareReportsEnvelopeSchema.safeParse(value.envelope);
        if (!parsed.success) invalid();
        this.events.push({ kind: 'result', envelope: parsed.data });
      } else invalid();
    }
  }
  drain() {
    const events = this.events;
    this.events = [];
    return events;
  }
  finish() {
    if (this.buffer !== '') invalid();
  }
}

export type CompareWireStep =
  | Readonly<{ kind: 'status' }>
  | Readonly<{ kind: 'report'; side: 'before' | 'after'; page?: number }>;

export function parseCompareWireSteps(
  value: unknown,
  input: CompareReportsInput,
): readonly CompareWireStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 63)
    return invalid();
  return Object.freeze(
    value.map((raw): CompareWireStep => {
      const step = object(raw);
      if (step.kind === 'status') {
        keys(step, ['kind']);
        return Object.freeze({ kind: 'status' });
      }
      if (
        step.kind !== 'report' ||
        (step.side !== 'before' && step.side !== 'after')
      )
        return invalid();
      if (input.family === 'backlink/checker') {
        keys(step, ['kind', 'side', 'page']);
        if (
          typeof step.page !== 'number' ||
          !Number.isSafeInteger(step.page) ||
          step.page < 0 ||
          step.page > 14
        )
          return invalid();
        return Object.freeze({
          kind: 'report',
          side: step.side,
          page: step.page,
        });
      }
      keys(step, ['kind', 'side']);
      return Object.freeze({ kind: 'report', side: step.side });
    }),
  );
}

/** Capture native fetch before installing the default deny guard; no response is fabricated. */
export function createCompareFixtureFetch(
  ownedOrigin: string,
  suppliedInput: unknown,
  suppliedSteps: unknown,
  nativeFetch: typeof fetch,
) {
  const input = compareReportsInputSchema.parse(suppliedInput);
  const steps = parseCompareWireSteps(suppliedSteps, input);
  const loopback = new URL(ownedOrigin);
  if (
    loopback.protocol !== 'http:' ||
    loopback.hostname !== '127.0.0.1' ||
    !loopback.port ||
    loopback.origin !== ownedOrigin ||
    loopback.username ||
    loopback.password
  )
    invalid();
  let entered = 0;
  const denied = () => {
    throw new Error('Compare fixture preconnect denied.');
  };
  const guarded: typeof fetch = Object.assign(
    async (
      target: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const step = steps[entered];
      if (!step) return invalid();
      const path = `/v2/task/${input.family}/${step.kind === 'status' ? 'status' : 'report'}`;
      const url = new URL(
        target instanceof Request ? target.url : target.toString(),
      );
      const body =
        step.kind === 'status'
          ? { task_ids: [input.beforeTaskId, input.afterTaskId] }
          : input.family === 'backlink/checker'
            ? {
                task_id:
                  step.side === 'before'
                    ? input.beforeTaskId
                    : input.afterTaskId,
                page: step.page,
                limit: 100,
              }
            : {
                task_id:
                  step.side === 'before'
                    ? input.beforeTaskId
                    : input.afterTaskId,
              };
      const headers = new Headers(init?.headers);
      if (
        url.href !== `https://api.speedyindex.com${path}` ||
        init?.method !== 'POST' ||
        init.redirect !== 'error' ||
        !(init.signal instanceof AbortSignal) ||
        init.body !== JSON.stringify(body) ||
        headers.get('authorization') !== compareFixtureKey ||
        headers.get('accept') !== 'application/json' ||
        headers.get('content-type') !== 'application/json' ||
        headers.get('user-agent') !== `speedyindex-mcp/${version}` ||
        [...headers].length !== 4
      )
        return invalid();
      entered++;
      return nativeFetch(new URL(path, loopback), init);
    },
    { preconnect: denied },
  );
  return Object.freeze({
    fetch: guarded,
    entered: () => entered,
    expected: steps.length,
  });
}

type NativeRead = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>;
export interface CompareNativeHooks {
  onReader?(reader: ReadableStreamDefaultReader<Uint8Array>): void;
  afterRead?(receipt: NativeRead): void;
  cancelSettled?(): void;
  holdCancel?: Promise<void>;
  afterCancel?(): void;
  afterRelease?(): void;
}
/** Native action FIRST; only its delegated cancel receipt may be held afterwards. */
export function decorateCompareNative(
  response: Response,
  hooks: CompareNativeHooks,
): Response {
  const body = response.body;
  if (!body) return response;
  const cancel = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } finally {
      hooks.cancelSettled?.();
      await hooks.holdCancel;
      hooks.afterCancel?.();
    }
  };
  const decoratedBody = new Proxy(body, {
    get(actualBody, property) {
      if (property === 'cancel') return () => cancel(() => actualBody.cancel());
      if (property === 'getReader')
        return () => {
          const reader = actualBody.getReader();
          hooks.onReader?.(reader);
          return new Proxy(reader, {
            get(actualReader, field) {
              if (field === 'read')
                return async () => {
                  const receipt = await actualReader.read();
                  hooks.afterRead?.(receipt);
                  return receipt;
                };
              if (field === 'cancel')
                return () => cancel(() => actualReader.cancel());
              if (field === 'releaseLock')
                return () => {
                  actualReader.releaseLock();
                  hooks.afterRelease?.();
                };
              const value = Reflect.get(
                actualReader,
                field,
                actualReader,
              ) as unknown;
              return typeof value === 'function'
                ? value.bind(actualReader)
                : value;
            },
          });
        };
      const value = Reflect.get(actualBody, property, actualBody) as unknown;
      return typeof value === 'function' ? value.bind(actualBody) : value;
    },
  });
  return new Proxy(response, {
    get(actualResponse, property) {
      if (property === 'body') return decoratedBody;
      const value = Reflect.get(
        actualResponse,
        property,
        actualResponse,
      ) as unknown;
      return typeof value === 'function' ? value.bind(actualResponse) : value;
    },
  });
}

/** Literal fixture images; no production projector, comparison, meter or observer supplies N. */
export function compareFixtureSelfCheck() {
  const deny = installCompareDefaultDeny();
  try {
    const data = {
      status: 'error',
      error: {
        code: 'InternalError',
        message: 'Report comparison failed internally.',
      },
    };
    const envelope = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
    const frames = [
      { kind: 'phase', phase: 'READY' },
      { kind: 'phase', phase: 'after_close' },
      { kind: 'result', envelope },
    ];
    const saved = frames.map((frame) => JSON.stringify(frame) + '\n').join('');
    for (const fragments of [
      [saved],
      [...saved],
      [saved.slice(0, 7), saved.slice(7, 39), saved.slice(39)],
    ]) {
      const parser = new CompareFixtureParser();
      for (const fragment of fragments) parser.push(fragment);
      parser.finish();
      assert.deepEqual(parser.drain(), frames);
      assert.deepEqual(parser.drain(), []);
    }
    for (const bad of [
      '{}\n',
      '{"kind":"phase","phase":"unlisted"}\n',
      '{"kind":"phase","phase":"READY","extra":1}\n',
      JSON.stringify({
        kind: 'result',
        envelope: { ...envelope, isError: false },
      }) + '\n',
    ]) {
      assert.throws(() => new CompareFixtureParser().push(bad));
    }
    const incomplete = new CompareFixtureParser();
    incomplete.push('{"kind":"phase"');
    assert.throws(() => incomplete.finish());
    assert.throws(() => new CompareFixtureParser(32).push('x'.repeat(33)));
    assert.equal(deny.calls(), 0);
    const oracle = compareLiteralFrameOracle();
    assert.equal(
      oracle.rawGenericVisits.reduce((sum, count) => sum + count, 0),
      12,
    );
    assert.equal(
      oracle.peakBytes,
      Math.max(...Object.values(oracle.frameBytes)),
    );
    return {
      kind: 'self_check',
      parserCases: 9,
      networkCalls: 0,
      frameCases: Object.keys(oracle.frames).length,
      frameBytes: oracle.frameBytes,
      framePeakBytes: oracle.peakBytes,
      fixturePeaks: oracle.fixturePeaks,
      backlinkEnvelopeBytes: oracle.backlinkEnvelopeBytes,
      rawBacklinkDonorVisits: oracle.rawBacklinkDonorVisits,
      rawBacklinkTargetVisits: oracle.rawBacklinkTargetVisits,
      envelopeBytes: oracle.envelopeBytes,
      rawGenericTotal: oracle.rawGenericTotal,
    };
  } finally {
    deny.restore();
  }
}

async function runCompareFixtureChild() {
  const guard = installCompareDefaultDeny();
  const phase = (value: FixturePhase): void => {
    process.stderr.write(
      JSON.stringify({ kind: 'phase', phase: value }) + '\n',
    );
  };
  try {
    phase('READY');
    if (
      !process.execArgv.includes('--no-env-file') ||
      !Object.keys(process.env).every((name) =>
        ['HOME', 'TMPDIR', 'PATH', 'TZ'].includes(name),
      ) ||
      !process.env.HOME ||
      !process.env.TMPDIR ||
      (statSync(process.env.HOME).mode & 0o777) !== 0o700 ||
      (statSync(process.env.TMPDIR).mode & 0o777) !== 0o700
    )
      invalid();
    phase('ENV_OK');
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of process.stdin) {
      text +=
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(text, 'utf8') > 65_536) invalid();
    }
    text += decoder.decode();
    const command = object(JSON.parse(text));
    keys(command, ['origin', 'input', 'steps']);
    if (typeof command.origin !== 'string') invalid();
    const input = compareReportsInputSchema.parse(command.input);
    const transport = createCompareFixtureFetch(
      command.origin,
      input,
      command.steps,
      guard.nativeFetch,
    );
    // The actual owner module is the next C2-A implementation target; no substitute is provided here.
    const { createCompareReportsOwner } =
      await import('../../src/compare-reports-owner');
    const owner = createCompareReportsOwner(
      new SpeedyIndexClient(compareFixtureKey, transport.fetch),
      { onPhase: phase },
    );
    const envelope = await owner.compare(input);
    phase('SETTLED');
    if (guard.calls() !== 0) invalid();
    process.stdout.write(JSON.stringify({ kind: 'result', envelope }) + '\n');
  } finally {
    guard.restore();
  }
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === '--self-check') {
    process.stdout.write(JSON.stringify(compareFixtureSelfCheck()) + '\n');
  } else if (process.argv.length === 2) {
    await runCompareFixtureChild();
  } else invalid();
}

export { compareLiteralFrameOracle, installCompareDefaultDeny };
