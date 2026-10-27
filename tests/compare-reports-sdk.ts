import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { ReadBuffer, type Client } from '@modelcontextprotocol/client';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import { compareReportsEnvelopeSchema } from '../src/compare-reports';
import {
  bounded,
  connect,
  connectOwnedStdio,
  deferred,
  dummyKey,
  fixture,
} from './helpers';
import {
  ComparePhaseDecoder,
  COMPARE_PROTOCOL_ERROR,
  type ComparePhase,
} from './fixtures/compare-reports-sdk-protocol';

type Entry = 'src/cli.ts' | 'dist/cli.js';
export const compareReportsFiniteCases = ['A', 'B', 'C', 'D', 'E'] as const;
type Finite = (typeof compareReportsFiniteCases)[number];
type Kind = 'generic' | 'backlink' | 'schema' | 'cancel' | Finite;
const input = {
  family: 'google/indexer',
  beforeTaskId: ' caller-before ',
  afterTaskId: 'caller-after',
};
const backlinkInput = {
  family: 'backlink/checker',
  beforeTaskId: 'backlink-before',
  afterTaskId: 'backlink-after',
};
const A = 'https://SDK.test/A?b=2&a=1#exact',
  B = 'https://sdk.test/b',
  C = 'https://sdk.test/c',
  D = 'https://sdk.test/d',
  E = 'https://sdk.test/e';
const targets = ['Target.EXAMPLE', ' target text ', 'Target.EXAMPLE'];
const donorA = 'https://donor.test/A',
  donorB = 'https://donor.test/B',
  donorC = 'https://donor.test/C';
const targetUrl = 'https://target.test/Common?Case=1';
const targetLink = { url: targetUrl, anchor: ' exact é ', nofollow: false };
const scope = {
  basis: 'observed_union',
  direction: 'caller_selected',
  observations: 'non_atomic_provider_reports',
  originalCorpusEquality: 'unknown',
  originalHistory: 'unknown',
  liveState: 'not_observed',
};
const absent = {
  status: null,
  checkAfter: null,
  awaitingResult: null,
  dripFeed: null,
  days: null,
  daysPassed: null,
  isStopped: null,
};
function genericExpected() {
  // Full independent literals; no production projector/result/owner creates an oracle.
  const status = (id: string, date: string) => ({
    id,
    type: 'google/indexer',
    size: 4,
    processedCount: 4,
    indexedCount: 2,
    isCompleted: true,
    ...absent,
    targetDomains: null,
    providerCreatedAt: date,
  });
  const report = (date: string) => ({
    size: 4,
    processedCount: 4,
    indexedCount: 2,
    isCompleted: true,
    ...absent,
    type: 'google/indexer',
    providerCreatedAt: date,
  });
  const coverage = {
    observedIndexedCount: 2,
    observedUnindexedCount: 2,
    observedUniqueUrlCount: 4,
    indexedDuplicateCount: 0,
    unindexedDuplicateCount: 0,
    conflictingUrlCount: 0,
    reportedSlotGap: 0,
    indexedEnumerationGap: 0,
  };
  return {
    status: 'compared',
    reportKind: 'links',
    family: 'google/indexer',
    beforeTaskId: ' caller-before ',
    afterTaskId: 'caller-after',
    scope,
    before: {
      status: status(' caller-before ', '2030-12-31T23:59:59Z'),
      report: report(' raw-before "é" '),
      settled: true,
      coverage: { ...coverage, unindexedDuplicateCount: 1 },
    },
    after: {
      status: status('caller-after', '2000-01-01T00:00:00Z'),
      report: report('report-after ☃'),
      settled: true,
      coverage,
    },
    rows: [
      {
        url: A,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'reported_indexed_to_unindexed',
      },
      {
        url: C,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'indexed', membership: 'indexed' },
        change: 'unchanged_indexed',
      },
      {
        url: B,
        before: { state: 'unindexed', membership: 'unindexed' },
        after: { state: 'indexed', membership: 'indexed' },
        change: 'reported_unindexed_to_indexed',
      },
      {
        url: D,
        before: { state: 'unindexed', membership: 'unindexed' },
        after: {
          state: 'unknown',
          membership: 'omitted',
          reason: 'not_reported',
        },
        change: 'unknown',
      },
      {
        url: E,
        before: {
          state: 'unknown',
          membership: 'omitted',
          reason: 'not_reported',
        },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'unknown',
      },
    ],
    counts: {
      reportedUnindexedToIndexed: 1,
      reportedIndexedToUnindexed: 1,
      unchangedIndexed: 1,
      unchangedUnindexed: 0,
      unknown: 2,
      total: 5,
    },
  };
}
function backlinkExpected() {
  const status = (id: string, date: string) => ({
    id,
    type: 'backlink/checker',
    size: 2,
    processedCount: 2,
    indexedCount: null,
    isCompleted: true,
    ...absent,
    targetDomains: targets,
    providerCreatedAt: date,
  });
  const coverage = {
    rawDonorCount: 2,
    observedUniqueDonorCount: 2,
    duplicateDonorCount: 0,
    conflictingDonorCount: 0,
    rawTargetLinkCount: 2,
    duplicateTargetLinkCount: 0,
    reportedSlotGap: 0,
  };
  return {
    status: 'compared',
    reportKind: 'backlink',
    family: 'backlink/checker',
    beforeTaskId: 'backlink-before',
    afterTaskId: 'backlink-after',
    scope,
    targetScope: {
      provenance: 'matching_current_provider_status',
      targetDomains: targets,
      originalTargets: 'unknown',
    },
    before: {
      status: status('backlink-before', 'backlink-status-before'),
      report: {
        size: 2,
        processedCount: 2,
        isCompleted: true,
        lastPage: 2,
        pagesVisited: 3,
      },
      coverage,
    },
    after: {
      status: status('backlink-after', 'backlink-status-after'),
      report: {
        size: 2,
        processedCount: 2,
        isCompleted: true,
        lastPage: 1,
        pagesVisited: 2,
      },
      coverage,
    },
    rows: [
      {
        donorUrl: donorA,
        before: { state: 'reported', targetLinks: [targetLink] },
        after: { state: 'reported', targetLinks: [targetLink] },
        comparison: {
          state: 'compared',
          newlyReportedTargetUrls: [],
          noLongerReportedTargetUrls: [],
          attributeChangedTargetUrls: [],
          unchangedTargetUrls: [targetUrl],
        },
      },
      {
        donorUrl: donorB,
        before: { state: 'reported', targetLinks: [targetLink] },
        after: { state: 'unknown', reason: 'not_reported' },
        comparison: { state: 'unknown' },
      },
      {
        donorUrl: donorC,
        before: { state: 'unknown', reason: 'not_reported' },
        after: { state: 'reported', targetLinks: [targetLink] },
        comparison: { state: 'unknown' },
      },
    ],
    counts: {
      comparedDonors: 1,
      unknownDonors: 2,
      totalDonors: 3,
      newlyReportedTargetUrls: 0,
      noLongerReportedTargetUrls: 0,
      attributeChangedTargetUrls: 0,
      unchangedTargetUrls: 1,
    },
  };
}
function application(actual: unknown, data: unknown, isError: boolean) {
  compareReportsEnvelopeSchema.parse(actual);
  assert.deepEqual(actual, {
    isError,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const encoded = JSON.stringify(actual);
  assert(Buffer.byteLength(encoded) <= 2_097_152);
  for (const privateValue of [dummyKey, 'SENTINEL_PRIVATE_PROVIDER_BODY'])
    assert(!encoded.includes(privateValue));
}
function fixed(kind: Finite) {
  if (kind === 'A')
    return {
      status: 'error',
      error: {
        code: 'MissingCredentials',
        message: 'Report comparison requires configured credentials.',
      },
    };
  if (kind === 'B')
    return {
      status: 'blocked',
      blocker: {
        code: 'StatusUnavailable',
        message: 'A required task status was not returned.',
      },
    };
  if (kind === 'C' || kind === 'D')
    return {
      status: 'blocked',
      blocker: {
        code: 'EvidenceChanged',
        message: 'Required evidence changed between observations.',
      },
    };
  return {
    status: 'error',
    error: {
      code: 'ReadFailed',
      message: 'A required provider read failed.',
      phase: 'report',
      cause: 'http',
    },
  };
}
type Step =
  | { kind: 'status' }
  | { kind: 'report'; side: 'before' | 'after'; page?: number };
const genericSteps: Step[] = [
  { kind: 'status' },
  { kind: 'report', side: 'before' },
  { kind: 'report', side: 'after' },
  { kind: 'status' },
  { kind: 'report', side: 'before' },
  { kind: 'report', side: 'after' },
  { kind: 'status' },
];
const backlinkSteps: Step[] = [
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
];
function genericWire(step: Step) {
  const common = {
    size: 4,
    processed_count: 4,
    indexed_count: 2,
    is_completed: true,
    type: 'google/indexer',
  };
  return {
    code: 0,
    result:
      step.kind === 'status'
        ? [
            {
              id: ' caller-before ',
              ...common,
              created_at: '2030-12-31T23:59:59Z',
            },
            {
              id: 'caller-after',
              ...common,
              created_at: '2000-01-01T00:00:00Z',
            },
          ]
        : {
            id: step.side === 'before' ? ' caller-before ' : 'caller-after',
            ...common,
            title: 'SDK fixture',
            created_at:
              step.side === 'before' ? ' raw-before "é" ' : 'report-after ☃',
            indexed_links: step.side === 'before' ? [A, C] : [B, C],
            unindexed_links: step.side === 'before' ? [B, D, B] : [A, E],
          },
  };
}
function backlinkWire(step: Step) {
  const common = { size: 2, processed_count: 2, is_completed: true };
  if (step.kind === 'status')
    return {
      code: 0,
      result: [
        {
          id: 'backlink-before',
          type: 'backlink/checker',
          ...common,
          target_domains: targets,
          created_at: 'backlink-status-before',
        },
        {
          id: 'backlink-after',
          type: 'backlink/checker',
          ...common,
          target_domains: targets,
          created_at: 'backlink-status-after',
        },
      ],
    };
  const donors =
    step.side === 'before'
      ? step.page === 0
        ? [donorA]
        : step.page === 1
          ? []
          : [donorB]
      : step.page === 0
        ? [donorA]
        : [donorC];
  return {
    code: 0,
    result: {
      id: step.side === 'before' ? 'backlink-before' : 'backlink-after',
      ...common,
      page: step.page,
      last_page: step.side === 'before' ? 2 : 1,
      donors: donors.map((donor_url) => ({
        donor_url,
        processed: true,
        target_links: [targetLink],
      })),
      created_at: 'ignored-backlink-report-date',
    },
  };
}
async function receiver(kind: Kind) {
  const errors: unknown[] = [],
    closed: Promise<void>[] = [];
  const arrivals: { path: string; body: string }[] = [];
  const first = deferred<void>(),
    peer = deferred<void>();
  let peerAborted = false;
  const api = await fixture((request, response) => {
    const index = arrivals.length;
    const arrival = { path: request.url ?? '', body: '' };
    arrivals.push(arrival);
    closed.push(
      new Promise((resolve) =>
        response.once('close', () => {
          if (kind === 'cancel' && index === 0) {
            peerAborted = !response.writableEnded;
            peer.resolve();
          }
          resolve();
        }),
      ),
    );
    void (async () => {
      request.setEncoding('utf8');
      for await (const part of request) arrival.body += String(part);
      assert(Buffer.byteLength(arrival.body) <= 65_536);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, dummyKey);
      assert.equal(request.headers.accept, 'application/json');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.headers['user-agent'], 'speedyindex-mcp/0.1.0');
      let position = index;
      if (kind === 'E' && index >= 2) position = index - 2;
      if (kind === 'cancel' && index >= 1) position = index - 1;
      const step = (kind === 'backlink' ? backlinkSteps : genericSteps)[
        position
      ];
      assert(step, 'Unexpected provider request');
      const selected = kind === 'backlink' ? backlinkInput : input;
      assert.equal(request.url, `/v2/task/${selected.family}/${step.kind}`);
      const body =
        step.kind === 'status'
          ? { task_ids: [selected.beforeTaskId, selected.afterTaskId] }
          : {
              task_id:
                step.side === 'before'
                  ? selected.beforeTaskId
                  : selected.afterTaskId,
              ...(kind === 'backlink' ? { page: step.page, limit: 100 } : {}),
            };
      assert.equal(arrival.body, JSON.stringify(body));
      if (kind === 'cancel' && index === 0) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"code":0,"result":[');
        first.resolve();
        return;
      }
      if (kind === 'E' && index === 1) {
        response.writeHead(502, { 'Content-Type': 'text/plain' });
        response.end('SENTINEL_PRIVATE_PROVIDER_BODY');
        return;
      }
      let payload: unknown =
        kind === 'backlink' ? backlinkWire(step) : genericWire(step);
      if (kind === 'B' && index === 0) {
        const normal = genericWire({ kind: 'status' }).result;
        assert(Array.isArray(normal));
        payload = { code: 0, result: normal.slice(1) };
      }
      if (kind === 'C' && index === 3) {
        const normal = genericWire({ kind: 'status' }).result;
        assert(Array.isArray(normal));
        payload = {
          code: 0,
          result: normal.map((v, n) =>
            n === 0 ? { ...v, created_at: 'changed-status-date' } : v,
          ),
        };
      }
      if (kind === 'D' && index === 4) {
        const normal = genericWire({ kind: 'report', side: 'before' }).result;
        assert(!Array.isArray(normal));
        payload = {
          code: 0,
          result: { ...normal, created_at: 'changed-report-date' },
        };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    })().catch((e) => {
      errors.push(e);
      if (!response.headersSent) response.writeHead(500);
      response.end('fixture failure');
    });
  });
  return {
    ...api,
    arrivals,
    first: first.promise,
    peer: peer.promise,
    peerAborted: () => peerAborted,
    async receipts(expected: number) {
      assert.equal(arrivals.length, expected);
      await bounded(Promise.all(closed));
      assert.deepEqual(errors, []);
    },
  };
}
type Schema = {
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  enum?: unknown[];
  const?: unknown;
  type?: unknown;
  [key: string]: unknown;
};
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function schemas(value: unknown): Schema[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(schemas);
  return [value as Schema, ...Object.values(value).flatMap(schemas)];
}
function advertised(tools: Awaited<ReturnType<Client['listTools']>>['tools']) {
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
      'create_indexing_task',
      'create_index_check',
      'create_backlink_check',
      'plan_retry',
      'get_retry_history',
      'compare_reports',
    ],
  );
  const tool = tools[9]!;
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  const input = tool.inputSchema as Schema;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual([...(input.required ?? [])].sort(), [
    'afterTaskId',
    'beforeTaskId',
    'family',
  ]);
  assert.deepEqual(Object.keys(input.properties ?? {}).sort(), [
    'afterTaskId',
    'beforeTaskId',
    'family',
  ]);
  assert.deepEqual(input.properties?.family?.enum, [
    'google/indexer',
    'google/checker',
    'yandex/indexer',
    'yandex/checker',
    'bing/checker',
    'backlink/checker',
  ]);
  const branches = schemas(tool.outputSchema).filter(
    (s) => s.properties?.status?.const !== undefined,
  );
  assert.equal(branches.length, 4);
  for (const status of ['compared', 'blocked', 'error'])
    assert(branches.some((s) => s.properties?.status?.const === status));
  for (const branch of branches.filter(
    (s) => s.properties?.status?.const === 'compared',
  ))
    for (const side of ['before', 'after']) {
      const summary = branch.properties?.[side];
      assert(summary);
      const status = summary.properties?.status;
      assert(status);
      assert(status?.required?.includes('providerCreatedAt'));
      assert(
        schemas(status.properties?.providerCreatedAt).some(
          (s) =>
            s.type === 'null' ||
            (Array.isArray(s.type) && s.type.includes('null')),
        ),
      );
      const report = summary.properties?.report;
      assert(report);
      assert.equal(report.additionalProperties, false);
      if (branch.properties?.reportKind?.const === 'links') {
        assert(report.required?.includes('providerCreatedAt'));
        assert(
          schemas(report.properties?.providerCreatedAt).some(
            (s) =>
              s.type === 'null' ||
              (Array.isArray(s.type) && s.type.includes('null')),
          ),
        );
      } else {
        assert(!Object.hasOwn(report.properties ?? {}, 'providerCreatedAt'));
        assert.deepEqual(Object.keys(report.properties ?? {}).sort(), [
          'isCompleted',
          'lastPage',
          'pagesVisited',
          'processedCount',
          'size',
        ]);
      }
    }
}
const invalidInputs: readonly [string, unknown][] = [
  ['extra', { ...input, limits: { maxReads: 1 } }],
  ['family', { ...input, family: 'unknown/checker' }],
  ['missing', { family: input.family, beforeTaskId: input.beforeTaskId }],
  ['type', { ...input, beforeTaskId: 7 }],
  ['blank', { ...input, beforeTaskId: '   ' }],
  ['control', { ...input, beforeTaskId: 'bad\u0001id' }],
  ['surrogate', { ...input, beforeTaskId: '\ud800' }],
  ['utf8', { ...input, beforeTaskId: 'é'.repeat(2049) }],
  ['same', { ...input, afterTaskId: input.beforeTaskId }],
];
async function rejected(client: Client) {
  for (const [arm, arguments_] of invalidInputs) {
    const actual = await bounded(
      client.callTool({
        name: 'compare_reports',
        arguments: arguments_ as Record<string, unknown>,
      }),
    );
    assert.equal(actual.isError, true, arm);
    assert.equal(actual.structuredContent, undefined, arm);
    assert.match(
      JSON.stringify(actual.content),
      /Input validation error: Invalid arguments for tool compare_reports/,
      arm,
    );
  }
}
function root() {
  const p = mkdtempSync(join(realpathSync('/tmp'), 'crsdk-'));
  assert.equal(lstatSync(p).mode & 0o777, 0o700);
  return p;
}
function record(root: string, name: string, value: unknown) {
  writeFileSync(
    join(root, name + '.json'),
    JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
}
async function normal(
  entry: Entry,
  kind: Exclude<Kind, 'cancel'>,
  run: (
    client: Client,
    api: Awaited<ReturnType<typeof receiver>>,
  ) => Promise<void>,
) {
  const owned = root(),
    closes: (() => Promise<void>)[] = [],
    errors: unknown[] = [];
  let api: Awaited<ReturnType<typeof receiver>> | undefined;
  try {
    api = await receiver(kind);
    const session = await connect(
      api.origin,
      entry,
      kind === 'A' ? '' : dummyKey,
      '',
      { register: (close) => closes.push(close) },
    );
    await run(session.client, api);
    assert.equal(session.stderr(), '');
  } catch (e) {
    errors.push(e);
  } finally {
    const results = await Promise.allSettled(closes.map((close) => close()));
    for (const r of results) if (r.status === 'rejected') errors.push(r.reason);
    if (api) {
      try {
        await api.close();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length)
      record(owned, 'failure', {
        errors: errors.map(String),
        arrivals: api?.arrivals,
      });
    else rmSync(owned, { recursive: true });
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Comparison SDK ${entry}/${kind}; retained ${owned}`,
    );
}
export async function verifyCompareReportsSdk(
  entry: Entry,
  kind: 'generic' | 'backlink',
) {
  await normal(entry, kind, async (client, api) => {
    const actual = await bounded(
      client.callTool({
        name: 'compare_reports',
        arguments: kind === 'backlink' ? backlinkInput : input,
      }),
    );
    application(
      actual,
      kind === 'backlink' ? backlinkExpected() : genericExpected(),
      false,
    );
    await api.receipts(kind === 'backlink' ? 13 : 7);
  });
}
export async function verifyCompareReportsFiniteSdk(
  entry: Entry,
  kind: Finite,
) {
  await normal(entry, kind, async (client, api) => {
    const actual = await bounded(
      client.callTool({ name: 'compare_reports', arguments: input }),
    );
    application(actual, fixed(kind), kind === 'A' || kind === 'E');
    if (kind === 'E') {
      assert.equal(api.arrivals.length, 2);
      application(
        await bounded(
          client.callTool({ name: 'compare_reports', arguments: input }),
        ),
        genericExpected(),
        false,
      );
    }
    await api.receipts({ A: 0, B: 1, C: 4, D: 5, E: 9 }[kind]);
  });
}

/** Audits every raw line independently of the SDK decoder, including the EOF tail. */
class StdoutAudit {
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;
  private count = 0;
  private ended = false;
  push(chunk: Uint8Array) {
    assert(!this.ended, COMPARE_PROTOCOL_ERROR);
    this.total += chunk.byteLength;
    assert(this.total <= 8 * 1024 * 1024);
    const bytes = Buffer.concat([this.tail, chunk]),
      messages: unknown[] = [];
    let start = 0;
    for (
      let end = bytes.indexOf(10);
      end !== -1;
      end = bytes.indexOf(10, start)
    ) {
      assert(end - start <= 4 * 1024 * 1024);
      assert(++this.count <= 128);
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(start, end));
      const value: unknown = JSON.parse(text);
      JSONRPCMessageSchema.parse(value);
      messages.push(value);
      start = end + 1;
    }
    this.tail = Buffer.from(bytes.subarray(start));
    assert(this.tail.length <= 4 * 1024 * 1024);
    return messages;
  }
  finish() {
    assert(!this.ended);
    assert.equal(
      this.tail.length,
      0,
      'Incomplete comparison JSON-RPC EOF tail',
    );
    this.ended = true;
    return { bytes: this.total, frames: this.count, tailBytes: 0 };
  }
}
type OwnedChild = Parameters<Parameters<typeof connectOwnedStdio>[2]>[0];
type PipeReceipt = {
  eof: boolean;
  closed: 'pending' | 'fulfilled' | 'rejected';
  released: boolean;
};
async function observed(
  kind: 'schema' | 'cancel',
  run: (h: {
    client: Client;
    phase: ComparePhaseDecoder;
    barrier: () => Promise<Extract<ComparePhase, { event: 'BARRIER' }>>;
    release: () => Promise<void>;
    sent: { method: unknown; id: unknown; params: unknown; flushed: boolean }[];
    cancelledFlush: Promise<Record<string, unknown>>;
    api: Awaited<ReturnType<typeof receiver>>;
  }) => Promise<void>,
) {
  const owned = root(),
    home = join(owned, 'home');
  mkdirSync(home, { mode: 0o700 });
  const errors: unknown[] = [],
    observations: Promise<unknown>[] = [],
    closes: (() => Promise<void>)[] = [];
  const phase = new ComparePhaseDecoder(),
    audit = new StdoutAudit(),
    sdk = new ReadBuffer(),
    wire: unknown[] = [];
  const pipes: { stdout: PipeReceipt; stderr: PipeReceipt } = {
    stdout: { eof: false, closed: 'pending', released: false },
    stderr: { eof: false, closed: 'pending', released: false },
  };
  const sent: {
    method: unknown;
    id: unknown;
    params: unknown;
    flushed: boolean;
  }[] = [];
  const flushed = deferred<Record<string, unknown>>();
  let child: OwnedChild | undefined,
    api: Awaited<ReturnType<typeof receiver>> | undefined,
    socket: Socket | undefined,
    socketClosed: Promise<void> | undefined;
  let frameEOF: unknown,
    sequence = 0,
    released = false;
  function watch(
    stream: ReadableStream<Uint8Array>,
    kind: 'stdout' | 'stderr',
  ) {
    const getReader = stream.getReader.bind(stream);
    Object.defineProperty(stream, 'getReader', {
      configurable: true,
      value: () => {
        const reader = getReader();
        const read = reader.read.bind(reader),
          release = reader.releaseLock.bind(reader);
        observations.push(
          reader.closed.then(
            () => {
              pipes[kind].closed = 'fulfilled';
            },
            () => {
              pipes[kind].closed = 'rejected';
            },
          ),
        );
        return new Proxy(reader, {
          get(target, field) {
            if (field === 'read')
              return () =>
                read().then((part) => {
                  if (part.done) {
                    pipes[kind].eof = true;
                    if (kind === 'stdout') frameEOF = audit.finish();
                    else phase.finish();
                  } else if (kind === 'stderr') phase.push(part.value);
                  return part;
                });
            if (field === 'releaseLock')
              return () => {
                release();
                pipes[kind].released = true;
              };
            const v = Reflect.get(target, field, target) as unknown;
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    });
  }
  async function command(value: unknown) {
    assert(socket && !socket.destroyed);
    await bounded(
      new Promise<void>((resolve, reject) =>
        socket!.write(JSON.stringify(value) + '\n', (e) =>
          e ? reject(e) : resolve(),
        ),
      ),
    );
  }
  try {
    api = await receiver(kind);
    const session = await connectOwnedStdio(
      [
        'tests/fixtures/compare-reports-sdk-child.ts',
        kind === 'schema' ? 'observe' : 'cancel',
        owned,
      ],
      {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
        HOME: home,
        TMPDIR: home,
        TZ: 'UTC',
        SPEEDYINDEX_API_KEY: dummyKey,
        TEST_ACCOUNT_ORIGIN: api.origin,
      },
      (nativeChild) => {
        child = nativeChild;
        watch(nativeChild.stdout, 'stdout');
        watch(nativeChild.stderr, 'stderr');
      },
      {
        register: (close) => closes.push(close),
        onStdout(bytes) {
          const raw = audit.push(bytes);
          sdk.append(Buffer.from(bytes));
          let message = sdk.readMessage();
          while (message !== null) {
            JSONRPCMessageSchema.parse(message);
            assert.deepEqual(message, raw.shift());
            wire.push(message);
            message = sdk.readMessage();
          }
          assert.equal(raw.length, 0);
        },
      },
    );
    const send = session.transport.send.bind(session.transport);
    session.transport.send = async (message) => {
      const raw = object(message),
        receipt = {
          method: raw.method,
          id: raw.id,
          params: raw.params,
          flushed: false,
        };
      sent.push(receipt);
      await send(message);
      receipt.flushed = true;
      if (raw.method === 'notifications/cancelled')
        flushed.resolve(object(raw.params));
    };
    await phase.waitFor({ event: 'BOOT_READY' });
    const path = join(owned, 'compare.sock'),
      inode = lstatSync(path);
    assert(inode.isSocket());
    assert.equal(inode.uid, process.getuid?.());
    assert.equal(inode.mode & 0o777, 0o600);
    socket = createConnection(path);
    socketClosed = new Promise((resolve) =>
      socket!.once('close', () => resolve()),
    );
    socket.on('error', (e) => errors.push(e));
    await bounded(once(socket, 'connect'));
    async function barrier() {
      await command({ event: 'BARRIER', sequence: ++sequence });
      const p = await phase.waitFor({ event: 'BARRIER', sequence });
      assert.equal(p.event, 'BARRIER');
      return p as Extract<ComparePhase, { event: 'BARRIER' }>;
    }
    await run({
      client: session.client,
      phase,
      barrier,
      async release() {
        assert(!released);
        released = true;
        await command({ event: 'RELEASE_CANCEL', operation: 1 });
      },
      sent,
      cancelledFlush: flushed.promise,
      api,
    });
    assert(
      !phase.events.some(
        (p) => p.event === 'FIXTURE_ERROR' || p.event === 'PROTOCOL_ERROR',
      ),
    );
  } catch (e) {
    errors.push(e);
  } finally {
    socket?.end();
    const results = await Promise.allSettled(closes.map((close) => close()));
    for (const r of results) if (r.status === 'rejected') errors.push(r.reason);
    if (socketClosed) {
      try {
        await bounded(socketClosed);
      } catch (e) {
        errors.push(e);
        socket?.destroy();
      }
    }
    const settled = await Promise.allSettled(observations);
    for (const r of settled) if (r.status === 'rejected') errors.push(r.reason);
    if (child) {
      try {
        assert.equal(await bounded(child.exited), 0);
        assert.equal(child.signalCode, null);
        for (const p of Object.values(pipes))
          assert.deepEqual(p, {
            eof: true,
            closed: 'fulfilled',
            released: true,
          });
        assert(frameEOF);
        assert.equal(sdk.readMessage(), null);
        assert(!existsSync(join(owned, 'compare.sock')));
      } catch (e) {
        errors.push(e);
      }
    }
    if (api) {
      try {
        await api.close();
      } catch (e) {
        errors.push(e);
      }
    }
    const resources = {
      pipes,
      frameEOF,
      childPid: child?.pid,
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      wire,
      sent,
      phases: phase.events,
      arrivals: api?.arrivals,
      errors: errors.map(String),
    };
    record(owned, 'resources', resources);
    if (kind === 'cancel')
      writeFileSync(
        2,
        `COMPARE_CANCEL_RESOURCE_RECEIPT ${JSON.stringify({
          kind,
          ownedRoot: owned,
          resources,
        })}\n`,
      );
    if (!errors.length) rmSync(owned, { recursive: true });
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Comparison observed SDK ${kind}; retained ${owned}`,
    );
}
export async function verifyCompareReportsSchemaSdk(entry: Entry) {
  if (entry === 'dist/cli.js')
    return normal(entry, 'schema', async (client, api) => {
      advertised((await bounded(client.listTools())).tools);
      await rejected(client);
      await api.receipts(0);
    });
  await observed('schema', async (h) => {
    advertised((await bounded(h.client.listTools())).tools);
    const before = await h.barrier();
    await rejected(h.client);
    const after = await h.barrier();
    for (const field of [
      'handlers',
      'readsEntered',
      'readsSettled',
      'cancelsSettled',
      'releases',
      'clientsSettled',
      'closes',
      'ownersSettled',
      'httpAttempts',
    ] as const) {
      assert.equal(before[field], 0);
      assert.equal(after[field], 0);
    }
    assert.equal(
      h.sent.filter((p) => p.method === 'tools/call' && p.flushed).length,
      9,
    );
    await h.api.receipts(0);
  });
}
export async function verifyCompareReportsCancellationSdk() {
  await observed('cancel', async (h) => {
    const controller = new AbortController();
    const call = h.client
      .callTool(
        { name: 'compare_reports', arguments: input },
        { signal: controller.signal },
      )
      .then(
        (value) => ({ state: 'resolved' as const, value }),
        (error) => ({ state: 'rejected' as const, error: error as unknown }),
      );
    await bounded(h.api.first);
    await h.phase.waitFor({ event: 'READ_PENDING', operation: 1 });
    const pending = await h.barrier();
    assert(pending.readsEntered > pending.readsSettled);
    assert.equal(pending.handlers, 1);
    assert.equal(pending.httpAttempts, 1);
    assert.equal(pending.ownersSettled, 0);
    const requests = h.sent.filter((p) => p.method === 'tools/call');
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert(request.flushed);
    assert(typeof request.id === 'number' || typeof request.id === 'string');
    controller.abort();
    const notification = await bounded(h.cancelledFlush);
    assert.equal(notification.requestId, request.id);
    const cancellation = h.sent.find(
      (p) => p.method === 'notifications/cancelled',
    );
    assert(cancellation?.flushed);
    assert.equal(object(cancellation.params).requestId, request.id);
    await h.phase.waitFor({ event: 'SIGNAL_ABORTED', operation: 1 });
    const native = await h.phase.waitFor({
      event: 'NATIVE_CANCEL',
      operation: 1,
    });
    assert('outcome' in native);
    assert(['fulfilled', 'rejected'].includes(native.outcome));
    await bounded(h.api.peer);
    assert.equal(h.api.peerAborted(), true);
    const held = await h.barrier();
    assert.equal(held.cancelsSettled, 1);
    for (const field of [
      'releases',
      'clientsSettled',
      'closes',
      'ownersSettled',
    ] as const)
      assert.equal(held[field], 0);
    await h.release();
    for (const event of [
      'READ_SETTLED',
      'NATIVE_CLOSED',
      'READER_RELEASED',
      'CLIENT_SETTLED',
      'AFTER_CLOSE',
    ] as const)
      await h.phase.waitFor({ event, operation: 1 });
    assert.deepEqual(
      await h.phase.waitFor({ event: 'OWNER_SETTLED', operation: 1 }),
      {
        event: 'OWNER_SETTLED',
        operation: 1,
        aborted: true,
        status: 'error',
        code: 'Cancelled',
        cancelledEnvelope: true,
      },
    );
    const outcome = await bounded(call);
    if (outcome.state === 'resolved')
      application(
        outcome.value,
        {
          status: 'error',
          error: {
            code: 'Cancelled',
            message: 'Report comparison was cancelled.',
          },
        },
        true,
      );
    else assert(outcome.error instanceof Error);
    application(
      await bounded(
        h.client.callTool({ name: 'compare_reports', arguments: input }),
      ),
      genericExpected(),
      false,
    );
    await h.phase.waitFor({ event: 'OWNER_SETTLED', operation: 2 });
    const final = await h.barrier();
    assert.equal(final.handlers, 2);
    assert.equal(final.ownersSettled, 2);
    assert.equal(final.httpAttempts, 8);
    await h.api.receipts(8);
  });
}
