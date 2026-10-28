/** Retained private measurement component cases; synthetic in-memory fixtures only. */
import { expect, test } from 'bun:test';
import {
  CompareReportsFault,
  compareProjectedReports,
  compareReportsError,
  compareReportsToolResult,
  projectCompareBacklinkPage,
  projectCompareLinksReport,
  projectCompareStatus,
  type CompareBacklinkProjection,
  type CompareLinksProjection,
  type ComparePrivateMeasurements,
  type CompareReportsInput,
  type CompareReportsResult,
  type CompareStatusProjection,
} from '../src/compare-reports';
import {
  createCompareOwnerRootBytes,
  type ComparePrivateMeasurements as KernelMeasurements,
} from '../src/compare-reports-measurements';
import type { TaskFamily } from '../src/task-status';
import {
  compareLiteralFrameOracle,
  installCompareDefaultDeny,
} from './fixtures/compare-reports-measurements';

const a = 'https://example.test/a';
const b = 'https://example.test/b';
const c = 'https://example.test/c';
const d = 'https://example.test/d';
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
function asBacklink(value: CompareReportsResult) {
  if (value.status !== 'compared' || value.reportKind !== 'backlink')
    throw new Error('Expected backlink comparison: ' + JSON.stringify(value));
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

type KernelWriters = Parameters<Parameters<AcMeter['measurementScope']>[0]>[0];
interface FacadeCalls {
  array: number;
  set: number;
  map: number;
  privateRead: number;
  privateKeys: number;
  privateValues: number;
  privateFilter: number;
}
function facadeCalls(): FacadeCalls {
  return {
    array: 0,
    set: 0,
    map: 0,
    privateRead: 0,
    privateKeys: 0,
    privateValues: 0,
    privateFilter: 0,
  };
}
function facadeView(
  writers: ComparePrivateMeasurements,
  calls: FacadeCalls,
): ComparePrivateMeasurements {
  return {
    array: <V>() => {
      calls.array++;
      return writers.array<V>();
    },
    set: <V>() => {
      calls.set++;
      return writers.set<V>();
    },
    map: <V>() => {
      calls.map++;
      return writers.map<V>();
    },
    privateRead: (root, checkpoint) => {
      calls.privateRead++;
      return writers.privateRead(root, checkpoint);
    },
    privateKeys: (root, checkpoint) => {
      calls.privateKeys++;
      return writers.privateKeys(root, checkpoint);
    },
    privateValues: (root, checkpoint) => {
      calls.privateValues++;
      return writers.privateValues(root, checkpoint);
    },
    privateFilter: (rows, predicate, checkpoint) => {
      calls.privateFilter++;
      return writers.privateFilter(rows, predicate, checkpoint);
    },
  };
}
function facadeTotal(calls: FacadeCalls): number {
  return Object.values(calls).reduce((total, count) => total + count, 0);
}

test('CR-MM01-KERNEL-FACADE measured comparison and publication succeed without an observer', () => {
  const meter = createCompareOwnerRootBytes();
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
      selected: { ...input, family: 'backlink/checker' as const },
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
  for (const { selected, before, after } of scenarios) {
    const ordinary = compareProjectedReports(selected, before, after);
    expect(ordinary.status).toBe('compared');
    const expected = independentEnvelope(ordinary);
    const comparisonCalls = facadeCalls();
    const measured = meter.measurementScope((writers) => {
      const writerSet: KernelWriters = writers;
      const kernel: KernelMeasurements = writerSet;
      const facade: ComparePrivateMeasurements = kernel;
      return compareProjectedReports(
        selected,
        before,
        after,
        undefined,
        undefined,
        facadeView(facade, comparisonCalls),
      );
    });
    expect(measured).toEqual(ordinary);
    expect(independentEnvelope(measured)).toEqual(expected);
    expect(facadeTotal(comparisonCalls)).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(measured), 'utf8')).toBe(
      bytes(ordinary),
    );
    const publicationCalls = facadeCalls();
    const published = meter.measurementScope((writers) => {
      const writerSet: KernelWriters = writers;
      const kernel: KernelMeasurements = writerSet;
      const facade: ComparePrivateMeasurements = kernel;
      return compareReportsToolResult(measured, {
        measurements: facadeView(facade, publicationCalls),
      });
    });
    expect(published).toEqual(expected);
    expect(published.content[0]!.text).toBe(JSON.stringify(ordinary));
    expect(Buffer.byteLength(JSON.stringify(published), 'utf8')).toBe(
      bytes(expected),
    );
    expect(facadeTotal(publicationCalls)).toBeGreaterThan(0);
    const roots = [measured, published];
    expect(meter.bytes(roots)).toBe(
      cmFrameBytes([null, [], [], [], null, roots]),
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
