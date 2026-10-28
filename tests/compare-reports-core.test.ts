import { expect, test } from 'bun:test';
import {
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
  type ComparePrivateMeasurements,
  type CompareReportsResult,
} from '../src/compare-reports';
import type { TaskFamily } from '../src/task-status';

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
/**
 * Independent complete expected envelope for the accepted compact literal.
 * Static evidence only: no production call, measurement factory or frame oracle.
 */
function literalGenericEnvelope() {
  const observations = {
    size: 2,
    processedCount: 2,
    indexedCount: 1,
    isCompleted: true,
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
  };
  const beforeStatus = {
    id: 'before',
    type: 'google/indexer',
    ...observations,
    targetDomains: null,
    providerCreatedAt: ' status-before Ω ',
  };
  const afterStatus = {
    id: 'after',
    type: 'google/indexer',
    ...observations,
    targetDomains: null,
    providerCreatedAt: ' status-after Ω ',
  };
  const beforeReport = {
    ...observations,
    type: 'google/indexer',
    providerCreatedAt: 'report-before é',
  };
  const afterReport = {
    ...observations,
    type: 'google/indexer',
    providerCreatedAt: 'report-after é',
  };
  const coverage = {
    observedIndexedCount: 1,
    observedUnindexedCount: 1,
    observedUniqueUrlCount: 2,
    indexedDuplicateCount: 1,
    unindexedDuplicateCount: 0,
    conflictingUrlCount: 0,
    reportedSlotGap: 0,
    indexedEnumerationGap: 0,
  };
  const expected: CompareReportsResult = {
    status: 'compared',
    reportKind: 'links',
    family: 'google/indexer',
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
    before: {
      status: beforeStatus,
      report: beforeReport,
      settled: true,
      coverage: { ...coverage },
    },
    after: {
      status: afterStatus,
      report: afterReport,
      settled: true,
      coverage: { ...coverage },
    },
    rows: [
      {
        url: literalA,
        before: { state: 'indexed', membership: 'indexed' },
        after: { state: 'unindexed', membership: 'unindexed' },
        change: 'reported_indexed_to_unindexed',
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
      unchangedIndexed: 0,
      unchangedUnindexed: 0,
      unknown: 0,
      total: 2,
    },
  };
  return independentEnvelope(expected);
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

test('CR-R1-ERROR-DETAILS fixed errors retain only applicable defined metadata', () => {
  const typed = compareReportsError('DeadlineExceeded', {
    phase: 'status',
    cause: 'http',
    cleanup: 'failed',
  });
  expectCode(typed, 'DeadlineExceeded');
  if (typed.status !== 'error') throw new Error('Expected fixed error.');
  expect(Object.keys(typed.error).sort()).toEqual(['code', 'message']);
  expect(typed.cleanup).toBe('failed');

  const variants: {
    phase?: 'status' | undefined;
    cause?: 'http' | undefined;
    cleanup?: 'failed' | undefined;
    extra?: string;
  }[] = [
    {},
    { phase: undefined },
    { cause: undefined },
    { phase: 'status' },
    { cause: 'http' },
    { phase: 'status', cause: 'http' },
    { cleanup: undefined },
    { cleanup: 'failed' },
    { phase: 'status', cause: 'http', cleanup: 'failed' },
    { phase: 'status', extra: 'synthetic-private-metadata' },
  ];
  for (const code of compareReportsErrorCodeSchema.options) {
    for (const details of variants) {
      // Exercise JavaScript's explicit-undefined shapes without widening the API.
      const actual: unknown = Reflect.apply(compareReportsError, undefined, [
        code,
        details,
      ]);
      const result = compareReportsResultSchema.parse(actual);
      if (result.status !== 'error') throw new Error('Expected fixed error.');
      expect(result.error.code).toBe(code);
      const phase = code === 'ReadFailed' ? details.phase : undefined;
      const cause = code === 'ReadFailed' ? details.cause : undefined;
      expect(result.error.phase).toBe(phase);
      expect(result.error.cause).toBe(cause);
      expect(Object.hasOwn(result.error, 'phase')).toBe(phase !== undefined);
      expect(Object.hasOwn(result.error, 'cause')).toBe(cause !== undefined);
      expect(result.cleanup).toBe(details.cleanup);
      expect(Object.hasOwn(result, 'cleanup')).toBe(
        details.cleanup !== undefined,
      );
      expect(Object.isFrozen(actual)).toBe(true);
      expect(JSON.stringify(actual)).not.toContain(
        'synthetic-private-metadata',
      );
      expect(
        compareReportsEnvelopeSchema.safeParse(independentEnvelope(result))
          .success,
      ).toBe(true);
    }
  }
});

test('CR-R1-MEASUREMENTS-ONLY facade refusal and checkpoints remain active without an observer', () => {
  const refuseMeasurement = (): never => {
    throw new Error('synthetic-private-measurement-refusal');
  };
  const measurements: ComparePrivateMeasurements = {
    array: refuseMeasurement,
    set: refuseMeasurement,
    map: refuseMeasurement,
    privateRead: refuseMeasurement,
    privateKeys: refuseMeasurement,
    privateValues: refuseMeasurement,
    privateFilter: refuseMeasurement,
  };
  const scenarios = [
    {
      selected: input,
      before: {
        status: projectCompareStatus(status('before')),
        reports: [projectCompareLinksReport(links('before'))],
      },
      after: {
        status: projectCompareStatus(status('after')),
        reports: [projectCompareLinksReport(links('after', [b, c], [a, d]))],
      },
    },
    {
      selected: { ...input, family: 'backlink/checker' },
      before: {
        status: projectCompareStatus(backlinkStatus('before')),
        reports: [projectCompareBacklinkPage(page('before'))],
      },
      after: {
        status: projectCompareStatus(backlinkStatus('after')),
        reports: [projectCompareBacklinkPage(page('after'))],
      },
    },
  ];
  const expected = {
    status: 'error',
    error: {
      code: 'InternalError',
      message: 'Report comparison failed internally.',
    },
  } as const;
  for (const { selected, before, after } of scenarios) {
    const ordinary = compareProjectedReports(selected, before, after);
    expect(ordinary.status).toBe('compared');
    expect(
      compareProjectedReports(
        selected,
        before,
        after,
        undefined,
        undefined,
        measurements,
      ),
    ).toEqual(expected);
    expect(compareReportsToolResult(ordinary, { measurements })).toEqual(
      independentEnvelope(expected),
    );
  }

  const interrupted = new Error('synthetic checkpoint interruption');
  let measured = false;
  const checkpointMeasurements: ComparePrivateMeasurements = {
    ...measurements,
    privateRead: () => {
      measured = true;
      return false;
    },
  };
  let caught: unknown;
  try {
    compareReportsToolResult(genericPair(), {
      measurements: checkpointMeasurements,
      checkpoint: () => {
        if (measured) throw interrupted;
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(interrupted);
});

test('CR-R2-OBSERVER-ABORT trusted observer and checkpoint failures retain owner identity', () => {
  const scenarios = [
    {
      selected: input,
      before: {
        status: projectCompareStatus(status('before')),
        reports: [projectCompareLinksReport(links('before'))],
      },
      after: {
        status: projectCompareStatus(status('after')),
        reports: [projectCompareLinksReport(links('after'))],
      },
    },
    {
      selected: { ...input, family: 'backlink/checker' },
      before: {
        status: projectCompareStatus(backlinkStatus('before')),
        reports: [projectCompareBacklinkPage(page('before'))],
      },
      after: {
        status: projectCompareStatus(backlinkStatus('after')),
        reports: [projectCompareBacklinkPage(page('after'))],
      },
    },
  ];
  const caughtFrom = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('Expected trusted callback abort.');
  };
  const interrupted = new Error('synthetic owner budget abort');
  const abort = () => {
    throw interrupted;
  };
  for (const { selected, before, after } of scenarios) {
    const ordinary = compareProjectedReports(selected, before, after);
    expect(ordinary.status).toBe('compared');
    const compare = (checkpoint: () => void, observeWork: () => void) =>
      compareProjectedReports(selected, before, after, checkpoint, observeWork);
    const publish = (checkpoint: () => void, observeWork: () => void) =>
      compareReportsToolResult(ordinary, { checkpoint, observeWork });
    for (const action of [compare, publish]) {
      expect(caughtFrom(() => action(() => {}, abort))).toBe(interrupted);
      expect(caughtFrom(() => action(abort, () => {}))).toBe(interrupted);
      let observed = false;
      expect(
        caughtFrom(() =>
          action(
            () => {
              if (observed) abort();
            },
            () => {
              observed = true;
            },
          ),
        ),
      ).toBe(interrupted);
    }
    expect(
      compare(
        () => {},
        () => {},
      ),
    ).toEqual(ordinary);
    expect(
      publish(
        () => {},
        () => {},
      ),
    ).toEqual(independentEnvelope(ordinary));
    expectCode(
      compareProjectedReports({ ...selected, extra: true }, before, after),
      'InvalidInput',
    );
  }
});

function capRefusal(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return compareReportsFailure(error);
  }
  throw new Error('Expected resource or evidence refusal.');
}

test('CR-R2-LINKS-PARTITION-CAP counts both partitions inclusively', () => {
  const urls = Array.from(
    { length: 10_000 },
    (_, i) => `https://example.test/cap/${i}`,
  );
  const report = links('before', urls.slice(0, 5_000), urls.slice(5_000), {
    size: 10_000,
    processedCount: 10_000,
    indexedCount: 5_000,
  });
  const projected = projectCompareLinksReport(report);
  expect(projected.indexedLinks.length).toBe(5_000);
  expect(projected.unindexedLinks.length).toBe(5_000);
  expectCode(
    capRefusal(() =>
      projectCompareLinksReport({
        ...report,
        unindexedLinks: [
          ...report.unindexedLinks,
          'https://example.test/extra',
        ],
      }),
    ),
    'ResourceLimitExceeded',
  );
});

test('CR-R2-BACKLINK-PROJECTION-CAPS preserve inclusive page and donor bounds', () => {
  const donors = Array.from({ length: 100 }, (_, i) =>
    donor([], { donor_url: `https://donor.test/${i}` }),
  );
  const report = page('before', donors, { size: 101, processedCount: 101 });
  expect(projectCompareBacklinkPage(report).donors.length).toBe(100);
  expectCode(
    capRefusal(() =>
      projectCompareBacklinkPage({ ...report, donors: [...donors, donor()] }),
    ),
    'ConflictingEvidence',
  );
  expect(
    projectCompareBacklinkPage(page('before', [], { lastPage: 14 })).lastPage,
  ).toBe(14);
  expectCode(
    capRefusal(() =>
      projectCompareBacklinkPage(page('before', [], { lastPage: 15 })),
    ),
    'ResourceLimitExceeded',
  );
  const tuple = { url: a, anchor: 'synthetic', nofollow: false };
  const links = Array.from({ length: 1_000 }, () => ({ ...tuple }));
  const projected = projectCompareBacklinkPage(page('before', [donor(links)]));
  expect(projected.rawTargetLinkCount).toBe(1_000);
  expect(projected.duplicateTargetLinkCount).toBe(999);
  expectCode(
    capRefusal(() =>
      projectCompareBacklinkPage(page('before', [donor([...links, tuple])])),
    ),
    'ResourceLimitExceeded',
  );
});

test('CR-R2-BACKLINK-PAGE-RAW-TARGET-CAP sums donors before accepting a page', () => {
  const tuple = { url: a, anchor: 'synthetic', nofollow: false };
  const donors = Array.from({ length: 10 }, (_, i) =>
    donor(
      Array.from({ length: 1_000 }, () => ({ ...tuple })),
      {
        donor_url: `https://donor.test/${i}`,
      },
    ),
  );
  const report = page('before', donors, { size: 11, processedCount: 11 });
  expect(projectCompareBacklinkPage(report).rawTargetLinkCount).toBe(10_000);
  expectCode(
    capRefusal(() =>
      projectCompareBacklinkPage({
        ...report,
        donors: [...donors, donor([tuple])],
      }),
    ),
    'ResourceLimitExceeded',
  );
});

test('CR-R2-BACKLINK-PAGE-COUNT-CAP accepts fifteen coherent pages', () => {
  const reports = Array.from({ length: 15 }, (_, i) =>
    projectCompareBacklinkPage(
      page('before', [], { size: 0, processedCount: 0, page: i, lastPage: 14 }),
    ),
  );
  const before = {
    status: projectCompareStatus(
      backlinkStatus('before', { size: 0, processedCount: 0 }),
    ),
    reports,
  };
  const after = {
    status: projectCompareStatus(
      backlinkStatus('after', { size: 0, processedCount: 0 }),
    ),
    reports: [
      projectCompareBacklinkPage(
        page('after', [], { size: 0, processedCount: 0 }),
      ),
    ],
  };
  const selected = { ...input, family: 'backlink/checker' };
  const result = asBacklink(compareProjectedReports(selected, before, after));
  expect(result.before.report.pagesVisited).toBe(15);
  expect(result.before.report.lastPage).toBe(14);
  expectCode(
    compareProjectedReports(selected, { ...before, reports: [] }, after),
    'ConflictingEvidence',
  );
  expectCode(
    compareProjectedReports(
      selected,
      { ...before, reports: [...reports, reports[0]!] },
      after,
    ),
    'ConflictingEvidence',
  );
});

test('CR-R2-BACKLINK-COMPARE-RAW-TARGET-CAP sums individually valid pages', () => {
  const tuple = { url: a, anchor: 'synthetic', nofollow: false };
  const donors = Array.from({ length: 10 }, (_, i) =>
    donor(
      Array.from({ length: 1_000 }, () => ({ ...tuple })),
      {
        donor_url: `https://donor.test/${i}`,
      },
    ),
  );
  const makePage = (n: number, rows: unknown[]) =>
    page('before', rows, {
      size: 11,
      processedCount: 11,
      page: n,
      lastPage: 1,
    });
  const before = {
    status: projectCompareStatus(
      backlinkStatus('before', { size: 11, processedCount: 11 }),
    ),
    reports: [
      projectCompareBacklinkPage(makePage(0, donors.slice(0, 5))),
      projectCompareBacklinkPage(makePage(1, donors.slice(5))),
    ],
  };
  const after = {
    status: projectCompareStatus(
      backlinkStatus('after', { size: 0, processedCount: 0 }),
    ),
    reports: [
      projectCompareBacklinkPage(
        page('after', [], { size: 0, processedCount: 0 }),
      ),
    ],
  };
  const selected = { ...input, family: 'backlink/checker' };
  const boundary = asBacklink(compareProjectedReports(selected, before, after));
  expect(boundary.before.coverage.rawTargetLinkCount).toBe(10_000);
  const overPage = projectCompareBacklinkPage(
    makePage(1, [...donors.slice(5), donor([tuple])]),
  );
  expect(overPage.rawTargetLinkCount).toBe(5_001);
  expectCode(
    compareProjectedReports(
      selected,
      { ...before, reports: [before.reports[0]!, overPage] },
      after,
    ),
    'ResourceLimitExceeded',
  );
});

test('CR-R3-PROJECTION-ABORT helpers preserve trusted aborts and completed ownership', () => {
  type Observer = (roots: readonly unknown[], completedOwned?: object) => void;
  const cases: {
    ordinary: object;
    project: (checkpoint: () => void, observer: Observer) => object;
  }[] = [
    {
      ordinary: projectCompareStatus(status('before')),
      project: (checkpoint, observeWork) =>
        projectCompareStatus(status('before'), { checkpoint, observeWork }),
    },
    {
      ordinary: projectCompareLinksReport(links('before')),
      project: (checkpoint, observeWork) =>
        projectCompareLinksReport(links('before'), checkpoint, observeWork),
    },
    {
      ordinary: projectCompareBacklinkPage(page('before')),
      project: (checkpoint, observeWork) =>
        projectCompareBacklinkPage(page('before'), checkpoint, observeWork),
    },
  ];
  const interrupted = new Error('synthetic projection owner abort');
  const abort = () => {
    throw interrupted;
  };
  const caughtFrom = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('Expected trusted projection abort.');
  };
  for (const { ordinary, project } of cases) {
    expect(caughtFrom(() => project(abort, () => {}))).toBe(interrupted);
    expect(caughtFrom(() => project(() => {}, abort))).toBe(interrupted);
    let observed = false;
    expect(
      caughtFrom(() =>
        project(
          () => {
            if (observed) abort();
          },
          () => {
            observed = true;
          },
        ),
      ),
    ).toBe(interrupted);
    expect(
      caughtFrom(() =>
        project(
          () => {},
          (_roots, completedOwned) => {
            if (completedOwned) abort();
          },
        ),
      ),
    ).toBe(interrupted);
    let completed: object | undefined;
    const actual = project(
      () => {},
      (_roots, completedOwned) => {
        if (completedOwned) completed = completedOwned;
      },
    );
    expect(actual).toEqual(ordinary);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(completed).toBe(actual);
  }
});
