import { expect, test } from 'bun:test';

import { spawn } from 'node:child_process';

import { createHash } from 'node:crypto';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createServer } from 'node:http';

import type { Socket } from 'node:net';

import { join } from 'node:path';

import { gzipSync, gunzipSync } from 'node:zlib';

import { SpeedyIndexClient } from '../src/client';

import {
  createCompareReportsOwner,
  type CompareOwnerPhase,
} from '../src/compare-reports-owner';

import type {
  InvocationReadBudget,
  ReadBudgetRuntime,
} from '../src/read-budget';

import {
  CompareFixtureParser,
  compareFixtureKey,
  compareLiteralFrameOracle,
  createCompareFixtureFetch,
  decorateCompareNative,
  installCompareDefaultDeny,
  type CompareWireStep,
} from './fixtures/compare-reports-native';

import {
  compareReportsEnvelopeSchema,
  type CompareReportsInput,
  type CompareReportsResult,
} from '../src/compare-reports';

import { normalizeTaskStatusResult, type TaskFamily } from '../src/task-status';

import { normalizeTaskReport } from '../src/task-report';

const a = 'https://example.test/a';

const b = 'https://example.test/b';

const c = 'https://example.test/c';

const d = 'https://example.test/d';

const e = 'https://example.test/e';

const f = 'https://example.test/f';

const donorUrl = 'https://DONOR.test/Path?b=2&a=1#exact';

const family: TaskFamily = 'google/indexer';

const input = { family, beforeTaskId: 'before', afterTaskId: 'after' };

const expectedScope = {
  basis: 'observed_union',
  direction: 'caller_selected',
  observations: 'non_atomic_provider_reports',
  originalCorpusEquality: 'unknown',
  originalHistory: 'unknown',
  liveState: 'not_observed',
} as const;

function status(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: family,
    size: 4,
    processedCount: 4,
    indexedCount: 2,
    isCompleted: true,
    ...extra,
  };
}

function links(
  id: string,
  indexedLinks = [a, c],
  unindexedLinks = [b, d],
  extra: Record<string, unknown> = {},
) {
  return {
    family,
    reportKind: 'links',
    taskId: id,
    type: family,
    size: 4,
    processedCount: 4,
    indexedCount: 2,
    indexedLinks,
    unindexedLinks,
    title: 'ignored',
    createdAt: 'ignored chronology',
    ...extra,
  };
}

function donor(targetLinks: unknown = [], extra: Record<string, unknown> = {}) {
  return {
    donor_url: donorUrl,
    processed: true,
    target_links: targetLinks,
    ...extra,
  };
}

function page(
  id: string,
  donors: unknown[] = [donor()],
  extra: Record<string, unknown> = {},
) {
  return {
    family: 'backlink/checker',
    reportKind: 'backlink',
    taskId: id,
    size: 1,
    processedCount: 1,
    page: 0,
    lastPage: 0,
    donors,
    isCompleted: true,
    ...extra,
  };
}

function asLinks(value: CompareReportsResult) {
  if (value.status !== 'compared' || value.reportKind !== 'links')
    throw new Error('Expected links comparison: ' + JSON.stringify(value));
  return value;
}

function independentEnvelope(value: CompareReportsResult) {
  return {
    isError: value.status === 'error',
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const bytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').length;

const literalA = 'https://example.test/é"\\a',
  literalB = 'https://example.test/Ω/b';

function literalGenericEnvelope() {
  const frame = compareLiteralFrameOracle().frames.envelopeCopy;
  const work: unknown = frame?.[5];
  if (!Array.isArray(work))
    throw new Error('Missing independent literal frame.');
  return compareReportsEnvelopeSchema.parse(work[2]);
}

const genericSteps: readonly CompareWireStep[] = [
  { kind: 'status' },
  { kind: 'report', side: 'before' },
  { kind: 'report', side: 'after' },
  { kind: 'status' },
  { kind: 'report', side: 'before' },
  { kind: 'report', side: 'after' },
  { kind: 'status' },
];

const ownerPhases: CompareOwnerPhase[] = [
  'before_status0',
  'after_status0',
  'after_report_a',
  'after_report_a',
  'after_status1',
  'after_report_b',
  'after_report_b',
  'after_status2',
  'after_comparison',
  'after_serialization',
  'before_close',
  'after_close',
];

function genericWireResponse(step: CompareWireStep) {
  const common = {
    size: 2,
    processed_count: 2,
    indexed_count: 1,
    is_completed: true,
  };
  return {
    code: 0,
    result:
      step.kind === 'status'
        ? [
            {
              id: 'before',
              type: 'google/indexer',
              ...common,
              created_at: ' status-before Ω ',
            },
            {
              id: 'after',
              type: 'google/indexer',
              ...common,
              created_at: ' status-after Ω ',
            },
          ]
        : {
            id: step.side,
            ...common,
            type: 'google/indexer',
            title: 'ignored fixture',
            created_at:
              step.side === 'before' ? 'report-before é' : 'report-after é',
            indexed_links:
              step.side === 'before'
                ? [literalA, literalA]
                : [literalB, literalB],
            unindexed_links: step.side === 'before' ? [literalB] : [literalA],
          },
  };
}

async function genericReceiver() {
  const arrivals: { path: string; body: string; bytes: number }[] = [];
  const closed: Promise<void>[] = [],
    errors: unknown[] = [];
  let closeCount = 0;
  const server = createServer((request, response) => {
    closed.push(
      new Promise((resolve) =>
        response.once('close', () => {
          closeCount++;
          resolve();
        }),
      ),
    );
    const step = genericSteps[arrivals.length];
    const index = arrivals.length;
    arrivals.push({ path: request.url ?? '', body: '', bytes: 0 });
    void (async () => {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      const expectedBody =
        step?.kind === 'status'
          ? { task_ids: ['before', 'after'] }
          : { task_id: step?.side };
      expect(step).toBeDefined();
      expect(request.method).toBe('POST');
      expect(request.url).toBe(
        `/v2/task/google/indexer/${step?.kind === 'status' ? 'status' : 'report'}`,
      );
      expect(request.headers.authorization).toBe(compareFixtureKey);
      expect(body).toBe(JSON.stringify(expectedBody));
      if (!step) throw new Error('Unexpected native request.');
      const wire = JSON.stringify(genericWireResponse(step));
      arrivals[index] = {
        path: request.url!,
        body,
        bytes: Buffer.byteLength(wire, 'utf8'),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(wire);
    })().catch((error) => {
      errors.push(error);
      response.writeHead(500);
      response.end('{}');
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing owned receiver.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    arrivals,
    async receipts() {
      await Promise.all(closed);
      expect(errors).toEqual([]);
      expect(closeCount).toBe(7);
      expect(arrivals).toHaveLength(7);
    },
    async close() {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function readComparePipe(
  stream: AsyncIterable<Buffer | string>,
  parser: CompareFixtureParser,
) {
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    parser.push(
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true }),
    );
  parser.push(decoder.decode());
  parser.finish();
}

test('CR-I01 Google actual child and captured receiver methods use seven native reads and original signal budget', async () => {
  const api = await genericReceiver();
  const root = await mkdtemp(
    join(process.env.TMPDIR || '/tmp', 'compare-child-'),
  );
  await Promise.all([
    mkdir(join(root, 'home'), { mode: 0o700 }),
    mkdir(join(root, 'tmp'), { mode: 0o700 }),
  ]);
  const child = spawn(
    process.execPath,
    ['--no-env-file', 'tests/fixtures/compare-reports-native.ts'],
    {
      cwd: process.cwd(),
      env: {
        HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        PATH: '/usr/bin:/bin',
        TZ: 'UTC',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stdout = new CompareFixtureParser(),
    stderr = new CompareFixtureParser();
  const pipes = Promise.all([
    readComparePipe(child.stdout, stdout),
    readComparePipe(child.stderr, stderr),
  ]);
  let succeeded = false;
  try {
    child.stdin.end(
      JSON.stringify({ origin: api.origin, input, steps: genericSteps }),
    );
    expect(await exit).toEqual({ code: 0, signal: null });
    await pipes;
    expect(stderr.drain()).toEqual(
      (['READY', 'ENV_OK', ...ownerPhases, 'SETTLED'] as const).map(
        (phase) => ({
          kind: 'phase',
          phase,
        }),
      ),
    );
    expect(stdout.drain()).toEqual([
      { kind: 'result', envelope: literalGenericEnvelope() },
    ]);
    await api.receipts();
    succeeded = true;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    const cleanup = await Promise.allSettled([exit, pipes, api.close()]);
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
    if (succeeded) await rm(root, { recursive: true });
  }

  const native = await genericReceiver(),
    guard = installCompareDefaultDeny();
  const readerReceipts: Promise<void>[] = [];
  const transport = createCompareFixtureFetch(
    native.origin,
    input,
    genericSteps,
    guard.nativeFetch,
  );
  const decorated: typeof fetch = Object.assign(
    async (
      target: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) =>
      decorateCompareNative(await transport.fetch(target, init), {
        onReader(reader) {
          readerReceipts.push(reader.closed);
        },
      }),
    {
      preconnect() {
        throw new Error('Denied preconnect.');
      },
    },
  );
  const client = new SpeedyIndexClient(compareFixtureKey, decorated);
  const observed: {
    receiver: boolean;
    signal: AbortSignal | undefined;
    budget: InvocationReadBudget | undefined;
  }[] = [];
  const originalStatus = client.getTaskStatus,
    originalReport = client.getTaskReport;
  client.getTaskStatus = function (
    this: SpeedyIndexClient,
    ...args: Parameters<SpeedyIndexClient['getTaskStatus']>
  ) {
    const receipt = originalStatus.apply(this, args);
    observed.push({
      receiver: this === client,
      signal: args[1],
      budget: args[2],
    });
    return receipt;
  };
  client.getTaskReport = function (
    this: SpeedyIndexClient,
    ...args: Parameters<SpeedyIndexClient['getTaskReport']>
  ) {
    const receipt = originalReport.apply(this, args);
    observed.push({
      receiver: this === client,
      signal: args[1],
      budget: args[2],
    });
    return receipt;
  };
  let receiverChecks = 0;
  const runtime: ReadBudgetRuntime = {
    now() {
      const value = performance.now();
      expect(this).toBe(runtime);
      receiverChecks++;
      return value;
    },
    setTimeout(callback, delay) {
      const handle = setTimeout(callback, delay);
      expect(this).toBe(runtime);
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      expect(this).toBe(runtime);
    },
  };
  const lower = { maxReads: 63 };
  const phases: CompareOwnerPhase[] = [];
  const owner = createCompareReportsOwner(client, {
    limits: lower,
    runtime,
    onPhase: (phase) => {
      phases.push(phase);
    },
  });
  client.getTaskStatus = () => {
    throw new Error('Uncaptured status sentinel.');
  };
  client.getTaskReport = () => {
    throw new Error('Uncaptured report sentinel.');
  };
  runtime.now = () => {
    throw new Error('Uncaptured clock sentinel.');
  };
  runtime.setTimeout = () => {
    throw new Error('Uncaptured timer sentinel.');
  };
  runtime.clearTimeout = () => {
    throw new Error('Uncaptured disarm sentinel.');
  };
  lower.maxReads = 1;
  const controller = new AbortController();
  try {
    const envelope = await owner.compare(input, controller.signal);
    expect(envelope).toEqual(literalGenericEnvelope());
    expect(phases).toEqual(ownerPhases);
    expect(observed).toHaveLength(7);
    expect(
      observed.every(
        (item) =>
          item.receiver &&
          item.signal === controller.signal &&
          item.budget === observed[0]!.budget,
      ),
    ).toBe(true);
    expect(observed[0]!.budget).toBeDefined();
    expect(receiverChecks).toBeGreaterThan(7);
    await Promise.all(readerReceipts);
    expect(readerReceipts).toHaveLength(7);
    await native.receipts();
    expect(transport.entered()).toBe(7);
    expect(guard.calls()).toBe(0);
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.all(readerReceipts),
      native.close(),
    ]);
    guard.restore();
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
  }
}, 30_000);

test('CR-I05 generic independent literal frame inclusive N22271 and N-1 native receipts', async () => {
  const oracle = compareLiteralFrameOracle();
  expect(oracle.fixturePeaks.generic).toBe(22271);
  expect(oracle.envelopeBytes).toBe(5196);
  expect(oracle.rawGenericVisits).toEqual([3, 3, 3, 3]);
  expect(oracle.rawGenericVisits.reduce((sum, count) => sum + count, 0)).toBe(
    12,
  );
  for (const retainedBytes of [22271, 22270]) {
    const api = await genericReceiver(),
      guard = installCompareDefaultDeny();
    const receipts: Promise<void>[] = [],
      phases: CompareOwnerPhase[] = [];
    const transport = createCompareFixtureFetch(
      api.origin,
      input,
      genericSteps,
      guard.nativeFetch,
    );
    const decorated: typeof fetch = Object.assign(
      async (
        target: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) =>
        decorateCompareNative(await transport.fetch(target, init), {
          onReader(reader) {
            receipts.push(reader.closed);
          },
        }),
      {
        preconnect() {
          throw new Error('Denied preconnect.');
        },
      },
    );
    try {
      const owner = createCompareReportsOwner(
        new SpeedyIndexClient(compareFixtureKey, decorated),
        {
          limits: { retainedBytes },
          onPhase: (phase) => {
            phases.push(phase);
          },
        },
      );
      const result = await owner.compare(input);
      const failure: CompareReportsResult = {
        status: 'error',
        error: {
          code: 'ResourceLimitExceeded',
          message: 'Report comparison exceeded a resource limit.',
        },
      };
      expect(result).toEqual(
        retainedBytes === 22271
          ? literalGenericEnvelope()
          : independentEnvelope(failure),
      );
      expect(phases).toEqual(
        retainedBytes === 22271
          ? ownerPhases
          : ownerPhases.filter((phase) => phase !== 'after_serialization'),
      );
      expect(bytes(result)).toBe(
        retainedBytes === 22271 ? 5196 : bytes(independentEnvelope(failure)),
      );
      expect(compareReportsEnvelopeSchema.safeParse(result).success).toBe(true);
      await Promise.all(receipts);
      expect(receipts).toHaveLength(7);
      await api.receipts();
      expect(transport.entered()).toBe(7);
      expect(guard.calls()).toBe(0);
    } finally {
      const cleanup = await Promise.allSettled([
        Promise.all(receipts),
        api.close(),
      ]);
      guard.restore();
      expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
    }
  }
}, 30_000);

type N1Record = Record<string, unknown>;

type N1GenericFamily = Exclude<TaskFamily, 'backlink/checker'>;

type N1LinksResult = Extract<CompareReportsResult, { reportKind: 'links' }>;

type N1BacklinkResult = Extract<
  CompareReportsResult,
  { reportKind: 'backlink' }
>;

type N1Target = Extract<
  N1BacklinkResult['rows'][number]['before'],
  { state: 'reported' }
>['targetLinks'][number];

interface N1Script {
  id: string;
  input: CompareReportsInput;
  steps: readonly CompareWireStep[];
  reply(step: CompareWireStep, index: number): unknown;
}

interface N1Expected {
  result: CompareReportsResult;
  reads: number;
  progress: readonly CompareOwnerPhase[];
  child?: boolean;
  retainedBytes?: number;
}

const n1Selected: CompareReportsInput = { ...input };

const n1BacklinkSelected: CompareReportsInput = {
  ...input,
  family: 'backlink/checker',
};

const n1Initial: readonly CompareOwnerPhase[] = ['before_status0'];

const n1ReportStart: readonly CompareOwnerPhase[] = [
  'before_status0',
  'after_status0',
];

const n1Status1: readonly CompareOwnerPhase[] = [
  ...n1ReportStart,
  'after_report_a',
  'after_report_a',
];

const n1BeforeFence: readonly CompareOwnerPhase[] = [
  ...n1Status1,
  'after_status1',
  'after_report_b',
];

const n1AfterFence: readonly CompareOwnerPhase[] = [
  ...n1BeforeFence,
  'after_report_b',
];

const n1Complete: readonly CompareOwnerPhase[] = ownerPhases.slice(0, -2);

function n1ReportMarkers(
  phase: 'after_report_a' | 'after_report_b',
  pages: number,
): readonly CompareOwnerPhase[] {
  return Array.from({ length: pages }, () => phase);
}

const n1BacklinkStatus1: readonly CompareOwnerPhase[] = [
  ...n1ReportStart,
  ...n1ReportMarkers('after_report_a', 5),
];

const n1BacklinkBeforeB: readonly CompareOwnerPhase[] = [
  ...n1BacklinkStatus1,
  'after_status1',
];

const n1BacklinkBeforeFence: readonly CompareOwnerPhase[] = [
  ...n1BacklinkBeforeB,
  ...n1ReportMarkers('after_report_b', 3),
];

const n1BacklinkAfterFence: readonly CompareOwnerPhase[] = [
  ...n1BacklinkBeforeFence,
  ...n1ReportMarkers('after_report_b', 2),
];

const n1BacklinkComplete: readonly CompareOwnerPhase[] = [
  ...n1BacklinkAfterFence,
  'after_status2',
  'after_comparison',
  'after_serialization',
];

const n1BacklinkFirstA: readonly CompareOwnerPhase[] = [
  ...n1ReportStart,
  'after_report_a',
];

const n1BacklinkFirstB: readonly CompareOwnerPhase[] = [
  ...n1BacklinkBeforeB,
  'after_report_b',
];

const n1BoundaryComplete: readonly CompareOwnerPhase[] = [
  ...n1ReportStart,
  ...n1ReportMarkers('after_report_a', 3),
  'after_status1',
  ...n1ReportMarkers('after_report_b', 3),
  'after_status2',
  'after_comparison',
  'after_serialization',
];

const n1BlockMessages = {
  StatusUnavailable: 'A required task status was not returned.',
  IncompatibleTaskType:
    'The observed task types do not match the selected family.',
  TargetScopeUnavailable: 'Safe current backlink target scope is unavailable.',
  IncompatibleTargetScope:
    'Current backlink target scopes do not match exactly.',
  ConflictingEvidence: 'Required report observations conflict.',
  EvidenceChanged: 'Required evidence changed between observations.',
} as const;

function n1Blocked(code: keyof typeof n1BlockMessages): CompareReportsResult {
  return {
    status: 'blocked',
    blocker: { code, message: n1BlockMessages[code] },
  };
}

function n1ReadFailed(
  phase: 'status' | 'report' | 'fence',
): CompareReportsResult {
  return {
    status: 'error',
    error: {
      code: 'ReadFailed',
      message: 'A required provider read failed.',
      phase,
      cause: 'response',
    },
  };
}

function n1ResourceFailure(): CompareReportsResult {
  return {
    status: 'error',
    error: {
      code: 'ResourceLimitExceeded',
      message: 'Report comparison exceeded a resource limit.',
    },
  };
}

function n1Record(value: unknown): value is N1Record {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function n1GenericResult(selected: N1GenericFamily): N1LinksResult {
  const original = asLinks(literalGenericEnvelope().structuredContent);
  return {
    ...original,
    family: selected,
    before: {
      ...original.before,
      status: { ...original.before.status, type: selected },
      report: { ...original.before.report, type: selected },
    },
    after: {
      ...original.after,
      status: { ...original.after.status, type: selected },
      report: { ...original.after.report, type: selected },
    },
  };
}

function n1Statuses(
  selected: TaskFamily,
  boundary = false,
): [N1Record, N1Record] {
  return ['before', 'after']
    .map((id): N1Record => ({
      id,
      type: selected,
      size: selected === 'backlink/checker' ? (boundary ? 1 : 4) : 2,
      processed_count: selected === 'backlink/checker' ? (boundary ? 1 : 2) : 2,
      ...(selected === 'backlink/checker' ? {} : { indexed_count: 1 }),
      is_completed: selected !== 'backlink/checker',
      created_at: id === 'before' ? ' status-before Ω ' : ' status-after Ω ',
      ...(selected === 'backlink/checker'
        ? {
            target_domains: boundary
              ? [' Example.test ', ' Example.test ']
              : [' Example.test ', ' Example.test ', 'Case.Test'],
          }
        : {}),
    }))
    .reduce<[N1Record, N1Record]>(
      (pair, row, index) => {
        pair[index === 0 ? 0 : 1] = row;
        return pair;
      },
      [{}, {}],
    );
}

function n1GenericReport(
  selected: N1GenericFamily,
  side: 'before' | 'after',
): N1Record {
  return {
    id: side,
    type: selected,
    title: 'ignored fixture',
    created_at: side === 'before' ? 'report-before é' : 'report-after é',
    size: 2,
    processed_count: 2,
    indexed_count: 1,
    is_completed: true,
    indexed_links:
      side === 'before' ? [literalA, literalA] : [literalB, literalB],
    unindexed_links: side === 'before' ? [literalB] : [literalA],
  };
}

function n1GenericScript(
  id: string,
  selected: N1GenericFamily = 'google/indexer',
): N1Script {
  return {
    id,
    input: { ...n1Selected, family: selected },
    steps: genericSteps,
    reply: (step) => ({
      code: 0,
      result:
        step.kind === 'status'
          ? n1Statuses(selected)
          : n1GenericReport(selected, step.side),
    }),
  };
}

function n1Frozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) n1Frozen(child);
  }
}

async function n1Run(script: N1Script, expected: N1Expected): Promise<void> {
  const guard = installCompareDefaultDeny();
  const arrivals: { path: string; body: string; responseBytes: number }[] = [];
  const handlers: Promise<void>[] = [],
    peers: Promise<void>[] = [];
  const closedReceipts: Promise<void>[] = [];
  const receiverErrors: unknown[] = [];
  const phases: CompareOwnerPhase[] = [];
  const calls: {
    receiver: boolean;
    signal: AbortSignal | undefined;
    budget: InvocationReadBudget | undefined;
  }[] = [];
  let root: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exit:
    Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let pipes: Promise<unknown> | undefined;
  let childExit:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stdoutEOF = false,
    stderrEOF = false,
    succeeded = false;
  let childPhases: string[] = [];
  let peerCloses = 0,
    readers = 0,
    readerClosed = 0,
    readReceipts = 0;
  let doneReceipts = 0,
    cancelReceipts = 0,
    releaseReceipts = 0;
  let beforeTeardown = false;
  const server = createServer((request, response) => {
    const index = arrivals.length;
    const step = script.steps[index];
    arrivals.push({ path: request.url ?? '', body: '', responseBytes: 0 });
    peers.push(
      new Promise<void>((resolve) =>
        response.once('close', () => {
          peerCloses++;
          resolve();
        }),
      ),
    );
    const handling = (async () => {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      if (!step) throw new Error('Unexpected N1 native request.');
      const expectedBody =
        step.kind === 'status'
          ? { task_ids: [script.input.beforeTaskId, script.input.afterTaskId] }
          : script.input.family === 'backlink/checker'
            ? {
                task_id:
                  step.side === 'before'
                    ? script.input.beforeTaskId
                    : script.input.afterTaskId,
                page: step.page,
                limit: 100,
              }
            : {
                task_id:
                  step.side === 'before'
                    ? script.input.beforeTaskId
                    : script.input.afterTaskId,
              };
      expect(request.method).toBe('POST');
      expect(request.url).toBe(
        `/v2/task/${script.input.family}/${step.kind === 'status' ? 'status' : 'report'}`,
      );
      expect(request.headers.authorization).toBe(compareFixtureKey);
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers['content-type']).toBe('application/json');
      expect(body).toBe(JSON.stringify(expectedBody));
      const wire = JSON.stringify(script.reply(step, index));
      if (typeof wire !== 'string')
        throw new Error('Invalid N1 saved wire data.');
      arrivals[index] = {
        path: request.url ?? '',
        body,
        responseBytes: Buffer.byteLength(wire, 'utf8'),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(wire);
    })().catch((error: unknown) => {
      receiverErrors.push(error);
      response.writeHead(500);
      response.end('{}');
    });
    handlers.push(handling);
  });
  const closeReceiver = async () => {
    server.closeIdleConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  };
  // This finally encloses all resource setup, including private roots and listen.
  try {
    root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'compare-n1-'));
    await writeFile(
      join(root, 'script.json'),
      JSON.stringify({
        id: script.id,
        input: script.input,
        steps: script.steps,
        responses: script.steps.map((step, index) => script.reply(step, index)),
        expected,
      }),
      { mode: 0o600 },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing N1 receiver.');
    const origin = `http://127.0.0.1:${address.port}`;
    if (expected.child) {
      await Promise.all([
        mkdir(join(root, 'home'), { mode: 0o700 }),
        mkdir(join(root, 'tmp'), { mode: 0o700 }),
      ]);
      child = spawn(
        process.execPath,
        ['--no-env-file', 'tests/fixtures/compare-reports-native.ts'],
        {
          cwd: process.cwd(),
          env: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            PATH: '/usr/bin:/bin',
            TZ: 'UTC',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      exit = new Promise((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', (code, signal) => resolve({ code, signal }));
      });
      if (!child.stdout || !child.stderr || !child.stdin)
        throw new Error('Missing owned child pipes.');
      const stdout = new CompareFixtureParser(),
        stderr = new CompareFixtureParser();
      pipes = Promise.all([
        readComparePipe(child.stdout, stdout).then(() => {
          stdoutEOF = true;
        }),
        readComparePipe(child.stderr, stderr).then(() => {
          stderrEOF = true;
        }),
      ]);
      child.stdin.end(
        JSON.stringify({ origin, input: script.input, steps: script.steps }),
      );
      childExit = await exit;
      expect(childExit).toEqual({ code: 0, signal: null });
      await pipes;
      const childEvents = stderr.drain();
      childPhases = childEvents.flatMap((event) =>
        event.kind === 'phase' ? [event.phase] : [],
      );
      expect(childEvents).toEqual(
        (
          [
            'READY',
            'ENV_OK',
            ...expected.progress,
            'before_close',
            'after_close',
            'SETTLED',
          ] as const
        ).map((phase) => ({ kind: 'phase', phase })),
      );
      expect(stdout.drain()).toEqual([
        { kind: 'result', envelope: independentEnvelope(expected.result) },
      ]);
      expect(guard.calls()).toBe(0);
    } else {
      const transport = createCompareFixtureFetch(
        origin,
        script.input,
        script.steps,
        guard.nativeFetch,
      );
      const decorated: typeof fetch = Object.assign(
        async (
          target: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) =>
          decorateCompareNative(await transport.fetch(target, init), {
            onReader(reader) {
              readers++;
              closedReceipts.push(
                reader.closed.then(() => {
                  readerClosed++;
                }),
              );
            },
            afterRead(receipt) {
              readReceipts++;
              if (receipt.done) doneReceipts++;
            },
            cancelSettled() {
              cancelReceipts++;
            },
            afterRelease() {
              releaseReceipts++;
            },
          }),
        {
          preconnect() {
            throw new Error('Denied N1 preconnect.');
          },
        },
      );
      const client = new SpeedyIndexClient(compareFixtureKey, decorated);
      const originalStatus = client.getTaskStatus,
        originalReport = client.getTaskReport;
      client.getTaskStatus = function (
        this: SpeedyIndexClient,
        ...args: Parameters<SpeedyIndexClient['getTaskStatus']>
      ) {
        const promise = originalStatus.apply(this, args);
        calls.push({
          receiver: this === client,
          signal: args[1],
          budget: args[2],
        });
        return promise;
      };
      client.getTaskReport = function (
        this: SpeedyIndexClient,
        ...args: Parameters<SpeedyIndexClient['getTaskReport']>
      ) {
        const promise = originalReport.apply(this, args);
        calls.push({
          receiver: this === client,
          signal: args[1],
          budget: args[2],
        });
        return promise;
      };
      const owner = createCompareReportsOwner(client, {
        ...(expected.retainedBytes === undefined
          ? {}
          : { limits: { retainedBytes: expected.retainedBytes } }),
        onPhase(phase) {
          phases.push(phase);
        },
      });
      client.getTaskStatus = () => {
        throw new Error('Uncaptured N1 status.');
      };
      client.getTaskReport = () => {
        throw new Error('Uncaptured N1 report.');
      };
      const controller = new AbortController();
      const actual = await owner.compare(script.input, controller.signal);
      expect(actual).toEqual(independentEnvelope(expected.result));
      expect(phases).toEqual([
        ...expected.progress,
        'before_close',
        'after_close',
      ]);
      expect(calls).toHaveLength(expected.reads);
      expect(calls[0]?.budget).toBeDefined();
      expect(
        calls.every(
          (call) =>
            call.receiver &&
            call.signal === controller.signal &&
            call.budget === calls[0]?.budget,
        ),
      ).toBe(true);
      expect(transport.entered()).toBe(expected.reads);
      expect(compareReportsEnvelopeSchema.safeParse(actual).success).toBe(true);
      expect(actual.isError).toBe(expected.result.status === 'error');
      expect(bytes(actual)).toBe(bytes(independentEnvelope(expected.result)));
      n1Frozen(actual);
      await Promise.all(closedReceipts);
      expect(readers).toBe(expected.reads);
      expect(readerClosed).toBe(expected.reads);
      expect(doneReceipts).toBe(expected.reads);
      expect(releaseReceipts).toBe(expected.reads);
      expect(guard.calls()).toBe(0);
    }
    await Promise.all(handlers);
    await Promise.all(peers);
    expect(receiverErrors).toEqual([]);
    expect(arrivals).toHaveLength(expected.reads);
    expect(peerCloses).toBe(expected.reads);
    beforeTeardown = true;
    succeeded = true;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    const settlement = await Promise.allSettled([
      ...handlers,
      ...closedReceipts,
      ...(exit ? [exit] : []),
      ...(pipes ? [pipes] : []),
    ]);
    const closure = await Promise.allSettled([closeReceiver()]);
    guard.restore();
    const receipt = {
      id: script.id,
      success: succeeded,
      nativeRequests: arrivals.length,
      arrivals,
      expectedRequests: expected.reads,
      peerCloses,
      completionBeforeTeardown: beforeTeardown,
      readers,
      readerClosed,
      readReceipts,
      doneReceipts,
      cancelReceipts,
      releaseReceipts,
      readerInstrumentation: expected.child
        ? 'Unchanged child fixture has no separate reader decorator; actual owner after_close plus child native EOF/reap recorded.'
        : 'Original native delegated receipts only.',
      phases: expected.child ? childPhases : phases,
      childPid: child?.pid ?? null,
      childExit: childExit ?? null,
      stdoutEOF,
      stderrEOF,
      settlement: settlement.map((result) => result.status),
      receiverClosure: closure.map((result) => result.status),
      receiverErrors: receiverErrors.map((error) =>
        error instanceof Error ? error.message : 'Non-Error receiver failure',
      ),
      failedRoot: succeeded ? null : (root ?? null),
    };
    if (root)
      await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt), {
        mode: 0o600,
      });
    console.info('CR_N1_NATIVE ' + JSON.stringify(receipt));
    expect(settlement.every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    expect(closure.every((result) => result.status === 'fulfilled')).toBe(true);
    if (succeeded && root) await rm(root, { recursive: true });
  }
}

const n1DonorUrl = 'https://example.test/donor';

const n1UnprocessedUrl = 'https://example.test/unprocessed';

const n1InvalidUrl = 'https://example.test/invalid';

const n1AfterOnlyUrl = 'https://example.test/after-only';

const n1OldLinks: readonly [N1Target, N1Target, N1Target] = [
  { url: literalA, anchor: 'old Ω', nofollow: false },
  { url: literalB, anchor: '', nofollow: true },
  { url: c, anchor: 'same', nofollow: false },
];

const n1NewLinks: readonly [N1Target, N1Target, N1Target] = [
  { url: literalA, anchor: 'new Ω', nofollow: true },
  { url: c, anchor: 'same', nofollow: false },
  { url: e, anchor: 'z', nofollow: false },
];

function n1MainDonor(
  side: 'before' | 'after',
  duplicate = false,
  reordered = false,
): N1Record {
  const links = side === 'before' ? [...n1OldLinks] : [...n1NewLinks];
  if (duplicate)
    links.push({ url: literalA, anchor: 'old Ω', nofollow: false });
  if (reordered) links.reverse();
  return {
    donor_url: n1DonorUrl,
    processed: true,
    target_links: links,
    DA: reordered ? 90 : 10,
  };
}

function n1UnprocessedDonor(): N1Record {
  return {
    donor_url: n1UnprocessedUrl,
    processed: false,
    target_links: [{ ignored: 'unprocessed' }],
  };
}

function n1InvalidDonor(): N1Record {
  return {
    donor_url: n1InvalidUrl,
    processed: true,
    target_links: [{ url: c, anchor: 17, nofollow: false }],
  };
}

function n1AfterOnlyDonor(): N1Record {
  return { donor_url: n1AfterOnlyUrl, processed: true, target_links: [] };
}

function n1BacklinkSteps(
  beforeLast: number,
  afterLast: number,
): readonly CompareWireStep[] {
  const reports = (side: 'before' | 'after', last: number): CompareWireStep[] =>
    Array.from({ length: last + 1 }, (_, page) => ({
      kind: 'report',
      side,
      page,
    }));
  return [
    { kind: 'status' },
    ...reports('before', beforeLast),
    ...reports('after', afterLast),
    { kind: 'status' },
    ...reports('before', beforeLast),
    ...reports('after', afterLast),
    { kind: 'status' },
  ];
}

function n1BacklinkReport(
  step: Extract<CompareWireStep, { kind: 'report' }>,
  redistributed = false,
  boundary = false,
): N1Record {
  const before = step.side === 'before',
    pageNumber = step.page ?? 0;
  let donors: N1Record[];
  if (boundary) donors = [n1MainDonor(step.side)];
  else if (before && redistributed)
    donors =
      pageNumber === 0
        ? [n1InvalidDonor()]
        : pageNumber === 1
          ? [n1MainDonor('before', true, true)]
          : [n1UnprocessedDonor(), n1MainDonor('before', true, true)];
  else if (before)
    donors =
      pageNumber === 0
        ? [n1MainDonor('before', true), n1UnprocessedDonor()]
        : pageNumber === 1
          ? []
          : [n1MainDonor('before', true), n1InvalidDonor()];
  else if (redistributed)
    donors =
      pageNumber === 0
        ? [n1AfterOnlyDonor(), n1UnprocessedDonor()]
        : [n1MainDonor('after', false, true)];
  else
    donors =
      pageNumber === 0
        ? [n1MainDonor('after')]
        : [n1UnprocessedDonor(), n1AfterOnlyDonor()];
  return {
    id: step.side,
    size: boundary ? 1 : 4,
    processed_count: boundary ? 1 : 2,
    is_completed: false,
    page: pageNumber,
    last_page: boundary ? (before ? 1 : 0) : before ? 2 : 1,
    donors,
    // These raw report fields are ignored by the current backlink normalizer.
    ...(boundary
      ? {}
      : {
          created_at: redistributed
            ? 'ignored later report date'
            : 'ignored first report date',
        }),
  };
}

function n1BacklinkScript(
  id: string,
  redistributed = false,
  boundary = false,
): N1Script {
  return {
    id,
    input: n1BacklinkSelected,
    steps: n1BacklinkSteps(boundary ? 1 : 2, boundary ? 0 : 1),
    reply(step, index) {
      return {
        code: 0,
        result:
          step.kind === 'status'
            ? n1Statuses('backlink/checker', boundary)
            : n1BacklinkReport(step, redistributed && index > 6, boundary),
      };
    },
  };
}

function n1BacklinkResult(): N1BacklinkResult {
  const summary = (id: 'before' | 'after'): N1BacklinkResult['before'] => ({
    status: {
      id,
      type: 'backlink/checker',
      size: 4,
      processedCount: 2,
      indexedCount: null,
      isCompleted: false,
      status: null,
      checkAfter: null,
      awaitingResult: null,
      dripFeed: null,
      days: null,
      daysPassed: null,
      isStopped: null,
      targetDomains: [' Example.test ', ' Example.test ', 'Case.Test'],
      providerCreatedAt:
        id === 'before' ? ' status-before Ω ' : ' status-after Ω ',
    },
    report: {
      size: 4,
      processedCount: 2,
      isCompleted: false,
      lastPage: id === 'before' ? 2 : 1,
      pagesVisited: id === 'before' ? 3 : 2,
    },
    coverage:
      id === 'before'
        ? {
            rawDonorCount: 4,
            observedUniqueDonorCount: 3,
            duplicateDonorCount: 1,
            conflictingDonorCount: 0,
            rawTargetLinkCount: 10,
            duplicateTargetLinkCount: 2,
            reportedSlotGap: 1,
          }
        : {
            rawDonorCount: 3,
            observedUniqueDonorCount: 3,
            duplicateDonorCount: 0,
            conflictingDonorCount: 0,
            rawTargetLinkCount: 4,
            duplicateTargetLinkCount: 0,
            reportedSlotGap: 1,
          },
  });
  return {
    status: 'compared',
    reportKind: 'backlink',
    family: 'backlink/checker',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: { ...expectedScope },
    targetScope: {
      provenance: 'matching_current_provider_status',
      targetDomains: [' Example.test ', ' Example.test ', 'Case.Test'],
      originalTargets: 'unknown',
    },
    before: summary('before'),
    after: summary('after'),
    rows: [
      {
        donorUrl: n1DonorUrl,
        before: { state: 'reported', targetLinks: [...n1OldLinks] },
        after: { state: 'reported', targetLinks: [...n1NewLinks] },
        comparison: {
          state: 'compared',
          newlyReportedTargetUrls: [e],
          noLongerReportedTargetUrls: [literalB],
          attributeChangedTargetUrls: [literalA],
          unchangedTargetUrls: [c],
        },
      },
      {
        donorUrl: n1UnprocessedUrl,
        before: { state: 'unknown', reason: 'not_processed' },
        after: { state: 'unknown', reason: 'not_processed' },
        comparison: { state: 'unknown' },
      },
      {
        donorUrl: n1InvalidUrl,
        before: { state: 'unknown', reason: 'invalid_target_link' },
        after: { state: 'unknown', reason: 'not_reported' },
        comparison: { state: 'unknown' },
      },
      {
        donorUrl: n1AfterOnlyUrl,
        before: { state: 'unknown', reason: 'not_reported' },
        after: { state: 'reported', targetLinks: [] },
        comparison: { state: 'unknown' },
      },
    ],
    counts: {
      comparedDonors: 1,
      unknownDonors: 3,
      totalDonors: 4,
      newlyReportedTargetUrls: 1,
      noLongerReportedTargetUrls: 1,
      attributeChangedTargetUrls: 1,
      unchangedTargetUrls: 1,
    },
  };
}

function n1BoundaryResult(): N1BacklinkResult {
  const frame = compareLiteralFrameOracle().frames.backlinkEnvelopeCopy;
  const roots: unknown = frame?.[5];
  if (!Array.isArray(roots))
    throw new Error('Missing accepted independent backlink frame.');
  const envelope = compareReportsEnvelopeSchema.parse(roots[2]);
  const result = envelope.structuredContent;
  if (result.status !== 'compared' || result.reportKind !== 'backlink')
    throw new Error('Invalid independent backlink frame.');
  return result;
}

test('CR-N1-PREP finite native wire scripts and original route guard preparation', async () => {
  const scripts = [
    n1GenericScript('prep-generic'),
    n1BacklinkScript('prep-traversal'),
    n1BacklinkScript('prep-reordered', true),
    n1BacklinkScript('prep-boundary', false, true),
  ];
  const shapes: {
    id: string;
    steps: readonly CompareWireStep[];
    responseBytes: number[];
    responses: unknown[];
  }[] = [];
  for (const script of scripts) {
    const responses = script.steps.map((step, index) =>
      script.reply(step, index),
    );
    for (const [index, step] of script.steps.entries()) {
      const raw = responses[index];
      if (step.kind === 'status') {
        const value = normalizeTaskStatusResult(
          script.input.family,
          ['before', 'after'],
          raw,
        );
        expect(value.tasks.map((task) => task.id)).toEqual(['before', 'after']);
      } else {
        const value = normalizeTaskReport(
          script.input.family === 'backlink/checker'
            ? {
                family: 'backlink/checker',
                taskId: step.side,
                page: step.page ?? 0,
                limit: 100,
              }
            : { family: script.input.family, taskId: step.side },
          raw,
        );
        expect(value.taskId).toBe(step.side);
      }
    }
    shapes.push({
      id: script.id,
      steps: script.steps,
      responseBytes: responses.map(bytes),
      responses,
    });
  }
  expect(shapes.map((shape) => shape.steps.length)).toEqual([7, 13, 13, 9]);
  const oracle = compareLiteralFrameOracle();
  expect(Object.keys(oracle.frames)).toHaveLength(64);
  expect(oracle.fixturePeaks).toEqual({ generic: 22271, backlink: 25199 });
  expect(bytes(independentEnvelope(n1BoundaryResult()))).toBe(5744);
  expect(
    compareReportsEnvelopeSchema.safeParse(
      independentEnvelope(n1BacklinkResult()),
    ).success,
  ).toBe(true);
  const guard = installCompareDefaultDeny();
  let arrivals = 0;
  const receiver = createServer((_request, response) => {
    arrivals++;
    response.end('{}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', resolve);
    });
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing preparation receiver.');
    const transport = createCompareFixtureFetch(
      `http://127.0.0.1:${address.port}`,
      input,
      genericSteps,
      guard.nativeFetch,
    );
    const init = {
      method: 'POST',
      redirect: 'error',
      signal: new AbortController().signal,
      headers: {
        Authorization: compareFixtureKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'speedyindex-mcp/0.1.0',
      },
      body: JSON.stringify({ task_ids: ['before', 'after'] }),
    } satisfies RequestInit;
    for (const target of [
      'https://api.speedyindex.com/account',
      'https://api.speedyindex.com/v2/task/google/indexer/status?unexpected=1',
      'https://api.speedyindex.com/v2/task/google/indexer/status#fragment',
      'http://api.speedyindex.com/v2/task/google/indexer/status',
      'https://user@api.speedyindex.com/v2/task/google/indexer/status',
    ])
      await expect(transport.fetch(target, init)).rejects.toThrow(
        'Invalid compare fixture protocol.',
      );
    expect(() =>
      transport.fetch.preconnect('https://api.speedyindex.com'),
    ).toThrow('Compare fixture preconnect denied.');
    expect(transport.entered()).toBe(0);
    expect(arrivals).toBe(0);
    expect(guard.calls()).toBe(0);
  } finally {
    receiver.closeIdleConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
    guard.restore();
  }
  console.info(
    'CR_N1_PREP ' +
      JSON.stringify({
        shapes,
        guardNonarrival: arrivals,
        oracleFrames: 64,
        boundaryN: 25199,
        boundaryEnvelopeBytes: 5744,
      }),
  );
});

test('CR-N1-I01 remaining four generic families capture actual methods signal budget and seven native reads', async () => {
  const families: readonly N1GenericFamily[] = [
    'google/checker',
    'yandex/indexer',
    'yandex/checker',
    'bing/checker',
  ];
  for (const selected of families)
    await n1Run(n1GenericScript('CR-I01-' + selected, selected), {
      result: n1GenericResult(selected),
      reads: 7,
      progress: n1Complete,
    });
}, 30_000);

test('CR-N1-I02 thirteen-read backlink traversal child typed unknowns duplicate rows and semantic redistribution', async () => {
  const result: N1BacklinkResult = n1BacklinkResult();
  await n1Run(n1BacklinkScript('CR-I02-child'), {
    result,
    reads: 13,
    progress: n1BacklinkComplete,
    child: true,
  });
  await n1Run(n1BacklinkScript('CR-I02-native'), {
    result,
    reads: 13,
    progress: n1BacklinkComplete,
  });
  await n1Run(n1BacklinkScript('CR-I02-redistributed', true), {
    result,
    reads: 13,
    progress: n1BacklinkComplete,
  });
}, 30_000);

interface N1StatusMutation {
  id: string;
  family: TaskFamily;
  result: CompareReportsResult;
  edit(rows: [N1Record, N1Record]): N1Record[];
}

const n1InitialCases: readonly N1StatusMutation[] = [
  {
    id: 'omit-before',
    family,
    result: n1Blocked('StatusUnavailable'),
    edit: (rows) => [rows[1]],
  },
  {
    id: 'omit-after',
    family,
    result: n1Blocked('StatusUnavailable'),
    edit: (rows) => [rows[0]],
  },
  {
    id: 'duplicate-root',
    family,
    result: n1ReadFailed('status'),
    edit: (rows) => [rows[0], rows[0]],
  },
  {
    id: 'unrelated-root',
    family,
    result: n1ReadFailed('status'),
    edit: (rows) => [rows[0], { ...rows[1], id: 'unrelated' }],
  },
  {
    id: 'wrong-generic-type',
    family,
    result: n1Blocked('IncompatibleTaskType'),
    edit(rows) {
      rows[0].type = 'google/checker';
      return rows;
    },
  },
  {
    id: 'wrong-backlink-type',
    family: 'backlink/checker',
    result: n1Blocked('IncompatibleTaskType'),
    edit(rows) {
      rows[1].type = 'google/indexer';
      return rows;
    },
  },
  {
    id: 'malformed-type',
    family,
    result: n1ReadFailed('status'),
    edit(rows) {
      rows[0].type = 12;
      return rows;
    },
  },
  {
    id: 'malformed-status-date',
    family,
    result: n1ReadFailed('status'),
    edit(rows) {
      rows[0].created_at = null;
      return rows;
    },
  },
  {
    id: 'unsafe-status-date',
    family,
    result: n1Blocked('ConflictingEvidence'),
    edit(rows) {
      rows[0].created_at = 'unsafe\nsentinel';
      return rows;
    },
  },
  {
    id: 'scope-missing-before',
    family: 'backlink/checker',
    result: n1Blocked('TargetScopeUnavailable'),
    edit(rows) {
      delete rows[0].target_domains;
      return rows;
    },
  },
  {
    id: 'scope-missing-after',
    family: 'backlink/checker',
    result: n1Blocked('TargetScopeUnavailable'),
    edit(rows) {
      delete rows[1].target_domains;
      return rows;
    },
  },
  {
    id: 'scope-empty',
    family: 'backlink/checker',
    result: n1Blocked('TargetScopeUnavailable'),
    edit(rows) {
      rows[1].target_domains = [];
      return rows;
    },
  },
  {
    id: 'scope-unsafe-text',
    family: 'backlink/checker',
    result: n1Blocked('TargetScopeUnavailable'),
    edit(rows) {
      rows[0].target_domains = ['unsafe\nsentinel'];
      return rows;
    },
  },
  {
    id: 'scope-malformed-null',
    family: 'backlink/checker',
    result: n1ReadFailed('status'),
    edit(rows) {
      rows[0].target_domains = null;
      return rows;
    },
  },
  {
    id: 'scope-malformed-entry',
    family: 'backlink/checker',
    result: n1ReadFailed('status'),
    edit(rows) {
      rows[0].target_domains = [null];
      return rows;
    },
  },
  {
    id: 'scope-order',
    family: 'backlink/checker',
    result: n1Blocked('IncompatibleTargetScope'),
    edit(rows) {
      rows[1].target_domains = [
        'Case.Test',
        ' Example.test ',
        ' Example.test ',
      ];
      return rows;
    },
  },
  {
    id: 'scope-case',
    family: 'backlink/checker',
    result: n1Blocked('IncompatibleTargetScope'),
    edit(rows) {
      rows[1].target_domains = [
        ' Example.test ',
        ' Example.test ',
        'case.test',
      ];
      return rows;
    },
  },
  {
    id: 'scope-multiplicity',
    family: 'backlink/checker',
    result: n1Blocked('IncompatibleTargetScope'),
    edit(rows) {
      rows[1].target_domains = [' Example.test ', 'Case.Test'];
      return rows;
    },
  },
];

const n1FenceCases: readonly N1StatusMutation[] = [
  {
    id: 'size',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[0].size = 3;
      return rows;
    },
  },
  {
    id: 'processed-count',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[0].processed_count = 1;
      return rows;
    },
  },
  {
    id: 'counter-presence',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      delete rows[1].indexed_count;
      return rows;
    },
  },
  {
    id: 'counter-contradiction',
    family,
    result: n1Blocked('ConflictingEvidence'),
    edit(rows) {
      rows[0].indexed_count = 3;
      return rows;
    },
  },
  {
    id: 'type-change',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[0].type = 'yandex/indexer';
      return rows;
    },
  },
  {
    id: 'type-presence',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      delete rows[1].type;
      return rows;
    },
  },
  {
    id: 'date-exact-text',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[0].created_at = '2026-10-23T00:00:00+00:00';
      return rows;
    },
  },
  {
    id: 'date-presence',
    family,
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      delete rows[1].created_at;
      return rows;
    },
  },
  {
    id: 'date-malformed-null',
    family,
    result: n1ReadFailed('fence'),
    edit(rows) {
      rows[0].created_at = null;
      return rows;
    },
  },
  {
    id: 'date-unsafe-text',
    family,
    result: n1Blocked('ConflictingEvidence'),
    edit(rows) {
      rows[1].created_at = '\ud800';
      return rows;
    },
  },
  {
    id: 'later-missing',
    family,
    result: n1Blocked('StatusUnavailable'),
    edit: (rows) => [rows[0]],
  },
  {
    id: 'later-duplicate',
    family,
    result: n1ReadFailed('fence'),
    edit: (rows) => [rows[1], rows[1]],
  },
  {
    id: 'later-unrelated',
    family,
    result: n1ReadFailed('fence'),
    edit: (rows) => [{ ...rows[0], id: 'unrelated' }, rows[1]],
  },
  {
    id: 'target-order',
    family: 'backlink/checker',
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[0].target_domains = [
        'Case.Test',
        ' Example.test ',
        ' Example.test ',
      ];
      return rows;
    },
  },
  {
    id: 'target-multiplicity',
    family: 'backlink/checker',
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      rows[1].target_domains = [' Example.test ', 'Case.Test'];
      return rows;
    },
  },
  {
    id: 'target-presence',
    family: 'backlink/checker',
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      delete rows[0].target_domains;
      return rows;
    },
  },
  {
    id: 'target-unsafe-text',
    family: 'backlink/checker',
    result: n1Blocked('TargetScopeUnavailable'),
    edit(rows) {
      rows[0].target_domains = ['bad\nsentinel'];
      return rows;
    },
  },
  {
    id: 'target-malformed-null',
    family: 'backlink/checker',
    result: n1ReadFailed('fence'),
    edit(rows) {
      rows[0].target_domains = null;
      return rows;
    },
  },
  {
    id: 'backlink-source-date',
    family: 'backlink/checker',
    result: n1Blocked('EvidenceChanged'),
    edit(rows) {
      delete rows[0].created_at;
      return rows;
    },
  },
];

function n1StatusScript(
  id: string,
  variant: N1StatusMutation,
  at: number,
): N1Script {
  const base =
    variant.family === 'backlink/checker'
      ? n1BacklinkScript(id)
      : n1GenericScript(id, variant.family);
  return {
    ...base,
    reply(step, index) {
      return step.kind === 'status' && index === at
        ? { code: 0, result: variant.edit(n1Statuses(variant.family)) }
        : base.reply(step, index);
    },
  };
}

test('CR-N1-I03-initial omissions malformed roots type dates and exact ordered target scope refuse before reports', async () => {
  for (const variant of n1InitialCases)
    await n1Run(n1StatusScript('CR-I03-S0-' + variant.id, variant, 0), {
      result: variant.result,
      reads: 1,
      progress: n1Initial,
    });
}, 30_000);

test('CR-N1-I03-fences independent S1 S2 source presence counters type scope and correlation stop without another pass', async () => {
  for (const stage of [1, 2] as const)
    for (const variant of n1FenceCases) {
      const at =
        variant.family === 'backlink/checker'
          ? stage === 1
            ? 6
            : 12
          : stage === 1
            ? 3
            : 6;
      await n1Run(
        n1StatusScript(`CR-I03-S${stage}-${variant.id}`, variant, at),
        {
          result: variant.result,
          reads: at + 1,
          progress:
            variant.family === 'backlink/checker'
              ? stage === 1
                ? n1BacklinkStatus1
                : n1BacklinkAfterFence
              : stage === 1
                ? n1Status1
                : n1AfterFence,
        },
      );
    }
}, 30_000);

interface N1ReportMutation {
  id: string;
  at: number;
  alsoAt?: number;
  result: CompareReportsResult;
  progress: readonly CompareOwnerPhase[];
  edit(report: N1Record): N1Record;
}

const n1GenericReportCases: readonly N1ReportMutation[] = [
  {
    id: 'initial-wrong-type',
    at: 1,
    alsoAt: 4,
    result: n1Blocked('IncompatibleTaskType'),
    progress: n1Complete,
    edit: (report) => ({ ...report, type: 'yandex/checker' }),
  },
  {
    id: 'initial-wrong-id',
    at: 1,
    result: n1ReadFailed('report'),
    progress: n1ReportStart,
    edit: (report) => ({ ...report, id: 'unrelated' }),
  },
  {
    id: 'initial-missing-date',
    at: 1,
    result: n1ReadFailed('report'),
    progress: n1ReportStart,
    edit(report) {
      delete report.created_at;
      return report;
    },
  },
  {
    id: 'initial-malformed-date',
    at: 1,
    result: n1ReadFailed('report'),
    progress: n1ReportStart,
    edit: (report) => ({ ...report, created_at: null }),
  },
  {
    id: 'initial-unsafe-date',
    at: 1,
    result: n1Blocked('ConflictingEvidence'),
    progress: n1ReportStart,
    edit: (report) => ({ ...report, created_at: 'unsafe\nsentinel' }),
  },
  {
    id: 'report-date-channel',
    at: 4,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BeforeFence,
    edit: (report) => ({ ...report, created_at: '2026-10-23T01:00:00+01:00' }),
  },
  {
    id: 'later-missing-date',
    at: 4,
    result: n1ReadFailed('fence'),
    progress: [...n1Status1, 'after_status1'],
    edit(report) {
      delete report.created_at;
      return report;
    },
  },
  {
    id: 'link-membership',
    at: 4,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BeforeFence,
    edit: (report) => ({ ...report, unindexed_links: [c] }),
  },
  {
    id: 'raw-duplicate-count',
    at: 4,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BeforeFence,
    edit: (report) => ({
      ...report,
      indexed_links: [literalA, literalA, literalA],
    }),
  },
  {
    id: 'report-counter',
    at: 4,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BeforeFence,
    edit: (report) => ({ ...report, size: 3 }),
  },
  {
    id: 'report-type',
    at: 4,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BeforeFence,
    edit: (report) => ({ ...report, type: 'bing/checker' }),
  },
  {
    id: 'after-report-date-channel',
    at: 5,
    result: n1Blocked('EvidenceChanged'),
    progress: n1AfterFence,
    edit: (report) => ({
      ...report,
      created_at: 'different exact after source',
    }),
  },
];

function n1MutateReportScript(
  base: N1Script,
  variant: N1ReportMutation,
  editAllBeforeB = false,
): N1Script {
  return {
    ...base,
    reply(step, index) {
      const raw = base.reply(step, index);
      if (
        step.kind !== 'report' ||
        (index !== variant.at &&
          index !== variant.alsoAt &&
          !(editAllBeforeB && index >= 7 && index <= 9))
      )
        return raw;
      if (!n1Record(raw) || !n1Record(raw.result))
        throw new Error('Invalid finite N1 report fixture.');
      return { ...raw, result: variant.edit(raw.result) };
    },
  };
}

function n1PartialGenericResult(): N1LinksResult {
  const base = n1GenericResult('google/indexer');
  return {
    ...base,
    before: {
      ...base.before,
      status: { ...base.before.status, processedCount: 1, isCompleted: false },
      report: { ...base.before.report, processedCount: 1, isCompleted: false },
      settled: false,
    },
    after: {
      ...base.after,
      status: { ...base.after.status, processedCount: 1, isCompleted: false },
      report: { ...base.after.report, processedCount: 1, isCompleted: false },
      settled: false,
    },
    rows: [
      {
        url: literalA,
        before: {
          state: 'unknown',
          membership: 'indexed',
          reason: 'processing_unsettled',
        },
        after: {
          state: 'unknown',
          membership: 'unindexed',
          reason: 'processing_unsettled',
        },
        change: 'unknown',
      },
      {
        url: literalB,
        before: {
          state: 'unknown',
          membership: 'unindexed',
          reason: 'processing_unsettled',
        },
        after: {
          state: 'unknown',
          membership: 'indexed',
          reason: 'processing_unsettled',
        },
        change: 'unknown',
      },
    ],
    counts: {
      reportedUnindexedToIndexed: 0,
      reportedIndexedToUnindexed: 0,
      unchangedIndexed: 0,
      unchangedUnindexed: 0,
      unknown: 2,
      total: 2,
    },
  };
}

test('CR-N1-I04-generic report correlation content source timestamps raw multiplicity and stable partial evidence', async () => {
  for (const variant of n1GenericReportCases) {
    const script = n1MutateReportScript(
      n1GenericScript('CR-I04-generic-' + variant.id),
      variant,
    );
    await n1Run(script, {
      result: variant.result,
      reads: variant.id === 'initial-wrong-type' ? 7 : variant.at + 1,
      progress: variant.progress,
    });
  }
  const partial = n1GenericScript('CR-I04-generic-partial');
  const partialScript: N1Script = {
    ...partial,
    reply(step, index) {
      const raw = partial.reply(step, index);
      if (!n1Record(raw)) throw new Error('Invalid partial fixture.');
      if (step.kind === 'status')
        return {
          ...raw,
          result: n1Statuses('google/indexer').map((row) => ({
            ...row,
            processed_count: 1,
            is_completed: false,
          })),
        };
      return {
        ...raw,
        result: {
          ...n1GenericReport('google/indexer', step.side),
          processed_count: 1,
          is_completed: false,
        },
      };
    },
  };
  await n1Run(partialScript, {
    result: n1PartialGenericResult(),
    reads: 7,
    progress: n1Complete,
  });
  const ignored = n1GenericScript('CR-I04-generic-ignored-fields');
  await n1Run(
    {
      ...ignored,
      reply(step, index) {
        return {
          code: 0,
          result:
            step.kind === 'status'
              ? n1Statuses('google/indexer')
                  .reverse()
                  .map((row) => ({
                    ...row,
                    title: 'ignored ' + index,
                    provider_extra: index,
                  }))
              : {
                  ...n1GenericReport('google/indexer', step.side),
                  title: 'ignored ' + index,
                  provider_extra: index,
                },
        };
      },
    },
    {
      result: n1GenericResult('google/indexer'),
      reads: 7,
      progress: n1Complete,
    },
  );
  const reordered = n1GenericScript('CR-I04-generic-semantic-order');
  await n1Run(
    {
      ...reordered,
      reply(step, index) {
        const common = { size: 3, processed_count: 3, indexed_count: 2 };
        return {
          code: 0,
          result:
            step.kind === 'status'
              ? n1Statuses('google/indexer').map((row) => ({
                  ...row,
                  ...common,
                }))
              : {
                  ...n1GenericReport('google/indexer', step.side),
                  ...common,
                  indexed_links:
                    index < 4
                      ? step.side === 'before'
                        ? [literalA, c, literalA]
                        : [literalB, c, literalB]
                      : step.side === 'before'
                        ? [c, literalA, literalA]
                        : [c, literalB, literalB],
                },
        };
      },
    },
    { result: n1ReorderedGenericResult(), reads: 7, progress: n1Complete },
  );
}, 30_000);

function n1ReorderedGenericResult(): N1LinksResult {
  const base = n1GenericResult('google/indexer');
  const summary = (side: N1LinksResult['before']): N1LinksResult['before'] => ({
    ...side,
    status: { ...side.status, size: 3, processedCount: 3, indexedCount: 2 },
    report: { ...side.report, size: 3, processedCount: 3, indexedCount: 2 },
    coverage: {
      observedIndexedCount: 2,
      observedUnindexedCount: 1,
      observedUniqueUrlCount: 3,
      indexedDuplicateCount: 1,
      unindexedDuplicateCount: 0,
      conflictingUrlCount: 0,
      reportedSlotGap: 0,
      indexedEnumerationGap: 0,
    },
  });
  return {
    ...base,
    before: summary(base.before),
    after: summary(base.after),
    rows: [
      {
        url: literalA,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'reported_indexed_to_unindexed',
      },
      {
        url: c,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'indexed', membership: 'indexed' },
        change: 'unchanged_indexed',
      },
      {
        url: literalB,
        before: { state: 'unindexed', membership: 'unindexed' },
        after: { state: 'indexed', membership: 'indexed' },
        change: 'reported_unindexed_to_indexed',
      },
    ],
    counts: {
      reportedUnindexedToIndexed: 1,
      reportedIndexedToUnindexed: 1,
      unchangedIndexed: 1,
      unchangedUnindexed: 0,
      unknown: 0,
      total: 3,
    },
  };
}

function n1EditDonors(
  report: N1Record,
  edit: (donors: N1Record[]) => N1Record[],
): N1Record {
  if (!Array.isArray(report.donors))
    throw new Error('Missing finite donor fixture.');
  const donors: N1Record[] = [];
  for (const value of report.donors) {
    if (!n1Record(value)) throw new Error('Invalid finite donor fixture.');
    donors.push(value);
  }
  return { ...report, donors: edit(donors) };
}

interface N1BacklinkMutation extends N1ReportMutation {
  reads: number;
  allBeforeB?: boolean;
}

const n1BacklinkReportCases: readonly N1BacklinkMutation[] = [
  ...(['anchor', 'nofollow', 'url'] as const).map(
    (field): N1BacklinkMutation => ({
      id: 'typed-' + field,
      at: 7,
      reads: 10,
      result: n1Blocked('EvidenceChanged'),
      progress: n1BacklinkBeforeFence,
      edit: (report) =>
        n1EditDonors(report, (donors) =>
          donors.map((row) => {
            if (row.donor_url !== n1DonorUrl) return row;
            const link: N1Target = {
              ...n1OldLinks[0],
              ...(field === 'anchor'
                ? { anchor: 'changed exact anchor' }
                : field === 'nofollow'
                  ? { nofollow: true }
                  : { url: f }),
            };
            return {
              ...row,
              target_links: [link, n1OldLinks[1], n1OldLinks[2], link],
            };
          }),
        ),
    }),
  ),
  {
    id: 'processed-witness',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) =>
          row.donor_url === n1UnprocessedUrl
            ? { ...row, processed: true }
            : row,
        ),
      ),
  },
  {
    id: 'unknown-raw-count',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) =>
          row.donor_url === n1UnprocessedUrl
            ? { ...row, target_links: [{ ignored: 1 }, { ignored: 2 }] }
            : row,
        ),
      ),
  },
  {
    id: 'unknown-raw-presence',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) => {
          if (row.donor_url === n1UnprocessedUrl) delete row.target_links;
          return row;
        }),
      ),
  },
  {
    id: 'duplicate-donor-multiplicity',
    at: 9,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.filter((row) => row.donor_url !== n1DonorUrl),
      ),
  },
  {
    id: 'duplicate-target-multiplicity',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) =>
          row.donor_url === n1DonorUrl
            ? {
                ...row,
                target_links: [...n1OldLinks, n1OldLinks[0], n1OldLinks[0]],
              }
            : row,
        ),
      ),
  },
  {
    id: 'donor-identity',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) =>
          row.donor_url === n1UnprocessedUrl
            ? { ...row, donor_url: 'https://example.test/different-donor' }
            : row,
        ),
      ),
  },
  {
    id: 'whole-task-size',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    allBeforeB: true,
    edit: (report) => ({ ...report, size: 5 }),
  },
  {
    id: 'whole-task-processed',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    allBeforeB: true,
    edit: (report) => ({ ...report, processed_count: 3 }),
  },
  {
    id: 'whole-task-completion-presence',
    at: 7,
    reads: 10,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeFence,
    allBeforeB: true,
    edit(report) {
      delete report.is_completed;
      return report;
    },
  },
  {
    id: 'whole-task-page-count',
    at: 7,
    reads: 8,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkBeforeB,
    edit: (report) => ({ ...report, last_page: 3 }),
  },
  {
    id: 'after-typed-link',
    at: 10,
    reads: 12,
    result: n1Blocked('EvidenceChanged'),
    progress: n1BacklinkAfterFence,
    edit: (report) =>
      n1EditDonors(report, (donors) =>
        donors.map((row) =>
          row.donor_url === n1DonorUrl
            ? {
                ...row,
                target_links: [
                  { ...n1NewLinks[0], anchor: 'changed after' },
                  n1NewLinks[1],
                  n1NewLinks[2],
                ],
              }
            : row,
        ),
      ),
  },
  {
    id: 'in-pass-size',
    at: 2,
    reads: 3,
    result: n1Blocked('ConflictingEvidence'),
    progress: n1BacklinkFirstA,
    edit: (report) => ({ ...report, size: 5 }),
  },
  {
    id: 'in-pass-processed',
    at: 2,
    reads: 3,
    result: n1Blocked('ConflictingEvidence'),
    progress: n1BacklinkFirstA,
    edit: (report) => ({ ...report, processed_count: 3 }),
  },
  {
    id: 'in-pass-last-page',
    at: 2,
    reads: 3,
    result: n1Blocked('ConflictingEvidence'),
    progress: n1BacklinkFirstA,
    edit: (report) => ({ ...report, last_page: 3 }),
  },
  {
    id: 'in-pass-completion-presence',
    at: 2,
    reads: 3,
    result: n1Blocked('ConflictingEvidence'),
    progress: n1BacklinkFirstA,
    edit(report) {
      delete report.is_completed;
      return report;
    },
  },
  {
    id: 'in-pass-wrong-page',
    at: 2,
    reads: 3,
    result: n1ReadFailed('report'),
    progress: n1BacklinkFirstA,
    edit: (report) => ({ ...report, page: 2 }),
  },
  {
    id: 'in-pass-wrong-id',
    at: 2,
    reads: 3,
    result: n1ReadFailed('report'),
    progress: n1BacklinkFirstA,
    edit: (report) => ({ ...report, id: 'unrelated' }),
  },
  {
    id: 'fence-wrong-page',
    at: 8,
    reads: 9,
    result: n1ReadFailed('fence'),
    progress: n1BacklinkFirstB,
    edit: (report) => ({ ...report, page: 2 }),
  },
];

test('CR-N1-I04-backlink full typed multiset multiplicity sidecars and in-pass headers correlation refuse exactly', async () => {
  for (const variant of n1BacklinkReportCases) {
    const script = n1MutateReportScript(
      n1BacklinkScript('CR-I04-backlink-' + variant.id),
      variant,
      variant.allBeforeB,
    );
    await n1Run(script, {
      result: variant.result,
      reads: variant.reads,
      progress: variant.progress,
    });
  }
}, 30_000);

test('CR-N1-I05-backlink unchanged independent literal retained N25199 N-1 native boundary', async () => {
  const oracle = compareLiteralFrameOracle();
  expect(oracle.fixturePeaks.backlink).toBe(25199);
  expect(oracle.backlinkEnvelopeBytes).toBe(5744);
  expect(oracle.rawBacklinkDonorVisits).toEqual([2, 1, 2, 1]);
  expect(oracle.rawBacklinkTargetVisits).toEqual([6, 3, 6, 3]);
  for (const retainedBytes of [25199, 25198])
    await n1Run(
      n1BacklinkScript('CR-I05-backlink-' + retainedBytes, false, true),
      {
        result:
          retainedBytes === 25199 ? n1BoundaryResult() : n1ResourceFailure(),
        reads: 9,
        progress:
          retainedBytes === 25199
            ? n1BoundaryComplete
            : n1BoundaryComplete.filter(
                (phase) => phase !== 'after_serialization',
              ),
        retainedBytes,
      },
    );
}, 30_000);

type N2Construction = NonNullable<
  Parameters<typeof createCompareReportsOwner>[1]
>;

const ioModes = [
  'queued-abort-last-before-B-and-recover',
  'deadline-at-yield',
  'backwards-at-yield',
  'nonfinite-at-yield',
] as const;

type IOMode = (typeof ioModes)[number];

type IORecipe = Readonly<{ mode: IOMode }>;

interface N2Expected {
  result: CompareReportsResult;
  reads: number;
  clientCalls?: number;
  clientRejections?: number;
  done?: number;
  progress: readonly CompareOwnerPhase[];
  limits?: NonNullable<N2Construction['limits']>;
  budgetLimits?: NonNullable<N2Construction['budgetLimits']>;
  gzip?: boolean;
  ioRecipe?: IORecipe;
}

function ioParseRecipe(value: unknown): IORecipe {
  if (n1Record(value) && Object.keys(value).length === 1) {
    const mode = ioModes.find((mode) => mode === value.mode);
    if (mode !== undefined) return Object.freeze({ mode });
  }
  throw new RangeError('Invalid finite comparison I/O recipe.');
}

interface IOCallbackReceipt {
  kind: 'timer' | 'immediate';
  invocation: number;
  targeted: boolean;
  entered: number | null;
  exited: number | null;
  completion: Promise<void>;
}

function ioObservation(recipe: IORecipe) {
  return {
    recipe,
    invocation: 0,
    pending: false,
    now: 100,
    transitions: 0,
    sequence: 0,
    receipts: [] as IOCallbackReceipt[],
  };
}

type IOObservation = ReturnType<typeof ioObservation>;

function ioCaptureNative<T extends (...args: never[]) => unknown>(
  original: T,
  kind: IOCallbackReceipt['kind'],
  observation: IOObservation,
): T {
  return new Proxy(original, {
    apply(delegate, receiver, args) {
      const callback: unknown = args[0];
      if (typeof callback !== 'function')
        return Reflect.apply(delegate, receiver, args);
      let finish!: () => void;
      const receipt: IOCallbackReceipt = {
        kind,
        invocation: observation.invocation,
        targeted: false,
        entered: null,
        exited: null,
        completion: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      const decorated = new Proxy(callback, {
        apply(actual, callbackReceiver, callbackArgs) {
          receipt.entered = ++observation.sequence;
          if (kind === 'timer' && observation.pending) {
            observation.pending = false;
            receipt.targeted = true;
            if (observation.recipe.mode !== ioModes[0]) {
              observation.transitions++;
              observation.now =
                observation.recipe.mode === 'deadline-at-yield'
                  ? 60_100
                  : observation.recipe.mode === 'backwards-at-yield'
                    ? 99
                    : Number.NaN;
            }
          }
          try {
            return Reflect.apply(actual, callbackReceiver, callbackArgs);
          } finally {
            receipt.exited = ++observation.sequence;
            finish();
          }
        },
      });
      try {
        const handle: unknown = Reflect.apply(delegate, receiver, [
          decorated,
          ...args.slice(1),
        ]);
        observation.receipts.push(receipt);
        return handle;
      } catch (reason) {
        finish();
        throw reason;
      }
    },
  });
}

function ioObserveSignal(signal: AbortSignal, observation: IOObservation) {
  const originalAdd = signal.addEventListener,
    originalRemove = signal.removeEventListener;
  const addDescriptor = Object.getOwnPropertyDescriptor(
      signal,
      'addEventListener',
    ),
    removeDescriptor = Object.getOwnPropertyDescriptor(
      signal,
      'removeEventListener',
    );
  const active = new Set<unknown>();
  const counts = { added: 0, removed: 0 };
  const aborts: number[] = [];
  const onAbort = () => {
    aborts.push(++observation.sequence);
  };
  Reflect.apply(originalAdd, signal, ['abort', onAbort]);
  signal.addEventListener = new Proxy(originalAdd, {
    apply(delegate, receiver, args) {
      const result: unknown = Reflect.apply(delegate, receiver, args);
      if (receiver === signal && args[0] === 'abort') {
        active.add(args[1]);
        counts.added++;
      }
      return result;
    },
  });
  signal.removeEventListener = new Proxy(originalRemove, {
    apply(delegate, receiver, args) {
      const result: unknown = Reflect.apply(delegate, receiver, args);
      if (receiver === signal && args[0] === 'abort') {
        active.delete(args[1]);
        counts.removed++;
      }
      return result;
    },
  });
  return {
    active,
    counts,
    aborts,
    restore() {
      Reflect.apply(originalRemove, signal, ['abort', onAbort]);
      if (addDescriptor)
        Object.defineProperty(signal, 'addEventListener', addDescriptor);
      else Reflect.deleteProperty(signal, 'addEventListener');
      if (removeDescriptor)
        Object.defineProperty(signal, 'removeEventListener', removeDescriptor);
      else Reflect.deleteProperty(signal, 'removeEventListener');
    },
  };
}

function n2SavedScript(script: N1Script, expected: N2Expected) {
  return {
    id: script.id,
    input: script.input,
    steps: script.steps,
    responses: script.steps.map((step, index) => script.reply(step, index)),
    expected,
  };
}

const ioCancelled = {
  status: 'error',
  error: {
    code: 'Cancelled',
    message: 'Report comparison was cancelled.',
  },
} as const satisfies CompareReportsResult;

const ioDeadline = {
  status: 'error',
  error: {
    code: 'DeadlineExceeded',
    message: 'Report comparison exceeded its observation deadline.',
  },
} as const satisfies CompareReportsResult;

function ioFixture(mode: IOMode): { script: N1Script; expected: N2Expected } {
  if (mode === 'queued-abort-last-before-B-and-recover') {
    const base = n1BacklinkScript('CR-IO-01');
    return {
      script: {
        ...base,
        steps: [...base.steps.slice(0, 10), ...base.steps],
        reply: (step, index) =>
          base.reply(step, index < 10 ? index : index - 10),
      },
      expected: {
        ioRecipe: { mode },
        result: ioCancelled,
        reads: 10,
        progress: n1BacklinkBeforeFence,
      },
    };
  }
  return {
    script: n1GenericScript('CR-IO-' + mode),
    expected: {
      ioRecipe: { mode },
      result: ioDeadline,
      reads: 5,
      progress: n1BeforeFence,
    },
  };
}

test('CR-IO-PREP finite saved recipes and transparent native capture preparation', async () => {
  const guard = installCompareDefaultDeny();
  try {
    const backlinkSteps = [
      { kind: 'status' },
      { kind: 'report', side: 'before', page: 0 },
      { kind: 'report', side: 'before', page: 1 },
      { kind: 'report', side: 'before', page: 2 },
      { kind: 'report', side: 'after', page: 0 },
      { kind: 'report', side: 'after', page: 1 },
      { kind: 'status' },
      { kind: 'report', side: 'before', page: 0 },
      { kind: 'report', side: 'before', page: 1 },
      { kind: 'report', side: 'before', page: 2 },
      { kind: 'report', side: 'after', page: 0 },
      { kind: 'report', side: 'after', page: 1 },
      { kind: 'status' },
    ] as const satisfies readonly CompareWireStep[];
    const googleSteps = [
      { kind: 'status' },
      { kind: 'report', side: 'before' },
      { kind: 'report', side: 'after' },
      { kind: 'status' },
      { kind: 'report', side: 'before' },
      { kind: 'report', side: 'after' },
      { kind: 'status' },
    ] as const satisfies readonly CompareWireStep[];
    for (const mode of ioModes) {
      const recipe = ioParseRecipe({ mode });
      expect(recipe.mode).toBe(mode);
      expect(Object.isFrozen(recipe)).toBe(true);
      const { script, expected } = ioFixture(mode);
      const saved: unknown = JSON.parse(
        JSON.stringify(n2SavedScript(script, expected)),
      );
      if (
        !n1Record(saved) ||
        !n1Record(saved.expected) ||
        !Array.isArray(saved.responses)
      )
        throw new Error('Invalid saved finite I/O fixture shape.');
      expect(Object.keys(saved).sort()).toEqual([
        'expected',
        'id',
        'input',
        'responses',
        'steps',
      ]);
      const recovery = mode === 'queued-abort-last-before-B-and-recover';
      const steps: readonly CompareWireStep[] = recovery
        ? [...backlinkSteps.slice(0, 10), ...backlinkSteps]
        : googleSteps;
      expect<unknown>(saved.steps).toEqual(steps);
      expect(saved.responses).toHaveLength(recovery ? 23 : 7);
      expect<unknown>(saved.input).toEqual({
        family: recovery ? 'backlink/checker' : 'google/indexer',
        beforeTaskId: 'before',
        afterTaskId: 'after',
      });
      expect<unknown>(saved.expected.ioRecipe).toEqual({ mode });
      expect<unknown>(saved.expected.reads).toBe(recovery ? 10 : 5);
      expect<unknown>(saved.expected.result).toEqual(
        recovery
          ? {
              status: 'error',
              error: {
                code: 'Cancelled',
                message: 'Report comparison was cancelled.',
              },
            }
          : {
              status: 'error',
              error: {
                code: 'DeadlineExceeded',
                message: 'Report comparison exceeded its observation deadline.',
              },
            },
      );
      expect<unknown>(saved.expected.progress).toEqual(
        recovery
          ? [
              'before_status0',
              'after_status0',
              'after_report_a',
              'after_report_a',
              'after_report_a',
              'after_report_a',
              'after_report_a',
              'after_status1',
              'after_report_b',
              'after_report_b',
              'after_report_b',
            ]
          : [
              'before_status0',
              'after_status0',
              'after_report_a',
              'after_report_a',
              'after_status1',
              'after_report_b',
            ],
      );
      const prefix = steps.slice(0, recovery ? 10 : 5);
      expect(prefix).toHaveLength(recovery ? 10 : 5);
      expect<unknown>(prefix.at(-1)).toEqual(
        recovery
          ? { kind: 'report', side: 'before', page: 2 }
          : { kind: 'report', side: 'before' },
      );
      if (recovery) {
        expect(steps.slice(10)).toHaveLength(13);
        expect<unknown>(steps.slice(10)).toEqual(backlinkSteps);
      }
      for (const [index, step] of steps.entries()) {
        const raw: unknown = saved.responses[index];
        if (!n1Record(raw)) throw new Error('Missing saved I/O response.');
        expect<unknown>(raw.code).toBe(0);
        if (step.kind === 'status') {
          if (!Array.isArray(raw.result))
            throw new Error('Invalid saved I/O status array.');
          expect(raw.result).toHaveLength(2);
          expect(
            raw.result.map((task: unknown) => {
              if (!n1Record(task)) throw new Error('Invalid saved I/O task.');
              return [task.id, task.type];
            }),
          ).toEqual([
            ['before', recovery ? 'backlink/checker' : 'google/indexer'],
            ['after', recovery ? 'backlink/checker' : 'google/indexer'],
          ]);
        } else {
          if (!n1Record(raw.result))
            throw new Error('Invalid saved I/O report.');
          expect<unknown>(raw.result.id).toBe(step.side);
          if (recovery) {
            if (!Array.isArray(raw.result.donors))
              throw new Error('Invalid saved I/O donor array.');
            expect<unknown>(raw.result.page).toBe(step.page);
            expect<unknown>(raw.result.last_page).toBe(
              step.side === 'before' ? 2 : 1,
            );
            expect(raw.result.donors).toHaveLength(
              step.side === 'before'
                ? step.page === 1
                  ? 0
                  : 2
                : step.page === 0
                  ? 1
                  : 2,
            );
          } else {
            expect<unknown>(raw.result.indexed_links).toEqual(
              step.side === 'before'
                ? [literalA, literalA]
                : [literalB, literalB],
            );
            expect<unknown>(raw.result.unindexed_links).toEqual(
              step.side === 'before' ? [literalB] : [literalA],
            );
          }
        }
      }
    }
    for (const invalid of [
      undefined,
      null,
      [],
      {},
      { mode: 'unknown' },
      { mode: 'deadline-at-yield', extra: true },
      { mode: 'deadline-at-yield', delay: 0 },
    ])
      expect(() => ioParseRecipe(invalid)).toThrow(
        'Invalid finite comparison I/O recipe.',
      );

    // Offline stand-ins verify forwarding only; they supply no owner coverage.
    for (const kind of ['timer', 'immediate'] as const) {
      const observation = ioObservation({ mode: 'deadline-at-yield' });
      const schedulerReceiver = {},
        callbackReceiver = {},
        argument = {},
        handle = {},
        callbackReturn = Promise.resolve({});
      const scheduled: { receiver: unknown; args: unknown[] }[] = [];
      function delegate(this: unknown, ...args: unknown[]) {
        scheduled.push({ receiver: this, args });
        return handle;
      }
      const capture = ioCaptureNative(delegate, kind, observation);
      let callbackCalls = 0;
      function callback(this: unknown, ...args: unknown[]) {
        callbackCalls++;
        expect<unknown>(this).toBe(callbackReceiver);
        expect(args).toEqual([argument, 17]);
        return callbackReturn;
      }
      const returned: unknown = Reflect.apply(capture, schedulerReceiver, [
        callback,
        0,
        argument,
      ]);
      expect(returned).toBe(handle);
      expect(scheduled).toHaveLength(1);
      const call = scheduled[0];
      if (!call || typeof call.args[0] !== 'function')
        throw new Error('Missing offline native capture delegate.');
      expect<unknown>(call.receiver).toBe(schedulerReceiver);
      expect(call.args.slice(1)).toEqual([0, argument]);
      expect(callbackCalls).toBe(0);
      const callbackResult: unknown = Reflect.apply(
        call.args[0],
        callbackReceiver,
        [argument, 17],
      );
      expect(callbackResult).toBe(callbackReturn);
      expect(callbackCalls).toBe(1);
      await Promise.all(
        observation.receipts.map((receipt) => receipt.completion),
      );
      expect(observation.receipts).toHaveLength(1);
      expect(observation.receipts[0]?.entered).toBe(1);
      expect(observation.receipts[0]?.exited).toBe(2);

      const callbackFailure = new Error('Offline callback sentinel.');
      const throwing = ioCaptureNative(delegate, kind, observation);
      Reflect.apply(throwing, schedulerReceiver, [
        () => {
          throw callbackFailure;
        },
      ]);
      const throwCall = scheduled[1];
      if (!throwCall || typeof throwCall.args[0] !== 'function')
        throw new Error('Missing offline throwing callback.');
      let callbackReason: unknown;
      try {
        Reflect.apply(throwCall.args[0], callbackReceiver, []);
      } catch (reason) {
        callbackReason = reason;
      }
      expect(callbackReason).toBe(callbackFailure);
      expect(scheduled).toHaveLength(2);
      await Promise.all(
        observation.receipts.map((receipt) => receipt.completion),
      );
      expect(observation.receipts[1]?.entered).toBe(3);
      expect(observation.receipts[1]?.exited).toBe(4);

      const schedulingFailure = new Error('Offline scheduling sentinel.');
      let failedCalls = 0;
      const failed = ioCaptureNative(
        function (this: unknown, ...args: unknown[]) {
          failedCalls++;
          expect<unknown>(this).toBe(schedulerReceiver);
          expect(args.slice(1)).toEqual([0, argument]);
          throw schedulingFailure;
        },
        kind,
        observation,
      );
      let schedulingReason: unknown;
      try {
        Reflect.apply(failed, schedulerReceiver, [callback, 0, argument]);
      } catch (reason) {
        schedulingReason = reason;
      }
      expect(schedulingReason).toBe(schedulingFailure);
      expect(failedCalls).toBe(1);
      expect(observation.receipts).toHaveLength(2);
    }
    const controller = new AbortController();
    const observation = ioObservation({ mode: 'deadline-at-yield' });
    const originalAdd = controller.signal.addEventListener,
      originalRemove = controller.signal.removeEventListener;
    const observer = ioObserveSignal(controller.signal, observation);
    try {
      let events = 0;
      const listener = () => {
        events++;
      };
      controller.signal.addEventListener('abort', listener);
      expect(observer.active.size).toBe(1);
      controller.abort();
      expect(events).toBe(1);
      expect(observer.aborts).toEqual([1]);
      controller.signal.removeEventListener('abort', listener);
      expect(observer.active.size).toBe(0);
      expect(observer.counts).toEqual({ added: 1, removed: 1 });
    } finally {
      observer.restore();
    }
    expect(controller.signal.addEventListener).toBe(originalAdd);
    expect(controller.signal.removeEventListener).toBe(originalRemove);
    expect(guard.calls()).toBe(0);
  } finally {
    guard.restore();
  }
});

test('CR-IO-01 queued native abort before the next read and independent same-owner recovery', async () => {
  const fixture = ioFixture('queued-abort-last-before-B-and-recover');
  await n2Run(fixture.script, fixture.expected);
}, 30_000);

test('CR-IO-02 original deadline refuses the read after an actual native yield', async () => {
  const fixture = ioFixture('deadline-at-yield');
  await n2Run(fixture.script, fixture.expected);
}, 30_000);

test('CR-IO-03 backwards original clock refuses the read after an actual native yield', async () => {
  const fixture = ioFixture('backwards-at-yield');
  await n2Run(fixture.script, fixture.expected);
}, 30_000);

test('CR-IO-04 nonfinite original clock refuses the read after an actual native yield', async () => {
  const fixture = ioFixture('nonfinite-at-yield');
  await n2Run(fixture.script, fixture.expected);
}, 30_000);

function n2Reason(reason: unknown) {
  return {
    name: reason instanceof Error ? reason.name : 'Non-Error rejection',
    message: reason instanceof Error ? reason.message : 'Non-Error rejection',
    code:
      n1Record(reason) && typeof reason.code === 'string' ? reason.code : null,
  };
}

function n2Outcome(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled'
    ? { status: 'fulfilled' }
    : { status: 'rejected', reason: n2Reason(result.reason) };
}

type NDJSON =
  null | boolean | number | string | NDJSON[] | { [key: string]: NDJSON };

type NDObject = { [key: string]: NDJSON };

type NDEvent = {
  sequence: number;
  atMs: number | 'UNKNOWN';
  originalElapsedMs: number | 'UNKNOWN';
  kind: string;
  attempt: number | 'UNKNOWN';
  data: NDObject;
};

function ndText(value: string): {
  value: string;
  truncated: boolean;
  redacted: boolean;
} {
  const clean = value.split(compareFixtureKey).join('[REDACTED]');
  const buffer = Buffer.from(clean, 'utf8');
  let end = Math.min(buffer.length, 4096);
  if (end < buffer.length) {
    while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  }
  return {
    value: buffer.subarray(0, end).toString('utf8'),
    truncated: end < buffer.length,
    redacted: clean !== value,
  };
}

function ndOwn(value: unknown, key: string): unknown {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  )
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ndPublic(value: unknown): NDJSON {
  if (typeof value === 'string') return ndText(value).value;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item: unknown) => typeof item === 'string')
  ) {
    return value.map((item: string) => ndText(item).value);
  }
  return 'UNKNOWN';
}

function ndPublicInput(value: unknown): NDObject {
  const output: NDObject = {};
  for (const key of ['family', 'taskId', 'taskIds', 'page', 'limit']) {
    const item = ndOwn(value, key);
    if (item !== undefined) output[key] = ndPublic(item);
  }
  return output;
}

function ndErrors() {
  const identities = new WeakMap<object, number>();
  const originals = new Map<number, unknown>();
  let next = 0,
    overflow = 0;
  const fields = [
    'name',
    'message',
    'code',
    'errno',
    'syscall',
    'stack',
    'kind',
    'cause',
  ];
  const snapshot = (
    value: unknown,
    depth = 0,
    seen = new Set<object>(),
  ): NDObject => {
    const object =
      (typeof value === 'object' && value !== null) ||
      typeof value === 'function';
    if (!object)
      return {
        identity: 'UNKNOWN',
        type: typeof value,
        primitive: ndPublic(value),
        unknown:
          value === undefined ||
          typeof value === 'symbol' ||
          typeof value === 'bigint' ||
          (typeof value === 'number' && !Number.isFinite(value)),
        truncated: false,
        cycle: false,
      };
    let identity = identities.get(value);
    if (identity === undefined) {
      identity = ++next;
      identities.set(value, identity);
      if (originals.size < 512) originals.set(identity, value);
      else overflow++;
    }
    if (seen.has(value))
      return {
        identity,
        type: typeof value,
        unknown: true,
        truncated: false,
        cycle: true,
      };
    if (depth > 2)
      return {
        identity,
        type: typeof value,
        unknown: true,
        truncated: true,
        cycle: false,
      };
    seen.add(value);
    const data: NDObject = {};
    let unknown = false,
      truncated = false,
      cause: unknown;
    const ownDataKeys: string[] = [];
    try {
      for (const key of fields) {
        let descriptor = Object.getOwnPropertyDescriptor(value, key),
          inherited = false;
        if (!descriptor && key === 'name') {
          let prototype: unknown = Object.getPrototypeOf(value);
          for (
            let level = 0;
            level < 3 && prototype !== null && typeof prototype === 'object';
            level++
          ) {
            descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            if (descriptor) {
              inherited = true;
              break;
            }
            prototype = Object.getPrototypeOf(prototype);
          }
        }
        if (!descriptor || !('value' in descriptor)) {
          data[key] = {
            value: 'UNKNOWN',
            unknown: true,
            truncated: false,
            source: descriptor ? 'accessor' : 'missing',
          };
          unknown = true;
          continue;
        }
        const item: unknown = descriptor.value;
        if (!inherited) ownDataKeys.push(key);
        if (key === 'cause') cause = item;
        if (typeof item === 'string') {
          const text = ndText(item);
          truncated ||= text.truncated;
          data[key] = {
            ...text,
            unknown: false,
            source: inherited ? 'inherited_data' : 'own_data',
          };
        } else {
          const scalar =
            item === null ||
            typeof item === 'boolean' ||
            (typeof item === 'number' && Number.isFinite(item))
              ? item
              : 'UNKNOWN';
          const unsupported = scalar === 'UNKNOWN';
          data[key] = {
            value: scalar,
            unknown: unsupported,
            truncated: false,
            source: 'own_data',
          };
          unknown ||= unsupported;
        }
      }
    } catch {
      unknown = true;
      data.descriptorFailure = true;
    }
    return {
      identity,
      type: typeof value,
      fields: data,
      ownDataKeys,
      otherOwnKeys: 'UNKNOWN',
      unknown,
      truncated,
      cycle: false,
      cause: cause === undefined ? 'UNKNOWN' : snapshot(cause, depth + 1, seen),
    };
  };
  return {
    snapshot,
    retainedIdentityTags: () => [...originals.keys()],
    overflow: () => overflow,
  };
}

function ndPeerWitness(arrivals: number, callbacks: number): NDObject {
  return {
    source: 'pre_explicit_teardown_callback_snapshot',
    arrivals,
    callbacks,
    allCallbacksObserved: callbacks === arrivals,
    pending: Math.max(0, arrivals - callbacks),
    establishesOriginalSuccess: false,
  };
}

function ndFreezeJSON(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) ndFreezeJSON(child);
    Object.freeze(value);
  }
}

function ndPreparationSchema(value: unknown): boolean {
  if (
    !n1Record(value) ||
    value.preparation_only !== true ||
    value.synthetic !== true ||
    value.nativeProof !== 'NOT_EXECUTED' ||
    !Array.isArray(value.events)
  )
    return false;
  const error = (item: unknown, depth = 0): boolean => {
    if (
      !n1Record(item) ||
      depth > 3 ||
      typeof item.type !== 'string' ||
      typeof item.unknown !== 'boolean' ||
      typeof item.truncated !== 'boolean' ||
      typeof item.cycle !== 'boolean'
    )
      return false;
    if (
      item.identity !== 'UNKNOWN' &&
      !(
        typeof item.identity === 'number' &&
        Number.isSafeInteger(item.identity) &&
        item.identity > 0
      )
    )
      return false;
    if (item.fields !== undefined) {
      if (!n1Record(item.fields) || Object.keys(item.fields).length > 8)
        return false;
      for (const [key, field] of Object.entries(item.fields)) {
        if (key === 'descriptorFailure' && field === true) continue;
        if (
          !n1Record(field) ||
          typeof field.unknown !== 'boolean' ||
          typeof field.truncated !== 'boolean' ||
          typeof field.source !== 'string'
        )
          return false;
        if (
          typeof field.value === 'string' &&
          Buffer.byteLength(field.value, 'utf8') > 4096
        )
          return false;
      }
    }
    return (
      item.cause === undefined ||
      item.cause === 'UNKNOWN' ||
      error(item.cause, depth + 1)
    );
  };
  return (
    value.events.length <= 64 &&
    value.events.every(
      (event: unknown, index: number) =>
        n1Record(event) &&
        event.sequence === index + 1 &&
        typeof event.kind === 'string' &&
        typeof event.signalAborted === 'boolean',
    ) &&
    error(value.error)
  );
}

type NDReceiptFailure = {
  phase: 'before-teardown' | 'cleanup' | 'final' | 'verify' | 'failure-report';
  reason: unknown;
};

async function ndFinalizeReceipts(options: {
  primary: { reason: unknown } | undefined;
  failures: NDReceiptFailure[];
  beforeTeardown: () => unknown | Promise<unknown>;
  cleanup: () => Promise<void>;
  finalReceipt: () => unknown;
  write: (phase: 'before-teardown' | 'final', text: string) => Promise<void>;
  publish: (text: string) => void;
  verify: () => void;
  report: (failures: readonly NDReceiptFailure[]) => void;
}): Promise<void> {
  const attempt = async (
    phase: NDReceiptFailure['phase'],
    action: () => void | Promise<void>,
  ) => {
    try {
      await action();
    } catch (reason) {
      options.failures.push({ phase, reason });
    }
  };
  await attempt('before-teardown', async () => {
    const text = JSON.stringify(await options.beforeTeardown());
    await options.write('before-teardown', text);
  });
  await attempt('cleanup', options.cleanup);
  await attempt('final', async () => {
    const text = JSON.stringify(options.finalReceipt());
    await options.write('final', text);
    options.publish(text);
  });
  await attempt('verify', options.verify);
  if (options.failures.length > 0)
    await attempt('failure-report', () => options.report(options.failures));
  if (options.primary !== undefined) throw options.primary.reason;
  if (options.failures.length > 0)
    throw new AggregateError(
      options.failures.map((failure) => failure.reason),
      'N2 diagnostic finalization failed.',
    );
}

async function n2Run(script: N1Script, expected: N2Expected): Promise<void> {
  const io =
    expected.ioRecipe === undefined
      ? undefined
      : ioObservation(ioParseRecipe(expected.ioRecipe));
  const recover = io?.recipe.mode === 'queued-abort-last-before-B-and-recover';
  const guard = installCompareDefaultDeny();
  const nativeNow = performance.now.bind(performance);
  const nativeArm = globalThis.setTimeout.bind(globalThis);
  const nativeDisarm = globalThis.clearTimeout.bind(globalThis);
  const signalObservers: ReturnType<typeof ioObserveSignal>[] = [];
  const ioResults: unknown[] = [];
  let controller = new AbortController(),
    reportBPhases = 0;
  let abortReceipt: Promise<void> | undefined;
  let abortEntered: number | null = null,
    abortExited: number | null = null;
  const ioCloseReceipts: {
    invocation: number;
    phase: 'before_close' | 'after_close';
    sequence: number;
  }[] = [];
  const timers = new Map<unknown, ReturnType<typeof setTimeout>>();
  const activeTimers = new Set<unknown>();
  let armed = 0,
    cleared = 0,
    fired = 0,
    forcedTimerCleanup = 0;
  let firstNow: number | null = null,
    lastNow: number | null = null,
    clockReads = 0;
  const ndError = ndErrors();
  const ndEvents: NDEvent[] = [],
    ndFaults: NDObject[] = [];
  const ndObservers: Promise<void>[] = [],
    ndNativePromises: Promise<Response>[] = [];
  const ndObjectIDs = new WeakMap<object, number>(),
    ndInitAttempts = new WeakMap<object, number>();
  const ndSignals = new Map<AbortSignal, number>();
  const ndRemovers: {
    scope: 'signal' | 'receiver';
    removed: boolean;
    remove: () => void;
  }[] = [];
  const ndSockets = new Map<
    Socket,
    {
      id: number;
      source: string;
      closed: boolean;
      hadError: boolean | 'UNKNOWN';
    }
  >();
  const ndTimerIDs = new Map<unknown, number>();
  let ndSequence = 0,
    ndIdentity = 0,
    ndClientCount = 0,
    ndTransportCount = 0,
    ndNativeCount = 0;
  let ndOverflow = 0,
    ndActiveClient: number | 'UNKNOWN' = 'UNKNOWN',
    ndTimerCount = 0;
  let ndPrimary: { reason: unknown } | undefined;
  const ndReceiptFailures: NDReceiptFailure[] = [];
  let ndCursor: () => number | 'UNKNOWN' = () => 'UNKNOWN';
  let ndGuardExpected: number | 'UNKNOWN' = 'UNKNOWN';
  let ndBeforeTeardown: NDObject | undefined;
  const ndID = (value: unknown): number | 'UNKNOWN' => {
    if (
      (typeof value !== 'object' || value === null) &&
      typeof value !== 'function'
    )
      return 'UNKNOWN';
    let id = ndObjectIDs.get(value);
    if (id === undefined) {
      id = ++ndIdentity;
      ndObjectIDs.set(value, id);
    }
    return id;
  };
  const ndFault = (reason: unknown) => {
    if (ndFaults.length < 64) ndFaults.push(ndError.snapshot(reason));
    else ndOverflow++;
  };
  const ndSafe = (action: () => void) => {
    try {
      action();
    } catch (reason) {
      ndFault(reason);
    }
  };
  const ndEvent = (
    kind: string,
    data: NDObject = {},
    attempt: number | 'UNKNOWN' = 'UNKNOWN',
  ) => {
    if (
      ndEvents.length >= 4096 ||
      (typeof attempt === 'number' && attempt > 64)
    ) {
      ndOverflow++;
      return;
    }
    const atMs = nativeNow();
    ndEvents.push({
      sequence: ++ndSequence,
      atMs: Number.isFinite(atMs) ? atMs : 'UNKNOWN',
      originalElapsedMs:
        firstNow === null || (io && !recover) ? 'UNKNOWN' : atMs - firstNow,
      kind,
      attempt,
      data,
    });
  };
  const ndObserve = <T>(
    promise: Promise<T>,
    fulfilled: (value: T) => void,
    rejected: (reason: unknown) => void,
  ) => {
    ndSafe(() => {
      ndObservers.push(
        promise.then(
          (value) => ndSafe(() => fulfilled(value)),
          (reason: unknown) => ndSafe(() => rejected(reason)),
        ),
      );
    });
  };
  const ndOwnListener = (
    scope: 'signal' | 'receiver',
    add: () => void,
    remove: () => void,
  ) => {
    if (ndRemovers.length >= 512) {
      ndOverflow++;
      return;
    }
    add();
    ndRemovers.push({ scope, removed: false, remove });
  };
  const ndRemove = (scope?: 'signal' | 'receiver') => {
    for (const owned of ndRemovers)
      if (!owned.removed && (scope === undefined || owned.scope === scope)) {
        ndSafe(() => {
          owned.remove();
          owned.removed = true;
        });
      }
  };
  const ndSignal = (value: unknown): NDObject => {
    if (!(value instanceof AbortSignal))
      return { identity: 'UNKNOWN', aborted: 'UNKNOWN' };
    const identity = ndID(value);
    if (!ndSignals.has(value) && ndSignals.size < 65) {
      if (typeof identity === 'number') ndSignals.set(value, identity);
      const listener = () =>
        ndSafe(() =>
          ndEvent('signal-abort', { signal: identity, aborted: value.aborted }),
        );
      ndOwnListener(
        'signal',
        () => value.addEventListener('abort', listener),
        () => value.removeEventListener('abort', listener),
      );
    } else if (!ndSignals.has(value)) ndOverflow++;
    return { identity, aborted: value.aborted };
  };
  const ndRequest = (
    target: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): NDObject => {
    const headers = ndOwn(init, 'headers');
    const names = n1Record(headers) ? Object.getOwnPropertyNames(headers) : [];
    const header = (name: string) => {
      const key = names.find((key) => key.toLowerCase() === name);
      return key === undefined ? undefined : ndOwn(headers, key);
    };
    const body = ndOwn(init, 'body');
    return {
      target:
        typeof target === 'string'
          ? ndText(target).value
          : target instanceof URL
            ? target.href
            : 'UNKNOWN',
      initIdentity: ndID(init),
      method: ndPublic(ndOwn(init, 'method')),
      redirect: ndPublic(ndOwn(init, 'redirect')),
      body: ndPublic(body),
      bodyTruncated: typeof body === 'string' && ndText(body).truncated,
      headerOwnFieldCount: n1Record(headers) ? names.length : 'UNKNOWN',
      authorizationMatchesFixture:
        typeof header('authorization') === 'string'
          ? header('authorization') === compareFixtureKey
          : 'UNKNOWN',
      acceptMatches:
        typeof header('accept') === 'string'
          ? header('accept') === 'application/json'
          : 'UNKNOWN',
      contentTypeMatches:
        typeof header('content-type') === 'string'
          ? header('content-type') === 'application/json'
          : 'UNKNOWN',
      userAgentMatches:
        typeof header('user-agent') === 'string'
          ? header('user-agent') === 'speedyindex-mcp/0.1.0'
          : 'UNKNOWN',
      signal: ndSignal(ndOwn(init, 'signal')),
    };
  };
  const ndClientStart = (
    method: string,
    input: unknown,
    receiver: boolean,
    signal: unknown,
    budget: unknown,
  ): number => {
    const ordinal = ++ndClientCount;
    ndSafe(() => {
      ndActiveClient = ordinal;
      ndEvent(
        'client-enter',
        {
          method,
          input: ndPublicInput(input),
          receiver,
          callerSignal: ndSignal(signal),
          budgetIdentity: ndID(budget),
        },
        ordinal,
      );
    });
    return ordinal;
  };
  const ndClientOutcome = (
    promise: Promise<unknown>,
    ordinal: number,
    signal: unknown,
  ) =>
    ndObserve(
      promise,
      () => {
        ndEvent(
          'client-fulfilled',
          { callerSignal: ndSignal(signal) },
          ordinal,
        );
        if (ndActiveClient === ordinal) ndActiveClient = 'UNKNOWN';
      },
      (reason) => {
        ndEvent(
          'client-rejected',
          { error: ndError.snapshot(reason), callerSignal: ndSignal(signal) },
          ordinal,
        );
        if (ndActiveClient === ordinal) ndActiveClient = 'UNKNOWN';
      },
    );
  const ndScalar = (value: unknown): NDJSON =>
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean' ||
    typeof value === 'string'
      ? value
      : 'UNKNOWN';
  const ndReadScalar = (object: object, key: string): NDJSON => {
    try {
      return ndScalar(Reflect.get(object, key, object));
    } catch (reason) {
      ndFault(reason);
      return 'UNKNOWN';
    }
  };
  const runtime: ReadBudgetRuntime = {
    now() {
      const value = io && !recover ? io.now : nativeNow();
      firstNow ??= value;
      lastNow = value;
      clockReads++;
      return value;
    },
    setTimeout(callback, delay) {
      const timer = ++ndTimerCount;
      ndSafe(() =>
        ndEvent('timer-arm', {
          timer,
          delay,
          observationDueMs: nativeNow() + delay,
        }),
      );
      const handle: ReturnType<typeof setTimeout> = nativeArm(() => {
        ndSafe(() => ndEvent('timer-fire', { timer, delay }));
        activeTimers.delete(handle);
        fired++;
        callback();
      }, delay);
      timers.set(handle, handle);
      ndTimerIDs.set(handle, timer);
      activeTimers.add(handle);
      armed++;
      return handle;
    },
    clearTimeout(handle) {
      const original = timers.get(handle);
      if (original === undefined)
        throw new Error('Unknown owned N2 native timer.');
      nativeDisarm(original);
      activeTimers.delete(handle);
      cleared++;
      ndSafe(() =>
        ndEvent('timer-clear', { timer: ndTimerIDs.get(handle) ?? 'UNKNOWN' }),
      );
    },
  };
  const arrivals: {
    path: string;
    body: string;
    decodedBytes: number;
    wireBytes: number;
  }[] = [];
  const handlers: Promise<void>[] = [],
    peers: Promise<void>[] = [];
  const nativeReads: Promise<unknown>[] = [],
    nativeCancels: Promise<void>[] = [],
    nativeClosed: Promise<void>[] = [];
  const passiveObservers: Promise<void>[] = [],
    clientReceipts: Promise<unknown>[] = [];
  const releaseOutcomes: {
    status: 'fulfilled' | 'rejected';
    reason?: ReturnType<typeof n2Reason>;
  }[] = [];
  const errors: unknown[] = [];
  const calls: {
    receiver: boolean;
    signal: AbortSignal | undefined;
    budget: InvocationReadBudget | undefined;
  }[] = [];
  const phases: CompareOwnerPhase[] = [];
  const phaseClock: { phase: CompareOwnerPhase; atMs: number }[] = [];
  let readers = 0,
    closedFulfilled = 0,
    closedRejected = 0,
    readDone = 0,
    deliveredBytes = 0,
    peerCloses = 0;
  let root: string | undefined,
    succeeded = false,
    beforeTeardown = false;
  let actualEnvelope: unknown,
    originalSettlementBeforeTeardown = false;
  const observe = <T>(
    promise: Promise<T>,
    fulfilled: (value: T) => void,
    rejected: (reason: unknown) => void,
  ) => {
    // This observer is not stored or reported as an original native receipt.
    passiveObservers.push(promise.then(fulfilled, rejected));
  };
  const delegate = (response: Response): Response => {
    const body = response.body;
    if (!body) return response;
    const decoratedBody = new Proxy(body, {
      get(actualBody, property) {
        if (property === 'cancel')
          return (reason?: unknown) => {
            const promise = actualBody.cancel(reason);
            nativeCancels.push(promise);
            return promise;
          };
        if (property === 'getReader')
          return () => {
            const reader = actualBody.getReader();
            readers++;
            nativeClosed.push(reader.closed);
            observe(
              reader.closed,
              () => {
                closedFulfilled++;
              },
              () => {
                closedRejected++;
              },
            );
            return new Proxy(reader, {
              get(actualReader, field) {
                if (field === 'read')
                  return () => {
                    const promise = actualReader.read();
                    nativeReads.push(promise);
                    observe(
                      promise,
                      (receipt) => {
                        if (receipt.done) readDone++;
                        else deliveredBytes += receipt.value.byteLength;
                      },
                      () => {},
                    );
                    return promise;
                  };
                if (field === 'cancel')
                  return (reason?: unknown) => {
                    const promise = actualReader.cancel(reason);
                    nativeCancels.push(promise);
                    return promise;
                  };
                if (field === 'releaseLock')
                  return () => {
                    try {
                      actualReader.releaseLock();
                      releaseOutcomes.push({ status: 'fulfilled' });
                    } catch (reason) {
                      releaseOutcomes.push({
                        status: 'rejected',
                        reason: n2Reason(reason),
                      });
                      throw reason;
                    }
                  };
                const value: unknown = Reflect.get(
                  actualReader,
                  field,
                  actualReader,
                );
                return typeof value === 'function'
                  ? value.bind(actualReader)
                  : value;
              },
            });
          };
        const value: unknown = Reflect.get(actualBody, property, actualBody);
        return typeof value === 'function' ? value.bind(actualBody) : value;
      },
    });
    return new Proxy(response, {
      get(actualResponse, property) {
        if (property === 'body') return decoratedBody;
        const value: unknown = Reflect.get(
          actualResponse,
          property,
          actualResponse,
        );
        return typeof value === 'function' ? value.bind(actualResponse) : value;
      },
    });
  };
  const ndSocket = (socket: Socket, source: string): number | 'UNKNOWN' => {
    const known = ndSockets.get(socket);
    if (known) return known.id;
    if (ndSockets.size >= 64) {
      ndOverflow++;
      return 'UNKNOWN';
    }
    const state: {
      id: number;
      source: string;
      closed: boolean;
      hadError: boolean | 'UNKNOWN';
    } = { id: ndSockets.size + 1, source, closed: false, hadError: 'UNKNOWN' };
    ndSockets.set(socket, state);
    ndEvent('socket-object-observed', {
      connection: state.id,
      source,
      localPort: ndScalar(socket.localPort),
      remotePort: ndScalar(socket.remotePort),
      destroyed: ndScalar(socket.destroyed),
      connecting: ndScalar(socket.connecting),
    });
    const close = (hadError: boolean) =>
      ndSafe(() => {
        state.closed = true;
        state.hadError = typeof hadError === 'boolean' ? hadError : 'UNKNOWN';
        ndEvent('socket-close', {
          connection: state.id,
          hadError: state.hadError,
          destroyed: ndScalar(socket.destroyed),
        });
      });
    ndOwnListener(
      'receiver',
      () => socket.once('close', close),
      () => socket.removeListener('close', close),
    );
    return state.id;
  };
  const server = createServer((request, response) => {
    const index = arrivals.length,
      step = script.steps[index];
    ndSafe(() => {
      const connection = ndSocket(request.socket, 'request');
      ndEvent('receiver-request', {
        ordinal: index + 1,
        connection,
        method: request.method ?? 'UNKNOWN',
        path: request.url ?? 'UNKNOWN',
      });
      const finish = () =>
        ndSafe(() =>
          ndEvent('response-finish', {
            ordinal: index + 1,
            connection,
            statusCode: ndScalar(response.statusCode),
            writableEnded: ndScalar(response.writableEnded),
          }),
        );
      const close = () =>
        ndSafe(() =>
          ndEvent('request-close', {
            ordinal: index + 1,
            connection,
            complete: ndScalar(request.complete),
            destroyed: ndScalar(request.destroyed),
          }),
        );
      ndOwnListener(
        'receiver',
        () => response.once('finish', finish),
        () => response.removeListener('finish', finish),
      );
      ndOwnListener(
        'receiver',
        () => request.once('close', close),
        () => request.removeListener('close', close),
      );
    });
    arrivals.push({
      path: request.url ?? '',
      body: '',
      decodedBytes: 0,
      wireBytes: 0,
    });
    peers.push(
      new Promise<void>((resolve) =>
        response.once('close', () => {
          peerCloses++;
          ndSafe(() =>
            ndEvent('response-close', {
              ordinal: index + 1,
              peerCloses,
              statusCode: ndScalar(response.statusCode),
            }),
          );
          resolve();
        }),
      ),
    );
    handlers.push(
      (async () => {
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) body += chunk;
        if (!step) throw new Error('Unexpected N2 native request.');
        const exactBody =
          step.kind === 'status'
            ? {
                task_ids: [script.input.beforeTaskId, script.input.afterTaskId],
              }
            : script.input.family === 'backlink/checker'
              ? {
                  task_id:
                    step.side === 'before'
                      ? script.input.beforeTaskId
                      : script.input.afterTaskId,
                  page: step.page,
                  limit: 100,
                }
              : {
                  task_id:
                    step.side === 'before'
                      ? script.input.beforeTaskId
                      : script.input.afterTaskId,
                };
        expect(request.method).toBe('POST');
        expect(request.url).toBe(
          `/v2/task/${script.input.family}/${step.kind === 'status' ? 'status' : 'report'}`,
        );
        expect(request.headers.authorization).toBe(compareFixtureKey);
        expect(request.headers.accept).toBe('application/json');
        expect(request.headers['content-type']).toBe('application/json');
        expect(body).toBe(JSON.stringify(exactBody));
        ndSafe(() =>
          ndEvent('receiver-body-validated', {
            ordinal: index + 1,
            body,
            step: ndPublicInput(step),
          }),
        );
        const json = JSON.stringify(script.reply(step, index));
        if (typeof json !== 'string')
          throw new Error('Invalid finite N2 JSON fixture.');
        const wire = expected.gzip ? gzipSync(json) : Buffer.from(json, 'utf8');
        arrivals[index] = {
          path: request.url ?? '',
          body,
          decodedBytes: Buffer.byteLength(json, 'utf8'),
          wireBytes: wire.byteLength,
        };
        response.writeHead(200, {
          'Content-Type': 'application/json',
          ...(expected.gzip ? { 'Content-Encoding': 'gzip' } : {}),
        });
        ndSafe(() =>
          ndEvent('response-end-enter', {
            ordinal: index + 1,
            wireBytes: wire.byteLength,
          }),
        );
        response.end(wire);
        ndSafe(() => ndEvent('response-end-return', { ordinal: index + 1 }));
      })().catch((reason: unknown) => {
        ndSafe(() =>
          ndEvent('receiver-handler-rejected', {
            ordinal: index + 1,
            error: ndError.snapshot(reason),
          }),
        );
        errors.push(reason);
        response.writeHead(500);
        response.end('{}');
      }),
    );
  });
  const ndServerScalars = (): NDObject => {
    const values: NDObject = {};
    for (const key of [
      'timeout',
      'keepAliveTimeout',
      'keepAliveTimeoutBuffer',
      'requestTimeout',
      'headersTimeout',
    ])
      values[key] = ndReadScalar(server, key);
    return values;
  };
  const ndConnection = (socket: Socket) =>
    ndSafe(() => {
      ndEvent('receiver-connection', {
        connection: ndSocket(socket, 'connection'),
      });
    });
  ndSafe(() =>
    ndOwnListener(
      'receiver',
      () => server.on('connection', ndConnection),
      () => server.removeListener('connection', ndConnection),
    ),
  );
  const ndSnapshot = (): NDObject => ({
    version: 1,
    source: 'actual_test_observation',
    synthetic: false,
    originalCause: 'UNKNOWN',
    events: ndEvents.map((event) => ({ ...event })),
    clientCalls: ndClientCount,
    transportEntries: ndTransportCount,
    nativeEntries: ndNativeCount,
    guardCursor: ndCursor(),
    guardExpected: ndGuardExpected,
    scriptSteps: script.steps.length,
    defaultDenyCalls: guard.calls(),
    traceOverflow: ndOverflow,
    overflowed: ndOverflow > 0 || ndError.overflow() > 0,
    metadataOverflow: ndError.overflow(),
    observerFaults: [...ndFaults],
    retainedOriginalReasonTags: ndError.retainedIdentityTags(),
    serverScalars: ndServerScalars(),
    connections: [...ndSockets.entries()].map(([socket, state]) => ({
      ...state,
      closeFieldMeans: 'callback_observed_not_socket_state',
      destroyed: ndReadScalar(socket, 'destroyed'),
      connecting: ndReadScalar(socket, 'connecting'),
    })),
    coverage: {
      connectionEvents: ndEvents.some(
        (event) => event.kind === 'receiver-connection',
      )
        ? 'OBSERVED'
        : 'UNKNOWN',
      socketCloseEvents: ndEvents.some((event) => event.kind === 'socket-close')
        ? 'OBSERVED'
        : 'UNKNOWN',
      clientErrorEvents: 'UNKNOWN_NO_ADDED_LISTENER',
      socketErrorEvents: 'UNKNOWN_NO_ADDED_LISTENER',
    },
    passiveListeners: {
      registered: ndRemovers.length,
      removed: ndRemovers.filter((owned) => owned.removed).length,
      signalRemaining: ndRemovers.filter(
        (owned) => owned.scope === 'signal' && !owned.removed,
      ).length,
    },
  });
  const closeReceiver = async () => {
    ndSafe(() =>
      ndEvent('explicit-teardown-enter', {
        listening: server.listening,
        serverScalars: ndServerScalars(),
      }),
    );
    server.closeIdleConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          ndSafe(() =>
            ndEvent('server-close-callback', {
              error: error ? ndError.snapshot(error) : null,
            }),
          );
          return error ? reject(error) : resolve();
        }),
      );
  };
  // Cleanup ownership is established before temporary-file/listener creation.
  try {
    root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'compare-n2-'));
    await writeFile(
      join(root, 'script.json'),
      JSON.stringify(n2SavedScript(script, expected)),
      { mode: 0o600 },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', (reason) => {
        ndSafe(() =>
          ndEvent('existing-server-error-handler', {
            error: ndError.snapshot(reason),
          }),
        );
        reject(reason);
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing N2 receiver.');
    const originalNativeFetch = guard.nativeFetch;
    // The unchanged guard calls this bare. Preserve that actual receiver, args,
    // init/signal identity and EXACT original promise; observers are separate.
    const observedNativeFetch: typeof fetch = Object.assign(
      function (
        this: unknown,
        ...args: Parameters<typeof fetch>
      ): ReturnType<typeof fetch> {
        let attempt: number | 'UNKNOWN' = 'UNKNOWN';
        ndSafe(() => {
          ndNativeCount++;
          if (ndNativeCount > 64) ndOverflow++;
          attempt = args[1]
            ? (ndInitAttempts.get(args[1]) ?? 'UNKNOWN')
            : 'UNKNOWN';
          ndEvent(
            'native-enter',
            {
              request: ndRequest(args[0], args[1]),
              actualThis:
                this === undefined
                  ? 'undefined'
                  : this === null
                    ? 'null'
                    : typeof this,
              guardCursor: ndCursor(),
              initLinkedToTransport: typeof attempt === 'number',
            },
            attempt,
          );
        });
        let original: ReturnType<typeof fetch>;
        try {
          original = Reflect.apply(originalNativeFetch, this, args);
        } catch (reason) {
          ndSafe(() =>
            ndEvent(
              'native-sync-throw',
              {
                error: ndError.snapshot(reason),
                signal: ndSignal(ndOwn(args[1], 'signal')),
              },
              attempt,
            ),
          );
          throw reason;
        }
        ndNativePromises.push(original);
        ndSafe(() =>
          ndEvent(
            'native-original-promise-captured',
            { identity: ndID(original) },
            attempt,
          ),
        );
        ndObserve(
          original,
          () =>
            ndEvent(
              'native-fulfilled',
              { signal: ndSignal(ndOwn(args[1], 'signal')) },
              attempt,
            ),
          (reason) =>
            ndEvent(
              'native-rejected',
              {
                error: ndError.snapshot(reason),
                signal: ndSignal(ndOwn(args[1], 'signal')),
              },
              attempt,
            ),
        );
        return original;
      },
      { preconnect: originalNativeFetch.preconnect },
    );
    const transport = createCompareFixtureFetch(
      `http://127.0.0.1:${address.port}`,
      script.input,
      script.steps,
      observedNativeFetch,
    );
    ndCursor = transport.entered;
    ndGuardExpected = transport.expected;
    const decorated: typeof fetch = Object.assign(
      async (
        target: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const attempt = ++ndTransportCount;
        ndSafe(() => {
          if (init) ndInitAttempts.set(init, attempt);
          ndEvent(
            'transport-enter',
            {
              client: ndActiveClient,
              request: ndRequest(target, init),
              guardCursor: transport.entered(),
              guardExpected: transport.expected,
              defaultDenyCalls: guard.calls(),
            },
            attempt,
          );
        });
        let response: Response;
        try {
          response = await transport.fetch(target, init);
          ndSafe(() =>
            ndEvent(
              'transport-fulfilled',
              { guardCursor: transport.entered() },
              attempt,
            ),
          );
        } catch (reason) {
          ndSafe(() =>
            ndEvent(
              'transport-rejected',
              {
                error: ndError.snapshot(reason),
                signal: ndSignal(ndOwn(init, 'signal')),
                guardCursor: transport.entered(),
                defaultDenyCalls: guard.calls(),
              },
              attempt,
            ),
          );
          throw reason;
        }
        try {
          ndSafe(() => ndEvent('delegate-enter', {}, attempt));
          const result = delegate(response);
          ndSafe(() => ndEvent('delegate-return', {}, attempt));
          return result;
        } catch (reason) {
          ndSafe(() =>
            ndEvent(
              'delegate-rejected',
              { error: ndError.snapshot(reason) },
              attempt,
            ),
          );
          throw reason;
        }
      },
      {
        preconnect() {
          throw new Error('Denied N2 preconnect.');
        },
      },
    );
    const client = new SpeedyIndexClient(compareFixtureKey, decorated);
    const originalStatus = client.getTaskStatus,
      originalReport = client.getTaskReport;
    client.getTaskStatus = function (
      this: SpeedyIndexClient,
      ...args: Parameters<SpeedyIndexClient['getTaskStatus']>
    ) {
      const ordinal = ndClientStart(
        'getTaskStatus',
        args[0],
        this === client,
        args[1],
        args[2],
      );
      const promise = originalStatus.apply(this, args);
      clientReceipts.push(promise);
      calls.push({
        receiver: this === client,
        signal: args[1],
        budget: args[2],
      });
      ndClientOutcome(promise, ordinal, args[1]);
      return promise;
    };
    client.getTaskReport = function (
      this: SpeedyIndexClient,
      ...args: Parameters<SpeedyIndexClient['getTaskReport']>
    ) {
      const ordinal = ndClientStart(
        'getTaskReport',
        args[0],
        this === client,
        args[1],
        args[2],
      );
      const promise = originalReport.apply(this, args);
      clientReceipts.push(promise);
      calls.push({
        receiver: this === client,
        signal: args[1],
        budget: args[2],
      });
      ndClientOutcome(promise, ordinal, args[1]);
      return promise;
    };
    const owner = (() => {
      const originalArm = globalThis.setTimeout,
        originalImmediate = globalThis.setImmediate;
      try {
        if (io) {
          globalThis.setTimeout = ioCaptureNative(originalArm, 'timer', io);
          globalThis.setImmediate = ioCaptureNative(
            originalImmediate,
            'immediate',
            io,
          );
        }
        return createCompareReportsOwner(client, {
          ...(expected.limits === undefined ? {} : { limits: expected.limits }),
          ...(expected.budgetLimits === undefined
            ? {}
            : { budgetLimits: expected.budgetLimits }),
          runtime,
          onPhase(phase) {
            phases.push(phase);
            phaseClock.push({ phase, atMs: nativeNow() });
            if (!io) return;
            if (phase === 'before_close' || phase === 'after_close')
              ioCloseReceipts.push({
                invocation: io.invocation,
                phase,
                sequence: ++io.sequence,
              });
            if (io.invocation === 0 && phase === 'after_report_b') {
              reportBPhases++;
              if (reportBPhases === (recover ? 3 : 1)) {
                expect(controller.signal.aborted).toBe(false);
                io.pending = true;
                if (recover)
                  abortReceipt = new Promise<void>((resolve) => {
                    nativeArm(() => {
                      abortEntered = ++io.sequence;
                      try {
                        controller.abort();
                      } finally {
                        abortExited = ++io.sequence;
                        resolve();
                      }
                    }, 0);
                  });
                expect(controller.signal.aborted).toBe(false);
              }
            }
          },
        });
      } finally {
        globalThis.setTimeout = originalArm;
        globalThis.setImmediate = originalImmediate;
      }
    })();
    client.getTaskStatus = () => {
      throw new Error('Uncaptured N2 status.');
    };
    client.getTaskReport = () => {
      throw new Error('Uncaptured N2 report.');
    };
    if (io) signalObservers.push(ioObserveSignal(controller.signal, io));
    const actual = await owner.compare(script.input, controller.signal);
    actualEnvelope = actual;
    if (io) {
      ioResults.push(actual);
      await abortReceipt;
      await Promise.all(io.receipts.map((receipt) => receipt.completion));
    }
    const [readStates, cancelStates, closedStates, clientStates] =
      await Promise.all([
        Promise.allSettled(nativeReads),
        Promise.allSettled(nativeCancels),
        Promise.allSettled(nativeClosed),
        Promise.allSettled(clientReceipts),
      ]);
    await Promise.all(passiveObservers);
    originalSettlementBeforeTeardown = true;
    expect(readStates).toHaveLength(nativeReads.length);
    expect(cancelStates).toHaveLength(nativeCancels.length);
    expect(closedStates).toHaveLength(nativeClosed.length);
    expect(actual).toEqual(independentEnvelope(expected.result));
    expect(phases).toEqual([
      ...expected.progress,
      'before_close',
      'after_close',
    ]);
    expect(calls).toHaveLength(expected.clientCalls ?? expected.reads);
    if (calls.length === 0) expect(calls[0]?.budget).toBeUndefined();
    else expect(calls[0]?.budget).toBeDefined();
    expect(
      calls.every(
        (call) =>
          call.receiver &&
          call.signal === controller.signal &&
          call.budget === calls[0]?.budget,
      ),
    ).toBe(true);
    expect(transport.entered()).toBe(expected.reads);
    expect(readers).toBe(expected.reads);
    expect(closedFulfilled + closedRejected).toBe(expected.reads);
    expect(readDone).toBe(expected.done ?? expected.reads);
    expect(releaseOutcomes).toHaveLength(expected.reads);
    expect(
      releaseOutcomes.every((receipt) => receipt.status === 'fulfilled'),
    ).toBe(true);
    expect(
      clientStates.filter((receipt) => receipt.status === 'rejected'),
    ).toHaveLength(expected.clientRejections ?? 0);
    expect(activeTimers.size).toBe(0);
    expect(armed).toBe(cleared);
    expect(guard.calls()).toBe(0);
    expect(compareReportsEnvelopeSchema.safeParse(actual).success).toBe(true);
    expect(actual.isError).toBe(expected.result.status === 'error');
    expect(bytes(actual)).toBe(bytes(independentEnvelope(expected.result)));
    n1Frozen(actual);
    await Promise.all(handlers);
    await Promise.all(peers);
    expect(errors).toEqual([]);
    expect(arrivals).toHaveLength(expected.reads);
    expect(peerCloses).toBe(expected.reads);
    const verifyIO = (invocation: number, pairs: number) => {
      if (!io) throw new Error('Missing comparison I/O observation.');
      const receipts = io.receipts.filter(
        (receipt) => receipt.invocation === invocation,
      );
      const before = ioCloseReceipts.find(
          (receipt) =>
            receipt.invocation === invocation &&
            receipt.phase === 'before_close',
        ),
        after = ioCloseReceipts.find(
          (receipt) =>
            receipt.invocation === invocation &&
            receipt.phase === 'after_close',
        );
      if (!before || !after)
        throw new Error('Missing comparison I/O close receipts.');
      expect(before.sequence).toBeLessThan(after.sequence);
      for (const kind of ['timer', 'immediate'] as const)
        expect(
          receipts.filter((receipt) => receipt.kind === kind),
        ).toHaveLength(pairs);
      expect(
        receipts.every(
          (receipt) =>
            receipt.entered !== null &&
            receipt.exited !== null &&
            receipt.entered < receipt.exited &&
            receipt.exited < before.sequence,
        ),
      ).toBe(true);
      const targeted = receipts.filter((receipt) => receipt.targeted);
      expect(targeted).toHaveLength(invocation === 0 ? 1 : 0);
      if (invocation === 0) {
        expect(targeted[0]?.kind).toBe('timer');
        expect(io.transitions).toBe(recover ? 0 : 1);
      }
      const observer = signalObservers[invocation];
      if (!observer) throw new Error('Missing original signal observation.');
      expect(observer.active.size).toBe(0);
      expect(observer.counts.added).toBe(observer.counts.removed);
      expect(observer.aborts).toHaveLength(recover && invocation === 0 ? 1 : 0);
      if (recover && invocation === 0) {
        if (abortEntered === null || abortExited === null)
          throw new Error('Missing queued abort completion.');
        const event = observer.aborts[0];
        if (event === undefined)
          throw new Error('Missing original abort event.');
        expect(abortEntered).toBeLessThan(event);
        expect(event).toBeLessThan(abortExited);
        expect(abortExited).toBeLessThan(before.sequence);
        const timerEntry = targeted[0]?.entered;
        if (timerEntry === null || timerEntry === undefined)
          throw new Error('Missing targeted native timer entry.');
        expect(abortExited).toBeLessThan(timerEntry);
      }
      expect(io.pending).toBe(false);
      expect(nativeCancels).toHaveLength(0);
    };
    if (io) {
      expect(closedFulfilled).toBe(expected.reads);
      expect(closedRejected).toBe(0);
      expect(
        [...readStates, ...closedStates, ...clientStates].every(
          (receipt) => receipt.status === 'fulfilled',
        ),
      ).toBe(true);
      ndRemove('signal');
      verifyIO(0, expected.reads);
    }
    if (io && recover) {
      const firstBudget = calls[0]?.budget;
      const firstSignal = controller.signal;
      const phaseOffset = phases.length,
        clientOffset = clientReceipts.length;
      io.invocation = 1;
      controller = new AbortController();
      signalObservers.push(ioObserveSignal(controller.signal, io));
      const recovered = await owner.compare(script.input, controller.signal);
      ioResults.push(recovered);
      await Promise.all(io.receipts.map((receipt) => receipt.completion));
      const [recoveryReads, recoveryCancels, recoveryClosed, recoveryClients] =
        await Promise.all([
          Promise.allSettled(nativeReads),
          Promise.allSettled(nativeCancels),
          Promise.allSettled(nativeClosed),
          Promise.allSettled(clientReceipts.slice(clientOffset)),
        ]);
      await Promise.all(passiveObservers);
      expect(recovered).toEqual(independentEnvelope(n1BacklinkResult()));
      expect(phases.slice(phaseOffset)).toEqual([
        ...n1BacklinkComplete,
        'before_close',
        'after_close',
      ]);
      const recoveryCalls = calls.slice(clientOffset);
      expect(recoveryCalls).toHaveLength(13);
      expect(recoveryCalls[0]?.budget).toBeDefined();
      expect(recoveryCalls[0]?.budget).not.toBe(firstBudget);
      expect(controller.signal).not.toBe(firstSignal);
      expect(controller.signal.aborted).toBe(false);
      expect(
        recoveryCalls.every(
          (call) =>
            call.receiver &&
            call.signal === controller.signal &&
            call.budget === recoveryCalls[0]?.budget,
        ),
      ).toBe(true);
      expect(recoveryReads).toHaveLength(nativeReads.length);
      expect(recoveryCancels).toHaveLength(0);
      expect(recoveryClosed).toHaveLength(23);
      expect(recoveryClients).toHaveLength(13);
      expect(
        [...recoveryReads, ...recoveryClosed, ...recoveryClients].every(
          (receipt) => receipt.status === 'fulfilled',
        ),
      ).toBe(true);
      expect(transport.entered()).toBe(23);
      expect(readers).toBe(23);
      expect(closedFulfilled).toBe(23);
      expect(closedRejected).toBe(0);
      expect(readDone).toBe(23);
      expect(releaseOutcomes).toHaveLength(23);
      expect(
        releaseOutcomes.every((receipt) => receipt.status === 'fulfilled'),
      ).toBe(true);
      expect(activeTimers.size).toBe(0);
      expect(armed).toBe(cleared);
      expect(guard.calls()).toBe(0);
      expect(compareReportsEnvelopeSchema.safeParse(recovered).success).toBe(
        true,
      );
      expect(recovered.isError).toBe(false);
      expect(bytes(recovered)).toBe(
        bytes(independentEnvelope(n1BacklinkResult())),
      );
      n1Frozen(recovered);
      await Promise.all(handlers);
      await Promise.all(peers);
      expect(errors).toEqual([]);
      expect(arrivals).toHaveLength(23);
      expect(peerCloses).toBe(23);
      ndRemove('signal');
      verifyIO(1, 12);
    }
    beforeTeardown = true;
    succeeded = true;
  } catch (reason) {
    ndPrimary = { reason };
    throw reason;
  } finally {
    const ioSettlement = await Promise.allSettled([
      ...(abortReceipt === undefined ? [] : [abortReceipt]),
      ...(io?.receipts.map((receipt) => receipt.completion) ?? []),
    ]);
    const nativeSettlement = await Promise.allSettled([
      ...nativeReads,
      ...nativeCancels,
      ...nativeClosed,
      ...clientReceipts,
    ]);
    await Promise.all(passiveObservers);
    const handlerSettlement = await Promise.allSettled(handlers);
    await Promise.allSettled(ndNativePromises);
    await Promise.allSettled(ndObservers);
    let diagnosticWitness: ReturnType<typeof ndPeerWitness> | 'UNKNOWN' =
      'UNKNOWN';
    let timerStateBeforeTeardown:
      | { armed: number; cleared: number; fired: number; active: number }
      | undefined;
    let receiverClosure: PromiseSettledResult<void>[] = [];
    let signalRestoration: PromiseSettledResult<void>[] = [];
    await ndFinalizeReceipts({
      primary: ndPrimary,
      failures: ndReceiptFailures,
      async beforeTeardown() {
        ndRemove('signal');
        diagnosticWitness = ndPeerWitness(arrivals.length, peerCloses);
        if (peerCloses === arrivals.length) await Promise.allSettled(peers);
        ndSafe(() => {
          ndEvent('pre-explicit-teardown', { diagnosticWitness });
          ndBeforeTeardown = { ...ndSnapshot(), diagnosticWitness };
        });
        ndBeforeTeardown ??= {
          version: 1,
          source: 'actual_test_observation',
          snapshot: 'UNKNOWN',
          observerFaults: [...ndFaults],
          traceOverflow: ndOverflow,
          metadataOverflow: ndError.overflow(),
          diagnosticWitness,
        };
        return ndBeforeTeardown;
      },
      async cleanup() {
        timerStateBeforeTeardown = {
          armed,
          cleared,
          fired,
          active: activeTimers.size,
        };
        for (const handle of activeTimers) {
          const original = timers.get(handle);
          if (original !== undefined) {
            nativeDisarm(original);
            forcedTimerCleanup++;
          }
        }
        receiverClosure = await Promise.allSettled([closeReceiver()]);
        try {
          ndRemove();
        } finally {
          try {
            signalRestoration = await Promise.allSettled(
              signalObservers.map(async (observer) => observer.restore()),
            );
          } finally {
            guard.restore();
          }
        }
      },
      finalReceipt() {
        let ndFinal: NDObject | 'UNKNOWN' = 'UNKNOWN';
        ndSafe(() => {
          ndFinal = ndSnapshot();
        });
        return {
          id: script.id,
          success: succeeded,
          expectedReads: recover ? 23 : expected.reads,
          nativeRequests: arrivals.length,
          arrivals,
          peerCloses,
          peerCompletionBeforeTeardown: beforeTeardown,
          originalSettlementBeforeTeardown,
          clientCalls: calls.length,
          originalReadOutcomes: nativeSettlement
            .slice(0, nativeReads.length)
            .map(n2Outcome),
          originalCancelOutcomes: nativeSettlement
            .slice(
              nativeReads.length,
              nativeReads.length + nativeCancels.length,
            )
            .map(n2Outcome),
          originalClosedOutcomes: nativeSettlement
            .slice(
              nativeReads.length + nativeCancels.length,
              nativeReads.length + nativeCancels.length + nativeClosed.length,
            )
            .map(n2Outcome),
          originalClientOutcomes: nativeSettlement
            .slice(
              nativeReads.length + nativeCancels.length + nativeClosed.length,
            )
            .map(n2Outcome),
          readers,
          closedFulfilled,
          closedRejected,
          readDone,
          deliveredBytes,
          releases: releaseOutcomes,
          phases,
          phaseClock,
          firstNow,
          lastNow,
          clockReads,
          elapsedOriginalClockMs:
            firstNow === null || lastNow === null ? null : lastNow - firstNow,
          timersBeforeTeardown: timerStateBeforeTeardown,
          forcedTimerCleanup,
          handlerSettlement: handlerSettlement.map(n2Outcome),
          receiverClosure: receiverClosure.map(n2Outcome),
          receiverErrors: errors.map(n2Reason),
          actualEnvelope,
          expectedEnvelope: independentEnvelope(expected.result),
          limits: expected.limits ?? null,
          budgetLimits: expected.budgetLimits ?? null,
          gzip: expected.gzip ?? false,
          ioObservation: io
            ? {
                recipe: io.recipe,
                transitions: io.transitions,
                pending: io.pending,
                results: ioResults,
                closeReceipts: ioCloseReceipts,
                callbacks: io.receipts.map((receipt) => ({
                  kind: receipt.kind,
                  invocation: receipt.invocation,
                  targeted: receipt.targeted,
                  entered: receipt.entered,
                  exited: receipt.exited,
                })),
                callbackSettlement: ioSettlement.map(n2Outcome),
                signalRestoration: signalRestoration.map(n2Outcome),
                abortEntered,
                abortExited,
                originalSignals: signalObservers.map((observer) => ({
                  ...observer.counts,
                  active: observer.active.size,
                  abortEvents: observer.aborts,
                })),
              }
            : null,
          failedRoot: succeeded ? null : (root ?? null),
          networkObservation: {
            receiptFailures: ndReceiptFailures.map(({ phase, reason }) => ({
              phase,
              error: ndError.snapshot(reason),
            })),
            observerFaults: [...ndFaults],
            traceOverflow: ndOverflow,
            metadataOverflow: ndError.overflow(),
            beforeExplicitTeardown: ndBeforeTeardown ?? 'UNKNOWN',
            final: ndFinal,
            diagnosticWitness,
          },
        };
      },
      async write(phase, text) {
        if (root)
          await writeFile(
            join(
              root,
              phase === 'before-teardown'
                ? 'diagnostic-before-teardown.json'
                : 'receipt.json',
            ),
            text,
            { mode: 0o600 },
          );
      },
      publish(text) {
        console.info('CR_N2_NATIVE ' + text);
      },
      verify() {
        expect(
          handlerSettlement.every((result) => result.status === 'fulfilled'),
        ).toBe(true);
        expect(
          receiverClosure.every((result) => result.status === 'fulfilled'),
        ).toBe(true);
        expect(forcedTimerCleanup).toBe(0);
        expect(
          [...ioSettlement, ...signalRestoration].every(
            (receipt) => receipt.status === 'fulfilled',
          ),
        ).toBe(true);
        if (ndPrimary === undefined) {
          expect(ndFaults).toEqual([]);
          expect(ndOverflow + ndError.overflow()).toBe(0);
          expect(ndRemovers.every((owned) => owned.removed)).toBe(true);
        }
      },
      report(failures) {
        console.error(
          'CR_N2_DIAGNOSTIC_FAILURE ' +
            JSON.stringify(
              failures.map(({ phase, reason }) => ({
                phase,
                error: ndError.snapshot(reason),
              })),
            ),
        );
      },
    });
    if (succeeded && root) await rm(root, { recursive: true });
  }
}

function n2WideTargets(
  id: string,
  kind: 'unprocessed' | 'malformed',
): N1Script {
  const base = n1BacklinkScript(id);
  const selected = kind === 'unprocessed' ? n1UnprocessedUrl : n1InvalidUrl;
  return {
    ...base,
    reply(step, index) {
      const raw = base.reply(step, index);
      if (step.kind === 'status') return raw;
      if (!n1Record(raw) || !n1Record(raw.result))
        throw new Error('Invalid N2 wide fixture.');
      return {
        ...raw,
        result: n1EditDonors(raw.result, (donors) =>
          donors.map((row) =>
            row.donor_url === selected
              ? {
                  ...row,
                  target_links: Array.from({ length: 5 }, () =>
                    kind === 'unprocessed'
                      ? { ignored: 'raw' }
                      : { url: c, anchor: 17, nofollow: false },
                  ),
                }
              : row,
          ),
        ),
      };
    },
  };
}

function n2WideResult(kind: 'unprocessed' | 'malformed'): N1BacklinkResult {
  const base = n1BacklinkResult();
  return {
    ...base,
    before: {
      ...base.before,
      coverage: { ...base.before.coverage, rawTargetLinkCount: 14 },
    },
    after: {
      ...base.after,
      coverage: {
        ...base.after.coverage,
        rawTargetLinkCount: kind === 'unprocessed' ? 8 : 4,
      },
    },
  };
}

const n2Aliases: CompareReportsInput = {
  family: 'google/indexer',
  beforeTaskId: 'avant é"\\',
  afterTaskId: 'après Ω',
};

function n2AliasScript(id: string): N1Script {
  return {
    id,
    input: n2Aliases,
    steps: genericSteps,
    reply(step) {
      return {
        code: 0,
        result:
          step.kind === 'status'
            ? n1Statuses('google/indexer').map((row, index) => ({
                ...row,
                id:
                  index === 0 ? n2Aliases.beforeTaskId : n2Aliases.afterTaskId,
              }))
            : {
                ...n1GenericReport('google/indexer', step.side),
                id:
                  step.side === 'before'
                    ? n2Aliases.beforeTaskId
                    : n2Aliases.afterTaskId,
              },
      };
    },
  };
}

function n2AliasResult(): N1LinksResult {
  const base = n1GenericResult('google/indexer');
  return {
    ...base,
    beforeTaskId: n2Aliases.beforeTaskId,
    afterTaskId: n2Aliases.afterTaskId,
    before: {
      ...base.before,
      status: { ...base.before.status, id: n2Aliases.beforeTaskId },
    },
    after: {
      ...base.after,
      status: { ...base.after.status, id: n2Aliases.afterTaskId },
    },
  };
}

const n2MaximumDonorIds: readonly string[] = Array.from(
  { length: 1500 },
  (_, index) => `https://d.test/${index.toString().padStart(4, '0')}`,
);

function n2MaximumScript(id: string, advertisedLast = 14): N1Script {
  return {
    id,
    input: n1BacklinkSelected,
    steps: n1BacklinkSteps(14, 14),
    reply(step) {
      if (step.kind === 'status')
        return {
          code: 0,
          result: ['before', 'after'].map((taskId) => ({
            id: taskId,
            type: 'backlink/checker',
            size: 1500,
            processed_count: 1500,
            is_completed: true,
            target_domains: ['Max.Example'],
            created_at:
              taskId === 'before' ? ' status-before Ω ' : ' status-after Ω ',
          })),
        };
      const pageNumber = step.page ?? 0;
      return {
        code: 0,
        result: {
          id: step.side,
          size: 1500,
          processed_count: 1500,
          is_completed: true,
          page: pageNumber,
          last_page: advertisedLast,
          donors: n2MaximumDonorIds
            .slice(pageNumber * 100, pageNumber * 100 + 100)
            .map((donor_url) => ({
              donor_url,
              processed: true,
              target_links: [],
            })),
        },
      };
    },
  };
}

function n2MaximumResult(): N1BacklinkResult {
  const summary = (id: 'before' | 'after'): N1BacklinkResult['before'] => ({
    status: {
      id,
      type: 'backlink/checker',
      size: 1500,
      processedCount: 1500,
      indexedCount: null,
      isCompleted: true,
      status: null,
      checkAfter: null,
      awaitingResult: null,
      dripFeed: null,
      days: null,
      daysPassed: null,
      isStopped: null,
      targetDomains: ['Max.Example'],
      providerCreatedAt:
        id === 'before' ? ' status-before Ω ' : ' status-after Ω ',
    },
    report: {
      size: 1500,
      processedCount: 1500,
      isCompleted: true,
      lastPage: 14,
      pagesVisited: 15,
    },
    coverage: {
      rawDonorCount: 1500,
      observedUniqueDonorCount: 1500,
      duplicateDonorCount: 0,
      conflictingDonorCount: 0,
      rawTargetLinkCount: 0,
      duplicateTargetLinkCount: 0,
      reportedSlotGap: 0,
    },
  });
  return {
    status: 'compared',
    reportKind: 'backlink',
    family: 'backlink/checker',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: { ...expectedScope },
    targetScope: {
      provenance: 'matching_current_provider_status',
      targetDomains: ['Max.Example'],
      originalTargets: 'unknown',
    },
    before: summary('before'),
    after: summary('after'),
    rows: n2MaximumDonorIds.map(
      (donorUrl): N1BacklinkResult['rows'][number] => ({
        donorUrl,
        before: { state: 'reported', targetLinks: [] },
        after: { state: 'reported', targetLinks: [] },
        comparison: {
          state: 'compared',
          newlyReportedTargetUrls: [],
          noLongerReportedTargetUrls: [],
          attributeChangedTargetUrls: [],
          unchangedTargetUrls: [],
        },
      }),
    ),
    counts: {
      comparedDonors: 1500,
      unknownDonors: 0,
      totalDonors: 1500,
      newlyReportedTargetUrls: 0,
      noLongerReportedTargetUrls: 0,
      attributeChangedTargetUrls: 0,
      unchangedTargetUrls: 0,
    },
  };
}

const n2MaximumProgress: readonly CompareOwnerPhase[] = [
  ...n1ReportStart,
  ...n1ReportMarkers('after_report_a', 30),
  'after_status1',
  ...n1ReportMarkers('after_report_b', 30),
  'after_status2',
  'after_comparison',
  'after_serialization',
];

interface N2RawCase {
  id: string;
  exact: number;
  lower: number;
  limits(value: number): NonNullable<N2Construction['limits']>;
  script(id: string): N1Script;
  result(): CompareReportsResult;
  successReads: number;
  failureReads: number;
  successProgress: readonly CompareOwnerPhase[];
  failureProgress: readonly CompareOwnerPhase[];
}

const n2GenericRawCases: readonly N2RawCase[] = [
  {
    id: 'generic-per-task',
    exact: 3,
    lower: 2,
    limits: (value) => ({ genericPerTask: value }),
    script: n1GenericScript,
    result: () => n1GenericResult('google/indexer'),
    successReads: 7,
    failureReads: 2,
    successProgress: n1Complete,
    failureProgress: n1ReportStart,
  },
  {
    id: 'generic-four-visits',
    exact: 12,
    lower: 11,
    limits: (value) => ({ genericTotal: value }),
    script: n1GenericScript,
    result: () => n1GenericResult('google/indexer'),
    successReads: 7,
    failureReads: 6,
    successProgress: n1Complete,
    failureProgress: n1BeforeFence,
  },
];

const n2BacklinkRawCases: readonly N2RawCase[] = [
  {
    id: 'donors-per-task',
    exact: 4,
    lower: 3,
    limits: (value) => ({ donorsPerTask: value }),
    script: n1BacklinkScript,
    result: n1BacklinkResult,
    successReads: 13,
    failureReads: 4,
    successProgress: n1BacklinkComplete,
    failureProgress: n1Status1,
  },
  {
    id: 'donors-all-passes',
    exact: 14,
    lower: 13,
    limits: (value) => ({ donorsTotal: value }),
    script: n1BacklinkScript,
    result: n1BacklinkResult,
    successReads: 13,
    failureReads: 12,
    successProgress: n1BacklinkComplete,
    failureProgress: [...n1BacklinkBeforeFence, 'after_report_b'],
  },
  {
    id: 'targets-per-donor',
    exact: 4,
    lower: 3,
    limits: (value) => ({ targetsPerDonor: value }),
    script: n1BacklinkScript,
    result: n1BacklinkResult,
    successReads: 13,
    failureReads: 2,
    successProgress: n1BacklinkComplete,
    failureProgress: n1ReportStart,
  },
  {
    id: 'targets-per-task',
    exact: 10,
    lower: 9,
    limits: (value) => ({ targetsPerTask: value }),
    script: n1BacklinkScript,
    result: n1BacklinkResult,
    successReads: 13,
    failureReads: 4,
    successProgress: n1BacklinkComplete,
    failureProgress: n1Status1,
  },
  {
    id: 'targets-all-passes',
    exact: 28,
    lower: 27,
    limits: (value) => ({ targetsTotal: value }),
    script: n1BacklinkScript,
    result: n1BacklinkResult,
    successReads: 13,
    failureReads: 12,
    successProgress: n1BacklinkComplete,
    failureProgress: [...n1BacklinkBeforeFence, 'after_report_b'],
  },
  {
    id: 'unprocessed-per-donor',
    exact: 5,
    lower: 4,
    limits: (value) => ({ targetsPerDonor: value }),
    script: (id) => n2WideTargets(id, 'unprocessed'),
    result: () => n2WideResult('unprocessed'),
    successReads: 13,
    failureReads: 2,
    successProgress: n1BacklinkComplete,
    failureProgress: n1ReportStart,
  },
  {
    id: 'malformed-per-donor',
    exact: 5,
    lower: 4,
    limits: (value) => ({ targetsPerDonor: value }),
    script: (id) => n2WideTargets(id, 'malformed'),
    result: () => n2WideResult('malformed'),
    successReads: 13,
    failureReads: 4,
    successProgress: n1BacklinkComplete,
    failureProgress: n1Status1,
  },
];

async function n2RawPair(variant: N2RawCase) {
  for (const value of [variant.exact, variant.lower])
    await n2Run(variant.script(`CR-I05-${variant.id}-${value}`), {
      result: value === variant.exact ? variant.result() : n1ResourceFailure(),
      reads:
        value === variant.exact ? variant.successReads : variant.failureReads,
      progress:
        value === variant.exact
          ? variant.successProgress
          : variant.failureProgress,
      limits: variant.limits(value),
    });
}

test('CR-N2L-RAW-GENERIC duplicate per-task and all four report visits use inclusive raw counts', async () => {
  for (const variant of n2GenericRawCases) await n2RawPair(variant);
}, 30_000);

test('CR-N2L-RAW-BACKLINK donors and raw targets include duplicates unprocessed malformed rows and both passes', async () => {
  for (const variant of n2BacklinkRawCases) await n2RawPair(variant);
}, 30_000);

test('CR-N2L-REQUEST exact escaped Unicode status body bound refuses before HTTP', async () => {
  const request = JSON.stringify({
    task_ids: [n2Aliases.beforeTaskId, n2Aliases.afterTaskId],
  });
  expect(Buffer.byteLength(request, 'utf8')).toBe(41);
  expect(Buffer.byteLength(request, 'utf8')).toBeGreaterThan(request.length);
  for (const value of [41, 40])
    await n2Run(n2AliasScript('CR-I05-request-' + value), {
      result: value === 41 ? n2AliasResult() : n1ResourceFailure(),
      reads: value === 41 ? 7 : 0,
      progress: value === 41 ? n1Complete : n1Initial,
      limits: { requestBytes: value },
    });
}, 30_000);

test('CR-N2L-DECODED original aggregate budget counts decoded UTF8 across plain and actual gzip responses', async () => {
  for (const gzip of [false, true])
    for (const value of [2141, 2140])
      await n2Run(
        n1GenericScript(`CR-I05-decoded-${gzip ? 'gzip' : 'plain'}-${value}`),
        {
          result:
            value === 2141
              ? n1GenericResult('google/indexer')
              : n1ResourceFailure(),
          reads: 7,
          done: value === 2141 ? 7 : 6,
          clientRejections: value === 2141 ? 0 : 1,
          progress: value === 2141 ? n1Complete : n1AfterFence,
          budgetLimits: { maxDecodedBytes: value },
          gzip,
        },
      );
}, 30_000);

test('CR-N2L-ENVELOPE inclusive independent E5196 and Eminus1 bounds own the complete application result', async () => {
  expect(bytes(independentEnvelope(n1GenericResult('google/indexer')))).toBe(
    5196,
  );
  for (const value of [5196, 5195])
    await n2Run(n1GenericScript('CR-I05-envelope-' + value), {
      result:
        value === 5196
          ? n1GenericResult('google/indexer')
          : n1ResourceFailure(),
      reads: 7,
      progress: n1Complete,
      limits: { resultBytes: value },
    });
}, 30_000);

test('CR-N2L-ADMISSION owner reservation and original budget fetch admission stop without an extra request', async () => {
  for (const value of [7, 6])
    await n2Run(n1GenericScript('CR-I05-owner-reads-' + value), {
      result:
        value === 7 ? n1GenericResult('google/indexer') : n1ResourceFailure(),
      reads: value === 7 ? 7 : 0,
      progress: value === 7 ? n1Complete : n1Initial,
      limits: { maxReads: value },
    });
  for (const value of [7, 6])
    await n2Run(n1GenericScript('CR-I05-budget-attempts-' + value), {
      result:
        value === 7 ? n1GenericResult('google/indexer') : n1ResourceFailure(),
      reads: value,
      clientCalls: 7,
      clientRejections: value === 7 ? 0 : 1,
      progress: value === 7 ? n1Complete : n1AfterFence,
      budgetLimits: { maxAttempts: value },
    });
}, 30_000);

test('CR-N2L-PAGES63 complete fifteen-page 1500-donor pair performs exactly63native reads with original clock', async () => {
  await n2Run(n2MaximumScript('CR-I05-pages63-full1500'), {
    result: n2MaximumResult(),
    reads: 63,
    progress: n2MaximumProgress,
  });
}, 90_000);

test('CR-N2L-PAGE-REFUSALS full-data reservation62 and advertised lastPage15 refuse before continuation', async () => {
  await n2Run(n2MaximumScript('CR-I05-pages-reserved62'), {
    result: n1ResourceFailure(),
    reads: 17,
    limits: { maxReads: 62 },
    progress: [...n1ReportStart, ...n1ReportMarkers('after_report_a', 15)],
  });
  await n2Run(n2MaximumScript('CR-I05-advertised-last15', 15), {
    result: n1ResourceFailure(),
    reads: 2,
    progress: n1ReportStart,
  });
}, 90_000);

function n2RawTotals(script: N1Script) {
  let generic = 0,
    donors = 0,
    targets = 0;
  const reportVisits: {
    side: 'before' | 'after';
    generic: number;
    donors: number;
    targets: number;
  }[] = [];
  for (const [index, step] of script.steps.entries()) {
    if (step.kind === 'status') continue;
    const raw = script.reply(step, index);
    if (!n1Record(raw) || !n1Record(raw.result))
      throw new Error('Invalid raw oracle fixture.');
    const record = raw.result;
    let g = 0,
      d = 0,
      t = 0;
    if (
      Array.isArray(record.indexed_links) &&
      Array.isArray(record.unindexed_links)
    )
      g = record.indexed_links.length + record.unindexed_links.length;
    if (Array.isArray(record.donors)) {
      d = record.donors.length;
      for (const row of record.donors)
        if (n1Record(row) && Array.isArray(row.target_links))
          t += row.target_links.length;
    }
    generic += g;
    donors += d;
    targets += t;
    reportVisits.push({ side: step.side, generic: g, donors: d, targets: t });
  }
  return { generic, donors, targets, reportVisits };
}

test('CR-N2L-PREP finite raw UTF8 gzip and full maximum fixture preparation preserves exact native guard', async () => {
  const generic = n1GenericScript('N2-prep-generic');
  const replies = generic.steps.map((step, index) =>
    JSON.stringify(generic.reply(step, index)),
  );
  const decoded = replies.map((json) => Buffer.byteLength(json, 'utf8'));
  expect(decoded).toEqual([301, 312, 307, 301, 312, 307, 301]);
  expect(decoded.reduce((sum, value) => sum + value, 0)).toBe(2141);
  const compressed = replies.map((json) => gzipSync(json));
  compressed.forEach((wire, index) =>
    expect<string | undefined>(gunzipSync(wire).toString('utf8')).toBe(
      replies[index],
    ),
  );
  expect(
    compressed.reduce((sum, wire) => sum + wire.byteLength, 0),
  ).toBeLessThan(2141);
  expect(n2RawTotals(generic).generic).toBe(12);
  const backlink = n1BacklinkScript('N2-prep-backlink');
  const rawBacklink = n2RawTotals(backlink);
  expect(rawBacklink.donors).toBe(14);
  expect(rawBacklink.targets).toBe(28);
  expect(
    n2RawTotals(n2WideTargets('N2-prep-unprocessed', 'unprocessed')).targets,
  ).toBe(44);
  expect(
    n2RawTotals(n2WideTargets('N2-prep-malformed', 'malformed')).targets,
  ).toBe(36);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        task_ids: [n2Aliases.beforeTaskId, n2Aliases.afterTaskId],
      }),
      'utf8',
    ),
  ).toBe(41);
  expect(bytes(independentEnvelope(n1GenericResult('google/indexer')))).toBe(
    5196,
  );
  const maximum = n2MaximumScript('N2-prep-maximum');
  expect(maximum.steps).toHaveLength(63);
  expect(new Set(n2MaximumDonorIds).size).toBe(1500);
  const maximumRaw = n2RawTotals(maximum);
  expect(maximumRaw.donors).toBe(6000);
  expect(maximumRaw.reportVisits).toHaveLength(60);
  expect(maximumRaw.reportVisits.every((visit) => visit.donors === 100)).toBe(
    true,
  );
  for (const [index, step] of maximum.steps.entries()) {
    const raw = maximum.reply(step, index);
    if (step.kind === 'status')
      expect(
        normalizeTaskStatusResult('backlink/checker', ['before', 'after'], raw)
          .tasks,
      ).toHaveLength(2);
    else {
      const report = normalizeTaskReport(
        {
          family: 'backlink/checker',
          taskId: step.side,
          page: step.page ?? 0,
          limit: 100,
        },
        raw,
      );
      expect(report.reportKind).toBe('backlink');
    }
  }
  const advertised = n2MaximumScript('N2-prep-last15', 15);
  const beforePage: CompareWireStep = {
    kind: 'report',
    side: 'before',
    page: 0,
  };
  const acceptedByNormalizer = normalizeTaskReport(
    { family: 'backlink/checker', taskId: 'before', page: 0, limit: 100 },
    advertised.reply(beforePage, 1),
  );
  expect(
    acceptedByNormalizer.reportKind === 'backlink' &&
      acceptedByNormalizer.lastPage,
  ).toBe(15);
  const maximumExpected = n2MaximumResult();
  expect(maximumExpected.rows).toHaveLength(1500);
  expect(
    compareReportsEnvelopeSchema.safeParse(independentEnvelope(maximumExpected))
      .success,
  ).toBe(true);
  const maximumEnvelopeBytes = bytes(independentEnvelope(maximumExpected));
  expect(maximumEnvelopeBytes).toBeLessThanOrEqual(2_097_152);
  const guard = installCompareDefaultDeny();
  const peers: Promise<void>[] = [],
    handlers: Promise<void>[] = [],
    errors: unknown[] = [];
  let arrivals = 0,
    peerCloses = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed: Promise<void> | undefined,
    released = false;
  const receiver = createServer((request, response) => {
    arrivals++;
    peers.push(
      new Promise<void>((resolve) =>
        response.once('close', () => {
          peerCloses++;
          resolve();
        }),
      ),
    );
    handlers.push(
      (async () => {
        let text = '';
        request.setEncoding('utf8');
        for await (const chunk of request) text += chunk;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v2/task/google/indexer/status');
        expect(request.headers.authorization).toBe(compareFixtureKey);
        expect(text).toBe('{"task_ids":["before","after"]}');
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        });
        response.end(compressed[0]);
      })().catch((reason: unknown) => {
        errors.push(reason);
        response.writeHead(500);
        response.end('{}');
      }),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', resolve);
    });
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing N2 preparation receiver.');
    const transport = createCompareFixtureFetch(
      `http://127.0.0.1:${address.port}`,
      input,
      genericSteps,
      guard.nativeFetch,
    );
    const init = {
      method: 'POST',
      redirect: 'error',
      signal: new AbortController().signal,
      headers: {
        Authorization: compareFixtureKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'speedyindex-mcp/0.1.0',
      },
      body: '{"task_ids":["before","after"]}',
    } satisfies RequestInit;
    await expect(
      transport.fetch(
        'https://api.speedyindex.com/v2/task/google/indexer/status?not-allowed=1',
        init,
      ),
    ).rejects.toThrow('Invalid compare fixture protocol.');
    expect(arrivals).toBe(0);
    expect(() =>
      transport.fetch.preconnect('https://api.speedyindex.com'),
    ).toThrow('Compare fixture preconnect denied.');
    const response = await transport.fetch(
      'https://api.speedyindex.com/v2/task/google/indexer/status',
      init,
    );
    if (!response.body) throw new Error('Missing native gzip body.');
    reader = response.body.getReader();
    closed = reader.closed;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      chunks.push(value.value);
    }
    await closed;
    const text = Buffer.concat(chunks).toString('utf8');
    expect<string | undefined>(text).toBe(replies[0]);
    expect(Buffer.byteLength(text, 'utf8')).toBe(301);
    reader.releaseLock();
    released = true;
    await Promise.all(handlers);
    await Promise.all(peers);
    expect(errors).toEqual([]);
    expect(arrivals).toBe(1);
    expect(peerCloses).toBe(1);
    expect(guard.calls()).toBe(0);
    console.info(
      'CR_N2_PREP ' +
        JSON.stringify({
          decoded,
          decodedTotal: 2141,
          gzipWireBytes: compressed.map((wire) => wire.byteLength),
          rawBacklink,
          maximumRaw,
          maximumEnvelopeBytes,
          completeRows: 1500,
          maximumPagesPerTask: 15,
          maxReadSchedule: 63,
          requestBytes: 41,
          envelopeE: 5196,
          nativeGzipRequests: 1,
          nativeClosed: true,
          released: true,
          peerClosesBeforeTeardown: 1,
        }),
    );
  } finally {
    if (reader && !released) {
      const cancelled = await Promise.allSettled([reader.cancel()]);
      if (closed) await Promise.allSettled([closed]);
      reader.releaseLock();
      console.info(
        'CR_N2_PREP_FAILURE_CLEANUP ' +
          JSON.stringify(cancelled.map(n2Outcome)),
      );
    }
    receiver.closeIdleConnections();
    const closure = await Promise.allSettled([
      new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
    guard.restore();
    expect(closure.every((outcome) => outcome.status === 'fulfilled')).toBe(
      true,
    );
  }
});

test('CR-ND-WRITE01 receipt faults preserve primary and complete owned cleanup offline', async () => {
  const deny = installCompareDefaultDeny();
  let cases = 0;
  try {
    const temporary = process.env.TMPDIR || '/tmp';
    for (const fault of [
      'before-teardown',
      'final',
      'both',
      'final-construction',
      'final-serialization',
    ] as const) {
      for (const hasPrimary of [true, false]) {
        const root = await mkdtemp(join(temporary, 'receipt-fault-'));
        const owned = join(root, 'owned');
        await mkdir(owned, { mode: 0o700 });
        const marker = join(owned, 'marker');
        await writeFile(marker, 'synthetic local cleanup resource', {
          mode: 0o600,
        });
        const primary = Object.freeze({ sentinel: 'P' });
        const beforeReason = new Error(
          'Synthetic before-teardown writer rejection.',
        );
        const finalReason = new Error('Synthetic final receipt rejection.');
        const failures: NDReceiptFailure[] = [];
        let reported: readonly NDReceiptFailure[] = [];
        const order: string[] = [];
        let published = false,
          didThrow = false,
          passed = false;
        let surfaced: unknown;
        try {
          try {
            await ndFinalizeReceipts({
              primary: hasPrimary ? { reason: primary } : undefined,
              failures,
              beforeTeardown() {
                order.push('build-before');
                return { preparation_only: true, receipt: 'before-teardown' };
              },
              async cleanup() {
                await rm(owned, { recursive: true });
                order.push('cleanup-complete');
              },
              finalReceipt() {
                order.push('build-final');
                if (fault === 'final-construction') throw finalReason;
                if (fault === 'final-serialization') {
                  const cyclic: Record<string, unknown> = {
                    preparation_only: true,
                  };
                  cyclic.self = cyclic;
                  return cyclic;
                }
                return { preparation_only: true, receipt: 'final' };
              },
              async write(phase, text) {
                order.push('write-' + phase);
                if (
                  phase === 'before-teardown' &&
                  (fault === phase || fault === 'both')
                )
                  throw beforeReason;
                if (phase === 'final' && (fault === phase || fault === 'both'))
                  throw finalReason;
                await writeFile(join(root, phase + '.json'), text, {
                  mode: 0o600,
                });
              },
              publish() {
                published = true;
              },
              verify() {
                order.push('verify');
              },
              report(observations) {
                reported = observations.map((observation) => ({
                  ...observation,
                }));
                order.push('report');
              },
            });
          } catch (reason) {
            didThrow = true;
            surfaced = reason;
          }
          expect(didThrow).toBe(true);
          if (hasPrimary) expect(surfaced).toBe(primary);
          else {
            expect(surfaced).toBeInstanceOf(AggregateError);
            if (!(surfaced instanceof AggregateError))
              throw new Error('Missing diagnostic harness failure.');
            expect(surfaced.message).toBe('N2 diagnostic finalization failed.');
            expect(surfaced.errors).toEqual(
              failures.map((failure) => failure.reason),
            );
            for (const [index, failure] of failures.entries())
              expect(surfaced.errors[index]).toBe(failure.reason);
          }
          expect(failures.map((failure) => failure.phase)).toEqual(
            fault === 'both'
              ? ['before-teardown', 'final']
              : [fault === 'before-teardown' ? fault : 'final'],
          );
          if (fault === 'before-teardown' || fault === 'both')
            expect(failures[0]?.reason).toBe(beforeReason);
          if (
            fault === 'final' ||
            fault === 'both' ||
            fault === 'final-construction'
          )
            expect(failures.at(-1)?.reason).toBe(finalReason);
          if (fault === 'final-serialization')
            expect(failures[0]?.reason).toBeInstanceOf(TypeError);
          expect(reported).toEqual(failures);
          expect(order).toEqual([
            'build-before',
            'write-before-teardown',
            'cleanup-complete',
            'build-final',
            ...(fault === 'final-construction' ||
            fault === 'final-serialization'
              ? []
              : ['write-final']),
            'verify',
            'report',
          ]);
          expect(published).toBe(fault === 'before-teardown');
          await expect(readFile(marker)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(deny.calls()).toBe(0);
          cases++;
          passed = true;
        } finally {
          if (passed) await rm(root, { recursive: true });
        }
      }
    }
    expect(cases).toBe(10);
    console.info(
      'CR_ND_WRITE01 ' +
        JSON.stringify({
          preparation_only: true,
          cases,
          nativeProof: 'NOT_EXECUTED',
          defaultDenyCalls: deny.calls(),
        }),
    );
  } finally {
    deny.restore();
  }
});

test('CR-ND-PREP saved-observation-schema-and-full-script', async () => {
  // Format samples only: no fetch, server, socket, client, owner, native promise
  // or product projector is executed. These records never establish native facts.
  const deny = installCompareDefaultDeny();
  try {
    const raw = Buffer.from(
      JSON.stringify(
        n2SavedScript(n2MaximumScript('CR-I05-pages63-full1500'), {
          result: n2MaximumResult(),
          reads: 63,
          progress: n2MaximumProgress,
        }),
      ),
      'utf8',
    );
    const fixtureHash = createHash('sha256').update(raw).digest('hex');
    expect(fixtureHash).toBe(
      '7e22ae9ba1e294886c4ddc8b10b546619ddba46955e6fe1586a648addde2751d',
    );
    const fixture: unknown = JSON.parse(raw.toString('utf8'));
    ndFreezeJSON(fixture);
    if (
      !n1Record(fixture) ||
      !Array.isArray(fixture.steps) ||
      !Array.isArray(fixture.responses) ||
      !n1Record(fixture.expected) ||
      !n1Record(fixture.expected.result)
    )
      throw new Error('Invalid frozen full-script fixture.');
    const steps: unknown[] = fixture.steps,
      responses: unknown[] = fixture.responses;
    const result = fixture.expected.result;
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(steps)).toBe(true);
    expect(steps).toHaveLength(63);
    expect(responses).toHaveLength(63);
    expect(fixture.input).toEqual({
      family: 'backlink/checker',
      beforeTaskId: 'before',
      afterTaskId: 'after',
    });
    expect(fixture.expected.reads).toBe(63);
    expect(result.status).toBe('compared');
    expect(Array.isArray(result.rows) && result.rows.length).toBe(1500);
    const complete = {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
    expect(Buffer.byteLength(JSON.stringify(complete), 'utf8')).toBe(894996);
    expect(steps[47]).toEqual({ kind: 'report', side: 'after', page: 0 });
    for (let page = 1; page <= 14; page++)
      expect(steps[47 + page]).toEqual({ kind: 'report', side: 'after', page });
    expect(steps[62]).toEqual({ kind: 'status' });
    let rawDonors = 0;
    for (let index = 0; index < 63; index++) {
      const response = responses[index];
      if (!n1Record(response)) throw new Error('Invalid saved response.');
      expect(response.code).toBe(0);
      if (index === 0 || index === 31 || index === 62) {
        expect(steps[index]).toEqual({ kind: 'status' });
        expect(Array.isArray(response.result)).toBe(true);
      } else {
        const passIndex = index < 31 ? index - 1 : index - 32;
        const side = passIndex < 15 ? 'before' : 'after',
          page = passIndex % 15;
        expect(steps[index]).toEqual({ kind: 'report', side, page });
        if (
          !n1Record(response.result) ||
          !Array.isArray(response.result.donors)
        )
          throw new Error('Invalid saved report response.');
        expect(response.result.id).toBe(side);
        expect(response.result.page).toBe(page);
        expect(response.result.last_page).toBe(14);
        expect(response.result.donors).toHaveLength(100);
        rawDonors += response.result.donors.length;
      }
    }
    expect(rawDonors).toBe(6000);
    const errors = ndErrors();
    let accessorReads = 0;
    const accessor: Record<string, unknown> = { code: 'SYNTHETIC' };
    Object.defineProperty(accessor, 'message', {
      get() {
        accessorReads++;
        throw new Error('Preparation getter must not execute.');
      },
    });
    const cyclic: Record<string, unknown> = {
      name: 'SyntheticError',
      message: 'preparation_only',
    };
    cyclic.cause = cyclic;
    const long = {
      message: 'é'.repeat(3000),
      authorization: 'PRIVATE_SYNTHETIC_VALUE_NOT_LOGGED',
    };
    const accessorImage = errors.snapshot(accessor),
      cyclicImage = errors.snapshot(cyclic),
      longImage = errors.snapshot(long);
    expect(accessorReads).toBe(0);
    expect(JSON.stringify(accessorImage)).toContain('accessor');
    expect(JSON.stringify(cyclicImage)).toContain('"cycle":true');
    expect(JSON.stringify(longImage)).toContain('"truncated":true');
    expect(JSON.stringify(longImage)).not.toContain(
      'PRIVATE_SYNTHETIC_VALUE_NOT_LOGGED',
    );
    const longFields = longImage.fields;
    if (
      !n1Record(longFields) ||
      !n1Record(longFields.message) ||
      typeof longFields.message.value !== 'string'
    )
      throw new Error('Invalid bounded metadata image.');
    expect(Buffer.byteLength(longFields.message.value, 'utf8')).toBe(4096);
    const cases: readonly {
      id: string;
      kinds: readonly string[];
      aborted: readonly boolean[];
      error: unknown;
    }[] = [
      {
        id: 'raw-reject',
        kinds: ['native-enter', 'native-rejected'],
        aborted: [false, false],
        error: { name: 'SyntheticNative', code: 'SYNTHETIC' },
      },
      {
        id: 'guard-reject-no-native-entry',
        kinds: ['transport-enter', 'transport-rejected'],
        aborted: [false, false],
        error: { message: 'synthetic guard rejection' },
      },
      {
        id: 'native-fulfilled-delegate-fail',
        kinds: [
          'native-enter',
          'native-fulfilled',
          'delegate-enter',
          'delegate-rejected',
        ],
        aborted: [false, false, false, false],
        error: { message: 'synthetic delegate rejection' },
      },
      {
        id: 'abort-before-reject',
        kinds: ['signal-abort', 'native-rejected'],
        aborted: [true, true],
        error: { message: 'synthetic order only' },
      },
      {
        id: 'abort-after-reject',
        kinds: ['native-rejected', 'signal-abort'],
        aborted: [false, true],
        error: { message: 'synthetic order only' },
      },
      {
        id: 'cyclic',
        kinds: ['native-rejected'],
        aborted: [false],
        error: cyclic,
      },
      {
        id: 'accessor',
        kinds: ['native-rejected'],
        aborted: [false],
        error: accessor,
      },
      {
        id: 'unknown',
        kinds: ['native-rejected'],
        aborted: [false],
        error: Symbol('synthetic'),
      },
      {
        id: 'pending-peer',
        kinds: ['pre-explicit-teardown'],
        aborted: [false],
        error: undefined,
      },
    ];
    const samples = cases.map((sample) => ({
      preparation_only: true,
      synthetic: true,
      nativeProof: 'NOT_EXECUTED',
      id: sample.id,
      events: sample.kinds.map((kind, index) => ({
        sequence: index + 1,
        kind,
        signalAborted: sample.aborted[index],
      })),
      error: errors.snapshot(sample.error),
      diagnosticWitness: ndPeerWitness(2, 1),
    }));
    for (const sample of samples) {
      expect(ndPreparationSchema(sample)).toBe(true);
      expect(ndPreparationSchema(JSON.parse(JSON.stringify(sample)))).toBe(
        true,
      );
      expect(ndPreparationSchema({ ...sample, synthetic: false })).toBe(false);
      expect(sample.diagnosticWitness).toEqual({
        source: 'pre_explicit_teardown_callback_snapshot',
        arrivals: 2,
        callbacks: 1,
        allCallbacksObserved: false,
        pending: 1,
        establishesOriginalSuccess: false,
      });
    }
    expect(accessorReads).toBe(0);
    expect(errors.overflow()).toBe(0);
    const ownSource = await readFile(import.meta.path, 'utf8');
    const begin = ownSource.indexOf('const observedNativeFetch: typeof fetch');
    const end = ownSource.indexOf(
      'const transport = createCompareFixtureFetch',
      begin,
    );
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const forwarding = ownSource.slice(begin, end);
    expect(forwarding).toContain(
      'Reflect.apply(originalNativeFetch, this, args)',
    );
    expect(forwarding).toContain('return original;');
    expect(forwarding).not.toContain('async');
    expect(forwarding).not.toContain('await');
    expect(forwarding).not.toContain('.bind(');
    const helper = await readFile(
      new URL('./fixtures/compare-reports-native.ts', import.meta.url),
    );
    expect(createHash('sha256').update(helper).digest('hex')).toBe(
      '7985cc007f20d7a3b1274fa9590043295d830028df65ff71320c04dfb5862acc',
    );
    expect(helper.toString('utf8')).toContain(
      'return nativeFetch(new URL(path, loopback), init);',
    );
    expect(deny.calls()).toBe(0);
    console.info(
      'CR_ND_PREP ' +
        JSON.stringify({
          preparation_only: true,
          synthetic: true,
          nativeProof: 'NOT_EXECUTED',
          fixtureHash,
          steps: 63,
          responses: 63,
          rawDonorVisits: 6000,
          resultRows: 1500,
          completeEnvelopeBytes: 894996,
          formatCases: samples.length,
          accessorReads,
          defaultDenyCalls: deny.calls(),
          sourceForwarding:
            'same receiver/args/init/signal/original promise return inspected; NOT runtime identity proof',
          socketAndServerDefaults: 'UNKNOWN_NOT_EXECUTED',
          nativeInvocations: 0,
        }),
    );
  } finally {
    deny.restore();
  }
});

test('CR-N27 immutable keyless and whitespace clients return the fixed MissingCredentials envelope twice with zero HTTP', async () => {
  const fixed = {
    status: 'error',
    error: {
      code: 'MissingCredentials',
      message: 'Report comparison requires configured credentials.',
    },
  } as const;
  const expected = {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(fixed) }],
    structuredContent: fixed,
  };
  for (const key of [undefined, '   '] as const) {
    let attempts = 0;
    const denied: typeof fetch = Object.assign(
      async () => {
        attempts++;
        throw new Error('Comparison credential fixture denied network.');
      },
      {
        preconnect: () => {
          attempts++;
          throw new Error('Comparison credential fixture denied network.');
        },
      },
    );
    const client = new SpeedyIndexClient(key, denied);
    const owner = createCompareReportsOwner(client);
    for (let call = 0; call < 2; call++) {
      const result = await owner.compare({
        family: 'google/indexer',
        beforeTaskId: 'keyless-before',
        afterTaskId: 'keyless-after',
      });
      expect(result).toEqual(expected);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(fixed);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toBe(JSON.stringify(fixed));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.structuredContent)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('keyless-before');
      expect(JSON.stringify(result)).not.toContain('SpeedyIndex');
    }
    expect(attempts).toBe(0);
  }
});
