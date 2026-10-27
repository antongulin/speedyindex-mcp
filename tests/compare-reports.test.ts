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
  createCompareOwnerRootBytes,
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
} from './fixtures/compare-reports-owner';
import {
  CompareReportsFault,
  compareProjectedReports,
  compareReportsBlocked,
  compareReportsBlockerCodeSchema,
  compareReportsEnvelopeSchema,
  compareReportsError,
  compareReportsErrorCodeSchema,
  compareReportsFailure,
  compareReportsInputSchema,
  compareReportsResultSchema,
  compareReportsToolResult,
  lowerCompareReportsResultByteLimit,
  projectCompareBacklinkPage,
  projectCompareLinksReport,
  projectCompareStatus,
  type CompareBacklinkProjection,
  type CompareLinksProjection,
  type CompareReportsInput,
  type CompareReportsResult,
  type CompareStatusProjection,
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
function genericPair(
  before = links('before'),
  after = links('after', [b, c], [a, d]),
  beforeStatus = status('before'),
  afterStatus = status('after'),
  selected: {
    family: TaskFamily;
    beforeTaskId: string;
    afterTaskId: string;
  } = input,
) {
  try {
    return compareProjectedReports(
      selected,
      {
        status: projectCompareStatus(beforeStatus),
        reports: [projectCompareLinksReport(before)],
      },
      {
        status: projectCompareStatus(afterStatus),
        reports: [projectCompareLinksReport(after)],
      },
    );
  } catch (error) {
    return compareReportsFailure(error);
  }
}
function backlinkStatus(id: string, extra: Record<string, unknown> = {}) {
  return status(id, {
    type: 'backlink/checker',
    size: 1,
    processedCount: 1,
    indexedCount: undefined,
    targetDomains: ['Example.test'],
    ...extra,
  });
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
function backlinkPair(
  before = [page('before')],
  after = [page('after')],
  beforeStatus = backlinkStatus('before'),
  afterStatus = backlinkStatus('after'),
) {
  try {
    return compareProjectedReports(
      { ...input, family: 'backlink/checker' },
      {
        status: projectCompareStatus(beforeStatus),
        reports: before.map((p) => projectCompareBacklinkPage(p)),
      },
      {
        status: projectCompareStatus(afterStatus),
        reports: after.map((p) => projectCompareBacklinkPage(p)),
      },
    );
  } catch (error) {
    return compareReportsFailure(error);
  }
}
function asLinks(value: CompareReportsResult) {
  if (value.status !== 'compared' || value.reportKind !== 'links')
    throw new Error('Expected links comparison: ' + JSON.stringify(value));
  return value;
}
function asBacklink(value: CompareReportsResult) {
  if (value.status !== 'compared' || value.reportKind !== 'backlink')
    throw new Error('Expected backlink comparison: ' + JSON.stringify(value));
  return value;
}
function expectCode(value: CompareReportsResult, code: string) {
  expect(value).toMatchObject(
    code === 'InternalError' ||
      compareReportsErrorCodeSchema.safeParse(code).success
      ? { status: 'error', error: { code } }
      : { status: 'blocked', blocker: { code } },
  );
}
function changed(
  value: unknown,
  path: (string | number)[],
  replacement: unknown,
) {
  const copy = structuredClone(value);
  let cursor = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path[path.length - 1]!] = replacement;
  return copy;
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

type BacklinkResultFixture = Extract<
  CompareReportsResult,
  { status: 'compared'; reportKind: 'backlink' }
>;
/** Independent one-row public DTO, including every retained coverage observation. */
function literalBacklinkResult(): BacklinkResultFixture & {
  rows: [BacklinkResultFixture['rows'][number]];
} {
  const side = (id: string): BacklinkResultFixture['before'] => ({
    status: {
      id,
      type: 'backlink/checker',
      size: 1,
      processedCount: 1,
      indexedCount: null,
      isCompleted: true,
      status: null,
      checkAfter: null,
      awaitingResult: null,
      dripFeed: null,
      days: null,
      daysPassed: null,
      isStopped: null,
      targetDomains: ['Example.test'],
      providerCreatedAt: null,
    },
    report: {
      size: 1,
      processedCount: 1,
      isCompleted: true,
      lastPage: 0,
      pagesVisited: 1,
    },
    coverage: {
      rawDonorCount: 1,
      observedUniqueDonorCount: 1,
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
      targetDomains: ['Example.test'],
      originalTargets: 'unknown',
    },
    before: side('before'),
    after: side('after'),
    rows: [
      {
        donorUrl: 'https://example.test/donor',
        before: { state: 'reported', targetLinks: [] },
        after: { state: 'reported', targetLinks: [] },
        comparison: {
          state: 'compared',
          newlyReportedTargetUrls: [],
          noLongerReportedTargetUrls: [],
          attributeChangedTargetUrls: [],
          unchangedTargetUrls: [],
        },
      },
    ],
    counts: {
      comparedDonors: 1,
      unknownDonors: 0,
      totalDonors: 1,
      newlyReportedTargetUrls: 0,
      noLongerReportedTargetUrls: 0,
      attributeChangedTargetUrls: 0,
      unchangedTargetUrls: 0,
    },
  };
}

test('CR-U01 strict six-family exact distinct safe IDs and application InvalidInput', () => {
  for (const family of [
    'google/indexer',
    'google/checker',
    'yandex/indexer',
    'yandex/checker',
    'bing/checker',
    'backlink/checker',
  ] as const) {
    const request = {
      family,
      beforeTaskId: '😀'.repeat(1_024),
      afterTaskId: ' after Ω ',
    };
    expect(compareReportsInputSchema.parse(request)).toEqual(request);
  }
  expect(
    compareReportsInputSchema.parse({
      ...input,
      beforeTaskId: 'same',
      afterTaskId: ' same',
    }),
  ).toEqual({ ...input, beforeTaskId: 'same', afterTaskId: ' same' });
  for (const bad of [
    {},
    { ...input, family: 'google' },
    { ...input, beforeTaskId: undefined },
    ...['', ' ', '\u0000', '\u007f', '\ud800', '\udc00', 'x'.repeat(4_097)].map(
      (beforeTaskId) => ({ ...input, beforeTaskId }),
    ),
    { ...input, afterTaskId: 'before' },
    ...[
      'searchEngine',
      'beforeFamily',
      'afterFamily',
      'reports',
      'targets',
      'key',
      'path',
      'policy',
      'page',
      'limit',
      'maxBytes',
      'proof',
    ].map((key) => ({ ...input, [key]: 'sentinel' })),
  ])
    expect(compareReportsInputSchema.safeParse(bad).success).toBe(false);
  const sameId = compareProjectedReports(
    { ...input, afterTaskId: 'before' },
    { status: projectCompareStatus(status('before')), reports: [] },
    { status: projectCompareStatus(status('after')), reports: [] },
  );
  expectCode(sameId, 'InvalidInput');
});

test('CR-U02 settled five-family exact transition matrix and caller-directed order', () => {
  const nullable = {
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
  };
  for (const family of [
    'google/indexer',
    'google/checker',
    'yandex/indexer',
    'yandex/checker',
    'bing/checker',
  ] as const) {
    const before = links('before', [a, c], [b, d], { family, type: family });
    const after = links('after', [b, c], [a, d], { family, type: family });
    const result = asLinks(
      genericPair(
        before,
        after,
        status('before', { type: family }),
        status('after', { type: family }),
        { ...input, family },
      ),
    );
    const expectedSummary = (id: string) => ({
      status: {
        id,
        type: family,
        size: 4,
        processedCount: 4,
        indexedCount: 2,
        isCompleted: true,
        ...nullable,
        targetDomains: null,
        providerCreatedAt: null,
      },
      report: {
        size: 4,
        processedCount: 4,
        indexedCount: 2,
        isCompleted: null,
        ...nullable,
        type: family,
        providerCreatedAt: 'ignored chronology',
      },
      settled: true,
      coverage: {
        observedIndexedCount: 2,
        observedUnindexedCount: 2,
        observedUniqueUrlCount: 4,
        indexedDuplicateCount: 0,
        unindexedDuplicateCount: 0,
        conflictingUrlCount: 0,
        reportedSlotGap: 0,
        indexedEnumerationGap: 0,
      },
    });
    expect(result).toEqual({
      status: 'compared',
      reportKind: 'links',
      family,
      beforeTaskId: 'before',
      afterTaskId: 'after',
      scope: expectedScope,
      before: expectedSummary('before'),
      after: expectedSummary('after'),
      rows: [
        {
          url: a,
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
          url: b,
          before: { state: 'unindexed', membership: 'unindexed' },
          after: { state: 'indexed', membership: 'indexed' },
          change: 'reported_unindexed_to_indexed',
        },
        {
          url: d,
          before: { state: 'unindexed', membership: 'unindexed' },
          after: { state: 'unindexed', membership: 'unindexed' },
          change: 'unchanged_unindexed',
        },
      ],
      counts: {
        reportedUnindexedToIndexed: 1,
        reportedIndexedToUnindexed: 1,
        unchangedIndexed: 1,
        unchangedUnindexed: 1,
        unknown: 0,
        total: 4,
      },
    });
    const reverse = asLinks(
      genericPair(
        after,
        before,
        status('after', { type: family }),
        status('before', { type: family }),
        { family, beforeTaskId: 'after', afterTaskId: 'before' },
      ),
    );
    expect(reverse.rows.map((r) => [r.url, r.change])).toEqual([
      [b, 'reported_indexed_to_unindexed'],
      [c, 'unchanged_indexed'],
      [a, 'reported_unindexed_to_indexed'],
      [d, 'unchanged_unindexed'],
    ]);
  }
});

test('CR-U03 partial official count gap and missing or contradictory finality remain unknown', () => {
  const before = links('before', [a], [e], {
    size: 3,
    processedCount: 3,
    indexedCount: 1,
  });
  const after = links('after', [a], [f], {
    size: 3,
    processedCount: 3,
    indexedCount: 1,
  });
  const bs = status('before', { size: 3, processedCount: 3, indexedCount: 1 });
  const as = status('after', { size: 3, processedCount: 3, indexedCount: 1 });
  const result = asLinks(genericPair(before, after, bs, as));
  expect(result.rows).toEqual([
    {
      url: a,
      before: { state: 'indexed', membership: 'indexed' },
      after: { state: 'indexed', membership: 'indexed' },
      change: 'unchanged_indexed',
    },
    {
      url: e,
      before: { state: 'unindexed', membership: 'unindexed' },
      after: {
        state: 'unknown',
        membership: 'omitted',
        reason: 'not_reported',
      },
      change: 'unknown',
    },
    {
      url: f,
      before: {
        state: 'unknown',
        membership: 'omitted',
        reason: 'not_reported',
      },
      after: { state: 'unindexed', membership: 'unindexed' },
      change: 'unknown',
    },
  ]);
  expect(result.before.coverage.reportedSlotGap).toBe(1);
  expect(result.after.coverage.reportedSlotGap).toBe(1);
  expect(result.before.status.awaitingResult).toBeNull();
  for (const extra of [
    { isCompleted: undefined },
    { isCompleted: false },
    { awaitingResult: true },
    { dripFeed: true, days: 5, daysPassed: 2 },
    { dripFeed: true },
  ]) {
    const uncertain = asLinks(
      genericPair(
        links('before'),
        links('after', [b, c], [a, d]),
        status('before', extra),
      ),
    );
    expect(uncertain.before.settled).toBe(false);
    expect(
      uncertain.rows.every(
        (r) => r.change === 'unknown' && r.before.state === 'unknown',
      ),
    ).toBe(true);
  }
  const reportConflict = asLinks(
    genericPair(links('before', [a, c], [b, d], { isCompleted: false })),
  );
  expect(reportConflict.before.settled).toBe(false);
  expect(reportConflict.counts.unknown).toBe(4);
  const incomplete = asLinks(
    genericPair(
      links('before', [a, c], [b, d], { processedCount: 3 }),
      undefined,
      status('before', { processedCount: 3 }),
    ),
  );
  expect(incomplete.counts.unknown).toBe(4);
  const empty = asLinks(
    genericPair(
      links('before', [], [], { size: 0, processedCount: 0, indexedCount: 0 }),
      links('after', [], [], { size: 0, processedCount: 0, indexedCount: 0 }),
      status('before', { size: 0, processedCount: 0, indexedCount: 0 }),
      status('after', { size: 0, processedCount: 0, indexedCount: 0 }),
    ),
  );
  expect(empty.rows).toEqual([]);
  expect(empty.scope).toEqual(expectedScope);
});

test('CR-U04 exact URL sets, duplicates, cross-partition ambiguity and impossible counts', () => {
  const urls: [string, string, string, string, string] = [
    'https://EXAMPLE.test/a',
    'https://example.test/a/',
    'https://example.test/a?b=2&a=1',
    'https://example.test/a?a=1&b=2',
    'https://example.test/a#x',
  ];
  const extra = { size: 5, processedCount: 5, indexedCount: 5 };
  const result = asLinks(
    genericPair(
      links('before', [...urls, urls[0]!], [urls[0]!], extra),
      links('after', urls, [], extra),
      status('before', extra),
      status('after', extra),
    ),
  );
  expect(result.rows.map((r) => r.url)).toEqual(urls);
  expect(result.rows[0]).toEqual({
    url: urls[0],
    before: {
      state: 'unknown',
      membership: 'both',
      reason: 'conflicting_partitions',
    },
    after: { state: 'indexed', membership: 'indexed' },
    change: 'unknown',
  });
  expect(result.before.coverage).toEqual({
    observedIndexedCount: 5,
    observedUnindexedCount: 1,
    observedUniqueUrlCount: 5,
    indexedDuplicateCount: 1,
    unindexedDuplicateCount: 0,
    conflictingUrlCount: 1,
    reportedSlotGap: 0,
    indexedEnumerationGap: 0,
  });
  for (const url of [
    'https://user:sentinel@example.test/',
    'https://example.test/\n',
    'https://example.test/\ud800',
    'ftp://example.test/',
    'https://example.test/' + 'x'.repeat(8_192),
  ]) {
    const bad = genericPair(links('before', [url], [], { indexedCount: 1 }));
    expectCode(bad, 'UnsupportedReportUrl');
    expect(JSON.stringify(bad)).not.toContain('sentinel');
  }
  for (const fields of [
    { processedCount: 5 },
    { size: 3 },
    { indexedCount: 1 },
    { indexedCount: 5 },
    { size: -1 },
    { processedCount: Number.MAX_SAFE_INTEGER + 1 },
    { processedCount: 1, indexedCount: 2 },
  ])
    expectCode(
      genericPair(links('before', [a, c], [b, d], fields)),
      'ConflictingEvidence',
    );
  const gap = asLinks(
    genericPair(
      links('before', [a], [b], {
        size: 4,
        processedCount: 4,
        indexedCount: 3,
      }),
      links('after', [a], [b], { size: 4, processedCount: 4, indexedCount: 3 }),
      status('before', { indexedCount: 3 }),
      status('after', { indexedCount: 3 }),
    ),
  );
  expect(gap.rows.map((r) => r.url)).toEqual([a, b]);
  expect(gap.before.coverage.indexedEnumerationGap).toBe(2);
  expect(gap.before.coverage.reportedSlotGap).toBe(2);
});

test('CR-U05 typed backlink URL partitions, attribute sets, duplicate tuples and exact order', () => {
  const beforeLinks = [
    { url: a, anchor: 'old', nofollow: false },
    { url: b, anchor: 'x', nofollow: true },
    { url: c, anchor: 'x', nofollow: false },
  ];
  const afterLinks = [
    { url: a, anchor: 'new', nofollow: true },
    { url: c, anchor: 'x', nofollow: false },
    { url: e, anchor: 'z', nofollow: false },
  ];
  const result = asBacklink(
    backlinkPair(
      [page('before', [donor(beforeLinks, { DA: 10 })])],
      [page('after', [donor(afterLinks, { DA: 90 })])],
    ),
  );
  expect(result.rows).toEqual([
    {
      donorUrl,
      before: { state: 'reported', targetLinks: beforeLinks },
      after: { state: 'reported', targetLinks: afterLinks },
      comparison: {
        state: 'compared',
        newlyReportedTargetUrls: [e],
        noLongerReportedTargetUrls: [b],
        attributeChangedTargetUrls: [a],
        unchangedTargetUrls: [c],
      },
    },
  ]);
  expect(result.counts).toEqual({
    comparedDonors: 1,
    unknownDonors: 0,
    totalDonors: 1,
    newlyReportedTargetUrls: 1,
    noLongerReportedTargetUrls: 1,
    attributeChangedTargetUrls: 1,
    unchangedTargetUrls: 1,
  });
  const multi: [
    { url: string; anchor: string; nofollow: boolean },
    { url: string; anchor: string; nofollow: boolean },
  ] = [
    { url: a, anchor: '', nofollow: false },
    { url: a, anchor: ' Second Ω ', nofollow: true },
  ];
  const repeated = asBacklink(
    backlinkPair(
      [page('before', [donor([multi[0], multi[1], multi[0]])])],
      [page('after', [donor([multi[1], multi[0]])])],
    ),
  );
  expect(repeated.rows[0]!.before).toEqual({
    state: 'reported',
    targetLinks: multi,
  });
  expect(repeated.rows[0]!.after).toEqual({
    state: 'reported',
    targetLinks: [multi[1], multi[0]],
  });
  expect(repeated.rows[0]!.comparison).toEqual({
    state: 'compared',
    newlyReportedTargetUrls: [],
    noLongerReportedTargetUrls: [],
    attributeChangedTargetUrls: [],
    unchangedTargetUrls: [a],
  });
  expect(repeated.before.coverage.rawTargetLinkCount).toBe(3);
  expect(repeated.before.coverage.duplicateTargetLinkCount).toBe(1);
});

test('CR-U06 unprocessed or malformed donors stay unknown, empty anchors valid, unkeyed rows refuse', () => {
  const link = { url: a, anchor: 'literal', nofollow: false };
  type UnknownDonorFixtureReason =
    'not_processed' | 'target_links_unavailable' | 'invalid_target_link';
  const cases: [Record<string, unknown>, UnknownDonorFixtureReason][] = [
    [{ processed: false }, 'not_processed'],
    [{ processed: undefined }, 'not_processed'],
    [{ processed: 'true' }, 'not_processed'],
    [{ target_links: undefined }, 'target_links_unavailable'],
    [{ target_links: null }, 'target_links_unavailable'],
    ...[
      { ...link, url: 'https://user:sentinel@example.test/' },
      { ...link, url: undefined },
      { ...link, anchor: undefined },
      { ...link, anchor: null },
      { ...link, anchor: '\n' },
      { ...link, anchor: '\u007f' },
      { ...link, anchor: '\ud800' },
      { ...link, anchor: '\udc00' },
      { ...link, anchor: 'é'.repeat(4_096) + 'x' },
      { ...link, nofollow: 'false' },
    ].map((bad): [Record<string, unknown>, UnknownDonorFixtureReason] => [
      { target_links: [bad] },
      'invalid_target_link',
    ]),
  ];
  for (const [extra, reason] of cases) {
    const result = asBacklink(
      backlinkPair(
        [page('before', [donor([link], extra)])],
        [page('after', [donor([])])],
      ),
    );
    expect(result.rows[0]).toEqual({
      donorUrl,
      before: { state: 'unknown', reason },
      after: { state: 'reported', targetLinks: [] },
      comparison: { state: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('sentinel');
  }
  for (const anchor of ['', 'é'.repeat(4_096)]) {
    const result = asBacklink(
      backlinkPair(
        [page('before', [donor([{ ...link, anchor }])])],
        [page('after', [donor([{ ...link, anchor }])])],
      ),
    );
    expect(result.rows[0]!.comparison).toMatchObject({
      state: 'compared',
      unchangedTargetUrls: [a],
    });
  }
  expect(asBacklink(backlinkPair()).rows[0]!.before).toEqual({
    state: 'reported',
    targetLinks: [],
  });
  for (const donor_url of [
    undefined,
    null,
    '',
    'https://user:sentinel@example.test/',
    '\ud800',
  ]) {
    const result = backlinkPair([page('before', [donor([], { donor_url })])]);
    expectCode(result, 'UnkeyedDonorEvidence');
    expect(JSON.stringify(result)).not.toContain('sentinel');
  }
});

test('CR-U07 duplicate and conflicting donors, missing identities and official partial enumeration', () => {
  const link = { url: a, anchor: 'x', nofollow: false };
  const before = [
    page('before', [donor([link], { http: 200 })], {
      size: 2,
      processedCount: 2,
      lastPage: 1,
    }),
    page('before', [donor([link], { http: 404 })], {
      size: 2,
      processedCount: 2,
      lastPage: 1,
      page: 1,
    }),
  ];
  const after = [
    page('after', [donor([link])], { size: 2, processedCount: 2 }),
  ];
  const bs = backlinkStatus('before', { size: 2, processedCount: 2 }),
    as = backlinkStatus('after', { size: 2, processedCount: 2 });
  const duplicate = asBacklink(backlinkPair(before, after, bs, as));
  expect(duplicate.rows).toHaveLength(1);
  expect(duplicate.before.coverage).toEqual({
    rawDonorCount: 2,
    observedUniqueDonorCount: 1,
    duplicateDonorCount: 1,
    conflictingDonorCount: 0,
    rawTargetLinkCount: 2,
    duplicateTargetLinkCount: 0,
    reportedSlotGap: 1,
  });
  expect(duplicate.after.coverage.reportedSlotGap).toBe(1);
  const conflict = asBacklink(
    backlinkPair(
      [
        before[0]!,
        page('before', [donor([{ ...link, anchor: 'different' }])], {
          size: 2,
          processedCount: 2,
          lastPage: 1,
          page: 1,
        }),
      ],
      after,
      bs,
      as,
    ),
  );
  expect(conflict.rows[0]!.before).toEqual({
    state: 'unknown',
    reason: 'conflicting_donor_rows',
  });
  expect(conflict.rows[0]!.comparison).toEqual({ state: 'unknown' });
  expect(conflict.before.coverage.conflictingDonorCount).toBe(1);
  const missing = asBacklink(
    backlinkPair(
      [page('before', [donor([link])])],
      [page('after', [donor([], { donor_url: e })])],
    ),
  );
  expect(missing.rows.map((r) => [r.donorUrl, r.comparison])).toEqual([
    [donorUrl, { state: 'unknown' }],
    [e, { state: 'unknown' }],
  ]);
  expect(missing.rows[0]!.after).toEqual({
    state: 'unknown',
    reason: 'not_reported',
  });
  expect(missing.rows[1]!.before).toEqual({
    state: 'unknown',
    reason: 'not_reported',
  });
  expect(missing.scope).toEqual(expectedScope);
});

test('CR-U08 exact ordered current targets, explicit provenance and incompatible types', () => {
  const targetDomains = [' Example.test ', 'example.test', ' Example.test '];
  const bs = backlinkStatus('before', { targetDomains }),
    as = backlinkStatus('after', { targetDomains });
  const valid = asBacklink(backlinkPair(undefined, undefined, bs, as));
  expect(valid.targetScope).toEqual({
    provenance: 'matching_current_provider_status',
    targetDomains,
    originalTargets: 'unknown',
  });
  for (const altered of [
    [...targetDomains].reverse().slice(1),
    [' example.test ', 'example.test', ' Example.test '],
    ['example.test', ' Example.test ', ' Example.test '],
    targetDomains.slice(0, 2),
  ])
    expectCode(
      backlinkPair(
        undefined,
        undefined,
        bs,
        backlinkStatus('after', { targetDomains: altered }),
      ),
      'IncompatibleTargetScope',
    );
  for (const targetDomains of [
    undefined,
    [],
    [''],
    ['\n'],
    ['\ud800'],
    ['x'.repeat(8_193)],
    Array(51).fill('example.test'),
  ])
    expectCode(
      backlinkPair(
        undefined,
        undefined,
        backlinkStatus('before', { targetDomains }),
      ),
      'TargetScopeUnavailable',
    );
  expectCode(
    backlinkPair(
      undefined,
      undefined,
      backlinkStatus('before', { type: 'google/checker' }),
    ),
    'IncompatibleTaskType',
  );
  expectCode(
    genericPair(links('before', [a, c], [b, d], { type: 'google/checker' })),
    'IncompatibleTaskType',
  );
  expectCode(
    genericPair(undefined, undefined, status('before', { type: 'indexer' })),
    'IncompatibleTaskType',
  );
  const omittedType = asLinks(
    genericPair(undefined, undefined, status('before', { type: undefined })),
  );
  expect(omittedType.before.status.type).toBeNull();
});

test('CR-U09 deep copied immutable strict semantic results, fixed failures and exact isError', () => {
  const originalLinks = [{ url: a, anchor: 'original', nofollow: false }];
  const targetDomains = ['Example.test'];
  const projected = projectCompareBacklinkPage(
    page('before', [donor(originalLinks)]),
  );
  const projectedStatus = projectCompareStatus(
    backlinkStatus('before', { targetDomains }),
  );
  originalLinks[0]!.anchor = 'mutated';
  targetDomains[0] = 'other.test';
  expect(projected.donors[0]!.evidence).toEqual({
    state: 'reported',
    targetLinks: [{ url: a, anchor: 'original', nofollow: false }],
  });
  expect(projectedStatus.targetDomains).toEqual(['Example.test']);
  const value = asBacklink(
    backlinkPair(
      [
        page('before', [
          donor([{ url: a, anchor: 'original', nofollow: false }]),
        ]),
      ],
      [
        page('after', [
          donor([{ url: a, anchor: 'original', nofollow: false }]),
        ]),
      ],
    ),
  );
  const mutable = structuredClone(value);
  const owned = compareReportsToolResult(mutable),
    saved = JSON.stringify(owned);
  if (mutable.rows[0]!.before.state === 'reported')
    mutable.rows[0]!.before.targetLinks[0]!.anchor = 'mutated';
  mutable.targetScope.targetDomains[0] = 'other.test';
  mutable.before.status.targetDomains![0] = 'other.test';
  expect(JSON.stringify(owned)).toBe(saved);
  const assertFrozen = (value: unknown) => {
    if (value && typeof value === 'object') {
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertFrozen(child);
    }
  };
  assertFrozen(owned);
  expect(() =>
    owned.content.push({ type: 'text', text: 'mutation' }),
  ).toThrow();
  const generic = asLinks(genericPair());
  for (const invalid of [
    changed(value, ['rows', 0, 'comparison', 'newlyReportedTargetUrls'], [a]),
    changed(value, ['rows', 0, 'comparison', 'unchangedTargetUrls'], []),
    changed(
      value,
      ['rows', 0, 'before', 'targetLinks'],
      [
        { url: a, anchor: 'original', nofollow: false },
        { url: a, anchor: 'original', nofollow: false },
      ],
    ),
    changed(value, ['counts', 'comparedDonors'], 0),
    changed(value, ['before', 'coverage', 'reportedSlotGap'], 1),
    changed(value, ['targetScope', 'targetDomains'], ['other.test']),
    changed(value, ['rows', 0, 'before', 'targetLinks', 0, 'anchor'], '\ud800'),
    changed(value, ['rows', 0, 'extra'], 'sentinel-private'),
    changed(generic, ['rows', 0, 'change'], 'unknown'),
    changed(generic, ['rows'], generic.rows.slice(1)),
    changed(generic, ['before', 'coverage', 'indexedDuplicateCount'], -1),
    changed(generic, ['rows', 0, 'before', 'reason'], 'sentinel-private'),
  ]) {
    expect(compareReportsResultSchema.safeParse(invalid).success).toBe(false);
    const result = compareReportsToolResult(invalid);
    expectCode(result.structuredContent, 'InternalError');
    expect(JSON.stringify(result)).not.toContain('sentinel-private');
  }
  for (const code of compareReportsErrorCodeSchema.options) {
    const result = compareReportsToolResult(
      compareReportsError(
        code,
        code === 'ReadFailed'
          ? { phase: 'fence', cause: 'network', cleanup: 'failed' }
          : {},
      ),
    );
    expect(result.isError).toBe(true);
    expectCode(result.structuredContent, code);
    expect(compareReportsEnvelopeSchema.safeParse(result).success).toBe(true);
  }
  for (const code of compareReportsBlockerCodeSchema.options) {
    const result = compareReportsToolResult(
      compareReportsBlocked(code, 'failed'),
    );
    expect(result.isError).toBe(false);
    expectCode(result.structuredContent, code);
    expect(compareReportsEnvelopeSchema.safeParse(result).success).toBe(true);
  }
  const mismatch = { ...owned, isError: true };
  expect(compareReportsEnvelopeSchema.safeParse(mismatch).success).toBe(false);
  expectCode(
    compareReportsToolResult(mismatch).structuredContent,
    'InternalError',
  );
  expect(compareReportsToolResult(generic).isError).toBe(false);
  expect(
    compareReportsToolResult(
      asLinks(
        genericPair(
          undefined,
          undefined,
          status('before', { isCompleted: false }),
        ),
      ),
    ).isError,
  ).toBe(false);
  expectCode(
    compareReportsFailure(
      new Error('sentinel-key /private/path provider body'),
    ),
    'InternalError',
  );
  expect(
    JSON.stringify(
      compareReportsFailure(
        new Error('sentinel-key /private/path provider body'),
      ),
    ),
  ).not.toContain('sentinel');
});

test('CR-U10 inclusive escaped duplicated envelope bytes and actual public ceiling without truncation', () => {
  const escaped = 'https://example.test/é"\\?A=1';
  const one = { size: 1, processedCount: 1, indexedCount: 1 };
  const generic = asLinks(
    genericPair(
      links('before', [escaped], [], one),
      links('after', [escaped], [], one),
      status('before', one),
      status('after', one),
    ),
  );
  const backlink = asBacklink(
    backlinkPair(
      [
        page('before', [
          donor([{ url: escaped, anchor: 'é"\\', nofollow: false }]),
        ]),
      ],
      [
        page('after', [
          donor([{ url: escaped, anchor: 'é"\\', nofollow: false }]),
        ]),
      ],
    ),
  );
  for (const value of [
    generic,
    backlink,
    compareReportsBlocked('IncompatibleTaskType'),
    compareReportsError('ReadFailed', {
      phase: 'report',
      cause: 'response',
      cleanup: 'failed',
    }),
  ]) {
    const expected = independentEnvelope(value),
      n = bytes(expected);
    expect(n).toBeGreaterThan(2 * bytes(value));
    const exact = compareReportsToolResult(value, { maxBytes: n });
    expect(exact).toEqual(expected);
    expect(bytes(exact)).toBe(n);
    const overflow = compareReportsToolResult(value, { maxBytes: n - 1 });
    expectCode(overflow.structuredContent, 'ResourceLimitExceeded');
    expect(overflow.isError).toBe(true);
    expect(bytes(overflow)).toBeLessThanOrEqual(n - 1);
    expect(compareReportsEnvelopeSchema.safeParse(overflow).success).toBe(true);
    expect(Object.keys(overflow.structuredContent).sort()).toEqual([
      'error',
      'status',
    ]);
  }
  expect(bytes(independentEnvelope(backlink))).toBeGreaterThan(
    JSON.stringify(independentEnvelope(backlink)).length,
  );
  const urls = Array.from(
    { length: 160 },
    (_, i) => 'https://example.test/' + i + '/é"\\' + 'x'.repeat(7_000),
  );
  const counts = { size: 160, processedCount: 160, indexedCount: 160 };
  const large = asLinks(
    genericPair(
      links('before', urls, [], counts),
      links('after', urls, [], counts),
      status('before', counts),
      status('after', counts),
    ),
  );
  expect(compareReportsResultSchema.safeParse(large).success).toBe(true);
  expect(bytes(independentEnvelope(large))).toBeGreaterThan(2_097_152);
  expectCode(
    compareReportsToolResult(large).structuredContent,
    'ResourceLimitExceeded',
  );
  const ordinary = compareReportsToolResult(backlink);
  expect(bytes(ordinary)).toBeLessThanOrEqual(2_097_152);
  expect(lowerCompareReportsResultByteLimit()).toBe(2_097_152);
  const internal = compareReportsToolResult({ status: 'invalid' });
  const resource = compareReportsToolResult(
    compareReportsError('ResourceLimitExceeded'),
  );
  const minimum = Math.max(bytes(internal), bytes(resource));
  for (const result of [internal, resource])
    expect(
      bytes(
        compareReportsToolResult(result.structuredContent, {
          maxBytes: minimum,
        }),
      ),
    ).toBeLessThanOrEqual(minimum);
  for (const maxBytes of [minimum - 1, 0, -1, 1.5, NaN, Infinity, 2_097_153])
    expect(() => compareReportsToolResult(backlink, { maxBytes })).toThrow(
      RangeError,
    );
});

test('CR-U04-R01 effective indexed totals fit distinct unindexed-only slots without settling partial tasks', () => {
  const impossible = {
    size: 2,
    processedCount: 2,
    indexedCount: 2,
    isCompleted: true,
  };
  expectCode(
    genericPair(
      links('before', [a], [b], impossible),
      links('after', [b], [a], impossible),
      status('before', impossible),
      status('after', impossible),
    ),
    'ConflictingEvidence',
  );

  // A missing report counter must not evade bounds by splitting facts across DTOs.
  for (const [processedCount, indexedCount] of [
    [2, 2],
    [2, 3],
    [1, 2],
  ] as const) {
    const reportFields = { size: 2, processedCount, indexedCount: undefined };
    const statusFields = {
      size: undefined,
      processedCount: undefined,
      indexedCount,
    };
    expectCode(
      genericPair(
        links('before', [a], [b], reportFields),
        links('after', [b], [a], reportFields),
        status('before', statusFields),
        status('after', statusFields),
      ),
      'ConflictingEvidence',
    );
  }

  const coherent = {
    size: 2,
    processedCount: 2,
    indexedCount: 1,
    isCompleted: true,
  };
  const publicResult = asLinks(
    genericPair(
      links('before', [a], [b], coherent),
      links('after', [b], [a], coherent),
      status('before', coherent),
      status('after', coherent),
    ),
  );
  const reportTotal = structuredClone(publicResult);
  reportTotal.before.status.indexedCount = 2;
  reportTotal.before.report.indexedCount = 2;
  reportTotal.before.coverage.indexedEnumerationGap = 1;
  const statusTotal = structuredClone(publicResult);
  statusTotal.before.status.size = null;
  statusTotal.before.status.processedCount = null;
  statusTotal.before.status.indexedCount = 3;
  statusTotal.before.report.indexedCount = null;
  statusTotal.before.coverage.indexedEnumerationGap = 2;
  for (const invalid of [reportTotal, statusTotal]) {
    expect(compareReportsResultSchema.safeParse(invalid).success).toBe(false);
    expectCode(
      compareReportsToolResult(invalid).structuredContent,
      'InternalError',
    );
  }

  // Unindexed report membership can include unprocessed URLs: union3 > processed1 is valid.
  const partial = {
    size: 3,
    processedCount: 1,
    indexedCount: 1,
    isCompleted: false,
  };
  for (const reportIndexedCount of [1, undefined]) {
    const result = asLinks(
      genericPair(
        links('before', [a], [b, d], {
          ...partial,
          indexedCount: reportIndexedCount,
        }),
        links('after', [b], [a, d], {
          ...partial,
          indexedCount: reportIndexedCount,
        }),
        status('before', partial),
        status('after', partial),
      ),
    );
    expect(result.before.settled).toBe(false);
    expect(result.after.settled).toBe(false);
    expect(result.rows.map((row) => [row.url, row.change])).toEqual([
      [a, 'unknown'],
      [b, 'unknown'],
      [d, 'unknown'],
    ]);
    expect(result.before.coverage.reportedSlotGap).toBe(0);
    expect(result.before.coverage.indexedEnumerationGap).toBe(0);
    expect(compareReportsResultSchema.safeParse(result).success).toBe(true);
  }
});

test('CR-U06-R02 distinct explicit processed witnesses survive unknown and conflicting donor rows', () => {
  const observedDonor = 'https://example.test/donor';
  const link = { url: a, anchor: '', nofollow: false };
  const zero = { size: 1, processedCount: 0, isCompleted: false };
  const beforeStatus = backlinkStatus('before', zero),
    afterStatus = backlinkStatus('after', zero);
  expectCode(
    backlinkPair(
      [page('before', [donor([link], { donor_url: observedDonor })], zero)],
      [page('after', [donor([], { donor_url: observedDonor })], zero)],
      beforeStatus,
      afterStatus,
    ),
    'ConflictingEvidence',
  );

  for (const target_links of [undefined, null, [{ ...link, anchor: '\n' }]]) {
    expectCode(
      backlinkPair(
        [page('before', [donor(target_links, { target_links })], zero)],
        [page('after', [donor([])], zero)],
        beforeStatus,
        afterStatus,
      ),
      'ConflictingEvidence',
    );
  }

  // Both known and malformed processed evidence must survive conflict projection in either order.
  for (const processedRow of [
    donor([link]),
    donor(undefined, { target_links: undefined }),
  ]) {
    for (const rows of [
      [processedRow, donor([], { processed: false })],
      [donor([], { processed: false }), processedRow],
    ]) {
      const before = rows.map((row, i) =>
        page('before', [row], { ...zero, page: i, lastPage: 1 }),
      );
      expectCode(
        backlinkPair(
          before,
          [page('after', [donor([])], zero)],
          beforeStatus,
          afterStatus,
        ),
        'ConflictingEvidence',
      );
    }
  }

  const partial = { size: 2, processedCount: 1, isCompleted: false };
  const partialBefore = backlinkStatus('before', partial),
    partialAfter = backlinkStatus('after', partial);
  expectCode(
    backlinkPair(
      [
        page('before', [donor([link])], { ...partial, lastPage: 1 }),
        page('before', [donor([], { donor_url: e })], {
          ...partial,
          page: 1,
          lastPage: 1,
        }),
      ],
      [page('after', [donor([])], partial)],
      partialBefore,
      partialAfter,
    ),
    'ConflictingEvidence',
  );

  // One witnessed donor is legitimate in an incomplete size2/processed1 task.
  const positive = asBacklink(
    backlinkPair(
      [page('before', [donor([link])], partial)],
      [page('after', [donor([])], partial)],
      partialBefore,
      partialAfter,
    ),
  );
  expect(positive.rows).toEqual([
    {
      donorUrl,
      before: { state: 'reported', targetLinks: [link] },
      after: { state: 'reported', targetLinks: [] },
      comparison: {
        state: 'compared',
        newlyReportedTargetUrls: [],
        noLongerReportedTargetUrls: [a],
        attributeChangedTargetUrls: [],
        unchangedTargetUrls: [],
      },
    },
  ]);
  expect(positive.before.status.isCompleted).toBe(false);
  expect(positive.before.coverage.reportedSlotGap).toBe(1);
  expect(JSON.stringify(positive)).not.toContain('processedWitness');

  // Duplicate raw rows across pages count as one processed identity, even when they conflict.
  const repeated = { size: 1, processedCount: 1, isCompleted: false };
  for (const later of [donor([link]), donor([], { processed: false })]) {
    const result = asBacklink(
      backlinkPair(
        [
          page('before', [donor([link])], { ...repeated, lastPage: 1 }),
          page('before', [later], { ...repeated, page: 1, lastPage: 1 }),
        ],
        [page('after', [donor([])], repeated)],
        backlinkStatus('before', repeated),
        backlinkStatus('after', repeated),
      ),
    );
    expect(result.before.coverage.rawDonorCount).toBe(2);
    expect(result.before.coverage.observedUniqueDonorCount).toBe(1);
    expect(result.before.coverage.duplicateDonorCount).toBe(1);
    expect(compareReportsResultSchema.safeParse(result).success).toBe(true);
  }

  for (const before of [
    { state: 'reported', targetLinks: [] },
    { state: 'unknown', reason: 'target_links_unavailable' },
    { state: 'unknown', reason: 'invalid_target_link' },
  ] as const) {
    const invalid = literalBacklinkResult();
    invalid.before.status.processedCount = 0;
    invalid.before.report.processedCount = 0;
    invalid.before.status.isCompleted = false;
    invalid.before.report.isCompleted = false;
    // Clone the finite fixture into mutable DTO arrays without borrowing product projections.
    invalid.rows[0].before =
      before.state === 'reported'
        ? { state: 'reported', targetLinks: [] }
        : { state: 'unknown', reason: before.reason };
    if (before.state === 'unknown') {
      invalid.rows[0].comparison = { state: 'unknown' };
      invalid.counts.comparedDonors = 0;
      invalid.counts.unknownDonors = 1;
    }
    expect(compareReportsResultSchema.safeParse(invalid).success).toBe(false);
    expectCode(
      compareReportsToolResult(invalid).structuredContent,
      'InternalError',
    );
  }

  // Public conflict unknowns discard the private witness; they do not prove processing by themselves.
  const unknown = literalBacklinkResult();
  unknown.before.status.processedCount = 0;
  unknown.before.report.processedCount = 0;
  unknown.before.status.isCompleted = false;
  unknown.before.report.isCompleted = false;
  unknown.before.coverage.rawDonorCount = 2;
  unknown.before.coverage.duplicateDonorCount = 1;
  unknown.before.coverage.conflictingDonorCount = 1;
  unknown.rows[0].before = {
    state: 'unknown',
    reason: 'conflicting_donor_rows',
  };
  unknown.rows[0].comparison = { state: 'unknown' };
  unknown.counts.comparedDonors = 0;
  unknown.counts.unknownDonors = 1;
  expect(compareReportsResultSchema.safeParse(unknown).success).toBe(true);
  expect(compareReportsToolResult(unknown).structuredContent).toEqual(unknown);
});

test('CR-U09-R03 coherent public coverage mutations obey page duplicate and raw tuple bounds', () => {
  const base = literalBacklinkResult();
  expect(compareReportsResultSchema.safeParse(base).success).toBe(true);
  const pageOverflow = literalBacklinkResult();
  pageOverflow.before.coverage.rawDonorCount = 101;
  pageOverflow.before.coverage.duplicateDonorCount = 100;
  const conflict = literalBacklinkResult();
  conflict.before.coverage.conflictingDonorCount = 1;
  conflict.rows[0].before = {
    state: 'unknown',
    reason: 'conflicting_donor_rows',
  };
  conflict.rows[0].comparison = { state: 'unknown' };
  conflict.counts.comparedDonors = 0;
  conflict.counts.unknownDonors = 1;
  const emptyRows = literalBacklinkResult();
  emptyRows.before.coverage.rawDonorCount = 0;
  emptyRows.before.coverage.observedUniqueDonorCount = 0;
  emptyRows.before.coverage.rawTargetLinkCount = 1;
  emptyRows.before.coverage.reportedSlotGap = 1;
  emptyRows.rows[0].before = { state: 'unknown', reason: 'not_reported' };
  emptyRows.rows[0].comparison = { state: 'unknown' };
  emptyRows.counts.comparedDonors = 0;
  emptyRows.counts.unknownDonors = 1;
  const targetOverflow = literalBacklinkResult();
  targetOverflow.before.coverage.rawTargetLinkCount = 1_001;
  for (const invalid of [pageOverflow, conflict, emptyRows, targetOverflow]) {
    expect(compareReportsResultSchema.safeParse(invalid).success).toBe(false);
    const result = compareReportsToolResult(invalid);
    expectCode(result.structuredContent, 'InternalError');
    expect(result.isError).toBe(true);
    expect(Object.keys(result.structuredContent).sort()).toEqual([
      'error',
      'status',
    ]);
  }
  const legitimateDuplicates = literalBacklinkResult();
  legitimateDuplicates.before.coverage.rawDonorCount = 100;
  legitimateDuplicates.before.coverage.duplicateDonorCount = 99;
  expect(
    compareReportsResultSchema.safeParse(legitimateDuplicates).success,
  ).toBe(true);
  expect(
    compareReportsToolResult(legitimateDuplicates).structuredContent,
  ).toEqual(legitimateDuplicates);
});

test('CR-U11 source timestamps preserve exact nullable safe text and refuse malformed present values', () => {
  const safe = ['', '  ', 'not a date', 'Ωé"\\', 'é'.repeat(4096)];
  expect(Buffer.byteLength(safe[4]!, 'utf8')).toBe(8192);
  for (const value of [undefined, ...safe]) {
    const expected = value === undefined ? null : value;
    expect(
      projectCompareStatus(status('before', { createdAt: value }))
        .providerCreatedAt,
    ).toBe(expected);
    expect(
      projectCompareLinksReport(links('before', [a], [b], { createdAt: value }))
        .metadata.providerCreatedAt,
    ).toBe(expected);
  }
  const fixed = {
    status: 'blocked',
    blocker: {
      code: 'ConflictingEvidence',
      message: 'Required report observations conflict.',
    },
  };
  for (const value of [
    null,
    false,
    7,
    {},
    [],
    '\u0000SENTINEL',
    '\u007f',
    '\ud800',
    '\udfff',
    'é'.repeat(4096) + 'x',
  ]) {
    for (const project of [
      () => projectCompareStatus(status('before', { createdAt: value })),
      () =>
        projectCompareLinksReport(
          links('before', [a], [b], { createdAt: value }),
        ),
    ]) {
      let refused: unknown;
      try {
        project();
      } catch (error) {
        refused = compareReportsFailure(error);
      }
      expect(refused).toEqual(fixed);
      expect(JSON.stringify(refused)).not.toContain('SENTINEL');
    }
  }
  const backlink = asBacklink(
    backlinkPair(
      undefined,
      undefined,
      backlinkStatus('before', { createdAt: ' source Ω ' }),
    ),
  );
  expect(backlink.before.status.providerCreatedAt).toBe(' source Ω ');
  expect(Object.hasOwn(backlink.before.report, 'providerCreatedAt')).toBe(
    false,
  );
  expect(
    compareReportsResultSchema.safeParse(
      changed(backlink, ['before', 'report', 'providerCreatedAt'], null),
    ).success,
  ).toBe(false);
  const result = asLinks(genericPair());
  for (const path of [
    ['before', 'status', 'providerCreatedAt'],
    ['before', 'report', 'providerCreatedAt'],
  ]) {
    expect(
      compareReportsResultSchema.safeParse(changed(result, path, '\ud800'))
        .success,
    ).toBe(false);
    expect(
      compareReportsResultSchema.safeParse(changed(result, path, undefined))
        .success,
    ).toBe(false);
  }
  const envelope = compareReportsToolResult(result);
  expect(envelope).toEqual(independentEnvelope(result));
  expect(Object.isFrozen(envelope.structuredContent)).toBe(true);
  expect(bytes(envelope)).toBe(
    Buffer.byteLength(JSON.stringify(independentEnvelope(result)), 'utf8'),
  );
});

const literalA = 'https://example.test/é"\\a',
  literalB = 'https://example.test/Ω/b';
function literalGenericEnvelope() {
  const frame = compareLiteralFrameOracle().frames.envelopeCopy;
  const work: unknown = frame?.[5];
  if (!Array.isArray(work))
    throw new Error('Missing independent literal frame.');
  return compareReportsEnvelopeSchema.parse(work[2]);
}
function literalGenericComparison() {
  const fields = {
    size: 2,
    processedCount: 2,
    indexedCount: 1,
    isCompleted: true,
  };
  return genericPair(
    links('before', [literalA, literalA], [literalB], {
      ...fields,
      createdAt: 'report-before é',
    }),
    links('after', [literalB, literalB], [literalA], {
      ...fields,
      createdAt: 'report-after é',
    }),
    status('before', { ...fields, createdAt: ' status-before Ω ' }),
    status('after', { ...fields, createdAt: ' status-after Ω ' }),
  );
}
test('CR-U12 complete literal result keeps source dates separate and caller direction without chronology', () => {
  const expected = literalGenericEnvelope();
  const result = literalGenericComparison();
  expect(result).toEqual(expected.structuredContent);
  expect(compareReportsToolResult(result)).toEqual(expected);
  expect(bytes(expected)).toBe(5196);
  const opposite = asLinks(
    genericPair(
      links('before', [a, c], [b, d], { createdAt: '9999-before-report' }),
      links('after', [b, c], [a, d], { createdAt: '0000-after-report' }),
      status('before', { createdAt: undefined }),
      status('after', { createdAt: ' invalid-date Ω ' }),
    ),
  );
  expect(opposite.beforeTaskId).toBe('before');
  expect(opposite.afterTaskId).toBe('after');
  expect(opposite.before.status.providerCreatedAt).toBeNull();
  expect(opposite.before.report.providerCreatedAt).toBe('9999-before-report');
  expect(opposite.after.status.providerCreatedAt).toBe(' invalid-date Ω ');
  expect(opposite.after.report.providerCreatedAt).toBe('0000-after-report');
  expect(opposite.rows.map((row) => [row.url, row.change])).toEqual([
    [a, 'reported_indexed_to_unindexed'],
    [c, 'unchanged_indexed'],
    [b, 'reported_unindexed_to_indexed'],
    [d, 'unchanged_unindexed'],
  ]);
  expect(opposite.scope).toEqual(expectedScope);
  expect(Object.hasOwn(opposite, 'observedAt')).toBe(false);
});

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
    ['--no-env-file', 'tests/fixtures/compare-reports-owner.ts'],
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

// N1 extends only native test data/receipts. The accepted fixture protocol and
// its independent 64-frame oracle remain unchanged.
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
// Expected notifications count completed pages in the independent finite scripts.
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

/** Finite native receiver; cleanup is owned before listen/spawn/startup work. */
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
        ['--no-env-file', 'tests/fixtures/compare-reports-owner.ts'],
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
/** Public expected rows and all coverage values are literal, never projected. */
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

/** Preparation operates on finite raw fixture values, not owner results. */
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

// N2 adds only an inline native harness and finite resource cases. N1 is unchanged.
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
/** Observe actual native callbacks without replacing their handles or results. */
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

// Private diagnostic JSON only. None of these values supplies owner facts.
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
/** All tracked receipts below are the original native promises, never recovered promises. */
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
/** All1500expected rows remain present; original corpus/history stay unknown. */
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

test('CR-MP01-ROOTS complete paired-row images dominate every two-row matched state', () => {
  type Donor = CompareBacklinkProjection['donors'][number];
  type Pair = { donor: Donor; rawTargetCount: number | null };
  type Wrapper = {
    projection: CompareBacklinkProjection;
    donorRawTargetCounts: readonly (number | null)[];
  };
  type Frame = readonly [
    readonly [CompareStatusProjection, CompareStatusProjection],
    readonly Wrapper[],
    readonly Wrapper[],
    readonly Wrapper[],
    null,
    readonly [readonly Pair[], readonly Pair[], readonly boolean[]],
  ];
  const beforeStatus: CompareStatusProjection = {
    id: 'before',
    type: 'backlink/checker',
    size: 1,
    processedCount: 1,
    indexedCount: null,
    isCompleted: false,
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
    targetDomains: [' Example.test ', ' Example.test '],
    providerCreatedAt: ' status-before Ω ',
  };
  const afterStatus: CompareStatusProjection = {
    ...beforeStatus,
    id: 'after',
    providerCreatedAt: ' status-after Ω ',
  };
  const oldDonor: Donor = {
    donorUrl: 'https://example.test/donor',
    processedWitness: true,
    evidence: {
      state: 'reported',
      targetLinks: [
        { url: 'https://example.test/é"\\a', anchor: 'old Ω', nofollow: false },
        { url: 'https://example.test/Ω/b', anchor: '', nofollow: true },
        { url: 'https://example.test/c', anchor: 'same', nofollow: false },
      ],
    },
  };
  const newDonor: Donor = {
    donorUrl: 'https://example.test/donor',
    processedWitness: true,
    evidence: {
      state: 'reported',
      targetLinks: [
        { url: 'https://example.test/é"\\a', anchor: 'new Ω', nofollow: true },
        { url: 'https://example.test/c', anchor: 'same', nofollow: false },
        { url: 'https://example.test/e', anchor: 'z', nofollow: false },
      ],
    },
  };
  const unknownDonor: Donor = {
    donorUrl: 'https://example.test/donor',
    processedWitness: false,
    evidence: { state: 'unknown', reason: 'not_processed' },
  };
  const pageBase = {
    family: 'backlink/checker',
    reportKind: 'backlink',
    taskId: 'before',
    size: 1,
    processedCount: 1,
    isCompleted: false,
    page: 0,
    lastPage: 1,
  } satisfies Omit<
    CompareBacklinkProjection,
    'donors' | 'rawTargetLinkCount' | 'duplicateTargetLinkCount'
  >;
  const frame = (nullCounts: boolean, matched: readonly boolean[]): Frame => {
    const donor = nullCounts ? unknownDonor : oldDonor;
    const counts: readonly [number | null, number | null] = nullCounts
      ? [null, 0]
      : [3, 3];
    const wrapper = (page: 0 | 1, rawCount: number | null): Wrapper => ({
      projection: {
        ...pageBase,
        page,
        processedCount: nullCounts ? 0 : 1,
        donors: [donor],
        rawTargetLinkCount: nullCounts ? 0 : 3,
        duplicateTargetLinkCount: 0,
      },
      donorRawTargetCounts: [rawCount],
    });
    const before = [wrapper(0, counts[0]), wrapper(1, counts[1])];
    const after: Wrapper[] = [
      {
        projection: {
          ...pageBase,
          taskId: 'after',
          lastPage: 0,
          donors: [newDonor],
          rawTargetLinkCount: 3,
          duplicateTargetLinkCount: 0,
        },
        donorRawTargetCounts: [3],
      },
    ];
    const pairedBefore: Pair[] = [
      { donor, rawTargetCount: counts[0] },
      { donor, rawTargetCount: counts[1] },
    ];
    const pairedAfter: Pair[] = [
      { donor, rawTargetCount: counts[0] },
      { donor, rawTargetCount: counts[1] },
    ];
    return [
      [{ ...beforeStatus, processedCount: nullCounts ? 0 : 1 }, afterStatus],
      before,
      after,
      before,
      null,
      [pairedBefore, pairedAfter, matched],
    ];
  };
  // Historical backlinkSecondTaskIndex used a conceptual unpaired sidecar image.
  // Preserve all 64 historical images; MP01 supplies the actual three-root paired
  // shape, not a claim that all 64 images exactly match the current source.
  const oracle = compareLiteralFrameOracle();
  const historical = oracle.frames.backlinkSecondTaskIndex;
  if (!historical) throw new Error('Missing historical backlink frame.');
  expect(Object.keys(oracle.frames)).toHaveLength(64);
  expect(oracle.fixturePeaks).toEqual({ generic: 22271, backlink: 25199 });
  const states: readonly (readonly [boolean, boolean])[] = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ];
  // Fixed UTF8 sizes come from the saved independent hand-authored literal JSON
  // calculation, never the production meter, projector or equality matcher.
  const variants: readonly {
    name: string;
    nullCounts: boolean;
    expected: readonly [number, number, number, number];
  }[] = [
    {
      name: 'historical-paired',
      nullCounts: false,
      expected: [4882, 4881, 4881, 4880],
    },
    {
      name: 'null-vs-zero',
      nullCounts: true,
      expected: [3334, 3333, 3333, 3332],
    },
  ];
  for (const variant of variants) {
    for (const [index, matched] of states.entries()) {
      const image = frame(variant.nullCounts, matched);
      const text = JSON.stringify(image),
        size = Buffer.byteLength(text, 'utf8');
      expect<number | undefined>(size).toBe(variant.expected[index]);
      expect(size).toBe(variant.expected[0] - matched.filter(Boolean).length);
      expect(size).toBeLessThanOrEqual(25199);
      expect(size).toBeGreaterThan(text.length);
      expect(image).toHaveLength(6);
      expect(image[5]).toHaveLength(3);
      expect(image[1]).toBe(image[3]);
      expect(text.match(/"projection":/g) ?? []).toHaveLength(5);
      expect(text.match(/"donorRawTargetCounts":/g) ?? []).toHaveLength(5);
      expect(text.match(/"donor":/g) ?? []).toHaveLength(4);
      expect(text.match(/"rawTargetCount":/g) ?? []).toHaveLength(4);
      expect(text.match(/"donorUrl":/g) ?? []).toHaveLength(9);
      expect(text.match(/"processedWitness":/g) ?? []).toHaveLength(9);
      if (variant.nullCounts) {
        expect(text.match(/"rawTargetCount":null/g) ?? []).toHaveLength(2);
        expect(text.match(/"rawTargetCount":0/g) ?? []).toHaveLength(2);
      } else {
        expect<unknown[]>(image.slice(0, 5)).toEqual(historical.slice(0, 5));
        expect(text.match(/"rawTargetCount":3/g) ?? []).toHaveLength(4);
      }
    }
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
      new URL('./fixtures/compare-reports-owner.ts', import.meta.url),
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

// CR-CM: independent pure fixtures for the scalar owner-contribution contract.
function cmFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) cmFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function cmStatus(
  id: string,
  indexedCount = 1,
  providerCreatedAt: string | null = null,
) {
  return cmFreeze({
    id,
    type: 'google/indexer',
    size: 1,
    processedCount: 1,
    indexedCount,
    isCompleted: true,
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
    targetDomains: null,
    providerCreatedAt,
  } satisfies CompareStatusProjection);
}
function cmWrapper(taskId: string, indexed = true, url = a) {
  const projection = {
    family: 'google/indexer',
    reportKind: 'links',
    taskId,
    metadata: {
      size: 1,
      processedCount: 1,
      indexedCount: indexed ? 1 : 0,
      isCompleted: true,
      status: null,
      checkAfter: null,
      awaitingResult: null,
      dripFeed: null,
      days: null,
      daysPassed: null,
      isStopped: null,
      type: 'google/indexer',
      providerCreatedAt: null,
    },
    indexedLinks: indexed ? [url] : [],
    unindexedLinks: indexed ? [] : [url],
    indexedDuplicateCount: 0,
    unindexedDuplicateCount: 0,
  } satisfies CompareLinksProjection;
  return cmFreeze({ projection, donorRawTargetCounts: null });
}
type CmFrame = [
  readonly unknown[] | null,
  unknown[],
  unknown[],
  unknown[],
  readonly unknown[] | null,
  readonly unknown[],
];
const cmEmptyFrame = (): CmFrame => [null, [], [], [], null, []];
/** Whole-frame oracle; never uses the new counter or production projectors. */
function cmFrameBytes(frame: readonly unknown[]) {
  return Buffer.from(
    JSON.stringify(frame, function (_key, entry: unknown) {
      if (entry instanceof Set) return Array.from(entry);
      if (entry instanceof Map) return Array.from(entry.entries());
      return entry;
    }),
    'utf8',
  ).length;
}

test('CR-CM01 exact scalar six-slot punctuation append reset and invocation isolation', () => {
  const meter = createCompareOwnerRootBytes();
  const model = cmEmptyFrame();
  const check = (roots: readonly unknown[] = []) => {
    model[5] = roots;
    expect(meter.bytes(roots)).toBe(cmFrameBytes(model));
  };
  // Hand-counted: two outer brackets, five commas, two nulls and four [].
  expect(JSON.stringify(model)).toBe('[null,[],[],[],null,[]]');
  expect(meter.bytes([])).toBe(23);
  check();
  const pair = cmFreeze([cmStatus('before'), cmStatus('after')] as const);
  model[0] = pair;
  meter.replaceStatus('baseline', pair);
  check();
  for (const [slot, index] of [
    ['beforeA', 1],
    ['afterA', 2],
    ['currentB', 3],
  ] as const) {
    for (let i = 0; i < 10; i++) {
      const wrapper = cmWrapper('task-' + i);
      model[index].push(wrapper);
      meter.appendReport(slot, wrapper);
      check();
      if (i === 0 || i === 1 || i === 9)
        expect(model[index]).toHaveLength(i + 1);
    }
  }
  for (const replacement of [pair, null, pair, null] as const) {
    model[4] = replacement;
    meter.replaceStatus('fence', replacement);
    check();
  }
  model[0] = null;
  meter.replaceStatus('baseline', null);
  check();
  for (let i = 0; i < 3; i++) {
    model[3] = [];
    meter.clearCurrentB();
    check();
    const wrapper = cmWrapper('repopulated-' + i);
    model[3].push(wrapper);
    meter.appendReport('currentB', wrapper);
    check();
  }
  expect(createCompareOwnerRootBytes().bytes([])).toBe(23);
  check([pair, model[1]]);
});

test('CR-CM02 aliases mutable work roots and simultaneous owner lifetimes stay exact', () => {
  const meter = createCompareOwnerRootBytes();
  const model = cmEmptyFrame();
  const pair = cmFreeze([cmStatus('before'), cmStatus('after')] as const);
  const wrapper = cmWrapper('before');
  const work: { prefix: unknown[]; label?: string } = {
    prefix: [],
    label: 'same',
  };
  const check = (roots: readonly unknown[]) => {
    model[5] = roots;
    const actual = meter.bytes(roots);
    expect(actual).toBe(cmFrameBytes(model));
    return actual;
  };
  meter.replaceStatus('baseline', pair);
  model[0] = pair;
  const prePush = check([wrapper]);
  meter.appendReport('beforeA', wrapper);
  model[1].push(wrapper);
  expect(check([])).toBe(prePush);
  for (const [slot, index] of [
    ['afterA', 2],
    ['currentB', 3],
  ] as const) {
    meter.appendReport(slot, wrapper);
    model[index].push(wrapper);
  }
  meter.replaceStatus('fence', pair);
  model[4] = pair;
  const roots = [wrapper, wrapper, work];
  const initial = check(roots);
  work.prefix.push({ url: a });
  expect(check(roots)).toBeGreaterThan(initial);
  work.label = 'size';
  const equalLength = check(roots);
  work.label = 'same';
  expect(check(roots)).toBe(equalLength);
  work.label = 'a longer value';
  expect(check(roots)).toBeGreaterThan(equalLength);
  work.prefix.length = 0;
  delete work.label;
  expect(check(roots)).toBeLessThan(initial);
  const draft = { rows: [{ url: a, before: false, after: true }] };
  const parsed = { success: true, data: structuredClone(draft) };
  const result = { ...structuredClone(draft), status: 'compared' };
  const envelope = {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: structuredClone(result),
    isError: false,
  };
  const copies = [
    work,
    draft,
    parsed,
    result,
    envelope,
    Object.values(envelope),
    Object.values(envelope.structuredContent),
    Object.values(envelope.structuredContent.rows),
  ];
  check(copies); // currentB, fence, drafts, copies and ancestors coexist.
  const pairedBefore = [
    { donor: { donorUrl: a }, rawTargetCount: null },
    { donor: { donorUrl: b }, rawTargetCount: 0 },
  ];
  const pairedAfter = structuredClone(pairedBefore);
  const matched = [false, false];
  const pairedRoots = [...copies, pairedBefore, pairedAfter, matched];
  const allFalse = check(pairedRoots);
  for (const state of [
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    matched[0] = state[0];
    matched[1] = state[1];
    expect(check(pairedRoots)).toBe(allFalse - state.filter(Boolean).length);
  }
  for (let i = 0; i < 3; i++) {
    meter.clearCurrentB();
    model[3] = [];
    check(pairedRoots);
    meter.appendReport('currentB', wrapper);
    model[3].push(wrapper);
    check(pairedRoots);
  }
  const replacement = cmFreeze([cmStatus('new'), cmStatus('after')] as const);
  for (const value of [replacement, null, pair, null] as const) {
    meter.replaceStatus('fence', value);
    model[4] = value;
    check(pairedRoots);
  }
  check([envelope]);
  check([]);
});

test('CR-CM03 exact UTF8 escaping omissions array nulls and duplicated envelope text', () => {
  const meter = createCompareOwnerRootBytes();
  const pair = cmFreeze([
    cmStatus('before', 1, ' é"\\Ω '),
    cmStatus('after'),
  ] as const);
  const wrapper = cmWrapper('before', true, 'https://example.test/é"\\a');
  meter.replaceStatus('baseline', pair);
  meter.appendReport('beforeA', wrapper);
  const escaped = '"\\\b\f\n\r\t\u0000';
  const unicode = 'éΩ😀e\u0301';
  const lone = '\ud800';
  expect(JSON.stringify(escaped)).toBe('"\\"\\\\\\b\\f\\n\\r\\t\\u0000"');
  expect(Buffer.byteLength(JSON.stringify(escaped), 'utf8')).toBe(22);
  expect(JSON.stringify(unicode)).toBe('"éΩ😀e\u0301"');
  expect(Buffer.byteLength(JSON.stringify(unicode), 'utf8')).toBe(13);
  expect(JSON.stringify(lone)).toBe('"\\ud800"');
  expect(Buffer.byteLength(JSON.stringify(lone), 'utf8')).toBe(8);
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = 'value';
  const omitted = { omit: undefined, keep: null };
  const array = [undefined, ...sparse];
  expect(JSON.stringify(omitted)).toBe('{"keep":null}');
  expect(JSON.stringify(array)).toBe('[null,null,"value"]');
  const data = {
    escaped,
    unicode,
    lone,
    values: [null, true, false, 0, -0, 1.25, 1e21],
    omitted,
    array,
    sparse,
  };
  const envelope = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
  for (const roots of [[data], [envelope], [data, envelope, data]]) {
    expect(meter.bytes(roots)).toBe(
      cmFrameBytes([pair, [wrapper], [], [], null, roots]),
    );
  }
});

test('CR-CM04 fresh Map Set entries aliases and frozen collection mutations', () => {
  const meter = createCompareOwnerRootBytes();
  const value = { text: 'first' };
  const set = new Set<unknown>();
  const map = new Map<unknown, unknown>();
  const nested = new Map<unknown, unknown>([['set', set]]);
  const roots = [map, nested, set, map];
  const check = () =>
    expect(meter.bytes(roots)).toBe(
      cmFrameBytes([null, [], [], [], null, roots]),
    );
  check();
  map.set('value', value);
  map.set(undefined, null);
  map.set(null, undefined);
  set.add(undefined);
  set.add(null);
  set.add(value);
  check();
  value.text = 'longer value Ω';
  check();
  map.delete('value');
  map.set('value', value); // insertion order changes, with the same object.
  set.delete(value);
  set.add(value);
  check();
  Object.freeze(map);
  Object.freeze(set);
  map.set('still mutable', nested);
  set.add('still mutable');
  check();
  map.delete('still mutable');
  set.delete('still mutable');
  check();
  set.clear();
  check();
  map.clear();
  nested.clear();
  check();
});

test('CR-CM05 settled registrations encode once and every extra root stays freshly visited', () => {
  const original = JSON.stringify;
  const receipts: unknown[] = [];
  for (const count of [1, 2, 4]) {
    for (const observations of [3, 9]) {
      const wrappers = Array.from({ length: count }, (_, i) =>
        cmWrapper('task-' + i),
      );
      const baseline = cmFreeze([
        cmStatus('before'),
        cmStatus('after'),
      ] as const);
      const fence = cmFreeze([cmStatus('fence'), cmStatus('after')] as const);
      const expected: number[] = [];
      const model = cmEmptyFrame();
      const expectedWork = { index: 0 };
      model[0] = baseline;
      for (const wrapper of wrappers) {
        model[1].push(wrapper);
        model[4] = fence;
        for (let i = 0; i < observations; i++) {
          expectedWork.index = i;
          model[5] = [expectedWork];
          expected.push(cmFrameBytes(model));
        }
      }
      for (let i = 0; i < observations; i++) {
        expectedWork.index = i;
        model[5] = [wrappers[0], expectedWork];
        expected.push(cmFrameBytes(model));
      }
      const visits = new Map<object, number>();
      let calls = 0;
      type Replacer = (this: unknown, key: string, value: unknown) => unknown;
      function record(
        value: unknown,
        replacer?: Replacer,
        space?: string | number,
      ): string;
      function record(
        value: unknown,
        replacer?: (number | string)[] | null,
        space?: string | number,
      ): string;
      function record(
        value: unknown,
        replacer?: Replacer | (number | string)[] | null,
        space?: string | number,
      ): string {
        calls++;
        if (typeof replacer !== 'function')
          return original(value, replacer, space);
        return original(
          value,
          function (key, entry: unknown) {
            if (entry !== null && typeof entry === 'object')
              visits.set(entry, (visits.get(entry) ?? 0) + 1);
            return replacer.call(this, key, entry);
          },
          space,
        );
      }
      const meter = createCompareOwnerRootBytes();
      const work = { index: 0 };
      const roots = [work];
      const actual: number[] = [];
      let normalWrapperVisits: number[],
        normalWorkVisits: number,
        normalCalls: number;
      try {
        JSON.stringify = record;
        meter.replaceStatus('baseline', baseline);
        for (const wrapper of wrappers) {
          meter.appendReport('beforeA', wrapper);
          meter.replaceStatus('fence', fence);
          for (let i = 0; i < observations; i++) {
            work.index = i;
            actual.push(meter.bytes(roots));
          }
        }
        normalWrapperVisits = wrappers.map(
          (wrapper) => visits.get(wrapper) ?? 0,
        );
        normalWorkVisits = visits.get(work) ?? 0;
        normalCalls = calls;
        for (let i = 0; i < observations; i++) {
          work.index = i;
          actual.push(meter.bytes([wrappers[0], work]));
        }
      } finally {
        JSON.stringify = original;
      }
      expect(actual).toEqual(expected);
      expect(normalWrapperVisits).toEqual(wrappers.map(() => 1));
      expect(visits.get(baseline)).toBe(1);
      expect(visits.get(fence)).toBe(count);
      expect(normalWorkVisits).toBe(count * observations);
      expect(normalCalls).toBe(1 + 2 * count + count * observations);
      expect(calls).toBe(1 + 2 * count + (count + 1) * observations);
      expect(visits.get(work)).toBe((count + 1) * observations);
      expect(visits.get(wrappers[0]!)).toBe(1 + observations);
      receipts.push({
        count,
        observations,
        normalCalls,
        calls,
        baselineVisits: visits.get(baseline),
        fenceVisits: visits.get(fence),
        normalWrapperVisits,
        aliasedWrapperVisits: visits.get(wrappers[0]!),
        normalWorkVisits,
        workVisits: visits.get(work),
      });
    }
  }
  expect(JSON.stringify).toBe(original);
  console.info('CR-CM05 scalar-operation-counts ' + original(receipts));
});

test('CR-CM07 original fixed faults escape pure comparison publication and nested notifications', () => {
  const beforeWrapper = cmWrapper('before');
  const afterWrapper = cmWrapper('after', false);
  const beforeStatus = cmStatus('before');
  const afterStatus = cmStatus('after', 0);
  const generic = {
    status: 'compared',
    reportKind: 'links',
    family: 'google/indexer',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: { ...expectedScope },
    before: {
      status: beforeStatus,
      report: beforeWrapper.projection.metadata,
      settled: true,
      coverage: {
        observedIndexedCount: 1,
        observedUnindexedCount: 0,
        observedUniqueUrlCount: 1,
        indexedDuplicateCount: 0,
        unindexedDuplicateCount: 0,
        conflictingUrlCount: 0,
        reportedSlotGap: 0,
        indexedEnumerationGap: 0,
      },
    },
    after: {
      status: afterStatus,
      report: afterWrapper.projection.metadata,
      settled: true,
      coverage: {
        observedIndexedCount: 0,
        observedUnindexedCount: 1,
        observedUniqueUrlCount: 1,
        indexedDuplicateCount: 0,
        unindexedDuplicateCount: 0,
        conflictingUrlCount: 0,
        reportedSlotGap: 0,
        indexedEnumerationGap: 0,
      },
    },
    rows: [
      {
        url: a,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'reported_indexed_to_unindexed',
      },
    ],
    counts: {
      reportedUnindexedToIndexed: 0,
      reportedIndexedToUnindexed: 1,
      unchangedIndexed: 0,
      unchangedUnindexed: 0,
      unknown: 0,
      total: 1,
    },
  } satisfies CompareReportsResult;
  const blStatus = (id: string) =>
    cmFreeze({
      ...cmStatus(id),
      type: 'backlink/checker',
      indexedCount: null,
      targetDomains: ['Example.test'],
    } satisfies CompareStatusProjection);
  const blWrapper = (taskId: string) =>
    cmFreeze({
      projection: {
        family: 'backlink/checker',
        reportKind: 'backlink',
        taskId,
        size: 1,
        processedCount: 1,
        isCompleted: true,
        page: 0,
        lastPage: 0,
        donors: [
          {
            donorUrl: 'https://example.test/donor',
            processedWitness: true,
            evidence: { state: 'reported', targetLinks: [] },
          },
        ],
        rawTargetLinkCount: 0,
        duplicateTargetLinkCount: 0,
      } satisfies CompareBacklinkProjection,
      donorRawTargetCounts: [0],
    });
  const fixtures = [
    {
      input,
      before: { status: beforeStatus, reports: [beforeWrapper.projection] },
      after: { status: afterStatus, reports: [afterWrapper.projection] },
      wrappers: [beforeWrapper, afterWrapper],
      expected: generic,
    },
    {
      input: { ...input, family: 'backlink/checker' } as const,
      before: {
        status: blStatus('before'),
        reports: [blWrapper('before').projection],
      },
      after: {
        status: blStatus('after'),
        reports: [blWrapper('after').projection],
      },
      wrappers: [blWrapper('before'), blWrapper('after')],
      expected: literalBacklinkResult(),
    },
  ];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const fixture of fixtures) {
    for (const boundary of ['comparison', 'publication'] as const) {
      type Injection = {
        fault: CompareReportsFault;
        phase: 'pre' | 'post' | 'checkpoint';
        at: number;
      };
      const run = (injection?: Injection) => {
        const meter = createCompareOwnerRootBytes();
        const pair = cmFreeze([
          fixture.before.status,
          fixture.after.status,
        ] as const);
        meter.replaceStatus('baseline', pair);
        meter.appendReport('beforeA', fixture.wrappers[0]);
        meter.appendReport('afterA', fixture.wrappers[1]);
        let checkpoints = 0;
        const trace: { semantic: boolean; freeze: boolean }[] = [];
        const checkpoint = () => {
          checkpoints++;
          if (injection?.phase === 'checkpoint' && checkpoints === injection.at)
            throw injection.fault;
        };
        const observeWork = (roots: readonly unknown[]) => {
          trace.push({
            semantic:
              roots.some(
                (root) =>
                  isRecord(root) &&
                  Array.isArray(root.rows) &&
                  isRecord(root.counts),
              ) &&
              roots.some((root) => root instanceof Map || root instanceof Set),
            freeze: roots.some(
              (root) => Array.isArray(root) && root.includes('compared'),
            ),
          });
          if (injection?.phase === 'pre' && trace.length === injection.at)
            throw injection.fault;
          const measured = meter.bytes(roots);
          expect(measured).toBe(
            cmFrameBytes([
              pair,
              [fixture.wrappers[0]],
              [fixture.wrappers[1]],
              [],
              null,
              roots,
            ]),
          );
          if (injection?.phase === 'post' && trace.length === injection.at)
            throw injection.fault;
        };
        const result =
          boundary === 'comparison'
            ? compareProjectedReports(
                fixture.input,
                fixture.before,
                fixture.after,
                checkpoint,
                observeWork,
              )
            : compareReportsToolResult(fixture.expected, {
                checkpoint,
                observeWork,
              });
        return { result, trace, checkpoints };
      };
      const control = run();
      expect<unknown>(control.result).toEqual(
        boundary === 'comparison'
          ? fixture.expected
          : independentEnvelope(fixture.expected),
      );
      const semantic = control.trace.findIndex((visit) => visit.semantic) + 1;
      const freeze = control.trace.findIndex((visit) => visit.freeze) + 1;
      expect(semantic).toBeGreaterThan(1);
      expect(freeze).toBeGreaterThan(semantic);
      expect(control.checkpoints).toBeGreaterThan(1);
      for (const code of [
        'ResourceLimitExceeded',
        'Cancelled',
        'DeadlineExceeded',
      ] as const) {
        const fault = new CompareReportsFault(code);
        for (const injection of [
          { phase: 'pre', at: 1 },
          { phase: 'post', at: 1 },
          { phase: 'pre', at: semantic },
          { phase: 'post', at: freeze },
          { phase: 'checkpoint', at: 2 },
        ] as const) {
          let caught: unknown;
          try {
            run({ ...injection, fault });
          } catch (error) {
            caught = error;
          }
          expect<unknown>(caught).toBe(fault);
        }
      }
    }
  }
});

test('CR-CM08 unchanged 64 literal frames retain exact bytes peaks and envelope sizes', () => {
  const oracle = compareLiteralFrameOracle();
  const savedFrames = JSON.stringify(oracle.frames);
  expect(Object.keys(oracle.frames)).toHaveLength(64);
  for (const [name, frame] of Object.entries(oracle.frames)) {
    expect(frame).toHaveLength(6);
    const meter = createCompareOwnerRootBytes();
    for (const [slot, index] of [
      ['baseline', 0],
      ['fence', 4],
    ] as const) {
      const component: unknown = frame[index];
      if (component !== null && !Array.isArray(component))
        throw new Error('Missing literal status-pair image.');
      meter.replaceStatus(slot, cmFreeze(structuredClone(component)));
    }
    for (const [slot, index] of [
      ['beforeA', 1],
      ['afterA', 2],
      ['currentB', 3],
    ] as const) {
      const component: unknown = frame[index];
      if (!Array.isArray(component))
        throw new Error('Missing literal report-array image.');
      for (const wrapper of component)
        meter.appendReport(slot, cmFreeze(structuredClone(wrapper)));
    }
    const work: unknown = frame[5];
    if (!Array.isArray(work))
      throw new Error('Missing literal work-root image.');
    expect<number | undefined>(meter.bytes(work)).toBe(oracle.frameBytes[name]);
  }
  expect(JSON.stringify(oracle.frames)).toBe(savedFrames);
  // backlinkSecondTaskIndex remains a historical conceptual image. The
  // unchanged CR-MP01-ROOTS case separately proves the actual paired frame.
  expect(oracle.fixturePeaks).toEqual({ generic: 22271, backlink: 25199 });
  expect(oracle.envelopeBytes).toBe(5196);
  expect(oracle.backlinkEnvelopeBytes).toBe(5744);
});

// CR-AC: independent fixtures; only this test-owned allocation helper freezes.
type AcMeter = ReturnType<typeof createCompareOwnerRootBytes>;
function acClose<T>(meter: AcMeter, value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) acClose(meter, child);
    Object.freeze(value);
    expect(meter.certifyOwned(value)).toBe(true);
  }
  return value;
}
function acDeepFrozen(value: unknown) {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) acDeepFrozen(child);
  }
}

test('CR-AC01 certified tiny Unicode escaped nested aliases keep exact cold warm six-slot bytes', () => {
  const meter = createCompareOwnerRootBytes();
  const model = cmEmptyFrame();
  const tiny = [{}, []];
  expect(cmFrameBytes([null, [], [], [], null, tiny])).toBe(28);
  expect(meter.bytes(tiny)).toBe(28);
  for (const child of tiny) acClose(meter, child);
  expect(meter.bytes(tiny)).toBe(28); // Both 2-byte children need -2 corrections.
  const data = {
    tiny,
    unicode: 'éΩ😀e\u0301',
    escaped: '"\\\b\f\n\r\t\u0000',
    lone: '\ud800',
    omitted: undefined,
    values: [null, undefined, true, false, -0, 1.25, 1e21],
  };
  const sparse: unknown[] = [undefined, null];
  sparse.length = 4;
  const parent = { data, alias: data, sparse, omitted: undefined };
  const check = (roots: readonly unknown[]) => {
    model[5] = roots;
    expect(meter.bytes(roots)).toBe(cmFrameBytes(model));
  };
  check([parent, data]);
  acClose(meter, data);
  for (let reuse = 0; reuse < 3; reuse++) check([parent, data, data]);
  const pair = acClose(meter, [data, data]);
  for (const slot of ['baseline', 'fence'] as const) {
    meter.replaceStatus(slot, pair);
    model[slot === 'baseline' ? 0 : 4] = pair;
  }
  const wrapper = acClose(meter, { projection: data, sidecar: [] });
  for (const [slot, index] of [
    ['beforeA', 1],
    ['afterA', 2],
    ['currentB', 3],
    ['beforeA', 1],
  ] as const) {
    meter.appendReport(slot, wrapper);
    model[index].push(wrapper);
    check([wrapper, pair, parent]);
  }
  const envelope = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
  check([envelope, data]);
  acClose(meter, envelope);
  check([envelope, envelope, data]);
  const n = cmFrameBytes(model);
  const admit = (limit: number) => {
    if (meter.bytes(model[5]) > limit)
      throw new CompareReportsFault('ResourceLimitExceeded');
  };
  expect(() => admit(n)).not.toThrow();
  expect(() => admit(n - 1)).toThrow(CompareReportsFault);
  expect(Object.isFrozen(parent)).toBe(false);
  expect(Object.isFrozen(sparse)).toBe(false);
});

test('CR-AC02 mutable prefixes builders shallow freezes and frozen collections never acquire stale bytes', () => {
  const meter = createCompareOwnerRootBytes();
  const closed = acClose(meter, { url: a, nested: [] });
  const rows: unknown[] = [];
  const counts: Record<string, unknown> = {};
  const draft = { rows, counts };
  const parsed = { success: true, data: draft };
  const child = { label: 'same', rows };
  const shallow = Object.freeze({ child, closed });
  const map = Object.freeze(new Map<unknown, unknown>([['closed', closed]]));
  const set = Object.freeze(new Set<unknown>([closed]));
  const roots = [closed, rows, counts, draft, parsed, shallow, map, set];
  const check = () =>
    expect(meter.bytes(roots)).toBe(
      cmFrameBytes([null, [], [], [], null, roots]),
    );
  for (const invalid of [rows, counts, draft, parsed, shallow, map, set])
    expect(meter.certifyOwned(invalid)).toBe(false);
  check();
  rows.push(closed, { value: 'one' });
  Object.assign(counts, { total: 2, label: 'same' });
  check();
  child.label = 'size';
  counts.label = 'size';
  check();
  child.label = 'longer Ω';
  rows.reverse();
  map.set('new', rows);
  set.add('new');
  check();
  rows.pop();
  delete counts.label;
  Object.assign(counts, { total: 1, unknown: 1 });
  map.delete('closed');
  map.set('closed', closed);
  set.delete(closed);
  set.add(closed);
  check();
  map.clear();
  set.clear();
  rows.length = 0;
  check();
  for (const caller of [rows, counts, draft, parsed, child])
    expect(Object.isFrozen(caller)).toBe(false);
  const unregisteredChild = Object.freeze({
    value: 'closed but not certified',
  });
  const unregisteredParent = Object.freeze({ unregisteredChild });
  expect(meter.certifyOwned(unregisteredParent)).toBe(false);
  expect(meter.certifyOwned(unregisteredChild)).toBe(true);
  expect(meter.certifyOwned(unregisteredParent)).toBe(true);
  const sparse = Object.freeze(new Array(2));
  const decorated = Object.freeze(Object.assign([1], { extra: 'ignored' }));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  Object.freeze(cycle);
  const proxy = new Proxy(Object.freeze({ value: 1 }), {
    getPrototypeOf() {
      throw new Error('Proxy must not be inspected.');
    },
    ownKeys() {
      throw new Error('Proxy must not be inspected.');
    },
  });
  for (const invalid of [
    sparse,
    decorated,
    cycle,
    proxy,
    Object.freeze(new Date(0)),
  ])
    expect(meter.certifyOwned(invalid)).toBe(false);
});

test('CR-AC03 native accessor toJSON collection order and failures preserve independent semantics', () => {
  const run = (
    mode: 'ordinary' | 'getter' | 'toJSON' | 'cycle' | 'collectionCycle',
    optimized: boolean,
  ) => {
    const meter = createCompareOwnerRootBytes();
    const safe = acClose(meter, { nested: { label: 'é"\\Ω' }, empty: [] });
    const trace: string[] = [];
    const sentinel = new Error('independent sentinel');
    const accessor = Object.freeze({
      get value() {
        trace.push('get:value');
        if (mode === 'getter') throw sentinel;
        return safe;
      },
    });
    const custom = Object.freeze({
      toJSON(key: string) {
        trace.push('toJSON:' + key);
        if (mode === 'toJSON') throw sentinel;
        return { key, safe };
      },
    });
    const inherited = Object.freeze(
      Object.create({
        get toJSON() {
          trace.push('inherited:get');
          return () => 'inherited';
        },
      }) as object,
    );
    for (const invalid of [accessor, custom, inherited])
      expect(meter.certifyOwned(invalid)).toBe(false);
    expect(trace).toEqual([]); // Rejection never executes an accessor/toJSON.
    const map = new Map<unknown, unknown>([
      ['custom', custom],
      ['safe', safe],
    ]);
    const set = new Set<unknown>([custom, safe, undefined]);
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = undefined;
    const roots: unknown[] = [
      accessor,
      { left: custom, right: custom },
      map,
      set,
      inherited,
      sparse,
      null,
    ];
    if (mode === 'cycle') {
      const cycle: { self?: unknown } = {};
      cycle.self = cycle;
      roots.push(cycle);
    }
    if (mode === 'collectionCycle') {
      const link = { map };
      map.set('cycle', link);
    }
    try {
      const measured = optimized
        ? meter.bytes(roots)
        : cmFrameBytes([null, [], [], [], null, roots]);
      return { measured, trace, error: null, sentinel: false };
    } catch (error) {
      return {
        measured: null,
        trace,
        error: error instanceof Error ? error.name : typeof error,
        sentinel: error === sentinel,
      };
    }
  };
  for (const mode of [
    'ordinary',
    'getter',
    'toJSON',
    'cycle',
    'collectionCycle',
  ] as const) {
    const reference = run(mode, false);
    expect(run(mode, true)).toEqual(reference);
    if (mode === 'ordinary') expect(reference.error).toBeNull();
    else expect(reference.error).not.toBeNull();
    if (mode === 'getter' || mode === 'toJSON')
      expect(reference.sentinel).toBe(true);
  }
  const meter = createCompareOwnerRootBytes();
  const root = acClose(meter, { tag: 'root', nested: { tag: 'leaf' } });
  const trace: string[] = [];
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value(this: { tag?: string }, key: string) {
        if (Object.hasOwn(this, 'tag')) trace.push(this.tag + '/' + key);
        return this.tag === 'leaf' ? 'changed/' + key : this;
      },
    });
    expect(meter.certifyOwned(Object.freeze({ new: true }))).toBe(false);
    expect(trace).toEqual([]);
    const expected = cmFrameBytes([null, [], [], [], null, [root, root]]);
    const expectedTrace = [...trace];
    trace.length = 0;
    expect(meter.bytes([root, root])).toBe(expected);
    expect(trace).toEqual(expectedTrace);
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'toJSON', prior);
    else Reflect.deleteProperty(Object.prototype, 'toJSON');
  }
});

function acFixture(backlink: boolean) {
  if (backlink) {
    const expected = literalBacklinkResult();
    const projection = (id: string): CompareBacklinkProjection => ({
      family: 'backlink/checker',
      reportKind: 'backlink',
      taskId: id,
      size: 1,
      processedCount: 1,
      isCompleted: true,
      page: 0,
      lastPage: 0,
      donors: [
        {
          donorUrl: 'https://example.test/donor',
          processedWitness: true,
          evidence: { state: 'reported', targetLinks: [] },
        },
      ],
      rawTargetLinkCount: 0,
      duplicateTargetLinkCount: 0,
    });
    return {
      args: { ...input, family: 'backlink/checker' } as const,
      before: {
        status: structuredClone(expected.before.status),
        reports: [projection('before')],
      },
      after: {
        status: structuredClone(expected.after.status),
        reports: [projection('after')],
      },
      expected,
    };
  }
  const before = {
    status: structuredClone(cmStatus('before')),
    reports: [structuredClone(cmWrapper('before').projection)],
  };
  const after = {
    status: structuredClone(cmStatus('after', 0)),
    reports: [structuredClone(cmWrapper('after', false).projection)],
  };
  const summary = (id: string, indexed: boolean) => ({
    status: structuredClone(cmStatus(id, indexed ? 1 : 0)),
    report: structuredClone(cmWrapper(id, indexed).projection.metadata),
    settled: true,
    coverage: {
      observedIndexedCount: indexed ? 1 : 0,
      observedUnindexedCount: indexed ? 0 : 1,
      observedUniqueUrlCount: 1,
      indexedDuplicateCount: 0,
      unindexedDuplicateCount: 0,
      conflictingUrlCount: 0,
      reportedSlotGap: 0,
      indexedEnumerationGap: 0,
    },
  });
  const expected: CompareReportsResult = {
    status: 'compared',
    reportKind: 'links',
    family: 'google/indexer',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: { ...expectedScope },
    before: summary('before', true),
    after: summary('after', false),
    rows: [
      {
        url: a,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'reported_indexed_to_unindexed',
      },
    ],
    counts: {
      reportedUnindexedToIndexed: 0,
      reportedIndexedToUnindexed: 1,
      unchangedIndexed: 0,
      unchangedUnindexed: 0,
      unknown: 0,
      total: 1,
    },
  };
  return { args: input, before, after, expected };
}

test('CR-AC04 actual private completion validation freeze roots and first cause keep full frame bytes', () => {
  for (const backlink of [false, true]) {
    for (const publication of [false, true]) {
      const run = (
        limit = Number.POSITIVE_INFINITY,
        injection?: 'completion' | 'checkpoint' | 'freeze',
      ) => {
        const fixture = acFixture(backlink);
        const meter = createCompareOwnerRootBytes();
        const original = publication
          ? structuredClone(fixture.expected)
          : fixture.before;
        const callerObjects = new Set<object>();
        const callers = (value: unknown) => {
          if (value !== null && typeof value === 'object') {
            callerObjects.add(value);
            for (const child of Object.values(value)) callers(child);
          }
        };
        callers(original);
        callers(fixture.after);
        const fault = new CompareReportsFault('Cancelled');
        let peak = 0,
          frames = 0,
          completions = 0,
          descriptors = 0,
          freezeFrames = 0;
        let checkpointPending = false;
        const checkpoint = () => {
          if (checkpointPending) throw fault;
        };
        const observe = (roots: readonly unknown[], completed?: object) => {
          frames++;
          const reference = cmFrameBytes([null, [], [], [], null, roots]);
          expect(meter.bytes(roots)).toBe(reference);
          peak = Math.max(peak, reference);
          if (reference > limit)
            throw new CompareReportsFault('ResourceLimitExceeded');
          if (
            roots.some(
              (root) => Array.isArray(root) && root.includes('compared'),
            )
          ) {
            freezeFrames++;
            if (injection === 'freeze') throw fault;
          }
          if (
            roots.some(
              (root) =>
                root !== null &&
                typeof root === 'object' &&
                Object.hasOwn(root, 'writable') &&
                Object.hasOwn(root, 'configurable'),
            )
          )
            descriptors++;
          if (completed) {
            completions++;
            expect(callerObjects.has(completed)).toBe(false);
            acDeepFrozen(completed);
            if (injection === 'completion') throw fault;
            expect(
              meter.certifyOwned(completed, (extra) =>
                observe([...roots, ...extra]),
              ),
            ).toBe(true);
            if (injection === 'checkpoint') checkpointPending = true;
          }
        };
        let result: unknown, caught: unknown;
        try {
          result = publication
            ? compareReportsToolResult(original, {
                checkpoint,
                observeWork: observe,
              })
            : compareProjectedReports(
                fixture.args,
                fixture.before,
                fixture.after,
                checkpoint,
                observe,
              );
        } catch (error) {
          caught = error;
        }
        for (const value of callerObjects)
          expect(Object.isFrozen(value)).toBe(false);
        if (!caught) {
          expect(result).toEqual(
            publication
              ? independentEnvelope(fixture.expected)
              : fixture.expected,
          );
          acDeepFrozen(result);
          fixture.before.reports.length = 0;
          fixture.after.status.id = 'still caller mutable';
        }
        if (injection) expect(caught).toBe(fault);
        return { peak, frames, completions, descriptors, freezeFrames, caught };
      };
      const control = run();
      expect(control.caught).toBeUndefined();
      for (const count of [
        control.frames,
        control.completions,
        control.descriptors,
        control.freezeFrames,
      ])
        expect(count).toBeGreaterThan(0);
      expect(run(control.peak).caught).toBeUndefined();
      expect(run(control.peak - 1).caught).toMatchObject({
        code: 'ResourceLimitExceeded',
      });
      for (const injection of ['completion', 'checkpoint', 'freeze'] as const)
        run(undefined, injection);
    }
  }
  const oracle = compareLiteralFrameOracle();
  expect(Object.keys(oracle.frames)).toHaveLength(64);
  for (const [name, saved] of Object.entries(oracle.frames)) {
    const frame = structuredClone(saved);
    const meter = createCompareOwnerRootBytes();
    for (const [slot, index] of [
      ['baseline', 0],
      ['fence', 4],
    ] as const) {
      const component = frame[index];
      if (component !== null && !Array.isArray(component))
        throw new Error('Invalid literal pair.');
      meter.replaceStatus(slot, acClose(meter, component));
    }
    for (const [slot, index] of [
      ['beforeA', 1],
      ['afterA', 2],
      ['currentB', 3],
    ] as const) {
      const component = frame[index];
      if (!Array.isArray(component))
        throw new Error('Invalid literal reports.');
      for (const wrapper of component)
        meter.appendReport(slot, acClose(meter, wrapper));
    }
    const roots = frame[5];
    if (!Array.isArray(roots)) throw new Error('Invalid literal roots.');
    acClose(meter, roots);
    expect(meter.bytes(roots)).toBe(oracle.frameBytes[name]!);
  }
  const caller = { invalid: { mutable: true } };
  expect(compareReportsToolResult(caller)).toEqual(
    independentEnvelope(compareReportsError('InternalError')),
  );
  caller.invalid.mutable = false;
  expect(Object.isFrozen(caller.invalid)).toBe(false);
});

test('CR-AC05 invocation weak ownership reset fence aliases and certified child visitation stay isolated', () => {
  const first = createCompareOwnerRootBytes();
  const second = createCompareOwnerRootBytes();
  const closed = acClose(first, { child: { label: 'é' } });
  const mutable = { closed };
  const roots = [closed, closed, mutable];
  const expected = cmFrameBytes([null, [], [], [], null, roots]);
  const original = JSON.stringify;
  const visits = { roots: 0, children: 0, mutable: 0, calls: 0 };
  type Replacer = (this: unknown, key: string, value: unknown) => unknown;
  function record(
    value: unknown,
    replacer?: Replacer,
    space?: string | number,
  ): string;
  function record(
    value: unknown,
    replacer?: (number | string)[] | null,
    space?: string | number,
  ): string;
  function record(
    value: unknown,
    replacer?: Replacer | (number | string)[] | null,
    space?: string | number,
  ): string {
    visits.calls++;
    if (typeof replacer !== 'function') return original(value, replacer, space);
    return original(
      value,
      function (key, entry: unknown) {
        if (entry === closed) visits.roots++;
        if (entry === closed.child) visits.children++;
        if (entry === mutable) visits.mutable++;
        return replacer.call(this, key, entry);
      },
      space,
    );
  }
  let warm: typeof visits, fresh: typeof visits;
  try {
    JSON.stringify = record;
    expect(first.bytes(roots)).toBe(expected);
    warm = { ...visits };
    visits.roots = visits.children = visits.mutable = visits.calls = 0;
    expect(second.bytes(roots)).toBe(expected);
    fresh = { ...visits };
  } finally {
    JSON.stringify = original;
  }
  expect(warm).toEqual({ roots: 3, children: 0, mutable: 1, calls: 1 });
  expect(fresh).toEqual({ roots: 3, children: 3, mutable: 1, calls: 1 });
  const model = cmEmptyFrame();
  const pair = acClose(first, [closed, closed]);
  const wrapper = acClose(first, {
    projection: closed,
    donorRawTargetCounts: [],
  });
  first.replaceStatus('baseline', pair);
  model[0] = pair;
  for (let iteration = 0; iteration < 3; iteration++) {
    first.appendReport('currentB', wrapper);
    model[3].push(wrapper);
    first.replaceStatus('fence', pair);
    model[4] = pair;
    model[5] = roots;
    expect(first.bytes(roots)).toBe(cmFrameBytes(model));
    first.clearCurrentB();
    model[3] = [];
    first.replaceStatus('fence', null);
    model[4] = null;
    expect(first.bytes(roots)).toBe(cmFrameBytes(model));
    expect(second.bytes(roots)).toBe(expected);
  }
  const fault = new CompareReportsFault('DeadlineExceeded');
  const failed = Object.freeze({ value: 'not installed on exception' });
  expect(() =>
    first.certifyOwned(failed, () => {
      throw fault;
    }),
  ).toThrow(fault);
  const independent = createCompareOwnerRootBytes();
  const logicalCopy = structuredClone(closed);
  const independentRoots = [failed, logicalCopy, closed, logicalCopy];
  expect(independent.bytes(independentRoots)).toBe(
    cmFrameBytes([null, [], [], [], null, independentRoots]),
  );
  logicalCopy.child.label = 'fresh mutable Ω';
  expect(independent.bytes(independentRoots)).toBe(
    cmFrameBytes([null, [], [], [], null, independentRoots]),
  );
  console.info(
    'CR-AC05 certified-operation-counts ' + original({ warm, fresh }),
  );
});

test('CR-AC03-REJECT-OBSERVERS unsafe certification stays inert and valid six-slot work stays charged', () => {
  const effects: string[] = [];
  const unsafe = Object.freeze({
    get value() {
      effects.push('own getter');
      return 'observed';
    },
  });
  const throwing = new Error('unsupported toJSON must stay inert');
  const custom = Object.freeze({
    toJSON(key: string) {
      effects.push('own toJSON/' + key);
      return { key };
    },
  });
  const inherited = Object.freeze(
    Object.create({
      get toJSON() {
        effects.push('inherited getter');
        return () => 'unsupported';
      },
    }) as object,
  );
  const proxy = new Proxy(Object.freeze({ value: 'proxy' }), {
    get() {
      effects.push('proxy get');
      throw throwing;
    },
    getPrototypeOf() {
      effects.push('proxy prototype');
      throw throwing;
    },
    ownKeys() {
      effects.push('proxy keys');
      throw throwing;
    },
  });
  for (const candidate of [
    unsafe,
    custom,
    Object.freeze({
      toJSON() {
        effects.push('throwing toJSON');
        throw throwing;
      },
    }),
    inherited,
    Object.freeze({ child: unsafe }),
    Object.freeze({ child: { nested: unsafe } }),
    Object.freeze({ child: proxy }),
    proxy,
    Object.freeze(new Map([['unsafe', unsafe]])),
    Object.freeze(new Set([custom])),
  ]) {
    const meter = createCompareOwnerRootBytes();
    effects.length = 0;
    let accepted: boolean | undefined, caught: unknown;
    try {
      accepted = meter.certifyOwned(candidate, (roots) => {
        const reference = cmFrameBytes([null, [], [], [], null, roots]);
        expect(meter.bytes(roots)).toBe(reference);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
    expect(accepted).toBe(false);
    expect(effects).toEqual([]);
    // A rejected value must not become a numeric certificate on a second call.
    expect(meter.certifyOwned(candidate)).toBe(false);
    expect(effects).toEqual([]);
  }

  for (const prototype of [Object.prototype, Array.prototype]) {
    const meter = createCompareOwnerRootBytes();
    const closed = acClose(meter, { tag: 'warm', nested: { tag: 'leaf' } });
    const array = acClose(meter, [closed]);
    const prior = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    const trace: string[] = [];
    let getterCalls = 0;
    let accepted: boolean | undefined, arrayAccepted: boolean | undefined;
    let rejectionCalls: number;
    let measured: number, reference: number;
    let nativeTrace: string[], measuredTrace: string[];
    try {
      Object.defineProperty(prototype, 'toJSON', {
        configurable: true,
        get(this: object) {
          getterCalls++;
          const tracked =
            this === closed || this === closed.nested || this === array;
          if (tracked) trace.push('get');
          return function (this: object, key: string) {
            if (tracked) trace.push('call/' + key);
            return this === closed.nested ? 'native/' + key : this;
          };
        },
      });
      const observe = (roots: readonly unknown[]) => {
        cmFrameBytes([null, [], [], [], null, roots]);
        meter.bytes(roots);
      };
      accepted = meter.certifyOwned(closed, observe);
      arrayAccepted = meter.certifyOwned(array, observe);
      rejectionCalls = getterCalls;
      reference = cmFrameBytes([
        null,
        [],
        [],
        [],
        null,
        [array, closed, array],
      ]);
      nativeTrace = [...trace];
      trace.length = 0;
      measured = meter.bytes([array, closed, array]);
      measuredTrace = [...trace];
    } finally {
      if (prior) Object.defineProperty(prototype, 'toJSON', prior);
      else Reflect.deleteProperty(prototype, 'toJSON');
    }
    expect(Object.getOwnPropertyDescriptor(prototype, 'toJSON')).toEqual(prior);
    expect(accepted).toBe(false);
    expect(arrayAccepted).toBe(false);
    expect(rejectionCalls).toBe(0);
    expect(measured).toBe(reference);
    expect(measuredTrace).toEqual(nativeTrace);
    expect(nativeTrace.length).toBeGreaterThan(0);
  }

  const run = (
    limit = Number.POSITIVE_INFINITY,
    injection?: 'observer' | 'checkpoint',
  ) => {
    const meter = createCompareOwnerRootBytes();
    const model = cmEmptyFrame();
    const child = acClose(meter, { empty: [], text: 'é"\\\n' });
    const pair = acClose(meter, [child, child]);
    for (const [slot, index] of [
      ['baseline', 0],
      ['fence', 4],
    ] as const) {
      meter.replaceStatus(slot, pair);
      model[index] = pair;
    }
    const wrapper = acClose(meter, { projection: child, sidecar: [] });
    for (const [slot, index] of [
      ['beforeA', 1],
      ['afterA', 2],
      ['currentB', 3],
    ] as const) {
      meter.appendReport(slot, wrapper);
      model[index].push(wrapper);
    }
    const candidate = Object.freeze({
      child,
      value: 'valid',
      omitted: undefined,
    });
    const ancestors = [
      { candidate, mutable: new Map([['child', child]]) },
      ['candidate'],
    ];
    const fault = new CompareReportsFault('Cancelled');
    let peak = 0,
      frames = 0,
      checkpoints = 0,
      lateWork = 0;
    let failed = false,
      accepted: boolean | undefined,
      caught: unknown;
    const checkpoint = () => {
      if (failed) lateWork++;
      checkpoints++;
      if (injection === 'checkpoint') {
        failed = true;
        throw fault;
      }
    };
    const observe = (extra: readonly unknown[]) => {
      if (failed) lateWork++;
      frames++;
      expect(extra).toContain(candidate);
      const roots = [...ancestors, ...extra];
      model[5] = roots;
      const reference = cmFrameBytes(model);
      expect(meter.bytes(roots)).toBe(reference);
      peak = Math.max(peak, reference);
      if (reference > limit)
        throw new CompareReportsFault('ResourceLimitExceeded');
      if (injection === 'observer') {
        failed = true;
        throw fault;
      }
    };
    try {
      accepted = meter.certifyOwned(candidate, observe, checkpoint);
    } catch (error) {
      caught = error;
    }
    expect(lateWork).toBe(0);
    expect(Object.isFrozen(ancestors[0])).toBe(false);
    if (injection) {
      expect(caught).toBe(fault);
      let resumedFrames = 0;
      expect(
        meter.certifyOwned(candidate, () => {
          resumedFrames++;
        }),
      ).toBe(true);
      expect(resumedFrames).toBeGreaterThan(0);
    }
    return { accepted, caught, peak, frames, checkpoints };
  };
  const control = run();
  expect(control.accepted).toBe(true);
  expect(control.caught).toBeUndefined();
  expect(control.frames).toBeGreaterThan(0);
  expect(control.checkpoints).toBeGreaterThan(0);
  expect(run(control.peak).accepted).toBe(true);
  expect(run(control.peak - 1).caught).toMatchObject({
    code: 'ResourceLimitExceeded',
  });
  run(undefined, 'observer');
  run(undefined, 'checkpoint');
});

test('CR-PB01 original generic N22271 succeeds and N22270 refuses with native six-slot frames', () => {
  const originalN = 22271;
  const originalNMinusOne = 22270;
  const originalEnvelopeBytes = 5196;
  const guard = installCompareDefaultDeny();
  try {
    const oracle = compareLiteralFrameOracle();
    expect(Object.keys(oracle.frames)).toHaveLength(64);
    expect(oracle.envelopeBytes).toBe(originalEnvelopeBytes);
    const draftFrame = oracle.frames.pureDraft;
    const pendingFrame = oracle.frames.pendingEnvelope;
    if (!draftFrame || !pendingFrame)
      throw new Error('Missing original generic frames.');
    const expectedResult = (draftFrame[5] as readonly unknown[]).at(
      -1,
    ) as CompareReportsResult;
    const expectedEnvelope = (
      pendingFrame[5] as readonly unknown[]
    )[1] as ReturnType<typeof compareReportsToolResult>;
    const run = (limit: 22271 | 22270) => {
      const slots = structuredClone(draftFrame.slice(0, 5));
      const baseline = slots[0] as CompareStatusProjection[];
      const beforeA = slots[1] as {
        projection: CompareLinksProjection | CompareBacklinkProjection;
      }[];
      const afterA = slots[2] as {
        projection: CompareLinksProjection | CompareBacklinkProjection;
      }[];
      expect(baseline).toHaveLength(2);
      expect(beforeA).toHaveLength(1);
      expect(afterA).toHaveLength(1);
      expect(slots[3]).toEqual([]);
      expect(slots[4]).toBeNull();
      const meter = createCompareOwnerRootBytes();
      const seeded = new Set<object>();
      const seedFixture = (value: unknown): void => {
        if (value === null || typeof value !== 'object' || seeded.has(value))
          return;
        seeded.add(value);
        for (const child of Object.values(value)) seedFixture(child);
        Object.freeze(value);
        expect(meter.certifyOwned(value)).toBe(true);
      };
      seedFixture(baseline);
      for (const wrapper of beforeA) seedFixture(wrapper);
      for (const wrapper of afterA) seedFixture(wrapper);
      meter.replaceStatus('baseline', baseline);
      meter.replaceStatus('fence', null);
      for (const wrapper of beforeA) meter.appendReport('beforeA', wrapper);
      for (const wrapper of afterA) meter.appendReport('afterA', wrapper);
      const args = {
        family: 'google/indexer',
        beforeTaskId: 'before',
        afterTaskId: 'after',
      } as const satisfies CompareReportsInput;
      const before = {
        status: baseline[0]!,
        reports: beforeA.map((wrapper) => wrapper.projection),
      };
      const after = {
        status: baseline[1]!,
        reports: afterA.map((wrapper) => wrapper.projection),
      };
      const boundary = new CompareReportsFault('ResourceLimitExceeded');
      let peak = 0;
      const checkpoint = () => {};
      const observe = (roots: readonly unknown[], completed?: object): void => {
        checkpoint();
        const measured = meter.bytes(roots);
        const exact = cmFrameBytes([...slots, roots]);
        checkpoint();
        expect(measured).toBe(exact);
        peak = Math.max(peak, exact);
        if (exact > limit) throw boundary;
        if (completed) {
          expect(
            meter.certifyOwned(
              completed,
              (extra) => observe([...roots, ...extra]),
              checkpoint,
            ),
          ).toBe(true);
        }
      };
      let result: CompareReportsResult | undefined;
      let envelope: ReturnType<typeof compareReportsToolResult> | undefined;
      let caught: unknown;
      try {
        result = compareProjectedReports(
          args,
          before,
          after,
          checkpoint,
          observe,
        );
        expect(result).toEqual(expectedResult);
        envelope = compareReportsToolResult(result, {
          checkpoint,
          observeWork: observe,
        });
      } catch (error) {
        caught = error;
      }
      expect(Object.isFrozen(args)).toBe(false);
      expect(Object.isFrozen(before)).toBe(false);
      expect(Object.isFrozen(after)).toBe(false);
      return { result, envelope, caught, peak, boundary };
    };
    const atN = run(originalN);
    expect(atN.caught).toBeUndefined();
    expect(atN.result).toEqual(expectedResult);
    acDeepFrozen(atN.result);
    expect(atN.envelope).toEqual(independentEnvelope(atN.result!));
    expect(atN.envelope).toEqual(expectedEnvelope);
    expect(atN.envelope!.isError).toBe(false);
    expect(atN.envelope!.structuredContent).toEqual(atN.result!);
    expect(atN.envelope!.content[0]!.text).toBe(JSON.stringify(atN.result));
    expect(Buffer.byteLength(JSON.stringify(atN.envelope), 'utf8')).toBe(
      originalEnvelopeBytes,
    );
    expect(atN.peak).toBe(originalN);
    acDeepFrozen(atN.envelope);
    const below = run(originalNMinusOne);
    expect(below.result).toEqual(expectedResult);
    expect(below.envelope).toBeUndefined();
    expect(below.caught).toBe(below.boundary);
    expect(guard.calls()).toBe(0);
  } finally {
    guard.restore();
  }
});

test('CR-AC06-EMPTY frozen empty record charges candidate and own-key list at N28', () => {
  const originalN = 28;
  const originalNMinusOne = 27;
  const emptyFrame = [null, [], [], [], null, [{}, []]];
  expect(JSON.stringify(emptyFrame)).toBe('[null,[],[],[],null,[{},[]]]');
  expect(Buffer.byteLength(JSON.stringify(emptyFrame), 'utf8')).toBe(originalN);
  expect(cmFrameBytes(emptyFrame)).toBe(originalN);
  const run = (limit: 28 | 27) => {
    const meter = createCompareOwnerRootBytes();
    const candidate = Object.freeze({});
    const boundary = new CompareReportsFault('ResourceLimitExceeded');
    let observations = 0;
    let peak = 0;
    let accepted: boolean | undefined;
    let caught: unknown;
    const observe = (roots: readonly unknown[]): void => {
      observations++;
      expect(roots[0]).toBe(candidate);
      expect(roots[1]).toEqual([]);
      const reference = cmFrameBytes([null, [], [], [], null, roots]);
      expect(reference).toBe(originalN);
      expect(meter.bytes(roots)).toBe(reference);
      peak = Math.max(peak, reference);
      if (reference > limit) throw boundary;
    };
    try {
      accepted = meter.certifyOwned(candidate, observe);
    } catch (error) {
      caught = error;
    }
    expect(Object.isFrozen(candidate)).toBe(true);
    return { meter, candidate, accepted, caught, observations, peak, boundary };
  };
  const atN = run(originalN);
  expect(atN.caught).toBeUndefined();
  expect(atN.accepted).toBe(true);
  expect(atN.observations).toBeGreaterThan(0);
  expect(atN.peak).toBe(originalN);
  const below = run(originalNMinusOne);
  expect(below.accepted).toBeUndefined();
  expect(below.caught).toBe(below.boundary);
  expect(below.observations).toBeGreaterThan(0);
  let resumed = 0;
  expect(
    below.meter.certifyOwned(below.candidate, () => {
      resumed++;
    }),
  ).toBe(true);
  expect(resumed).toBeGreaterThan(0);
});

// CR-CPU: native receipts count production only; independent oracles use saved native.
function cpuFrameBytes(
  native: typeof JSON.stringify,
  roots: readonly unknown[],
): number {
  return Buffer.byteLength(
    native([null, [], [], [], null, roots], function (_key, value: unknown) {
      if (value instanceof Map) return Array.from(value.entries());
      if (value instanceof Set) return Array.from(value.values());
      return value;
    }),
    'utf8',
  );
}

function cpu01Certification(n: 32 | 128, limit: number, counted: boolean) {
  const native = JSON.stringify;
  const meter = createCompareOwnerRootBytes();
  const element = String.fromCodePoint(233, 34, 92, 10);
  const candidate = Object.freeze(Array.from({ length: n }, () => element));
  const ancestor = { left: candidate, right: candidate };
  const boundary = new CompareReportsFault('ResourceLimitExceeded');
  let production = false;
  let calls = 0;
  let volume = 0;
  let observations = 0;
  let peak = 0;
  let checkpoints = 0;
  let sameKeys: unknown;
  let accepted: boolean | undefined;
  let caught: unknown;
  type Replacer = (this: unknown, key: string, value: unknown) => unknown;
  function record(
    this: unknown,
    value: unknown,
    replacer?: Replacer,
    space?: string | number,
  ): string;
  function record(
    this: unknown,
    value: unknown,
    replacer?: (number | string)[] | null,
    space?: string | number,
  ): string;
  function record(this: unknown, ...args: unknown[]): string {
    const result: string = Reflect.apply(native, this, args);
    if (production) {
      calls++;
      if (result !== undefined) volume += Buffer.byteLength(result, 'utf8');
    }
    return result;
  }
  expect([...element].map((value) => value.codePointAt(0))).toEqual([
    233, 34, 92, 10,
  ]);
  expect(Buffer.byteLength(native(element), 'utf8')).toBe(10);
  expect(Buffer.byteLength(native(candidate), 'utf8')).toBe(
    n === 32 ? 353 : 1409,
  );
  expect(Buffer.byteLength(native(Reflect.ownKeys(candidate)), 'utf8')).toBe(
    n === 32 ? 160 : 668,
  );
  try {
    JSON.stringify = record;
    production = counted;
    accepted = meter.certifyOwned(
      candidate,
      (extra: readonly unknown[]): void => {
        const roots = [ancestor, ...extra];
        const actual = meter.bytes(roots);
        production = false;
        try {
          observations++;
          expect(extra).toHaveLength(3);
          expect(extra[0]).toBe(candidate);
          sameKeys ??= extra[1];
          expect(extra[1]).toBe(sameKeys);
          expect(extra[1]).toEqual(Reflect.ownKeys(candidate));
          const key = observations <= n ? String(observations - 1) : 'length';
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
          expect(extra[2]).toEqual(descriptor);
          expect(Buffer.byteLength(native(descriptor), 'utf8')).toBe(
            key === 'length' ? (n === 32 ? 69 : 70) : 76,
          );
          const exact = cpuFrameBytes(native, roots);
          expect(actual).toBe(exact);
          peak = Math.max(peak, exact);
          if (exact > limit) throw boundary;
        } finally {
          production = counted;
        }
      },
      (): void => {
        checkpoints++;
      },
    );
  } catch (error) {
    caught = error;
  } finally {
    production = false;
    JSON.stringify = native;
  }
  expect(JSON.stringify).toBe(native);
  expect(Object.isFrozen(ancestor)).toBe(false);
  return {
    meter,
    candidate,
    ancestor,
    boundary,
    accepted,
    caught,
    observations,
    checkpoints,
    peak,
    calls,
    volume,
  };
}

test('CR-CPU01 fixed32 and128 certification keeps full frames and native volume bounds', () => {
  const receipts: { n: number; calls: number; volume: number; cap: number }[] =
    [];
  for (const [n, peak, cap] of [
    [32, 1339, 5506],
    [128, 5015, 20922],
  ] as const) {
    const atN = cpu01Certification(n, peak, true);
    expect(atN.caught).toBeUndefined();
    expect(atN.accepted).toBe(true);
    expect(atN.peak).toBe(peak);
    expect(atN.observations).toBe(n + 1);
    expect(atN.checkpoints).toBeGreaterThan(n + 1);
    const roots = [atN.ancestor, atN.candidate, atN.candidate];
    expect(atN.meter.bytes(roots)).toBe(cpuFrameBytes(JSON.stringify, roots));
    const below = cpu01Certification(n, peak - 1, false);
    expect(below.accepted).toBeUndefined();
    expect(below.caught).toBe(below.boundary);
    expect(below.peak).toBe(peak);
    expect(below.observations).toBe(1);
    const other = createCompareOwnerRootBytes();
    let cold = 0;
    expect(
      other.certifyOwned(atN.candidate, (extra: readonly unknown[]): void => {
        cold++;
        expect(other.bytes(extra)).toBe(cpuFrameBytes(JSON.stringify, extra));
      }),
    ).toBe(true);
    expect(cold).toBe(n + 1);
    receipts.push({ n, calls: atN.calls, volume: atN.volume, cap });
  }
  console.info('CR-CPU01 native-volume ' + JSON.stringify(receipts));
  // All functional/full-frame/N-N1 checks above precede this expected old RED.
  for (const receipt of receipts)
    expect(receipt.volume).toBeLessThanOrEqual(receipt.cap);
});

test('CR-CPU02 WRITER real containers retain native order aliases and exact N/N-1 bytes', () => {
  const native = JSON.stringify;
  const run = (limit = Infinity) => {
    const meter = createCompareOwnerRootBytes();
    const tiny = acClose(meter, { label: 'é"\\', omitted: undefined });
    const larger = acClose(meter, { label: 'Ω larger value', empty: [] });
    const boundary = new CompareReportsFault('ResourceLimitExceeded');
    let peak = 0;
    let frames = 0;
    let complete = false;
    let caught: unknown;
    try {
      meter.measurementScope((writers) => {
        const array = writers.array<unknown>();
        const map = writers.map<unknown>();
        const set = writers.set<unknown>();
        const expectedArray: unknown[] = [];
        const expectedMap = new Map<string, unknown>();
        const expectedSet = new Set<unknown>();
        const ancestor = { array: array.value, map: map.value, set: set.value };
        const check = () => {
          expect(array.value).toEqual(expectedArray);
          expect([...map.value.entries()]).toEqual([...expectedMap.entries()]);
          expect([...set.value.values()]).toEqual([...expectedSet.values()]);
          const roots = [ancestor, array.value, map.value, set.value, ancestor];
          const exact = cpuFrameBytes(native, roots);
          expect(meter.bytes(roots)).toBe(exact);
          frames++;
          peak = Math.max(peak, exact);
          if (exact > limit) throw boundary;
        };
        check();
        for (const child of [undefined, tiny, tiny, null, -0, 'é"\\\n']) {
          array.append(child);
          expectedArray.push(child);
          check();
        }
        for (const [name, child] of [
          ['second', tiny],
          ['first', undefined],
          ['second', tiny],
          ['second', larger],
          ['second', tiny],
          ['Ω"\\', larger],
        ] as const) {
          map.put(name, child);
          expectedMap.set(name, child);
          check();
        }
        expect(map.value.get('second')).toBe(tiny);
        expect(map.value.get('Ω"\\')).toBe(larger);
        expect([...map.value.keys()]).toEqual(['second', 'first', 'Ω"\\']);
        for (const child of [undefined, undefined, -0, 0, tiny, tiny, larger]) {
          set.add(child);
          expectedSet.add(child);
          check();
        }
        expect(array.seal()).toBe(array.value);
        expect(map.seal()).toBe(map.value);
        expect(set.seal()).toBe(set.value);
        check();
        const parent = writers.array<unknown>();
        parent.append(array.value);
        parent.append(map.value);
        parent.append(set.value);
        parent.append(map.value);
        expect(parent.seal()).toBe(parent.value);
        const roots = [parent.value, ancestor, parent.value, map.value];
        const exact = cpuFrameBytes(native, roots);
        expect(meter.bytes(roots)).toBe(exact);
        peak = Math.max(peak, exact);
        frames++;
        if (exact > limit) throw boundary;
        complete = true;
      });
    } catch (error) {
      caught = error;
    }
    return { peak, frames, complete, caught, boundary };
  };
  const control = run();
  expect(control.caught).toBeUndefined();
  expect(control.complete).toBe(true);
  expect(control.frames).toBeGreaterThan(20);
  const atN = run(control.peak);
  expect(atN.caught).toBeUndefined();
  expect(atN.complete).toBe(true);
  expect(atN.peak).toBe(control.peak);
  const below = run(control.peak - 1);
  expect(below.caught).toBe(below.boundary);
  expect(below.complete).toBe(false);
  expect(below.peak).toBe(control.peak);
});

test('CR-CPU02 FAIL-NESTED interrupted scopes restore outer frames and charge candidate retry', () => {
  const native = JSON.stringify;
  for (const injection of [
    'preflight-first',
    'preflight-last',
    'observe-first',
    'observe-last',
  ]) {
    const meter = createCompareOwnerRootBytes();
    const fault = new CompareReportsFault('DeadlineExceeded');
    const boundary = new CompareReportsFault('ResourceLimitExceeded');
    const candidate = Object.freeze(['inner Ω', 'é"\\']);
    const outerCandidate = Object.freeze(['outer', 'retained']);
    let checkpoints = 0;
    let observations = 0;
    let late = 0;
    let failed = false;
    let entered = false;
    let outerFrames = 0;
    meter.measurementScope((writers) => {
      const outer = writers.array<unknown>();
      outer.append('growing outer');
      expect(
        meter.certifyOwned(outerCandidate, (outerRoots) => {
          outerFrames++;
          const enclosing = [outer.value, ...outerRoots];
          expect(meter.bytes(enclosing)).toBe(cpuFrameBytes(native, enclosing));
          if (entered) return;
          entered = true;
          let alias: unknown[] | undefined;
          let caught: unknown;
          try {
            meter.measurementScope((innerWriters) => {
              const inner = innerWriters.array<unknown>();
              alias = inner.value;
              inner.append('unpublished');
              meter.certifyOwned(
                candidate,
                (roots) => {
                  if (failed) late++;
                  observations++;
                  const complete = [
                    outer.value,
                    inner.value,
                    ...outerRoots,
                    ...roots,
                  ];
                  expect(meter.bytes(complete)).toBe(
                    cpuFrameBytes(native, complete),
                  );
                  if (
                    (injection === 'observe-first' && observations === 1) ||
                    (injection === 'observe-last' && observations === 3)
                  ) {
                    failed = true;
                    throw fault;
                  }
                },
                () => {
                  if (failed) late++;
                  checkpoints++;
                  if (
                    (injection === 'preflight-first' && checkpoints === 1) ||
                    (injection === 'preflight-last' && checkpoints === 6)
                  ) {
                    failed = true;
                    throw fault;
                  }
                },
              );
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(fault);
          expect(late).toBe(0);
          expect(alias).toBeDefined();
          alias!.push('native mutation after failed scope');
          outer.append('outer resumed');
          const prefix = [outer.value, alias, ...outerRoots];
          const keys = Reflect.ownKeys(candidate);
          const peak = Math.max(
            ...keys.map((key) =>
              cpuFrameBytes(native, [
                ...prefix,
                candidate,
                keys,
                Object.getOwnPropertyDescriptor(candidate, key),
              ]),
            ),
          );
          let belowCaught: unknown;
          let belowFrames = 0;
          try {
            meter.certifyOwned(candidate, (roots) => {
              belowFrames++;
              const complete = [...prefix, ...roots];
              const exact = cpuFrameBytes(native, complete);
              expect(meter.bytes(complete)).toBe(exact);
              if (exact > peak - 1) throw boundary;
            });
          } catch (error) {
            belowCaught = error;
          }
          expect(belowCaught).toBe(boundary);
          expect(belowFrames).toBeGreaterThan(0);
          let retryFrames = 0;
          expect(
            meter.certifyOwned(candidate, (roots) => {
              retryFrames++;
              const complete = [...prefix, ...roots];
              const exact = cpuFrameBytes(native, complete);
              expect(meter.bytes(complete)).toBe(exact);
              expect(exact).toBeLessThanOrEqual(peak);
            }),
          ).toBe(true);
          expect(retryFrames).toBe(3);
          expect(meter.bytes(prefix)).toBe(cpuFrameBytes(native, prefix));
        }),
      ).toBe(true);
      expect(outerFrames).toBe(3);
      outer.seal();
      const roots = [outer.value, outerCandidate, candidate, outer.value];
      expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    });
  }
});

test('CR-CPU02 ABORTED-ALIAS unpublished builders stay fresh in the original and another meter', () => {
  const native = JSON.stringify;
  const first = createCompareOwnerRootBytes();
  const second = createCompareOwnerRootBytes();
  const fault = new CompareReportsFault('Cancelled');
  let array: unknown[] | undefined;
  let map: Map<string, unknown> | undefined;
  let set: Set<unknown> | undefined;
  let caught: unknown;
  try {
    first.measurementScope((writers) => {
      const a = writers.array<unknown>();
      const m = writers.map<unknown>();
      const s = writers.set<unknown>();
      array = a.value;
      map = m.value;
      set = s.value;
      a.append('initial array');
      m.put('k', 'longer initial map value');
      s.add('initial set');
      const roots = [array, map, set, { array, map, set }, array];
      expect(first.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      throw fault;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(fault);
  array!.splice(0, 1, 'Ω', undefined);
  map!.set('k', 'x');
  map!.set('new', undefined);
  set!.delete('initial set');
  set!.add('new set');
  const roots = [array, map, set, { array, map, set }, map, array];
  const exact = cpuFrameBytes(native, roots);
  expect(first.bytes(roots)).toBe(exact);
  expect(second.bytes(roots)).toBe(exact);
  first.measurementScope((writers) => {
    const fresh = writers.array<unknown>();
    fresh.append('fresh attempt');
    fresh.seal();
    const current = [fresh.value, ...roots];
    expect(first.bytes(current)).toBe(cpuFrameBytes(native, current));
    expect(second.bytes(current)).toBe(cpuFrameBytes(native, current));
  });
});

test('CR-CPU02 MEASUREMENT-NONOWNERSHIP a sealed plain child still requires actual completion', () => {
  const native = JSON.stringify;
  const meter = createCompareOwnerRootBytes();
  meter.measurementScope((writers) => {
    const child = writers.array<unknown>();
    child.append('plain child');
    child.append(undefined);
    const parent = Object.freeze({ child: child.value });
    let premature = 0;
    const reject = () => {
      premature++;
    };
    expect(meter.certifyOwned(parent, reject)).toBe(false);
    child.seal();
    expect(meter.certifyOwned(parent, reject)).toBe(false);
    expect(premature).toBe(0);
    let childFrames = 0;
    let parentFrames = 0;
    expect(
      meter.certifyOwned(child.value, (roots) => {
        childFrames++;
        const complete = [parent, ...roots];
        expect(meter.bytes(complete)).toBe(cpuFrameBytes(native, complete));
      }),
    ).toBe(true);
    expect(childFrames).toBe(3);
    expect(
      meter.certifyOwned(parent, (roots) => {
        parentFrames++;
        expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      }),
    ).toBe(true);
    expect(parentFrames).toBe(1);
    const roots = [parent, child.value, parent];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  });
});

test('CR-CPU02 FOREIGN-PROTOTYPE foreign children stay inert on append and native hooks remain observable', () => {
  const native = JSON.stringify;
  const meter = createCompareOwnerRootBytes();
  meter.measurementScope((writers) => {
    const array = ['foreign'];
    const map = Object.freeze(new Map<string, unknown>([['k', 'foreign']]));
    const set = Object.freeze(new Set<unknown>(['foreign']));
    const parent = writers.array<unknown>();
    for (const value of [array, map, set]) parent.append(value);
    parent.seal();
    array.push('still mutable');
    map.set('k', 'replacement Ω');
    set.add(undefined);
    const roots = [parent.value, map, set, array, parent.value];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    expect(Object.isFrozen(array)).toBe(false);
  });
  const effects: string[] = [];
  const fault = new CompareReportsFault('InternalError');
  const proxy = new Proxy(
    {},
    {
      get() {
        effects.push('proxy get');
        throw fault;
      },
      getPrototypeOf() {
        effects.push('proxy prototype');
        throw fault;
      },
      ownKeys() {
        effects.push('proxy keys');
        throw fault;
      },
    },
  );
  meter.measurementScope((writers) => {
    const parent = writers.array<unknown>();
    parent.append(proxy);
    expect(effects).toEqual([]);
    const roots = [parent.value, parent.value];
    let actualCaught: unknown;
    let nativeCaught: unknown;
    try {
      meter.bytes(roots);
    } catch (error) {
      actualCaught = error;
    }
    const actualEffects = effects.slice();
    effects.length = 0;
    try {
      cpuFrameBytes(native, roots);
    } catch (error) {
      nativeCaught = error;
    }
    expect(actualCaught).toBe(fault);
    expect(nativeCaught).toBe(fault);
    expect(effects).toEqual(actualEffects);
    expect(actualEffects).toEqual(['proxy get']);
  });
  meter.measurementScope((writers) => {
    const map = writers.map<unknown>();
    const set = writers.set<unknown>();
    map.put('k', 'é');
    set.add('Ω');
    map.seal();
    set.seal();
    const parent = writers.array<unknown>();
    parent.append(map.value);
    parent.append(set.value);
    parent.seal();
    const roots = [parent.value, map.value, set.value, parent.value];
    const checkEffects = () => {
      effects.length = 0;
      const actual = meter.bytes(roots);
      const actualEffects = effects.slice();
      effects.length = 0;
      const exact = cpuFrameBytes(native, roots);
      expect(actual).toBe(exact);
      expect(effects).toEqual(actualEffects);
      expect(actualEffects.length).toBeGreaterThan(0);
    };
    for (const [prototype, name] of [
      [Map.prototype, 'entries'],
      [Set.prototype, 'values'],
    ] as const) {
      const prior = Object.getOwnPropertyDescriptor(prototype, name)!;
      try {
        Object.defineProperty(prototype, name, {
          ...prior,
          value(this: object) {
            effects.push(name);
            return Reflect.apply(prior.value, this, []);
          },
        });
        checkEffects();
      } finally {
        Object.defineProperty(prototype, name, prior);
      }
      expect(Object.getOwnPropertyDescriptor(prototype, name)).toEqual(prior);
    }
    for (const prototype of [Map.prototype, Set.prototype]) {
      const prior = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
      try {
        Object.defineProperty(prototype, 'toJSON', {
          configurable: true,
          get() {
            effects.push('toJSON get');
            return function (this: object, key: string) {
              effects.push('toJSON call/' + key);
              return this;
            };
          },
        });
        checkEffects();
      } finally {
        if (prior) Object.defineProperty(prototype, 'toJSON', prior);
        else Reflect.deleteProperty(prototype, 'toJSON');
      }
      expect(Object.getOwnPropertyDescriptor(prototype, 'toJSON')).toEqual(
        prior,
      );
    }
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    expect(Object.isFrozen(map.value)).toBe(true);
    expect(Object.isFrozen(set.value)).toBe(true);
  });
});

test('CR-CPU02 writer fallback performs the ordinary mutation once and keeps post-mutation first fault', () => {
  const native = JSON.stringify;
  const meter = createCompareOwnerRootBytes();
  const trace: string[] = [];
  const fault = new CompareReportsFault('Cancelled');
  const priorGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!;
  const priorHas = Object.getOwnPropertyDescriptor(Map.prototype, 'has')!;
  const priorSet = Object.getOwnPropertyDescriptor(Map.prototype, 'set')!;
  let alias: Map<string, unknown> | undefined;
  let caught: unknown;
  try {
    meter.measurementScope((writers) => {
      const writer = writers.map<unknown>();
      alias = writer.value;
      writer.put('k', 'before');
      Object.defineProperty(Map.prototype, 'get', {
        ...priorGet,
        value(this: object, key: unknown) {
          trace.push('get');
          return Reflect.apply(priorGet.value, this, [key]);
        },
      });
      Object.defineProperty(Map.prototype, 'has', {
        ...priorHas,
        value(this: object, key: unknown) {
          trace.push('has');
          return Reflect.apply(priorHas.value, this, [key]);
        },
      });
      Object.defineProperty(Map.prototype, 'set', {
        ...priorSet,
        value(this: object, key: unknown, value: unknown) {
          trace.push('set');
          Reflect.apply(priorSet.value, this, [key, value]);
          throw fault;
        },
      });
      writer.put('k', 'after mutation Ω');
      trace.push('unreachable');
    });
  } catch (error) {
    caught = error;
  } finally {
    Object.defineProperty(Map.prototype, 'get', priorGet);
    Object.defineProperty(Map.prototype, 'has', priorHas);
    Object.defineProperty(Map.prototype, 'set', priorSet);
  }
  expect(caught).toBe(fault);
  expect(trace).toEqual(['set']);
  expect(alias!.get('k')).toBe('after mutation Ω');
  const roots = [alias, { alias }, alias];
  expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  const second = createCompareOwnerRootBytes();
  alias!.set('k', 'x');
  expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  expect(second.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  expect(Object.getOwnPropertyDescriptor(Map.prototype, 'get')).toEqual(
    priorGet,
  );
  expect(Object.getOwnPropertyDescriptor(Map.prototype, 'has')).toEqual(
    priorHas,
  );
  expect(Object.getOwnPropertyDescriptor(Map.prototype, 'set')).toEqual(
    priorSet,
  );
});

test('CR-CPU02 YOUNGER-SCOPE sealed inner native collections cannot leave stale outer byte counts', () => {
  const native = JSON.stringify;
  for (const kind of ['Map', 'Set'] as const) {
    const meter = createCompareOwnerRootBytes();
    const sentinel = new CompareReportsFault('Cancelled');
    meter.measurementScope((outerWriters) => {
      const parent = outerWriters.array<unknown>();
      const holder: { child?: Map<string, string> | Set<string> } = {};
      let caught: unknown;
      try {
        meter.measurementScope((innerWriters) => {
          if (kind === 'Map') {
            const inner = innerWriters.map<string>();
            inner.put('k', 'initial');
            inner.seal();
            holder.child = inner.value;
          } else {
            const inner = innerWriters.set<string>();
            inner.add('initial');
            inner.seal();
            holder.child = inner.value;
          }
          parent.append(holder.child);
          throw sentinel;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      const child = holder.child;
      if (!child) throw new Error('Missing released inner collection.');
      expect(parent.value[0]).toBe(child);
      expect(Object.isFrozen(child)).toBe(true);
      if (child instanceof Map) {
        child.set('k', 'released child Ω with a longer native value');
        expect(child.get('k')).toBe(
          'released child Ω with a longer native value',
        );
      } else {
        child.add('released child Ω with a longer native value');
        expect(child.has('released child Ω with a longer native value')).toBe(
          true,
        );
      }
      const roots = [parent.value, child, parent.value];
      const exact = cpuFrameBytes(native, roots);
      const actual = meter.bytes(roots);
      console.info(
        'CR-CPU02 YOUNGER-SCOPE native-frame ' +
          native({ kind, actual, exact }),
      );
      expect(actual).toBe(exact);
    });
  }
  expect(JSON.stringify).toBe(native);
});

// B1 fixtures are fresh test-owned closed DTOs, not production schema outputs.
function cpuB1PrivateFixture() {
  const shared = {
    token: 'unique shared éΩ"\\\n',
    empty: {},
    slots: [undefined, null, -0, true, false, 1.25, 1e21] as unknown[],
  };
  const record = Object.create(null) as Record<string, unknown>;
  record['2'] = 'two';
  record['1'] = 'one';
  record['Ω"\\'] = 'lone \ud800 and 😀';
  record.omitted = undefined;
  const root = {
    shared,
    alias: shared,
    record,
    sequence: [shared, shared, undefined, null],
    omitted: undefined,
  };
  return { root, shared, record };
}

test('CR-CPU02-PRIVATE-CLONE fresh test-owned closed graphs have atomic read bytes without ownership', () => {
  const native = JSON.stringify;
  const meter = createCompareOwnerRootBytes();
  const other = createCompareOwnerRootBytes();
  const fixture = cpuB1PrivateFixture();
  meter.measurementScope((helpers) => {
    let accepted: boolean;
    let checkpoints = 0;
    let sharedEncodes = 0;
    let containerEncodes = 0;
    let counting = false;
    function record(this: unknown, ...args: unknown[]): string {
      const result: string = Reflect.apply(native, this, args);
      if (counting) {
        if (args[0] === fixture.shared.token) sharedEncodes++;
        if (args[0] !== null && typeof args[0] === 'object') containerEncodes++;
      }
      return result;
    }
    try {
      JSON.stringify = record;
      counting = true;
      accepted = helpers.privateRead(fixture.root, () => {
        checkpoints++;
      });
    } finally {
      counting = false;
      JSON.stringify = native;
    }
    expect(JSON.stringify).toBe(native);
    expect(accepted).toBe(true);
    expect(checkpoints).toBeGreaterThan(1);
    expect(sharedEncodes).toBe(1); // Native primitive work, despite repeated aliases.
    expect(containerEncodes).toBe(0); // No whole-container stringify during preflight.
    for (const value of [
      fixture.root,
      fixture.shared,
      fixture.shared.slots,
      fixture.record,
    ])
      expect(Object.isFrozen(value)).toBe(false);
    const parent = Object.freeze({ child: fixture.root });
    let premature = 0;
    expect(
      meter.certifyOwned(parent, () => {
        premature++;
      }),
    ).toBe(false);
    expect(premature).toBe(0);
    const text = native(fixture.root);
    const envelope = { text, structuredContent: fixture.root };
    for (const roots of [
      [fixture.root],
      [parent, fixture.root, fixture.root],
      [fixture.shared, fixture.record, fixture.root.sequence, fixture.shared],
      [fixture.root, envelope, envelope],
    ]) {
      const exact = cpuFrameBytes(native, roots);
      expect(meter.bytes(roots)).toBe(exact);
      expect(other.bytes(roots)).toBe(exact);
    }
    acClose(meter, fixture.root);
    let completionFrames = 0;
    expect(
      meter.certifyOwned(parent, (roots) => {
        completionFrames++;
        expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      }),
    ).toBe(true);
    expect(completionFrames).toBe(1);
    const roots = [parent, fixture.root, fixture.shared, parent];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  });
  const roots = [fixture.root, fixture.shared, fixture.root];
  expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
});

test('CR-CPU02-CLONE-FAIL-SCOPE private preflight faults and captured older helpers discard unpublished bytes', () => {
  const native = JSON.stringify;
  let controlCheckpoints = 0;
  createCompareOwnerRootBytes().measurementScope((helpers) => {
    expect(
      helpers.privateRead(cpuB1PrivateFixture().root, () => {
        controlCheckpoints++;
      }),
    ).toBe(true);
  });
  expect(controlCheckpoints).toBeGreaterThan(2);
  for (const at of [1, controlCheckpoints]) {
    const meter = createCompareOwnerRootBytes();
    const other = createCompareOwnerRootBytes();
    const fixture = cpuB1PrivateFixture();
    const fault = new CompareReportsFault('DeadlineExceeded');
    const owned = acClose(meter, { token: 'valid completed immutable child' });
    meter.measurementScope((helpers) => {
      let failed = false;
      let calls = 0;
      let late = 0;
      let caught: unknown;
      try {
        helpers.privateRead(fixture.root, () => {
          if (failed) late++;
          calls++;
          if (calls === at) {
            failed = true;
            throw fault;
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(fault);
      expect(calls).toBe(at);
      expect(late).toBe(0);
      fixture.shared.token = 'changed released read leaf Ω with more bytes';
      fixture.shared.slots.push('changed array');
      const roots = [fixture.root, fixture.shared, fixture.root, owned];
      expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      let retry = 0;
      expect(
        helpers.privateRead(fixture.root, () => {
          retry++;
        }),
      ).toBe(true);
      expect(retry).toBeGreaterThan(0);
      expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(meter.certifyOwned(Object.freeze({ owned }))).toBe(true);
      expect(Object.isFrozen(fixture.root)).toBe(false);
    });
    fixture.shared.token = 'changed again after entire operation';
    const roots = [fixture.root, fixture.shared, fixture.root];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  }
  const effects: string[] = [];
  const fault = new CompareReportsFault('InternalError');
  const proxy = new Proxy(
    {},
    {
      get() {
        effects.push('proxy get');
        throw fault;
      },
      getPrototypeOf() {
        effects.push('proxy prototype');
        throw fault;
      },
      ownKeys() {
        effects.push('proxy keys');
        throw fault;
      },
    },
  );
  const cycle: { child?: object } = {};
  cycle.child = cycle;
  const unsafe = {
    good: { token: 'partially scanned leaf' },
    get bad() {
      effects.push('getter');
      throw fault;
    },
  };
  const custom = {
    toJSON() {
      effects.push('toJSON');
      throw fault;
    },
  };
  const inherited = Object.create({
    get toJSON() {
      effects.push('inherited');
      throw fault;
    },
  }) as object;
  const sparse = ['initial'];
  sparse.length = 3;
  const meter = createCompareOwnerRootBytes();
  meter.measurementScope((helpers) => {
    for (const value of [
      unsafe,
      proxy,
      { proxy },
      custom,
      inherited,
      cycle,
      sparse,
      new Map(),
    ]) {
      expect(helpers.privateRead(value)).toBe(false);
      expect(effects).toEqual([]);
    }
    unsafe.good.token = 'native mutation after rejected whole preflight Ω';
    const roots = [unsafe.good, unsafe.good];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  });
  for (const route of ['own', 'captured-older'] as const) {
    const first = createCompareOwnerRootBytes();
    const second = createCompareOwnerRootBytes();
    const sentinel = new CompareReportsFault('Cancelled');
    first.measurementScope((older) => {
      const parent = older.array<unknown>();
      const holder: { clone?: { tags: string[] } } = {};
      let caught: unknown;
      try {
        first.measurementScope((younger) => {
          const clone = { tags: ['private inner read'] };
          holder.clone = clone;
          const helpers = route === 'own' ? younger : older;
          expect(helpers.privateRead(clone)).toBe(true);
          parent.append(clone);
          const roots = [parent.value, clone, parent.value];
          expect(first.bytes(roots)).toBe(cpuFrameBytes(native, roots));
          throw sentinel;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      const clone = holder.clone;
      if (!clone) throw new Error('Missing released private read fixture.');
      expect(Object.isFrozen(clone)).toBe(false);
      expect(Object.isFrozen(clone.tags)).toBe(false);
      clone.tags.push('changed released mutable array Ω');
      const roots = [parent.value, clone, parent.value];
      expect(first.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(second.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(
        older.privateRead({ retry: 'fresh known-private test allocation' }),
      ).toBe(true);
    });
  }
});

test('CR-CPU02-PRIVATE-METADATA native snapshot identity effects and nested lifetimes remain exact', () => {
  const native = JSON.stringify;
  const nativeKeys = Object.keys;
  const nativeValues = Object.values;
  const meter = createCompareOwnerRootBytes();
  const trace: string[] = [];
  const foreign = { token: 'foreign mutable child' };
  const source: Record<string, unknown> = {
    '2': 'two',
    '1': undefined,
    foreign,
    alias: foreign,
  };
  Object.defineProperty(source, 'getter', {
    enumerable: true,
    get() {
      trace.push('source getter');
      return 'éΩ"\\';
    },
  });
  Object.defineProperty(source, 'hidden', {
    value: 'ignored',
    enumerable: false,
  });
  const proxy = new Proxy(source, {
    ownKeys(target) {
      trace.push('ownKeys');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, name) {
      trace.push('descriptor/' + String(name));
      return Reflect.getOwnPropertyDescriptor(target, name);
    },
    get(target, name, receiver) {
      trace.push('get/' + String(name));
      return Reflect.get(target, name, receiver);
    },
  });
  const expectedKeys = nativeKeys(proxy);
  const keyEffects = trace.slice();
  trace.length = 0;
  const expectedValues = nativeValues(proxy);
  const valueEffects = trace.slice();
  trace.length = 0;
  meter.measurementScope((helpers) => {
    const holder: { keys?: string[]; values?: unknown[] } = {};
    let keyCalls = 0;
    let valueCalls = 0;
    const captureKeys: typeof Object.keys = function (
      this: unknown,
      ...args: unknown[]
    ) {
      const values: string[] = Reflect.apply(nativeKeys, this, args);
      keyCalls++;
      holder.keys = values;
      return values;
    };
    const captureValues: typeof Object.values = function (
      this: unknown,
      ...args: unknown[]
    ) {
      const values = Reflect.apply(nativeValues, this, args);
      valueCalls++;
      holder.values = values;
      return values;
    };
    let keys: readonly string[] | undefined;
    let values: readonly unknown[] | undefined;
    let actualKeyEffects: string[];
    let actualValueEffects: string[];
    try {
      Object.keys = captureKeys;
      Object.values = captureValues;
      keys = helpers.privateKeys(proxy);
      actualKeyEffects = trace.slice();
      trace.length = 0;
      values = helpers.privateValues(proxy);
      actualValueEffects = trace.slice();
    } finally {
      Object.keys = nativeKeys;
      Object.values = nativeValues;
      trace.length = 0;
    }
    expect(Object.keys).toBe(nativeKeys);
    expect(Object.values).toBe(nativeValues);
    expect(keyCalls).toBe(1);
    expect(valueCalls).toBe(1);
    expect(keys).toBe(holder.keys!);
    expect(values).toBe(holder.values!);
    expect(keys).toEqual(expectedKeys);
    expect(values).toEqual(expectedValues);
    expect(actualKeyEffects).toEqual(keyEffects);
    expect(actualValueEffects).toEqual(valueEffects);
    expect(Object.isFrozen(keys)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(foreign)).toBe(false);
    foreign.token = 'changed foreign mutable child Ω and more bytes';
    source.newField = 'does not change existing native snapshots';
    expect(keys).toEqual(expectedKeys);
    const roots = [source, keys, values, { keys, values }, values];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  });
  meter.measurementScope((helpers) => {
    const clone = cpuB1PrivateFixture();
    const owned = acClose(meter, { stable: 'privately completed test child' });
    expect(helpers.privateRead(clone.root)).toBe(true);
    const source = { read: clone.root, owned, omitted: undefined };
    const keys = helpers.privateKeys(source);
    const values = helpers.privateValues(source);
    expect(keys).toEqual(['read', 'owned', 'omitted']);
    expect(values[0]).toBe(clone.root);
    expect(values[1]).toBe(owned);
    expect(values[2]).toBeUndefined();
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(clone.root)).toBe(false);
    expect(meter.certifyOwned(Object.freeze({ values }))).toBe(false);
    const roots = [source, keys, values, values, clone.root];
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    const fault = new CompareReportsFault('Cancelled');
    const effects: string[] = [];
    const bad = {
      get first() {
        effects.push('first');
        throw fault;
      },
      get later() {
        effects.push('later');
        return 'never';
      },
    };
    let caught: unknown;
    let late = 0;
    try {
      helpers.privateValues(bad, () => {
        late++;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fault);
    expect(effects).toEqual(['first']);
    expect(late).toBe(0);
    effects.length = 0;
    let originalCaught: unknown;
    try {
      nativeValues(bad);
    } catch (error) {
      originalCaught = error;
    }
    expect(originalCaught).toBe(fault);
    expect(effects).toEqual(['first']);
    expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  });
  meter.measurementScope((helpers) => {
    const effects: string[] = [];
    const fault = new CompareReportsFault('InternalError');
    const foreign = new Proxy(
      {},
      {
        get() {
          effects.push('get');
          throw fault;
        },
        getPrototypeOf() {
          effects.push('prototype');
          throw fault;
        },
        ownKeys() {
          effects.push('keys');
          throw fault;
        },
      },
    );
    const source = { foreign };
    const values = helpers.privateValues(source);
    expect(values[0]).toBe(foreign);
    expect(effects).toEqual([]);
    expect(Object.isFrozen(source)).toBe(false);
    const roots = [values, values];
    let actualCaught: unknown;
    let nativeCaught: unknown;
    try {
      meter.bytes(roots);
    } catch (error) {
      actualCaught = error;
    }
    const actualEffects = effects.slice();
    effects.length = 0;
    try {
      cpuFrameBytes(native, roots);
    } catch (error) {
      nativeCaught = error;
    }
    expect(actualCaught).toBe(fault);
    expect(nativeCaught).toBe(fault);
    expect(effects).toEqual(actualEffects);
    expect(actualEffects).toEqual(['get']);
  });
  for (const route of ['own', 'captured-older'] as const) {
    const first = createCompareOwnerRootBytes();
    const second = createCompareOwnerRootBytes();
    const fault = new CompareReportsFault('DeadlineExceeded');
    first.measurementScope((older) => {
      const parent = older.array<unknown>();
      const holder: {
        clone?: { tags: string[] };
        values?: readonly unknown[];
      } = {};
      let caught: unknown;
      try {
        first.measurementScope((younger) => {
          const clone = { tags: ['private nested metadata'] };
          const helpers = route === 'own' ? younger : older;
          expect(helpers.privateRead(clone)).toBe(true);
          const values = helpers.privateValues({ clone });
          holder.clone = clone;
          holder.values = values;
          expect(Object.isFrozen(values)).toBe(true);
          parent.append(values);
          const roots = [parent.value, values, parent.value];
          expect(first.bytes(roots)).toBe(cpuFrameBytes(native, roots));
          throw fault;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(fault);
      const clone = holder.clone;
      const values = holder.values;
      if (!clone || !values)
        throw new Error('Missing released private metadata fixture.');
      expect(Object.isFrozen(clone)).toBe(false);
      clone.tags.push('released nested metadata child changed Ω');
      const roots = [parent.value, values, parent.value, clone];
      expect(first.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(second.bytes(roots)).toBe(cpuFrameBytes(native, roots));
    });
  }
  expect(JSON.stringify).toBe(native);
  expect(Object.keys).toBe(nativeKeys);
  expect(Object.values).toBe(nativeValues);
});

// Guarded read views: actual native operations and independent full-frame oracles.
type CpuViewHelpers = Parameters<Parameters<AcMeter['measurementScope']>[0]>[0];
function cpuViewFixture() {
  const shared = {
    label: 'éΩ"\\\n😀',
    slots: [undefined, null, 'lone \ud800'],
  };
  const second = { label: 'second row', slots: [null, 'different'] };
  const rows = [shared, second, shared, undefined, null];
  return { shared, second, rows };
}
type CpuViewItem = ReturnType<typeof cpuViewFixture>['rows'][number];
function cpuViewMixed(_value: CpuViewItem, index: number) {
  return index !== 1;
}
interface CpuViewChange {
  target: object;
  name: PropertyKey;
  before: PropertyDescriptor | undefined;
}
function cpuViewChange(
  changes: CpuViewChange[],
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor,
) {
  changes.push({
    target,
    name,
    before: Object.getOwnPropertyDescriptor(target, name),
  });
  Object.defineProperty(target, name, descriptor);
}
function cpuViewRestore(changes: readonly CpuViewChange[]) {
  for (let index = changes.length - 1; index >= 0; index--) {
    const { target, name, before } = changes[index]!;
    if (before) Object.defineProperty(target, name, before);
    else Reflect.deleteProperty(target, name);
  }
  for (const { target, name, before } of changes)
    expect(Object.getOwnPropertyDescriptor(target, name)).toEqual(before);
}

test('CR-CPU02-READ-VIEW-NATIVE real filter views preserve callback semantics and complete native frames', () => {
  const native = JSON.stringify;
  const nativeFilter = Array.prototype.filter;
  const run = (limit = Infinity) => {
    const meter = createCompareOwnerRootBytes();
    const other = createCompareOwnerRootBytes();
    const boundary = new CompareReportsFault('ResourceLimitExceeded');
    const frameBytes: number[] = [];
    const events: string[] = [];
    const released: ReturnType<typeof cpuViewFixture>[] = [];
    let caught: unknown;
    let complete = false;
    meter.measurementScope((outer) => {
      const stable = acClose(meter, { label: 'unrelated outer certificate Ω' });
      const parent = outer.array<unknown>();
      parent.append(stable);
      parent.seal();
      try {
        meter.measurementScope((helpers) => {
          for (const selection of ['mixed', 'all', 'none'] as const) {
            const fixture = cpuViewFixture();
            const control = cpuViewFixture();
            released.push(fixture);
            expect(helpers.privateRead(fixture.rows)).toBe(true);
            type Call = {
              value: CpuViewItem;
              index: number;
              array: readonly CpuViewItem[];
              receiver: unknown;
              argc: number;
            };
            const actualCalls: Call[] = [];
            const controlCalls: Call[] = [];
            function predicate(
              this: unknown,
              value: CpuViewItem,
              index: number,
              array: readonly CpuViewItem[],
            ) {
              actualCalls.push({
                value,
                index,
                array,
                receiver: this,
                argc: arguments.length,
              });
              events.push(selection + '/predicate/' + index);
              return (
                selection === 'all' || (selection === 'mixed' && index !== 1)
              );
            }
            function controlPredicate(
              this: unknown,
              value: CpuViewItem,
              index: number,
              array: readonly CpuViewItem[],
            ) {
              controlCalls.push({
                value,
                index,
                array,
                receiver: this,
                argc: arguments.length,
              });
              return (
                selection === 'all' || (selection === 'mixed' && index !== 1)
              );
            }
            const expected =
              selection === 'none'
                ? []
                : selection === 'all'
                  ? [
                      control.shared,
                      control.second,
                      control.shared,
                      undefined,
                      null,
                    ]
                  : [control.shared, control.shared, undefined, null];
            const expectedReferences =
              selection === 'none'
                ? []
                : selection === 'all'
                  ? [
                      fixture.shared,
                      fixture.second,
                      fixture.shared,
                      undefined,
                      null,
                    ]
                  : [fixture.shared, fixture.shared, undefined, null];
            const nativeControl = Reflect.apply(nativeFilter, control.rows, [
              controlPredicate,
            ]);
            expect(nativeControl).toEqual(expected);
            let containerEncodes = 0;
            let checkpoints = 0;
            function record(this: unknown, ...args: unknown[]): string {
              if (args[0] !== null && typeof args[0] === 'object')
                containerEncodes++;
              return Reflect.apply(native, this, args);
            }
            const view = (() => {
              try {
                JSON.stringify = record;
                return helpers.privateFilter(fixture.rows, predicate, () => {
                  checkpoints++;
                });
              } finally {
                JSON.stringify = native;
              }
            })();
            expect(JSON.stringify).toBe(native);
            expect(containerEncodes).toBe(0);
            expect(checkpoints).toBe(view.length + 2);
            expect(view).not.toBe(fixture.rows);
            expect(Object.isFrozen(view)).toBe(true);
            expect(view).toEqual(expected);
            for (let index = 0; index < view.length; index++)
              expect(view[index]).toBe(expectedReferences[index]);
            expect(actualCalls.length).toBe(5);
            expect(controlCalls.length).toBe(5);
            for (let index = 0; index < actualCalls.length; index++) {
              const actual = actualCalls[index]!;
              const original = controlCalls[index]!;
              expect(actual.value).toBe(fixture.rows[index]);
              expect(actual.array).toBe(fixture.rows);
              expect(original.array).toBe(control.rows);
              expect(actual.index).toBe(original.index);
              expect(actual.receiver).toBe(original.receiver);
              expect(actual.argc).toBe(3);
              expect(original.argc).toBe(3);
            }
            for (const value of [
              fixture.rows,
              fixture.shared,
              fixture.shared.slots,
              fixture.second,
            ])
              expect(Object.isFrozen(value)).toBe(false);
            let premature = 0;
            expect(
              meter.certifyOwned(Object.freeze({ view }), () => {
                premature++;
              }),
            ).toBe(false);
            expect(premature).toBe(0);
            const roots = [
              fixture.rows,
              { view, alias: view },
              view,
              { parent: parent.value, source: fixture.rows },
              view,
            ];
            const expectedRoots = [
              control.rows,
              { view: expected, alias: expected },
              expected,
              { parent: parent.value, source: control.rows },
              expected,
            ];
            const exact = cpuFrameBytes(native, expectedRoots);
            expect(cpuFrameBytes(native, roots)).toBe(exact);
            expect(meter.bytes(roots)).toBe(exact);
            frameBytes.push(exact);
            events.push(selection + '/frame');
            if (exact > limit) throw boundary;
          }
          complete = true;
          events.push('complete');
        });
      } catch (error) {
        caught = error;
      }
      // Only after the inner readonly lifetime ended, change every escaped alias.
      for (const fixture of released) {
        fixture.shared.label += ' released child has new bytes Ω';
        fixture.shared.slots.push('changed after release');
        const roots = [
          parent.value,
          fixture.rows,
          fixture.shared,
          fixture.rows,
          parent.value,
        ];
        expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
        expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      }
      expect(meter.bytes([parent.value, parent.value])).toBe(
        cpuFrameBytes(native, [parent.value, parent.value]),
      );
    });
    return {
      frameBytes,
      peak: Math.max(...frameBytes),
      events,
      complete,
      caught,
      boundary,
    };
  };
  const control = run();
  expect(control.caught).toBeUndefined();
  expect(control.complete).toBe(true);
  expect(control.frameBytes.length).toBe(3);
  const atN = run(control.peak);
  expect(atN.caught).toBeUndefined();
  expect(atN.complete).toBe(true);
  expect(atN.frameBytes).toEqual(control.frameBytes);
  const below = run(control.peak - 1);
  expect(below.caught).toBe(below.boundary);
  expect(below.complete).toBe(false);
  const violating = control.frameBytes.findIndex(
    (bytes) => bytes > control.peak - 1,
  );
  expect(below.frameBytes).toEqual(control.frameBytes.slice(0, violating + 1));
  expect(below.events.at(-1)).toBe(
    ['mixed', 'all', 'none'][violating] + '/frame',
  );
  expect(below.events).not.toContain('complete');
  const meter = createCompareOwnerRootBytes();
  meter.measurementScope((helpers) => {
    for (const rows of [
      acClose(meter, [] as number[]),
      acClose(meter, [1, 2, 2]),
    ]) {
      const view = helpers.privateFilter(rows, () => true);
      expect(view).toEqual(rows);
      expect(view).not.toBe(rows);
      expect(Object.isFrozen(view)).toBe(true);
      expect(meter.certifyOwned(Object.freeze({ view }))).toBe(false);
      expect(meter.bytes([view, rows, view])).toBe(
        cpuFrameBytes(native, [view, rows, view]),
      );
    }
  });
  expect(Array.prototype.filter).toBe(nativeFilter);
  expect(JSON.stringify).toBe(native);
});

test('CR-CPU02-READ-VIEW-GUARDS real native species and overridden paths remain untouched once-only fallback', () => {
  const native = JSON.stringify;
  const nativeFilter = Array.prototype.filter;
  const filterDescriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    'filter',
  )!;
  const speciesDescriptor = Object.getOwnPropertyDescriptor(
    Array,
    Symbol.species,
  )!;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    'constructor',
  )!;
  const modes = [
    'own-filter',
    'filter-before-meter',
    'constructor-array',
    'constructor-alias',
    'constructor-proxy',
    'constructor-object',
    'default-species',
    'foreign-prototype',
    'sparse',
    'accessor',
    'proxy-source',
    'unmeasured',
    'foreign-child',
    'changed-filter',
    'changed-constructor',
    'changed-species',
  ] as const;
  type Mode = (typeof modes)[number];
  const run = (mode: Mode, useHelper: boolean) => {
    const changes: CpuViewChange[] = [];
    const effects: string[] = [];
    const foreignFault = new CompareReportsFault('InternalError');
    const fixture = cpuViewFixture();
    const rows: unknown[] = fixture.rows;
    const target: unknown[] = [];
    const output: object =
      mode === 'constructor-alias'
        ? rows
        : mode === 'constructor-object'
          ? { note: 'existing object' }
          : mode === 'constructor-proxy' || mode === 'own-filter'
            ? new Proxy(target, {
                defineProperty(value, name, descriptor) {
                  effects.push('output define/' + String(name));
                  return Reflect.defineProperty(value, name, descriptor);
                },
                ownKeys(value) {
                  effects.push('output ownKeys');
                  return Reflect.ownKeys(value);
                },
                getPrototypeOf(value) {
                  effects.push('output prototype');
                  return Reflect.getPrototypeOf(value);
                },
                preventExtensions(value) {
                  effects.push('output preventExtensions');
                  return Reflect.preventExtensions(value);
                },
              })
            : target;
    let methodCalls = 0;
    let methodPredicateSame = true;
    let methodReceiverSame = true;
    let checkpoints = 0;
    let predicateCalls = 0;
    function predicate(
      this: unknown,
      value: unknown,
      index: number,
      array: readonly unknown[],
    ) {
      effects.push('predicate/' + index);
      predicateCalls++;
      expect(this).toBeUndefined();
      expect(arguments.length).toBe(3);
      expect(array).toBe(source);
      expect(value).toBe(source[index]);
      if (index === 0 && mode.startsWith('changed-')) {
        const getter = () => {
          effects.push('unexpected changed getter');
          return nativeFilter;
        };
        if (mode === 'changed-filter')
          cpuViewChange(changes, Array.prototype, 'filter', {
            configurable: true,
            get: getter,
          });
        if (mode === 'changed-constructor')
          cpuViewChange(changes, Array.prototype, 'constructor', {
            configurable: true,
            get: getter,
          });
        if (mode === 'changed-species')
          cpuViewChange(changes, Array, Symbol.species, {
            configurable: true,
            get: getter,
          });
      }
      return true;
    }
    function method(this: unknown, ...args: unknown[]) {
      effects.push('method');
      methodCalls++;
      methodPredicateSame &&= args[0] === predicate && args.length === 1;
      methodReceiverSame &&= this === source;
      return mode === 'own-filter'
        ? output
        : Reflect.apply(nativeFilter, this, args);
    }
    function Species(size: number) {
      effects.push('construct/' + size);
      return output;
    }
    const constructor = {};
    Object.defineProperty(constructor, Symbol.species, {
      configurable: true,
      get() {
        effects.push('species');
        return Species;
      },
    });
    let source = rows;
    try {
      if (mode === 'own-filter')
        cpuViewChange(changes, rows, 'filter', {
          configurable: true,
          get() {
            effects.push('filter get');
            return method;
          },
        });
      if (mode === 'filter-before-meter')
        cpuViewChange(changes, Array.prototype, 'filter', {
          ...filterDescriptor,
          value: method,
        });
      if (mode.startsWith('constructor-'))
        cpuViewChange(changes, rows, 'constructor', {
          configurable: true,
          get() {
            effects.push('constructor');
            return constructor;
          },
        });
      if (mode === 'foreign-prototype')
        Object.setPrototypeOf(rows, Object.create(Array.prototype));
      if (mode === 'sparse') delete rows[1];
      if (mode === 'accessor')
        cpuViewChange(changes, rows, '0', {
          configurable: true,
          enumerable: true,
          get() {
            effects.push('source slot');
            return fixture.shared;
          },
        });
      if (mode === 'proxy-source')
        source = new Proxy(rows, {
          get(value, name, receiver) {
            effects.push('source get/' + String(name));
            return Reflect.get(value, name, receiver);
          },
          has(value, name) {
            effects.push('source has/' + String(name));
            return Reflect.has(value, name);
          },
          ownKeys(value) {
            effects.push('source ownKeys');
            return Reflect.ownKeys(value);
          },
          getPrototypeOf(value) {
            effects.push('source prototype');
            return Reflect.getPrototypeOf(value);
          },
        });
      if (mode === 'foreign-child')
        rows[0] = new Proxy(
          {},
          {
            get() {
              effects.push('foreign child get');
              throw foreignFault;
            },
          },
        );
      const meter = createCompareOwnerRootBytes(); // Baseline must not be recaptured here.
      return meter.measurementScope((helpers) => {
        if (useHelper && mode !== 'unmeasured') helpers.privateRead(source);
        if (mode === 'default-species')
          cpuViewChange(changes, Array, Symbol.species, {
            configurable: true,
            get() {
              effects.push('default species');
              return Species;
            },
          });
        const result = useHelper
          ? helpers.privateFilter(source, predicate, () => {
              checkpoints++;
            })
          : source.filter(predicate);
        const nativeEffects = effects;
        return {
          result,
          output,
          target,
          fixture,
          source,
          meter,
          nativeEffects,
          methodCalls,
          methodPredicateSame,
          methodReceiverSame,
          checkpoints,
          predicateCalls,
          foreignFault,
        };
      });
    } finally {
      cpuViewRestore(changes);
      if (mode === 'foreign-prototype')
        Object.setPrototypeOf(rows, Array.prototype);
    }
  };
  for (const mode of modes) {
    const control = run(mode, false);
    const actual = run(mode, true);
    expect(actual.nativeEffects).toEqual(control.nativeEffects);
    expect(actual.methodCalls).toBe(control.methodCalls);
    expect(actual.methodPredicateSame).toBe(true);
    expect(actual.methodReceiverSame).toBe(true);
    expect(actual.checkpoints).toBe(0);
    expect(actual.predicateCalls).toBe(control.predicateCalls);
    if (
      mode === 'own-filter' ||
      mode.startsWith('constructor-') ||
      mode === 'default-species'
    )
      expect<object>(actual.result).toBe(actual.output);
    expect(Object.isExtensible(actual.target)).toBe(true);
    // Proxy results are deliberately inspected only by the later native oracle.
    if (mode !== 'own-filter' && mode !== 'constructor-proxy')
      expect(Object.isFrozen(actual.result)).toBe(false);
    if (mode !== 'foreign-child') {
      actual.fixture.shared.label += ' changed after declined/released scope Ω';
      actual.fixture.shared.slots.push('fresh fallback alias');
      const roots = [
        actual.source,
        actual.result,
        { result: actual.result },
        actual.result,
        actual.fixture.shared,
      ];
      const exact = cpuFrameBytes(native, roots);
      expect(actual.meter.bytes(roots)).toBe(exact);
      expect(createCompareOwnerRootBytes().bytes(roots)).toBe(exact);
    } else {
      let actualFault: unknown;
      let nativeFault: unknown;
      try {
        actual.meter.bytes([actual.result, actual.result]);
      } catch (error) {
        actualFault = error;
      }
      try {
        cpuFrameBytes(native, [actual.result, actual.result]);
      } catch (error) {
        nativeFault = error;
      }
      expect(actualFault).toBe(actual.foreignFault);
      expect(nativeFault).toBe(actual.foreignFault);
    }
  }
  // RV-GUARD-01: these mutable lookup properties are not used by native filter.
  // Prepare all numeric provenance before mutation; assertions/native frames run
  // only after finally restores the exact descriptor. Map aliases exercise the
  // existing dependency checks that must follow the new readonly guard fences.
  const lookupRun = (
    lookup: 'isArray' | 'every',
    phase: 'preflight' | 'predicate' | number,
    useHelper: boolean,
  ) => {
    const meter = createCompareOwnerRootBytes();
    const effects: string[] = [];
    const calls: {
      value: unknown;
      index: number;
      array: readonly unknown[];
      receiver: unknown;
      argc: number;
    }[] = [];
    const lookupFault = new CompareReportsFault('InternalError');
    let getterCalls = 0;
    let checkpoints = 0;
    const target = lookup === 'isArray' ? Array : Array.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(target, lookup)!;
    return meter.measurementScope((helpers) => {
      const child = helpers.map<string>();
      child.put('entry', 'private stable map éΩ');
      child.seal();
      const source = helpers.array<unknown>();
      source.append(child.value);
      source.append(child.value);
      source.append(undefined);
      source.seal();
      const rows = source.value;
      const method = rows.filter;
      function invalidate() {
        effects.push('replace/' + lookup);
        Object.defineProperty(target, lookup, {
          configurable: true,
          get() {
            getterCalls++;
            effects.push('unexpected lookup/' + lookup);
            throw lookupFault;
          },
        });
      }
      function originalPredicate(
        this: unknown,
        value: unknown,
        index: number,
        array: readonly unknown[],
      ) {
        effects.push('predicate/' + index);
        calls.push({
          value,
          index,
          array,
          receiver: this,
          argc: arguments.length,
        });
        if (phase === 'predicate' && index === 0) invalidate();
        return true;
      }
      const result: readonly unknown[] = (() => {
        try {
          if (phase === 'preflight') invalidate();
          const values = useHelper
            ? helpers.privateFilter(rows, originalPredicate, () => {
                checkpoints++;
                if (checkpoints === phase) invalidate();
              })
            : Reflect.apply(nativeFilter, rows, [originalPredicate]);
          // The control models the same external post-native descriptor change;
          // native filter itself has no metadata checkpoint or helper lookups.
          if (!useHelper && typeof phase === 'number') invalidate();
          return values;
        } finally {
          Object.defineProperty(target, lookup, descriptor);
        }
      })();
      return {
        meter,
        rows,
        child: child.value,
        result,
        method,
        predicate: originalPredicate,
        calls,
        effects,
        getterCalls,
        checkpoints,
        target,
        descriptor,
        lookup,
      };
    });
  };
  for (const lookup of ['isArray', 'every'] as const) {
    // Three selected slots give existing checkpoints 1, 2..4, 5. First/slot/
    // final invalidation verifies the new fences without adding checkpoints.
    for (const phase of ['preflight', 'predicate', 1, 2, 5] as const) {
      const control = lookupRun(lookup, phase, false);
      const actual = lookupRun(lookup, phase, true);
      expect(Object.getOwnPropertyDescriptor(actual.target, lookup)).toEqual(
        actual.descriptor,
      );
      expect(actual.method).toBe(nativeFilter);
      expect(control.method).toBe(nativeFilter);
      expect(actual.getterCalls).toBe(0);
      expect(control.getterCalls).toBe(0);
      expect(actual.effects).toEqual(control.effects);
      expect(actual.calls.length).toBe(3);
      expect(control.calls.length).toBe(3);
      expect(actual.checkpoints).toBe(typeof phase === 'number' ? phase : 0);
      expect(control.checkpoints).toBe(0);
      expect(Object.isFrozen(actual.result)).toBe(false);
      expect(Object.isFrozen(control.result)).toBe(false);
      expect(actual.result).not.toBe(actual.rows);
      expect(actual.result.length).toBe(3);
      expect(actual.result[0]).toBe(actual.child);
      expect(actual.result[1]).toBe(actual.child);
      expect(actual.result[2]).toBeUndefined();
      expect(actual.result).toEqual(control.result);
      for (let index = 0; index < actual.calls.length; index++) {
        const call = actual.calls[index]!;
        const original = control.calls[index]!;
        expect(call.index).toBe(original.index);
        expect(call.array).toBe(actual.rows);
        expect(original.array).toBe(control.rows);
        expect(call.value).toBe(actual.rows[index]);
        expect(original.value).toBe(control.rows[index]);
        expect(call.receiver).toBe(original.receiver);
        expect(call.argc).toBe(3);
        expect(original.argc).toBe(3);
      }
      actual.child.set(
        'entry',
        'released map alias now has changed UTF8 bytes Ω',
      );
      const roots = [
        actual.rows,
        actual.result,
        { view: actual.result, again: actual.result },
        actual.result,
        actual.child,
      ];
      const exact = cpuFrameBytes(native, roots);
      expect(actual.meter.bytes(roots)).toBe(exact);
      expect(createCompareOwnerRootBytes().bytes(roots)).toBe(exact);
    }
  }
  expect(Object.getOwnPropertyDescriptor(Array.prototype, 'filter')).toEqual(
    filterDescriptor,
  );
  expect(
    Object.getOwnPropertyDescriptor(Array.prototype, 'constructor'),
  ).toEqual(constructorDescriptor);
  expect(Object.getOwnPropertyDescriptor(Array, Symbol.species)).toEqual(
    speciesDescriptor,
  );
  expect(JSON.stringify).toBe(native);
});

test('CR-CPU02-READ-VIEW-FIRST-CAUSE post-allocation faults publish no view and preserve exact native first cause', () => {
  const native = JSON.stringify;
  const nativeFilter = Array.prototype.filter;
  const nativeFault = new CompareReportsFault('Cancelled');
  const secondary = new CompareReportsFault('DeadlineExceeded');
  for (const mode of [
    'method-getter',
    'method-call',
    'constructor',
    'species',
    'predicate',
  ] as const) {
    const run = (useHelper: boolean) => {
      const fixture = cpuViewFixture();
      const changes: CpuViewChange[] = [];
      const effects: string[] = [];
      let checkpoints = 0;
      let completion = 0;
      let caught: unknown;
      const meter = createCompareOwnerRootBytes();
      function predicate(_value: CpuViewItem, index: number) {
        effects.push('predicate/' + index);
        if (index === 1) throw nativeFault;
        return true;
      }
      try {
        if (mode === 'method-getter')
          cpuViewChange(changes, fixture.rows, 'filter', {
            configurable: true,
            get() {
              effects.push('method getter');
              throw nativeFault;
            },
          });
        if (mode === 'method-call')
          cpuViewChange(changes, fixture.rows, 'filter', {
            configurable: true,
            value() {
              effects.push('method call');
              throw nativeFault;
            },
          });
        if (mode === 'constructor')
          cpuViewChange(changes, fixture.rows, 'constructor', {
            configurable: true,
            get() {
              effects.push('constructor getter');
              throw nativeFault;
            },
          });
        if (mode === 'species') {
          const constructor = {};
          Object.defineProperty(constructor, Symbol.species, {
            get() {
              effects.push('species getter');
              throw nativeFault;
            },
          });
          cpuViewChange(changes, fixture.rows, 'constructor', {
            configurable: true,
            value: constructor,
          });
        }
        meter.measurementScope((helpers) => {
          if (useHelper) helpers.privateRead(fixture.rows);
          if (useHelper)
            helpers.privateFilter(fixture.rows, predicate, () => {
              checkpoints++;
              throw secondary;
            });
          else fixture.rows.filter(predicate);
          completion++;
        });
      } catch (error) {
        caught = error;
      } finally {
        cpuViewRestore(changes);
      }
      return { effects, caught, checkpoints, completion, fixture, meter };
    };
    const control = run(false);
    const actual = run(true);
    expect(control.caught).toBe(nativeFault);
    expect(actual.caught).toBe(nativeFault);
    expect(actual.effects).toEqual(control.effects);
    expect(actual.checkpoints).toBe(0);
    expect(actual.completion).toBe(0);
    actual.fixture.shared.label += ' mutable after failed native scope Ω';
    const roots = [
      actual.fixture.rows,
      actual.fixture.shared,
      actual.fixture.rows,
    ];
    expect(actual.meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  }
  let controlCheckpoints = 0;
  createCompareOwnerRootBytes().measurementScope((helpers) => {
    const fixture = cpuViewFixture();
    expect(helpers.privateRead(fixture.rows)).toBe(true);
    const view = helpers.privateFilter(fixture.rows, cpuViewMixed, () => {
      controlCheckpoints++;
    });
    expect(view.length).toBe(4);
  });
  expect(controlCheckpoints).toBe(6);
  for (const at of [1, 2, controlCheckpoints]) {
    const meter = createCompareOwnerRootBytes();
    const other = createCompareOwnerRootBytes();
    const fixture = cpuViewFixture();
    const fault = new CompareReportsFault(
      at === 1 ? 'Cancelled' : 'DeadlineExceeded',
    );
    let checkpoints = 0;
    let predicates = 0;
    let completion = 0;
    let caught: unknown;
    const freezeTargets: unknown[] = [];
    meter.measurementScope((outer) => {
      const owned = acClose(meter, { stable: 'valid outer bytes Ω' });
      const parent = outer.array<unknown>();
      parent.append(owned);
      parent.seal();
      const freezeDescriptor = Object.getOwnPropertyDescriptor(
        Object,
        'freeze',
      )!;
      const nativeFreeze = Object.freeze;
      const trackedFreeze: typeof Object.freeze = function (
        this: unknown,
        ...args: unknown[]
      ) {
        freezeTargets.push(args[0]);
        return Reflect.apply(nativeFreeze, this, args);
      };
      try {
        meter.measurementScope((helpers) => {
          expect(helpers.privateRead(fixture.rows)).toBe(true);
          try {
            Object.defineProperty(Object, 'freeze', {
              ...freezeDescriptor,
              value: trackedFreeze,
            });
            helpers.privateFilter(
              fixture.rows,
              (_value, index) => {
                predicates++;
                return index !== 1;
              },
              () => {
                checkpoints++;
                if (checkpoints === at) throw fault;
              },
            );
            completion++;
          } finally {
            Object.defineProperty(Object, 'freeze', freezeDescriptor);
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(Object.getOwnPropertyDescriptor(Object, 'freeze')).toEqual(
        freezeDescriptor,
      );
      expect(caught).toBe(fault);
      expect(checkpoints).toBe(at);
      expect(predicates).toBe(5);
      expect(completion).toBe(0);
      expect(freezeTargets).toEqual([]);
      expect(Object.isFrozen(fixture.rows)).toBe(false);
      expect(Object.isFrozen(fixture.shared)).toBe(false);
      fixture.shared.label += ' failed metadata lifetime released Ω';
      fixture.shared.slots.push('new released data');
      const roots = [
        parent.value,
        fixture.rows,
        fixture.shared,
        fixture.rows,
        parent.value,
      ];
      expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
      meter.measurementScope((fresh) => {
        const good = cpuViewFixture();
        expect(fresh.privateRead(good.rows)).toBe(true);
        const view = fresh.privateFilter(good.rows, cpuViewMixed);
        expect(Object.isFrozen(view)).toBe(true);
        expect(meter.bytes([parent.value, view, view])).toBe(
          cpuFrameBytes(native, [parent.value, view, view]),
        );
      });
    });
  }
  // A final checkpoint may invalidate a guard, but may not publish/freeze or replay.
  const meter = createCompareOwnerRootBytes();
  const fixture = cpuViewFixture();
  const changes: CpuViewChange[] = [];
  let checkpoints = 0;
  let predicates = 0;
  const view = meter.measurementScope((helpers) => {
    expect(helpers.privateRead(fixture.rows)).toBe(true);
    try {
      return helpers.privateFilter(
        fixture.rows,
        (_value, index) => {
          predicates++;
          return index !== 1;
        },
        () => {
          checkpoints++;
          if (checkpoints === controlCheckpoints)
            cpuViewChange(changes, Array, Symbol.species, {
              configurable: true,
              value: undefined,
            });
        },
      );
    } finally {
      cpuViewRestore(changes);
    }
  });
  expect(checkpoints).toBe(controlCheckpoints);
  expect(predicates).toBe(5);
  expect(Object.isFrozen(view)).toBe(false);
  fixture.shared.label += ' final guard declined, no stale bytes';
  const roots = [fixture.rows, view, { view }, view, fixture.shared];
  expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
  expect(createCompareOwnerRootBytes().bytes(roots)).toBe(
    cpuFrameBytes(native, roots),
  );
  expect(Array.prototype.filter).toBe(nativeFilter);
  expect(JSON.stringify).toBe(native);
});

test('CR-CPU02-READ-VIEW-LIFETIME own and captured older capabilities cannot donate younger read-view proof', () => {
  const native = JSON.stringify;
  for (const route of ['own', 'captured-older'] as const) {
    for (const exit of ['normal', 'exception'] as const) {
      const meter = createCompareOwnerRootBytes();
      const other = createCompareOwnerRootBytes();
      const fixture = cpuViewFixture();
      const sentinel = new CompareReportsFault('Cancelled');
      const escaped: {
        view: readonly CpuViewItem[];
        second: readonly CpuViewItem[];
      }[] = [];
      let caught: unknown;
      let completions = 0;
      const expired: CpuViewHelpers = meter.measurementScope((older) => {
        const parent = older.array<unknown>();
        try {
          meter.measurementScope((younger) => {
            const helpers = route === 'own' ? younger : older;
            expect(helpers.privateRead(fixture.rows)).toBe(true);
            const view = helpers.privateFilter(fixture.rows, cpuViewMixed);
            const second = helpers.privateFilter(
              view,
              (_value, index) => index < 2,
            );
            escaped.push({ view, second });
            expect(view).not.toBe(fixture.rows);
            expect(view).toEqual([
              fixture.shared,
              fixture.shared,
              undefined,
              null,
            ]);
            expect(second).not.toBe(view);
            expect(second[0]).toBe(fixture.shared);
            expect(second[1]).toBe(fixture.shared);
            expect(Object.isFrozen(view)).toBe(true);
            expect(Object.isFrozen(second)).toBe(true);
            for (const value of [
              fixture.rows,
              fixture.shared,
              fixture.shared.slots,
            ])
              expect(Object.isFrozen(value)).toBe(false);
            expect(meter.certifyOwned(Object.freeze({ view, second }))).toBe(
              false,
            );
            parent.append(view);
            parent.append(second);
            const roots = [
              parent.value,
              view,
              fixture.rows,
              parent.value,
              second,
              view,
            ];
            expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
            if (exit === 'exception') throw sentinel;
            completions++;
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(exit === 'exception' ? sentinel : undefined);
        expect(completions).toBe(exit === 'exception' ? 0 : 1);
        const released = escaped[0];
        if (!released) throw new Error('Missing escaped native view fixture.');
        fixture.shared.label += ' changed released child Ω much larger';
        fixture.shared.slots.push('released nested slots');
        fixture.rows.push(fixture.shared);
        const roots = [
          parent.value,
          released.view,
          fixture.rows,
          parent.value,
          released.second,
          released.view,
          fixture.shared,
        ];
        expect(meter.bytes(roots)).toBe(cpuFrameBytes(native, roots));
        expect(other.bytes(roots)).toBe(cpuFrameBytes(native, roots));
        return older;
      });
      meter.measurementScope((fresh) => {
        const current = cpuViewFixture();
        expect(fresh.privateRead(current.rows)).toBe(true);
        let calls = 0;
        let checkpoints = 0;
        const view = expired.privateFilter(
          current.rows,
          (_value, index) => {
            calls++;
            return index !== 1;
          },
          () => {
            checkpoints++;
            throw sentinel;
          },
        );
        expect(calls).toBe(5);
        expect(checkpoints).toBe(0);
        expect(view).toEqual([current.shared, current.shared, undefined, null]);
        expect(Object.isFrozen(view)).toBe(false);
        expect(meter.bytes([view, current.rows, view])).toBe(
          cpuFrameBytes(native, [view, current.rows, view]),
        );
      });
    }
  }
  // Original recursive completion remains the sole permanent certificate path.
  const meter = createCompareOwnerRootBytes();
  meter.measurementScope((helpers) => {
    const fixture = cpuViewFixture();
    expect(helpers.privateRead(fixture.rows)).toBe(true);
    const view = helpers.privateFilter(fixture.rows, cpuViewMixed);
    const parent = Object.freeze({ view });
    expect(meter.certifyOwned(parent)).toBe(false);
    acClose(meter, view);
    expect(meter.certifyOwned(parent)).toBe(true);
    expect(meter.bytes([parent, view, parent])).toBe(
      cpuFrameBytes(native, [parent, view, parent]),
    );
  });
  expect(JSON.stringify).toBe(native);
});

// CR-CPU03: independent fixed data and the original source-derived frame grammar.
type Cpu03Compared = Extract<
  CompareReportsResult,
  { status: 'compared'; reportKind: 'backlink' }
>;
type Cpu03Evidence = CompareBacklinkProjection['donors'][number]['evidence'];
type Cpu03Envelope = ReturnType<typeof compareReportsToolResult>;
type Cpu03Side = Parameters<typeof compareProjectedReports>[1];
function cpu03Status(
  n: number,
  side: 'before' | 'after',
): CompareStatusProjection {
  return {
    id: side,
    type: 'backlink/checker',
    size: n,
    processedCount: n,
    indexedCount: null,
    isCompleted: true,
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
    targetDomains: ['CPU.Ω"\\'],
    providerCreatedAt:
      side === 'before' ? ' status-before Ω"\\ ' : ' status-after Ω"\\ ',
  };
}
function cpu03Page(
  n: number,
  side: 'before' | 'after',
  page: number,
): CompareBacklinkProjection {
  const first = page * 100;
  return {
    family: 'backlink/checker',
    reportKind: 'backlink',
    taskId: side,
    size: n,
    processedCount: n,
    isCompleted: true,
    page,
    lastPage: Math.ceil(n / 100) - 1,
    donors: Array.from({ length: Math.min(100, n - first) }, (_, offset) => ({
      donorUrl: 'https://cpu.test/d/' + String(first + offset).padStart(3, '0'),
      processedWitness: true,
      evidence: { state: 'reported', targetLinks: [] },
    })),
    rawTargetLinkCount: 0,
    duplicateTargetLinkCount: 0,
  };
}
function cpu03Fixture(n: number) {
  const baseline: [CompareStatusProjection, CompareStatusProjection] = [
    cpu03Status(n, 'before'),
    cpu03Status(n, 'after'),
  ];
  const wrappers = (side: 'before' | 'after') =>
    Array.from({ length: Math.ceil(n / 100) }, (_, page) => {
      const projection = cpu03Page(n, side, page);
      return {
        projection,
        donorRawTargetCounts: projection.donors.map(() => 0),
      };
    });
  return { baseline, beforeA: wrappers('before'), afterA: wrappers('after') };
}
type Cpu03Fixture = ReturnType<typeof cpu03Fixture>;
function cpu03Comparison(): Extract<
  Cpu03Compared['rows'][number]['comparison'],
  { state: 'compared' }
> {
  return {
    state: 'compared',
    newlyReportedTargetUrls: [],
    noLongerReportedTargetUrls: [],
    attributeChangedTargetUrls: [],
    unchangedTargetUrls: [],
  };
}
function cpu03Counts(n: number): Cpu03Compared['counts'] {
  return {
    comparedDonors: 0,
    unknownDonors: 0,
    totalDonors: n,
    newlyReportedTargetUrls: 0,
    noLongerReportedTargetUrls: 0,
    attributeChangedTargetUrls: 0,
    unchangedTargetUrls: 0,
  };
}
function cpu03Summary(
  n: number,
  side: 'before' | 'after',
): Cpu03Compared['before'] {
  const p = Math.ceil(n / 100);
  return {
    status: cpu03Status(n, side),
    report: {
      size: n,
      processedCount: n,
      isCompleted: true,
      lastPage: p - 1,
      pagesVisited: p,
    },
    coverage: {
      rawDonorCount: n,
      observedUniqueDonorCount: n,
      duplicateDonorCount: 0,
      conflictingDonorCount: 0,
      rawTargetLinkCount: 0,
      duplicateTargetLinkCount: 0,
      reportedSlotGap: 0,
    },
  };
}
function cpu03Expected(n: number): Cpu03Compared {
  return {
    status: 'compared',
    reportKind: 'backlink',
    family: 'backlink/checker',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: {
      basis: 'observed_union',
      direction: 'caller_selected',
      observations: 'non_atomic_provider_reports',
      originalCorpusEquality: 'unknown',
      originalHistory: 'unknown',
      liveState: 'not_observed',
    },
    targetScope: {
      provenance: 'matching_current_provider_status',
      targetDomains: ['CPU.Ω"\\'],
      originalTargets: 'unknown',
    },
    before: cpu03Summary(n, 'before'),
    after: cpu03Summary(n, 'after'),
    rows: Array.from({ length: n }, (_, i) => ({
      donorUrl: 'https://cpu.test/d/' + String(i).padStart(3, '0'),
      before: { state: 'reported', targetLinks: [] },
      after: { state: 'reported', targetLinks: [] },
      comparison: cpu03Comparison(),
    })),
    counts: { ...cpu03Counts(n), comparedDonors: n },
  };
}
interface Cpu03Frame {
  roots: readonly unknown[];
  label: string;
  completed?: object;
}
function cpu03MarkOwned(value: unknown, owned: WeakSet<object>) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) cpu03MarkOwned(child, owned);
    Object.freeze(value);
    owned.add(value);
  }
}
function* cpu03Certify(
  value: object,
  roots: readonly unknown[],
  owned: WeakSet<object>,
  label: string,
): Generator<Cpu03Frame, void, unknown> {
  if (owned.has(value)) return;
  const keys = Reflect.ownKeys(value);
  Object.freeze(keys);
  if (keys.length === 0)
    yield { roots: [...roots, value, keys], label: label + '/cert-empty' };
  for (const key of keys)
    yield {
      roots: [
        ...roots,
        value,
        keys,
        Object.getOwnPropertyDescriptor(value, key)!,
      ],
      label: label + '/cert',
    };
  owned.add(value);
}
function* cpu03Close(
  value: unknown,
  prefix: readonly unknown[],
  owned: WeakSet<object>,
  label: string,
  parents: readonly unknown[] = [],
): Generator<Cpu03Frame, void, unknown> {
  if (value === null || typeof value !== 'object') return;
  yield {
    roots: [...prefix, ...parents, value],
    label: label + '/close-value',
  };
  const keys = Object.keys(value);
  yield {
    roots: [...prefix, ...parents, value, keys],
    label: label + '/close-keys',
  };
  for (const key of keys)
    yield* cpu03Close(Reflect.get(value, key), prefix, owned, label, [
      ...parents,
      value,
      keys,
    ]);
  Object.freeze(value);
  const roots = [...prefix, ...parents, value, keys];
  yield { roots, completed: value, label: label + '/close-complete' };
  yield* cpu03Certify(value, roots, owned, label);
}
function* cpu03Freeze(
  value: unknown,
  prefix: readonly unknown[],
  owned: WeakSet<object>,
  label: string,
  parents: readonly unknown[] = [],
  privatelyCompleted?: WeakSet<object>,
  certify = true,
): Generator<Cpu03Frame, void, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (!certify && privatelyCompleted?.has(value))
  )
    return;
  const values = Object.values(value);
  yield {
    roots: [...prefix, ...parents, values],
    label: label + '/freeze-values',
  };
  for (const child of values)
    yield* cpu03Freeze(
      child,
      prefix,
      owned,
      label,
      [...parents, values],
      privatelyCompleted,
      certify,
    );
  Object.freeze(value);
  if (certify) {
    const roots = [...prefix, ...parents, values];
    yield { roots, completed: value, label: label + '/freeze-complete' };
    yield* cpu03Certify(value, roots, owned, label);
    privatelyCompleted?.add(value);
  }
}
function* cpu03CountFrames(
  n: number,
  prefix: readonly unknown[],
  label: string,
): Generator<Cpu03Frame, Cpu03Compared['counts'], unknown> {
  const counts = cpu03Counts(n);
  for (let i = 0; i < n; i++) {
    yield { roots: [...prefix, counts], label };
    counts.comparedDonors++;
  }
  yield { roots: [...prefix, counts], label };
  return counts;
}
function* cpu03DonorFrames(
  prefix: readonly unknown[],
  label: string,
): Generator<Cpu03Frame, ReturnType<typeof cpu03Comparison>, unknown> {
  const b = new Map<string, Set<string>>(),
    a = new Map<string, Set<string>>();
  const comparison = cpu03Comparison();
  const roots = [...prefix, b, a, comparison];
  // The pinned fixture has no target tuples: preserve the real empty unique frame.
  yield {
    roots: [...roots, [], new Set<string>(), []],
    label: label + '/target-union',
  };
  yield { roots, label: label + '/target-final' };
  return comparison;
}
function* cpu03SemanticFrames(
  value: Cpu03Compared,
  prefix: readonly unknown[],
  native: typeof JSON.stringify,
  label: string,
): Generator<Cpu03Frame, void, unknown> {
  yield { roots: [...prefix, value], label: label + '/clone' };
  const ids = value.rows.map((row) => row.donorUrl);
  const identity = [...prefix, value, ids];
  yield { roots: [...identity, new Set(ids)], label: label + '/ids-seen' };
  const counts = yield* cpu03CountFrames(
    value.rows.length,
    identity,
    label + '/counts',
  );
  yield {
    roots: [
      ...identity,
      value.counts,
      counts,
      native(value.counts),
      native(counts),
    ],
    label: label + '/counts-same',
  };
  for (const side of ['before', 'after'] as const) {
    const present = [...value.rows];
    const presentPrefix = [...identity, present];
    yield { roots: presentPrefix, label: label + '/present' };
    yield {
      roots: [...presentPrefix, []],
      label: label + '/conflict-selection',
    };
    yield {
      roots: [...presentPrefix, [...present]],
      label: label + '/processed-selection',
    };
    yield {
      roots: [
        ...presentPrefix,
        value[side].status.targetDomains,
        value.targetScope.targetDomains,
        native(value[side].status.targetDomains),
        native(value.targetScope.targetDomains),
      ],
      label: label + '/target-same',
    };
  }
  for (const row of value.rows) {
    for (const side of [row.before, row.after]) {
      yield { roots: [...identity, side], label: label + '/side' };
      yield {
        roots: [...identity, [], new Set<string>()],
        label: label + '/side-tuples',
      };
    }
    const comparison = yield* cpu03DonorFrames(identity, label);
    yield {
      roots: [
        ...identity,
        row.comparison,
        comparison,
        native(row.comparison),
        native(comparison),
      ],
      label: label + '/row-same',
    };
  }
}
function* cpu03ReadFrames(
  n: number,
  side: 'before' | 'after',
  source: Cpu03Side,
  prefix: readonly unknown[],
  owned: WeakSet<object>,
  native: typeof JSON.stringify,
) {
  const pages: CompareBacklinkProjection[] = [];
  for (let i = 0; i < source.reports.length; i++) {
    const original = source.reports[i]!;
    yield {
      roots: [...prefix, pages, original, original],
      label: side + '/read-source',
    };
    const parsed = { success: true, data: cpu03Page(n, side, i) };
    yield { roots: [...prefix, pages, parsed], label: side + '/read-parsed' };
    yield* cpu03Close(
      parsed.data,
      [...prefix, pages, parsed],
      owned,
      side + '/projection',
    );
    pages.push(parsed.data);
  }
  const first = pages[0]!;
  for (const page of pages) {
    const left = [
      page.taskId,
      page.size,
      page.processedCount,
      page.isCompleted,
      page.lastPage,
    ];
    const right = [
      first.taskId,
      first.size,
      first.processedCount,
      first.isCompleted,
      first.lastPage,
    ];
    yield {
      roots: [...prefix, pages, left, right, native(left), native(right)],
      label: side + '/header',
    };
  }
  const donors = new Map<string, Cpu03Evidence>(),
    witnesses = new Set<string>();
  const indexed = [...prefix, pages, donors, witnesses];
  for (const page of pages)
    for (const donor of page.donors) {
      witnesses.add(donor.donorUrl);
      donors.set(donor.donorUrl, donor.evidence);
      yield { roots: indexed, label: side + '/donor-insert' };
    }
  const summary = {
    status: source.status,
    report: {
      size: n,
      processedCount: n,
      isCompleted: true,
      lastPage: pages.length - 1,
      pagesVisited: pages.length,
    },
  };
  const coverage = {
    rawDonorCount: n,
    observedUniqueDonorCount: n,
    duplicateDonorCount: 0,
  };
  yield {
    roots: [...indexed, summary, coverage, []],
    label: side + '/summary-selection',
  };
  const result = {
    donors,
    summary: Object.assign(summary, {
      coverage: Object.assign(coverage, {
        conflictingDonorCount: 0,
        rawTargetLinkCount: 0,
        duplicateTargetLinkCount: 0,
        reportedSlotGap: 0,
      }),
    }),
  };
  yield { roots: [...indexed, result], label: side + '/read-final' };
  yield* cpu03Close(
    result.summary,
    [...indexed, result],
    owned,
    side + '/summary',
  );
  return result;
}
function* cpu03Grammar(
  n: number,
  warm: Cpu03Fixture,
  native: typeof JSON.stringify,
): Generator<Cpu03Frame, void, unknown> {
  const owned = new WeakSet<object>();
  cpu03MarkOwned(warm, owned);
  const sourceBefore = {
    status: warm.baseline[0],
    reports: warm.beforeA.map((w) => w.projection),
  };
  const sourceAfter = {
    status: warm.baseline[1],
    reports: warm.afterA.map((w) => w.projection),
  };
  const parsedInput = {
    success: true,
    data: {
      family: 'backlink/checker',
      beforeTaskId: 'before',
      afterTaskId: 'after',
    },
  };
  yield {
    roots: [
      sourceBefore,
      sourceAfter,
      parsedInput,
      sourceBefore.status,
      sourceAfter.status,
    ],
    label: 'caller/entry',
  };
  const beforeStatus = { success: true, data: cpu03Status(n, 'before') },
    afterStatus = { success: true, data: cpu03Status(n, 'after') };
  const caller = [
    sourceBefore,
    sourceAfter,
    parsedInput,
    beforeStatus,
    afterStatus,
  ];
  yield { roots: caller, label: 'caller/statuses' };
  yield* cpu03Close(beforeStatus.data, caller, owned, 'caller/before-status');
  yield* cpu03Close(afterStatus.data, caller, owned, 'caller/after-status');
  const helperBefore = {
      status: beforeStatus.data,
      reports: sourceBefore.reports,
    },
    helperAfter = { status: afterStatus.data, reports: sourceAfter.reports };
  const helper = [...caller, helperBefore, helperAfter];
  yield {
    roots: [
      ...helper,
      helperBefore.status.targetDomains,
      helperAfter.status.targetDomains,
      native(helperBefore.status.targetDomains),
      native(helperAfter.status.targetDomains),
    ],
    label: 'helper/targets',
  };
  const b = yield* cpu03ReadFrames(
    n,
    'before',
    helperBefore,
    helper,
    owned,
    native,
  );
  const a = yield* cpu03ReadFrames(
    n,
    'after',
    helperAfter,
    [...helper, b],
    owned,
    native,
  );
  const outer = [...helper, b, a];
  const missing: Cpu03Evidence = { state: 'unknown', reason: 'not_reported' };
  yield* cpu03Close(missing, [...outer, missing], owned, 'rows/missing');
  const rows: Cpu03Compared['rows'] = [];
  const allKeys = [...b.donors.keys(), ...a.donors.keys()],
    keys = new Set(allKeys),
    union = [...keys];
  yield { roots: [...outer, allKeys, keys, union], label: 'rows/union' };
  const loop = [...outer, union, rows];
  for (const donorUrl of union) {
    const before = b.donors.get(donorUrl)!,
      after = a.donors.get(donorUrl)!;
    const partial = { donorUrl, before, after };
    const comparison = yield* cpu03DonorFrames([...loop, partial], 'rows');
    const row = Object.assign(partial, { comparison });
    yield { roots: [...loop, row], label: 'rows/row' };
    yield* cpu03Close(row, [...loop, row], owned, 'rows/row');
    rows.push(row);
  }
  yield* cpu03Close(rows, [...outer, rows], owned, 'rows/all');
  const draft = {
    status: 'compared' as const,
    reportKind: 'backlink' as const,
    family: 'backlink/checker' as const,
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: {
      basis: 'observed_union' as const,
      direction: 'caller_selected' as const,
      observations: 'non_atomic_provider_reports' as const,
      originalCorpusEquality: 'unknown' as const,
      originalHistory: 'unknown' as const,
      liveState: 'not_observed' as const,
    },
    targetScope: {
      provenance: 'matching_current_provider_status' as const,
      targetDomains: ['CPU.Ω"\\'],
      originalTargets: 'unknown' as const,
    },
    before: b.summary,
    after: a.summary,
    rows,
  };
  const counts = yield* cpu03CountFrames(
    n,
    [...outer, rows, draft],
    'rows/counts',
  );
  const value = Object.assign(draft, { counts });
  yield { roots: [...outer, rows, value], label: 'rows/result' };
  yield* cpu03Close(value, [...outer, rows, value], owned, 'rows/result');
  yield {
    roots: [...caller, value, value],
    label: 'comparison/validate-entry',
  };
  const comparedClone = cpu03Expected(n);
  yield* cpu03SemanticFrames(
    comparedClone,
    [...caller, value],
    native,
    'comparison/semantic',
  );
  const parsedComparison = { success: true, data: comparedClone };
  const comparisonRoots = [...caller, value, parsedComparison];
  yield { roots: comparisonRoots, label: 'comparison/parsed' };
  yield* cpu03Freeze(comparedClone, comparisonRoots, owned, 'comparison');
  // Comparison lease has ended; publication starts with only its original value.
  yield { roots: [comparedClone, comparedClone], label: 'publication/entry' };
  const publicationClone = cpu03Expected(n);
  yield* cpu03SemanticFrames(
    publicationClone,
    [comparedClone],
    native,
    'publication/semantic',
  );
  const parsedPublication = { success: true, data: publicationClone };
  const publicationRoots = [comparedClone, parsedPublication];
  yield { roots: publicationRoots, label: 'publication/parsed' };
  const privatelyCompleted = new WeakSet<object>();
  yield* cpu03Freeze(
    publicationClone,
    publicationRoots,
    owned,
    'publication',
    [],
    privatelyCompleted,
  );
  const envelope = {
    isError: false,
    content: [{ type: 'text', text: native(publicationClone) }],
    structuredContent: publicationClone,
  };
  const envelopeRoots = [...publicationRoots, envelope];
  yield { roots: envelopeRoots, label: 'envelope/entry' };
  yield* cpu03Freeze(
    envelope,
    envelopeRoots,
    owned,
    'envelope',
    [],
    privatelyCompleted,
    false,
  );
  // Both measurement scopes have ended. This is the real owner's final frame.
  yield { roots: [comparedClone, envelope], label: 'owner/final' };
}

function cpu03Assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('CR-CPU03 ' + message);
}
function cpu03Binder() {
  const forward = new WeakMap<object, object>(),
    reverse = new WeakMap<object, object>();
  const widths = new WeakMap<object, number>();
  let checks = 0;
  const bind = (expected: unknown, actual: unknown, label: string): void => {
    checks++;
    if (expected === null || typeof expected !== 'object') {
      cpu03Assert(Object.is(actual, expected), label + ' primitive identity');
      return;
    }
    cpu03Assert(
      actual !== null && typeof actual === 'object',
      label + ' object',
    );
    const prior = forward.get(expected),
      other = reverse.get(actual);
    cpu03Assert(
      prior === undefined || prior === actual,
      label + ' retained root/alias',
    );
    cpu03Assert(
      other === undefined || other === expected,
      label + ' distinct allocation',
    );
    if (!prior) {
      forward.set(expected, actual);
      reverse.set(actual, expected);
    }
    if (expected instanceof Map) {
      cpu03Assert(
        actual instanceof Map && actual.size === expected.size,
        label + ' map width',
      );
      const old = widths.get(expected) ?? 0;
      if (!prior || old !== expected.size) {
        const observed = actual.entries();
        for (const [key, value] of expected) {
          const entry = observed.next();
          cpu03Assert(!entry.done, label + ' map order length');
          bind(key, entry.value[0], label + '/map-key');
          bind(value, entry.value[1], label + '/map-value');
        }
        cpu03Assert(observed.next().done, label + ' map final length');
      }
      widths.set(expected, expected.size);
    } else if (expected instanceof Set) {
      cpu03Assert(
        actual instanceof Set && actual.size === expected.size,
        label + ' set width',
      );
      if (!prior || widths.get(expected) !== expected.size) {
        const observed = actual.values();
        for (const value of expected) {
          const entry = observed.next();
          cpu03Assert(!entry.done, label + ' set order length');
          bind(value, entry.value, label + '/set');
        }
        cpu03Assert(observed.next().done, label + ' set final length');
      }
      widths.set(expected, expected.size);
    } else if (Array.isArray(expected)) {
      cpu03Assert(
        Array.isArray(actual) && actual.length === expected.length,
        label + ' array width',
      );
      const old = prior ? (widths.get(expected) ?? 0) : 0;
      for (let i = old; i < expected.length; i++)
        bind(expected[i], actual[i], label + '/array');
      widths.set(expected, expected.length);
    } else {
      cpu03Assert(
        Object.getPrototypeOf(actual) === Object.getPrototypeOf(expected),
        label + ' plain prototype',
      );
      const keys = Object.keys(expected),
        actualKeys = Object.keys(actual);
      cpu03Assert(
        keys.length === actualKeys.length,
        label + ' own field count',
      );
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        cpu03Assert(key === actualKeys[i], label + ' own field order');
        bind(
          Reflect.get(expected, key),
          Reflect.get(actual, key),
          label + '/' + key,
        );
      }
    }
  };
  return { bind, checks: () => checks };
}
function cpu03FrameText(
  native: typeof JSON.stringify,
  warm: Cpu03Fixture,
  roots: readonly unknown[],
) {
  return native(
    [warm.baseline, warm.beforeA, warm.afterA, [], null, roots],
    (_name, value: unknown) =>
      value instanceof Map
        ? Array.from(value.entries())
        : value instanceof Set
          ? Array.from(value.values())
          : value,
  );
}
function cpu03Run(n: 32 | 128, limit = Infinity) {
  const native = JSON.stringify;
  const original = cpu03Fixture(n);
  const originalText = native(original);
  const warm = structuredClone(original);
  const modelWarm = cpu03Fixture(n);
  const meter = createCompareOwnerRootBytes();
  // Owner-equivalent setup is deliberately outside the production receipt.
  acClose(meter, warm.baseline);
  for (const wrapper of warm.beforeA) acClose(meter, wrapper);
  for (const wrapper of warm.afterA) acClose(meter, wrapper);
  meter.replaceStatus('baseline', warm.baseline);
  for (const wrapper of warm.beforeA) meter.appendReport('beforeA', wrapper);
  for (const wrapper of warm.afterA) meter.appendReport('afterA', wrapper);
  const grammar = cpu03Grammar(n, modelWarm, native);
  const identities = cpu03Binder();
  const boundary = new CompareReportsFault('ResourceLimitExceeded');
  const frameBytes: number[] = [];
  const labels: string[] = [];
  const phaseCounts: Record<string, number> = {};
  const completed: { result: CompareReportsResult; envelope: Cpu03Envelope }[] =
    [];
  let production = false,
    nativeCalls = 0,
    nativeBytes = 0,
    peak = 0;
  let caught: unknown;
  let failed = false,
    lateFrames = 0,
    lateCheckpoints = 0,
    checkpoints = 0;
  const checkpoint = () => {
    checkpoints++;
    if (failed) lateCheckpoints++;
  };
  const record: typeof JSON.stringify = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const value = Reflect.apply(native, this, args);
    if (production) {
      nativeCalls++;
      if (typeof value === 'string')
        nativeBytes += Buffer.byteLength(value, 'utf8');
    }
    return value;
  };
  const observe = (
    roots: readonly unknown[],
    completedOwned?: object,
  ): void => {
    if (failed) lateFrames++;
    const wasProduction = production;
    let exact: number;
    try {
      production = false;
      const next = grammar.next();
      cpu03Assert(
        !next.done,
        'unexpected notification after independent grammar ended',
      );
      const frame = next.value;
      cpu03Assert(
        roots.length === frame.roots.length,
        frame.label + ' root count ' + roots.length + '/' + frame.roots.length,
      );
      for (let i = 0; i < roots.length; i++)
        identities.bind(frame.roots[i], roots[i], frame.label + '/root' + i);
      if (frame.completed) {
        cpu03Assert(
          completedOwned !== undefined,
          frame.label + ' missing original completion',
        );
        identities.bind(
          frame.completed,
          completedOwned,
          frame.label + '/completed',
        );
        cpu03Assert(
          Object.isFrozen(completedOwned),
          frame.label + ' actual completed candidate frozen',
        );
      } else
        cpu03Assert(
          completedOwned === undefined,
          frame.label + ' extra completion',
        );
      const expectedText = cpu03FrameText(native, modelWarm, frame.roots);
      const actualText = cpu03FrameText(native, warm, roots);
      if (actualText !== expectedText) {
        let at = 0;
        while (
          at < Math.min(actualText.length, expectedText.length) &&
          actualText[at] === expectedText[at]
        )
          at++;
        throw new Error(
          'CR-CPU03 ' +
            frame.label +
            ' full native grammar mismatch at ' +
            at +
            '; actual=' +
            actualText.slice(Math.max(0, at - 60), at + 120) +
            '; expected=' +
            expectedText.slice(Math.max(0, at - 60), at + 120),
        );
      }
      exact = Buffer.byteLength(expectedText, 'utf8');
      frameBytes.push(exact);
      labels.push(frame.label);
      const phase = frame.label.split('/')[0]!;
      phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
      peak = Math.max(peak, exact);
    } finally {
      production = wasProduction;
    }
    checkpoint();
    const measured = meter.bytes(roots);
    checkpoint();
    cpu03Assert(
      measured === exact,
      'complete six-slot scalar/native bytes ' + measured + '/' + exact,
    );
    if (exact > limit) {
      failed = true;
      throw boundary;
    }
    if (completedOwned)
      meter.certifyOwned(
        completedOwned,
        (metadata) => observe([...roots, ...metadata]),
        checkpoint,
      );
  };
  try {
    JSON.stringify = record;
    production = true;
    const result = meter.measurementScope((measurements) => {
      const before = {
        status: warm.baseline[0],
        reports: (() => {
          const writer = measurements.array<CompareBacklinkProjection>();
          for (const wrapper of warm.beforeA) writer.append(wrapper.projection);
          writer.seal();
          return writer.value;
        })(),
      };
      const after = {
        status: warm.baseline[1],
        reports: (() => {
          const writer = measurements.array<CompareBacklinkProjection>();
          for (const wrapper of warm.afterA) writer.append(wrapper.projection);
          writer.seal();
          return writer.value;
        })(),
      };
      return compareProjectedReports(
        {
          family: 'backlink/checker',
          beforeTaskId: 'before',
          afterTaskId: 'after',
        },
        before,
        after,
        checkpoint,
        observe,
        measurements,
      );
    });
    const envelope = meter.measurementScope((measurements) =>
      compareReportsToolResult(result, {
        checkpoint,
        observeWork: observe,
        measurements,
      }),
    );
    // Same real observer, after both synchronous read-measurement lifetimes ended.
    observe([result, envelope]);
    production = false;
    cpu03Assert(
      grammar.next().done,
      'missing independent original root lifetime frames',
    );
    completed.push({ result, envelope });
  } catch (error) {
    caught = error;
  } finally {
    production = false;
    JSON.stringify = native;
  }
  expect(JSON.stringify).toBe(native);
  expect(native(original)).toBe(originalText);
  const mutable = (value: unknown) => {
    if (value !== null && typeof value === 'object') {
      expect(Object.isFrozen(value)).toBe(false);
      for (const child of Object.values(value)) mutable(child);
    }
  };
  mutable(original);
  const settled = completed[0];
  if (settled) {
    const expected = cpu03Expected(n),
      text = native(expected);
    const envelope: ReturnType<typeof compareReportsToolResult> = {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: expected,
    };
    expect(settled.result).toEqual(expected);
    expect(settled.envelope).toEqual(envelope);
    expect(settled.envelope.content[0]!.text).toBe(text);
    expect(JSON.parse(settled.envelope.content[0]!.text)).toEqual(expected);
    expect(settled.envelope.structuredContent).not.toBe(settled.result);
    expect(settled.envelope.structuredContent).not.toBe(expected);
    expect(settled.envelope.isError).toBe(false);
    expect(Buffer.byteLength(native(settled.envelope), 'utf8')).toBe(
      Buffer.byteLength(native(envelope), 'utf8'),
    );
    acDeepFrozen(settled.result);
    acDeepFrozen(settled.envelope);
    expect(labels.at(-1)).toBe('owner/final');
  }
  expect(lateFrames).toBe(0);
  expect(lateCheckpoints).toBe(0);
  return {
    n,
    frameBytes,
    labels,
    phaseCounts,
    peak,
    nativeCalls,
    nativeBytes,
    checkpoints,
    identityChecks: identities.checks(),
    complete: settled !== undefined,
    caught,
    boundary,
  };
}

test('CR-CPU03 fixed32 and128 complete comparison and publication preserve data roots and native volume', () => {
  const receipts: unknown[] = [];
  for (const n of [32, 128] as const) {
    const control = cpu03Run(n);
    expect(control.caught).toBeUndefined();
    expect(control.complete).toBe(true);
    expect(control.nativeBytes).toBeLessThanOrEqual(
      n === 32 ? 119668736 : 426377216,
    );
    expect(control.identityChecks).toBeGreaterThan(control.frameBytes.length);
    const atN = cpu03Run(n, control.peak);
    expect(atN.caught).toBeUndefined();
    expect(atN.complete).toBe(true);
    expect(atN.frameBytes).toEqual(control.frameBytes);
    expect(atN.labels).toEqual(control.labels);
    expect(atN.nativeBytes).toBe(control.nativeBytes);
    const below = cpu03Run(n, control.peak - 1);
    expect(below.caught).toBe(below.boundary);
    expect(below.complete).toBe(false);
    const first = control.frameBytes.findIndex(
      (bytes) => bytes > control.peak - 1,
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(below.frameBytes).toEqual(control.frameBytes.slice(0, first + 1));
    expect(below.labels).toEqual(control.labels.slice(0, first + 1));
    receipts.push({
      n,
      pages: Math.ceil(n / 100),
      nativeCalls: control.nativeCalls,
      nativeBytes: control.nativeBytes,
      cap: n === 32 ? 119668736 : 426377216,
      independentNativeN: control.peak,
      Nminus1: control.peak - 1,
      frames: control.frameBytes.length,
      firstNminus1Violation: first,
      phaseCounts: control.phaseCounts,
      identityChecks: control.identityChecks,
      finalOwnerFrame: control.labels.at(-1),
      checkpoints: control.checkpoints,
    });
  }
  console.info(
    'CR-CPU03 fixed native/frame receipts ' + JSON.stringify(receipts),
  );
}, 300_000);

// CR-B2-SORT: real canonical consumer; saved-native complete six-slot oracles.
const sortB2Native = {
  stringify: JSON.stringify,
  sort: Array.prototype.sort,
  push: Array.prototype.push,
};
type SortB2Mode =
  'normal' | 'receiver' | 'alternate' | 'getter' | 'method' | 'observer';
interface SortB2Call {
  mapped: string[];
  spread: string[];
  parentRoots: readonly unknown[];
  atParent: string[];
  returned?: string[];
  gets: number;
  methods: number;
  sorts: number;
  appends: number;
  argumentCounts: number[];
}
function sortB2Strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}
// Descriptor-only traversal: keep caller state outside fixture/accounted roots.
function sortB2CallerState(root: object) {
  const seen = new WeakSet<object>();
  const nodes: {
    value: object;
    prototype: unknown;
    keys: PropertyKey[];
    descriptors: PropertyDescriptor[];
    frozen: boolean;
    extensible: boolean;
  }[] = [];
  const visit = (value: unknown) => {
    if (
      (typeof value !== 'object' || value === null) &&
      typeof value !== 'function'
    )
      return;
    if (seen.has(value)) return;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) throw new Error('Missing caller property descriptor.');
      return descriptor;
    });
    nodes.push({
      value,
      prototype: Object.getPrototypeOf(value),
      keys,
      descriptors,
      frozen: Object.isFrozen(value),
      extensible: Object.isExtensible(value),
    });
    for (const descriptor of descriptors) {
      if (Object.hasOwn(descriptor, 'value')) {
        const child: unknown = descriptor.value;
        visit(child);
      }
    }
  };
  visit(root);
  return { root, nodes };
}
function sortB2UnchangedCaller(
  root: object,
  original: ReturnType<typeof sortB2CallerState>,
) {
  const current = sortB2CallerState(root);
  expect(current.root).toBe(original.root);
  expect(current.nodes).toHaveLength(original.nodes.length);
  for (const [index, before] of original.nodes.entries()) {
    const after = current.nodes[index];
    if (!after) throw new Error('Missing original caller object.');
    expect(after.value).toBe(before.value);
    expect<unknown>(after.prototype).toBe(before.prototype);
    expect(after.keys).toEqual(before.keys);
    expect(after.frozen).toBe(before.frozen);
    expect(after.extensible).toBe(before.extensible);
    expect(after.descriptors).toHaveLength(before.descriptors.length);
    for (const [index, descriptor] of before.descriptors.entries()) {
      const actual = after.descriptors[index];
      if (!actual) throw new Error('Missing original caller descriptor.');
      expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(descriptor));
      expect(actual.configurable).toBe(descriptor.configurable);
      expect(actual.enumerable).toBe(descriptor.enumerable);
      expect(actual.writable).toBe(descriptor.writable);
      const value: unknown = actual.value,
        expected: unknown = descriptor.value;
      expect<unknown>(value).toBe(expected);
      expect(actual.get).toBe(descriptor.get);
      expect(actual.set).toBe(descriptor.set);
    }
  }
}
function sortB2Fixture() {
  const high = {
    url: 'https://sort-b2.test/z',
    anchor: 'éΩ"\\😀',
    nofollow: true,
  };
  const low = {
    url: 'https://sort-b2.test/a',
    anchor: 'first "\\',
    nofollow: false,
  };
  const links = [high, low, high];
  const projection = (id: string): CompareBacklinkProjection => ({
    family: 'backlink/checker',
    reportKind: 'backlink',
    taskId: id,
    size: 1,
    processedCount: 1,
    isCompleted: true,
    page: 0,
    lastPage: 0,
    // The final unknown row makes the output coherent while earlier canonical
    // calls still exercise exact duplicate tuples (which public rows reject).
    donors: [
      ...[links, [high, high, low]].map((targetLinks) => ({
        donorUrl,
        processedWitness: true,
        evidence: {
          state: 'reported' as const,
          targetLinks: structuredClone(targetLinks),
        },
      })),
      {
        donorUrl,
        processedWitness: true,
        evidence: { state: 'unknown', reason: 'target_links_unavailable' },
      },
    ],
    rawTargetLinkCount: 6,
    duplicateTargetLinkCount: 2,
  });
  const baseline: [CompareStatusProjection, CompareStatusProjection] = [
    projectCompareStatus(backlinkStatus('before')),
    projectCompareStatus(backlinkStatus('after')),
  ];
  const beforeA = [
    { projection: projection('before'), donorRawTargetCounts: [3, 3] },
  ];
  const afterA = [
    { projection: projection('after'), donorRawTargetCounts: [3, 3] },
  ];
  return {
    baseline,
    beforeA,
    afterA,
    links,
    sortedKeys: [low, high, high].map((link) =>
      sortB2Native.stringify([link.url, link.anchor, link.nofollow]),
    ),
    appended: sortB2Native.stringify([
      'https://sort-b2.test/native-append',
      'long current-sort payload Ω'.repeat(12),
      false,
    ]),
    alternate: sortB2Native.stringify([
      'https://sort-b2.test/alternate',
      'distinct returned array é"\\',
      true,
    ]),
  };
}
type SortB2Fixture = ReturnType<typeof sortB2Fixture>;
function sortB2FrameText(fixture: SortB2Fixture, roots: readonly unknown[]) {
  return sortB2Native.stringify(
    [fixture.baseline, fixture.beforeA, fixture.afterA, [], null, roots],
    (_key, value: unknown) =>
      value instanceof Map
        ? Array.from(value.entries())
        : value instanceof Set
          ? Array.from(value.values())
          : value,
  );
}
function sortB2Seed(meter: AcMeter, fixture: SortB2Fixture) {
  meter.replaceStatus('baseline', fixture.baseline);
  for (const wrapper of fixture.beforeA) meter.appendReport('beforeA', wrapper);
  for (const wrapper of fixture.afterA) meter.appendReport('afterA', wrapper);
}
function sortB2Run(mode: SortB2Mode, measured: boolean, limit = Infinity) {
  const fixture = sortB2Fixture();
  const callerState = sortB2CallerState(fixture);
  const originalText = sortB2Native.stringify(fixture);
  const meter = createCompareOwnerRootBytes(),
    fresh = createCompareOwnerRootBytes();
  sortB2Seed(meter, fixture);
  sortB2Seed(fresh, fixture);
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'sort');
  if (!descriptor) throw new Error('Missing native sort descriptor.');
  const boundary = new CompareReportsFault('ResourceLimitExceeded');
  const observerFault = new CompareReportsFault('DeadlineExceeded');
  const nativeFault = { synthetic: 'current sort original fault' };
  const calls: SortB2Call[] = [];
  const pairs: {
    left: string[];
    right: unknown;
    leftText: string;
    rightText: string;
  }[] = [];
  const frames: string[] = [],
    frameBytes: number[] = [],
    effects: string[] = [];
  const outerChecks: { measured: number; exact: number }[] = [];
  let result: CompareReportsResult | undefined, caught: unknown;
  let peak = 0,
    failed = false,
    lateFrames = 0,
    lateCheckpoints = 0;
  let checkpoints = 0,
    completions = 0,
    aliasFrames = 0;
  let outerAlias: unknown[] = [];
  const checkpoint = () => {
    checkpoints++;
    if (failed) lateCheckpoints++;
  };
  const selected = (receiver: unknown) =>
    calls.find((call) => call.spread === receiver);
  const method = function (this: unknown, ...args: unknown[]) {
    const call = selected(this);
    if (!call) return Reflect.apply(sortB2Native.sort, this, args);
    const index = calls.indexOf(call);
    call.methods++;
    call.argumentCounts.push(args.length);
    effects.push('sort:' + index);
    call.sorts++;
    const sorted: unknown = Reflect.apply(sortB2Native.sort, this, args);
    if (sorted !== call.spread)
      throw new Error('Native sort changed receiver identity.');
    if (mode !== 'observer') {
      Reflect.apply(sortB2Native.push, call.spread, [fixture.appended]);
      call.appends++;
      effects.push('append:' + index);
    }
    if (mode === 'method') {
      effects.push('native-fault:' + index);
      failed = true;
      throw nativeFault;
    }
    const returned = mode === 'alternate' ? [fixture.alternate] : call.spread;
    call.returned = returned;
    return returned;
  };
  const install = () => {
    if (mode === 'normal') return;
    if (mode === 'getter' || mode === 'observer') {
      Object.defineProperty(Array.prototype, 'sort', {
        configurable: descriptor.configurable ?? false,
        enumerable: descriptor.enumerable ?? false,
        get(this: unknown) {
          const call = selected(this);
          if (call) {
            const index = calls.indexOf(call);
            call.gets++;
            effects.push('get:' + index);
            if (mode === 'getter') {
              effects.push('native-fault:' + index);
              failed = true;
              throw nativeFault;
            }
          }
          return method;
        },
      });
    } else
      Object.defineProperty(Array.prototype, 'sort', {
        ...descriptor,
        value: method,
      });
  };
  const observe = (roots: readonly unknown[], completedOwned?: object) => {
    if (failed) lateFrames++;
    const text = sortB2FrameText(fixture, roots);
    const exact = Buffer.byteLength(text, 'utf8');
    frames.push(text);
    frameBytes.push(exact);
    peak = Math.max(peak, exact);
    const charged = measured ? meter.bytes(roots) : exact;
    if (charged !== exact)
      throw new Error(
        'CR-B2-SORT stale full-frame bytes: measured=' +
          charged +
          ' native=' +
          exact,
      );
    if (completedOwned) completions++;
    if (exact > limit) {
      failed = true;
      effects.push('byte-refusal');
      throw boundary;
    }
    const mapped: unknown = roots.at(-2),
      spread: unknown = roots.at(-1);
    if (
      sortB2Strings(mapped) &&
      sortB2Strings(spread) &&
      mapped !== spread &&
      mapped.length === 3 &&
      mapped.every((key) => key.startsWith('["https://sort-b2.test/')) &&
      sortB2Native.stringify(mapped) === sortB2Native.stringify(spread)
    ) {
      const index = calls.length;
      calls.push({
        mapped,
        spread,
        parentRoots: roots,
        atParent: [...spread],
        gets: 0,
        methods: 0,
        sorts: 0,
        appends: 0,
        argumentCounts: [],
      });
      effects.push('parent:' + index);
      if (index > 0) {
        const previous = calls[index - 1]!;
        if (roots.includes(previous.returned ?? previous.spread)) aliasFrames++;
      }
      if (mode === 'observer') {
        failed = true;
        effects.push('observer-fault');
        throw observerFault;
      }
    }
    const left: unknown = roots.at(-4),
      right: unknown = roots.at(-3);
    const leftText: unknown = roots.at(-2),
      rightText: unknown = roots.at(-1);
    if (
      sortB2Strings(left) &&
      typeof leftText === 'string' &&
      typeof rightText === 'string' &&
      calls.some((call) => (call.returned ?? call.spread) === left)
    ) {
      pairs.push({ left, right, leftText, rightText });
      effects.push('same:' + (pairs.length - 1));
    }
  };
  meter.measurementScope((outer) => {
    const enclosing = outer.array<unknown>();
    enclosing.append('outer before Ω');
    outerAlias = enclosing.value;
    try {
      meter.measurementScope((measurements) => {
        try {
          install();
          result = compareProjectedReports(
            {
              family: 'backlink/checker',
              beforeTaskId: 'before',
              afterTaskId: 'after',
            },
            {
              status: fixture.baseline[0],
              reports: fixture.beforeA.map((wrapper) => wrapper.projection),
            },
            {
              status: fixture.baseline[1],
              reports: fixture.afterA.map((wrapper) => wrapper.projection),
            },
            checkpoint,
            observe,
            measured ? measurements : undefined,
          );
        } finally {
          Object.defineProperty(Array.prototype, 'sort', descriptor);
        }
      });
    } catch (error) {
      caught = error;
    }
    // The inner scope has exited. Its arrays cannot donate numbers to this writer.
    enclosing.append('outer after Ω');
    for (const call of calls) {
      enclosing.append(call.spread);
      if (call.returned) enclosing.append(call.returned);
    }
    const roots = [
      enclosing.value,
      enclosing.value,
      { enclosing: enclosing.value },
      calls.map((call) => call.parentRoots),
    ];
    outerChecks.push({
      measured: meter.bytes(roots),
      exact: Buffer.byteLength(sortB2FrameText(fixture, roots), 'utf8'),
    });
  });
  return {
    mode,
    measured,
    fixture,
    callerState,
    originalText,
    meter,
    fresh,
    descriptor,
    boundary,
    observerFault,
    nativeFault,
    calls,
    pairs,
    frames,
    frameBytes,
    effects,
    outerAlias,
    outerChecks,
    result,
    caught,
    peak,
    lateFrames,
    lateCheckpoints,
    checkpoints,
    completions,
    aliasFrames,
  };
}
type SortB2Run = ReturnType<typeof sortB2Run>;
function sortB2Released(run: SortB2Run, mutate: boolean) {
  expect(Object.getOwnPropertyDescriptor(Array.prototype, 'sort')).toEqual(
    run.descriptor,
  );
  expect(Array.prototype.sort).toBe(sortB2Native.sort);
  expect(Array.prototype.push).toBe(sortB2Native.push);
  expect(JSON.stringify).toBe(sortB2Native.stringify);
  expect(run.lateFrames).toBe(0);
  expect(run.lateCheckpoints).toBe(0);
  for (const check of run.outerChecks) expect(check.measured).toBe(check.exact);
  const arrays = new Set(
    run.calls.flatMap((call) =>
      call.returned ? [call.spread, call.returned] : [call.spread],
    ),
  );
  for (const array of arrays) {
    expect(Object.isFrozen(array)).toBe(false);
    expect(Object.isExtensible(array)).toBe(true);
  }
  const roots = [
    run.outerAlias,
    run.calls.map((call) => call.parentRoots),
    [...arrays],
    [...arrays],
    { aliases: [...arrays] },
  ];
  const check = () => {
    const exact = Buffer.byteLength(
      sortB2FrameText(run.fixture, roots),
      'utf8',
    );
    expect(run.meter.bytes(roots)).toBe(exact);
    expect(run.fresh.bytes(roots)).toBe(exact);
    // Also check fresh logical scopes after failed/successful inner completion.
    run.meter.measurementScope(() =>
      expect(run.meter.bytes(roots)).toBe(exact),
    );
    run.fresh.measurementScope(() =>
      expect(run.fresh.bytes(roots)).toBe(exact),
    );
    return exact;
  };
  const before = check();
  let actualMutations = 0;
  if (mutate) {
    for (const array of arrays) {
      const length = array.length;
      Reflect.apply(sortB2Native.push, array, [
        'released mutable fallback Ω"\\',
      ]);
      actualMutations++;
      expect(array.length).toBe(length + 1);
    }
    expect(actualMutations).toBe(arrays.size);
  }
  const after = check();
  if (mutate && arrays.size > 0) expect(after).toBeGreaterThan(before);
  else {
    expect(actualMutations).toBe(0);
    expect(after).toBe(before);
  }
  expect(sortB2Native.stringify(run.fixture)).toBe(run.originalText);
  sortB2UnchangedCaller(run.fixture, run.callerState);
  console.info(
    'CR-B2-SORT-RELEASE ' +
      sortB2Native.stringify({
        mode: run.mode,
        measured: run.measured,
        requestedMutation: mutate,
        heldArrays: arrays.size,
        actualMutations,
        beforeBytes: before,
        afterBytes: after,
        callerObjects: run.callerState.nodes.length,
      }),
  );
}
function sortB2Success(control: SortB2Run, actual: SortB2Run) {
  expect(control.caught).toBeUndefined();
  expect(actual.caught).toBeUndefined();
  const expected = control.result,
    result = actual.result;
  if (!expected || !result)
    throw new Error('Missing actual comparator result.');
  expect(result).toEqual(expected);
  expect(result.status).toBe('compared');
  const backlink = asBacklink(result);
  expect(backlink.rows).toHaveLength(1);
  const row = backlink.rows[0]!;
  if (row.before.state !== 'unknown' || row.after.state !== 'unknown')
    throw new Error('Expected coherent final conflicting donor evidence.');
  const unknownSide = {
    state: 'unknown',
    reason: 'conflicting_donor_rows',
  } as const;
  expect(row.before).toEqual(unknownSide);
  expect(row.after).toEqual(unknownSide);
  expect(backlink.counts.unknownDonors).toBe(1);
  expect(actual.frames).toEqual(control.frames);
  expect(actual.effects).toEqual(control.effects);
  expect(actual.completions).toBe(control.completions);
  expect(actual.calls).toHaveLength(6);
  expect(actual.pairs).toHaveLength(4);
  expect(actual.aliasFrames).toBe(2);
  for (const [index, call] of actual.calls.entries()) {
    expect(call.mapped).not.toBe(call.spread);
    expect(call.atParent).toEqual(
      index % 3 !== 1
        ? [
            actual.fixture.sortedKeys[1]!,
            actual.fixture.sortedKeys[0]!,
            actual.fixture.sortedKeys[1]!,
          ]
        : [
            actual.fixture.sortedKeys[1]!,
            actual.fixture.sortedKeys[1]!,
            actual.fixture.sortedKeys[0]!,
          ],
    );
    const expectedReturn = call.returned ?? call.spread;
    const pair = actual.pairs.find(
      (pair) => pair.left === expectedReturn || pair.right === expectedReturn,
    );
    if (!pair)
      throw new Error('Missing actual same() observation of the sort return.');
    const returned: unknown =
      pair.left === expectedReturn ? pair.left : pair.right;
    if (!sortB2Strings(returned))
      throw new Error('Expected actual string-array sort result.');
    expect(returned).toBe(expectedReturn);
    expect(pair.left === returned ? pair.leftText : pair.rightText).toBe(
      sortB2Native.stringify(returned),
    );
    if (actual.mode === 'normal')
      expect(returned).toEqual(actual.fixture.sortedKeys);
    else {
      expect(call.gets).toBe(0);
      expect(call.methods).toBe(1);
      expect(call.sorts).toBe(1);
      expect(call.appends).toBe(1);
      expect(call.argumentCounts).toEqual([0]);
      expect(call.spread).toEqual([
        ...actual.fixture.sortedKeys,
        actual.fixture.appended,
      ]);
      if (actual.mode === 'alternate') {
        expect(returned).not.toBe(call.spread);
        expect(returned).toEqual([actual.fixture.alternate]);
      } else expect(returned).toBe(call.spread);
    }
  }
}
function sortB2Boundary(
  mode: 'normal' | 'receiver' | 'alternate',
  control: SortB2Run,
) {
  // N comes only from the ordinary comparator's complete native frame sequence.
  const n = control.peak;
  const atN = sortB2Run(mode, true, n);
  sortB2Success(control, atN);
  sortB2Released(atN, mode !== 'normal');
  const first = control.frameBytes.findIndex((bytes) => bytes > n - 1);
  expect(first).toBeGreaterThanOrEqual(0);
  const expected = sortB2Run(mode, false, n - 1),
    below = sortB2Run(mode, true, n - 1);
  expect<unknown>(expected.caught).toBe(expected.boundary);
  expect<unknown>(below.caught).toBe(below.boundary);
  expect(expected.result).toBeUndefined();
  expect(below.result).toBeUndefined();
  expect(expected.frameBytes).toEqual(control.frameBytes.slice(0, first + 1));
  expect(below.frames).toEqual(expected.frames);
  expect(below.effects).toEqual(expected.effects);
  expect(below.completions).toBe(expected.completions);
  sortB2Released(expected, mode !== 'normal');
  sortB2Released(below, mode !== 'normal');
  return {
    n,
    nMinus1: n - 1,
    firstRefusal: first,
    refusalFrames: below.frames.length,
  };
}

test('CR-B2-SORT-NORMAL real canonical order duplicates aliases and independent N/N-1', () => {
  const control = sortB2Run('normal', false),
    actual = sortB2Run('normal', true);
  sortB2Success(control, actual);
  sortB2Released(control, false);
  sortB2Released(actual, false);
  const boundary = sortB2Boundary('normal', control);
  console.info(
    'CR-B2-SORT-NORMAL ' +
      sortB2Native.stringify({
        frames: actual.frames.length,
        calls: actual.calls.length,
        aliasFrames: actual.aliasFrames,
        boundary,
      }),
  );
});
test('CR-B2-SORT-CURRENT-FALLBACK receiver and alternate retain current effects fresh bytes and lifetime', () => {
  for (const mode of ['receiver', 'alternate'] as const) {
    const control = sortB2Run(mode, false),
      actual = sortB2Run(mode, true);
    sortB2Success(control, actual);
    const boundary = sortB2Boundary(mode, control);
    sortB2Released(control, true);
    sortB2Released(actual, true);
    console.info(
      'CR-B2-SORT-CURRENT-FALLBACK ' +
        sortB2Native.stringify({
          mode,
          frames: actual.frames.length,
          effects: actual.effects,
          boundary,
        }),
    );
  }
});
test('CR-B2-SORT-NATIVE-FAULT original getter and post-mutation faults keep fixed conversion and outer lifetime', () => {
  for (const mode of ['getter', 'method'] as const) {
    const control = sortB2Run(mode, false),
      actual = sortB2Run(mode, true);
    expect(control.caught).toBeUndefined();
    expect(actual.caught).toBeUndefined();
    expect(control.result).toEqual(compareReportsError('InternalError'));
    expect(actual.result).toEqual(control.result);
    expect(actual.frames).toEqual(control.frames);
    expect(actual.effects).toEqual(control.effects);
    expect(actual.completions).toBe(control.completions);
    expect(actual.calls).toHaveLength(1);
    expect(actual.pairs).toHaveLength(0);
    const call = actual.calls[0]!;
    expect(call.gets).toBe(mode === 'getter' ? 1 : 0);
    expect(call.methods).toBe(mode === 'getter' ? 0 : 1);
    expect(call.sorts).toBe(mode === 'getter' ? 0 : 1);
    expect(call.appends).toBe(mode === 'getter' ? 0 : 1);
    expect(call.argumentCounts).toEqual(mode === 'getter' ? [] : [0]);
    expect(call.returned).toBeUndefined();
    expect(call.spread).toEqual(
      mode === 'getter'
        ? call.atParent
        : [...actual.fixture.sortedKeys, actual.fixture.appended],
    );
    expect(actual.effects.at(-1)).toBe('native-fault:0');
    sortB2Released(control, true);
    sortB2Released(actual, true);
    console.info(
      'CR-B2-SORT-NATIVE-FAULT ' +
        sortB2Native.stringify({
          mode,
          frames: actual.frames.length,
          effects: actual.effects,
          lateFrames: actual.lateFrames,
          lateCheckpoints: actual.lateCheckpoints,
        }),
    );
  }
});
test('CR-B2-SORT-OBSERVER-FAULT original parent refusal precedes sort and preserves exact sentinel', () => {
  const control = sortB2Run('observer', false),
    actual = sortB2Run('observer', true);
  expect<unknown>(control.caught).toBe(control.observerFault);
  expect<unknown>(actual.caught).toBe(actual.observerFault);
  expect(control.result).toBeUndefined();
  expect(actual.result).toBeUndefined();
  expect(actual.frames).toEqual(control.frames);
  expect(actual.effects).toEqual(['parent:0', 'observer-fault']);
  expect(actual.effects).toEqual(control.effects);
  expect(actual.completions).toBe(control.completions);
  expect(actual.calls).toHaveLength(1);
  expect(actual.pairs).toHaveLength(0);
  const call = actual.calls[0]!;
  expect(call.gets).toBe(0);
  expect(call.methods).toBe(0);
  expect(call.sorts).toBe(0);
  expect(call.appends).toBe(0);
  expect(call.spread).toEqual(call.atParent);
  expect(call.returned).toBeUndefined();
  sortB2Released(control, true);
  sortB2Released(actual, true);
  console.info(
    'CR-B2-SORT-OBSERVER-FAULT ' +
      sortB2Native.stringify({
        frames: actual.frames.length,
        effects: actual.effects,
        lateFrames: actual.lateFrames,
        lateCheckpoints: actual.lateCheckpoints,
      }),
  );
});
