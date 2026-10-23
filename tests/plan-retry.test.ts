import { createHash } from 'node:crypto';
import { buildCreateIndexingRequest } from '../src/create-indexing-task';
import { expect, test } from 'bun:test';
import {
  assessRetryObservations,
  assertRetryCombinedBytes,
  assertRetryProviderBytes,
  buildRetrySemanticIdentity,
  classifyRetryPass,
  compareRetryReferences,
  mergeRetryFacts,
  parseRetryPlanInput,
  projectRetryFact,
  retryInstant,
  retryRelations,
  RetrySemanticError,
  type RetryFact,
  type RetryFamily,
  type RetryObservations,
  type RetryPass,
  type RetryProposal,
  type RetryReportFact,
  type RetryTaskFields,
} from '../src/plan-retry';
import { packRetryStatusIds } from '../src/retry-observation';
import { ReadBudgetError } from '../src/read-budget';
import {
  planRetryResultSchema,
  planRetryToolResult,
  retryPlanResultFromView,
  type PlanRetryResult,
} from '../src/plan-retry-result';
import type { AvailableRetrySnapshot } from '../src/retry-ledger-snapshot';
import {
  computeRetryPlanFingerprint,
  type RetryPlanningState,
  type RetryPlanFingerprintInput,
} from '../src/submission-ledger';
import {
  createSubmissionContext,
  submissionCredentialFingerprint,
  type ConfiguredSubmission,
  type SubmissionPolicy,
} from '../src/submission-policy';

const utc = Date.parse('2026-10-21T12:00:00Z');
const A = 'https://example.test/A?b=1&a=2',
  B = 'https://example.test/A/?b=1&a=2',
  C = 'https://example.test/C';
const H = (domain: string, tuple: unknown) =>
  createHash('sha256')
    .update(domain + '\0' + JSON.stringify(tuple))
    .digest('hex');
const digest = 'a'.repeat(64),
  family: RetryFamily = 'google/indexer';
function local(
  overrides: Partial<AvailableRetrySnapshot> = {},
): AvailableRetrySnapshot {
  return {
    availability: 'available',
    schemaVersion: 2,
    ledgerId: 'synthetic-ledger',
    revision: digest,
    capturedAt: '2026-10-21T12:00:00Z',
    coverage: {
      localStore: true,
      keyBindingOnly: true,
      allBudgetScopes: true,
      allFamilies: true,
      globalProviderAccount: false,
      ancestry: 'cooperating_v2_retry_contexts_only',
    },
    holds: [],
    acceptedManifests: [],
    retryChildren: [],
    unresolvedHistory: [],
    attributionGaps: [],
    ambiguousProviderRefs: [],
    ...overrides,
  };
}
function configuration(adopt = true): ConfiguredSubmission {
  const binding = submissionCredentialFingerprint('pure-synthetic-key');
  const policy: SubmissionPolicy = {
    version: 1,
    enabled: true,
    mode: 'operator_policy',
    policyRevision: 'pure',
    budgetScope: 'pure',
    credentialFingerprint: binding,
    period: { kind: 'utc_day' },
    caps: { tokens: 10000, indexer: 100, checker: 100 },
    retry: {
      enabled: true,
      allowUnattributedParents: adopt,
      maxAttemptsPerSource: 3,
    },
  };
  return {
    state: 'configured',
    snapshot: { policy, digest: H('synthetic-policy', policy) },
    credential: { effectiveKey: 'pure-synthetic-key', fingerprint: binding },
    stateDirectory: '/synthetic-only',
    indexCheckReservationSource: { state: 'unconfigured' },
  };
}
const fields = (
  id = 'parent',
  overrides: Partial<RetryTaskFields> = {},
): RetryTaskFields => ({
  id,
  size: 3,
  processedCount: 3,
  indexedCount: 1,
  isCompleted: true,
  status: 'completed',
  createdAt: '2026-10-01T00:00:00Z',
  payPerIndexed: true,
  checkAfter: '2026-10-08T00:00:00Z',
  ...overrides,
});
function report(
  fact: RetryFact,
  indexed: string[] = [C],
  unindexed: string[] = [A, B],
): RetryReportFact {
  return [
    fact[0],
    fact[1],
    fact[2]!,
    fact[3]!,
    fact[4],
    [...new Set(indexed)],
    [...new Set(unindexed)],
    fact,
  ];
}
function pass(
  facts: readonly RetryFact[],
  selected: RetryReportFact | null = null,
  childReports: RetryReportFact[] = [],
): RetryPass {
  return [
    [
      [
        'google/indexer',
        'regular',
        0,
        [
          [
            0,
            facts
              .filter((fact) => fact[0] === 'google/indexer')
              .map((fact) => [fact[0], fact[1]] as const),
          ],
        ],
      ],
      ['google/indexer', 'drip', 0, [[0, []]]],
      [
        'yandex/indexer',
        'regular',
        0,
        [
          [
            0,
            facts
              .filter((fact) => fact[0] === 'yandex/indexer')
              .map((fact) => [fact[0], fact[1]] as const),
          ],
        ],
      ],
    ],
    [...facts].sort(compareRetryReferences),
    retryRelations(facts),
    selected,
    childReports,
  ];
}
function observations(facts: RetryPass, snapshot = local()): RetryObservations {
  return {
    facts,
    initialLedgerId: snapshot.ledgerId,
    initialRevision: snapshot.revision,
    observedUtcMs: utc,
    nonAtomic: true,
    finality: 'provider_observed',
  };
}
function proposal(
  facts = pass(
    [projectRetryFact(family, fields())],
    report(projectRetryFact(family, fields())),
  ),
  snapshot = local(),
  policy = configuration().snapshot.policy,
): RetryProposal {
  const result = assessRetryObservations(
    {},
    observations(facts, snapshot),
    snapshot,
    policy,
  );
  expect(result.status).toBe('proposal');
  if (result.status !== 'proposal')
    throw new Error('Expected internal proposal: ' + JSON.stringify(result));
  return result;
}
function final(snapshot = local()): RetryPlanningState {
  return {
    availability: 'available',
    snapshot,
    decision: {
      periodCompatible: true,
      usage: { tokens: '0', indexer: '0', checker: '0' },
      withinCaps: { tokens: true, indexer: true, checker: true },
      attempts: { count: 0, limit: 3, canCreate: true },
    },
  };
}
function manifest(
  id: string,
  urls: readonly string[],
  engine: RetryFamily = family,
  originKind = 'standalone',
) {
  return {
    taskFamily: engine,
    providerTaskId: id,
    requestId: 'local-' + id,
    originKind,
    payloadDigest: digest,
    manifestDigest: H('speedyindex-intent-url-manifest-v1', [engine, urls]),
    submittedUrls: urls,
    provenance: 'durable_local_intent_ack' as const,
  };
}
function blocked(
  result: ReturnType<typeof assessRetryObservations>,
  code: string,
) {
  expect(result).toMatchObject({ status: 'blocked', blockers: [code] });
  expect('eligibleUrls' in result).toBe(false);
  expect('fingerprint' in result).toBe(false);
}

test('P1B-01 strict default selector rejects caller authority before controlled owner reads', () => {
  expect(parseRetryPlanInput({})).toEqual({ searchEngine: 'google' });
  expect(parseRetryPlanInput({ searchEngine: 'yandex' })).toEqual({
    searchEngine: 'yandex',
  });
  let localReads = 0;
  const owner = (input: unknown) => {
    const parsed = parseRetryPlanInput(input);
    localReads++;
    return parsed;
  };
  for (const key of [
    'taskId',
    'urls',
    'report',
    'snapshot',
    'hash',
    'proof',
    'ready',
    'permission',
    'adoption',
    'key',
    'path',
    'clock',
    'endpoint',
    'policy',
    'caps',
    'limits',
  ])
    expect(() => owner({ [key]: true })).toThrow();
  for (const input of [null, [], { searchEngine: 'bing' }, { searchEngine: 1 }])
    expect(() => owner(input)).toThrow();
  expect(localReads).toBe(0);
  const supplied = { searchEngine: 'google' };
  const captured = parseRetryPlanInput(supplied);
  supplied.searchEngine = 'yandex';
  expect(captured.searchEngine).toBe('google');
});

test('P1B-02 strict RFC3339 calendar and offset chronology, not ID ordering', () => {
  expect(retryInstant('2026-10-01T02:00:00+02:00')).toEqual(
    retryInstant('2026-10-01T00:00:00Z'),
  );
  for (const bad of [
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T00:00:60Z',
    '2026-10-01',
    '2026-10-01T00:00:00+24:00',
  ])
    expect(() => retryInstant(bad)).toThrow(RetrySemanticError);
  const older = projectRetryFact(family, fields('zzzz')),
    newer = projectRetryFact(
      family,
      fields('0000', { createdAt: '2026-10-02T00:00:00Z' }),
    );
  expect(
    classifyRetryPass(pass([newer, older]), local(), 'google', utc),
  ).toEqual({ kind: 'selected', reference: [family, '0000'] });
  const tie = projectRetryFact(
    family,
    fields('tie', { createdAt: '2026-10-02T02:00:00+02:00' }),
  );
  expect(() =>
    classifyRetryPass(pass([tie, newer]), local(), 'google', utc),
  ).toThrow(RetrySemanticError);
});

test('P1B-02 latest uncertainty never falls back; known unfinished and ordinary work are distinct', () => {
  const older = projectRetryFact(family, fields('old'));
  for (const change of [
    { isCompleted: undefined },
    { status: undefined },
    { status: 'novel' },
    { checkAfter: '2026-12-01T00:00:00Z' },
    { checkAfter: undefined },
    { payPerIndexed: undefined },
    { awaitingResult: true },
  ]) {
    const newer = projectRetryFact(
      family,
      fields('new', { createdAt: '2026-10-02T00:00:00Z', ...change }),
    );
    const data = pass([older, newer], report(newer));
    blocked(
      assessRetryObservations(
        {},
        observations(data),
        local(),
        configuration().snapshot.policy,
      ),
      'UnprovenLatest',
    );
  }
  const unfinished = projectRetryFact(
    family,
    fields('new', {
      createdAt: '2026-10-02T00:00:00Z',
      isCompleted: false,
      status: undefined,
    }),
  );
  expect(
    classifyRetryPass(pass([unfinished, older]), local(), 'google', utc),
  ).toEqual({ kind: 'selected', reference: [family, 'old'] });
  expect(classifyRetryPass(pass([unfinished]), local(), 'google', utc)).toEqual(
    { kind: 'none' },
  );
  expect(
    classifyRetryPass(
      pass([
        projectRetryFact(family, fields('ordinary', { payPerIndexed: false })),
      ]),
      local(),
      'google',
      utc,
    ),
  ).toEqual({ kind: 'none' });
  expect(() =>
    classifyRetryPass(
      pass([
        projectRetryFact(family, fields('undated', { createdAt: undefined })),
      ]),
      local(),
      'google',
      utc,
    ),
  ).toThrow();
  expect(() =>
    mergeRetryFacts(
      older,
      projectRetryFact(family, fields('old', { isCompleted: false })),
    ),
  ).toThrow();
  const yandex = projectRetryFact(
    'yandex/indexer',
    fields('y', { payPerIndexed: undefined }),
  );
  const y = assessRetryObservations(
    { searchEngine: 'yandex' },
    observations(pass([yandex], report(yandex))),
    local(),
    configuration().snapshot.policy,
  );
  expect(y.status).toBe('proposal');
  expect(() =>
    classifyRetryPass(
      pass([
        projectRetryFact(
          'yandex/indexer',
          fields('y', { payPerIndexed: false }),
        ),
      ]),
      local(),
      'yandex',
      utc,
    ),
  ).toThrow();
});

test('P1B-03 relation validation excludes proven children and exact own retry children', () => {
  const parent = projectRetryFact(
    family,
    fields('p', { childTaskIds: ['child'] }),
  );
  const child = projectRetryFact(
    family,
    fields('child', { createdAt: '2026-10-20T00:00:00Z' }),
  );
  const own = projectRetryFact(
    family,
    fields('own', { createdAt: '2026-10-19T00:00:00Z' }),
  );
  const snapshot = local({
    acceptedManifests: [manifest('own', [A], family, 'retry')],
  });
  expect(
    classifyRetryPass(pass([parent, child, own]), snapshot, 'google', utc),
  ).toEqual({ kind: 'selected', reference: [family, 'p'] });
  expect(() =>
    projectRetryFact(family, fields('p', { childTaskIds: ['child', 'child'] })),
  ).toThrow();
  expect(() =>
    projectRetryFact(
      family,
      fields('p', { childTaskIds: ['child'], children: [fields('other')] }),
    ),
  ).toThrow();
  for (const tasks of [
    [fields('p', { childTaskIds: ['p'] })],
    [
      fields('p', { childTaskIds: ['child'] }),
      fields('q', { childTaskIds: ['child'] }),
    ],
    [
      fields('p', { childTaskIds: ['q'] }),
      fields('q', { childTaskIds: ['p'] }),
    ],
  ])
    expect(() =>
      retryRelations(tasks.map((task) => projectRetryFact(family, task))),
    ).toThrow();
  const sameIdYandex = projectRetryFact(
    'yandex/indexer',
    fields('p', { payPerIndexed: undefined }),
  );
  expect(
    classifyRetryPass(
      pass([parent, child, sameIdYandex]),
      snapshot,
      'yandex',
      utc,
    ),
  ).toEqual({ kind: 'selected', reference: ['yandex/indexer', 'p'] });
});

test('P1B-05 exact corpus, local union equality and explicit external omissions', () => {
  const exact = [
    'https://example.test/Case?q=1&b=2',
    'https://example.test/case?q=1&b=2',
    'https://example.test/Case?b=2&q=1',
    'https://example.test/é/#x',
    'https://example.test/%C3%A9/#x',
  ];
  const fact = projectRetryFact(
    family,
    fields('parent', {
      size: exact.length + 1,
      processedCount: exact.length + 1,
    }),
  );
  expect(proposal(pass([fact], report(fact, [C], exact))).eligibleUrls).toEqual(
    exact,
  );
  const source = projectRetryFact(family, fields());
  const snapshot = local({
    acceptedManifests: [manifest('parent', [A, B, C])],
  });
  const missing = assessRetryObservations(
    {},
    observations(pass([source], report(source, [C], [A])), snapshot),
    snapshot,
    configuration().snapshot.policy,
  );
  expect(missing).toMatchObject({
    status: 'blocked',
    blockers: ['SourceReportIncomplete'],
    unknownUrlCount: 1,
    knownMissingLocalUrls: [B],
  });
  blocked(
    assessRetryObservations(
      {},
      observations(
        pass([source], report(source, [C], [A, 'https://example.test/extra'])),
        snapshot,
      ),
      snapshot,
      configuration().snapshot.policy,
    ),
    'SourceManifestConflict',
  );
  const partial = assessRetryObservations(
    {},
    observations(pass([source], report(source, [C], [A]))),
    local(),
    configuration().snapshot.policy,
  );
  expect(partial).toMatchObject({
    unknownUrlCount: 1,
    knownMissingLocalUrls: null,
  });
  for (const unindexed of [
    [C, A],
    ['javascript:bad', B],
  ])
    blocked(
      assessRetryObservations(
        {},
        observations(pass([source], report(source, [C], unindexed))),
        local(),
        configuration().snapshot.policy,
      ),
      'SourceManifestConflict',
    );
  const adopted = proposal();
  expect(adopted.source).toMatchObject({
    provenance: 'external_unattributed',
    originalManifestKnown: false,
    manifestDigest: H('speedyindex-provider-report-url-manifest-v1', [
      family,
      'parent',
      [C, A, B],
    ]),
  });
  blocked(
    assessRetryObservations(
      {},
      observations(pass([source], report(source))),
      local(),
      configuration(false).snapshot.policy,
    ),
    'UnattributedParentPermissionRequired',
  );
  const legacy = local({
    acceptedManifests: [
      manifest('parent', [B, C, A], family, 'legacy_unattributed'),
    ],
  });
  blocked(
    assessRetryObservations(
      {},
      observations(pass([source], report(source)), legacy),
      legacy,
      configuration(false).snapshot.policy,
    ),
    'UnattributedParentPermissionRequired',
  );
  expect(
    proposal(pass([source], report(source)), legacy).source.manifestDigest,
  ).toBe(H('speedyindex-intent-url-manifest-v1', [family, [B, C, A]]));
  const ambiguous = local({
    ambiguousProviderRefs: [
      {
        taskFamily: family,
        providerTaskId: 'parent',
        requestIds: ['one', 'two'],
        records: [],
      },
    ],
  });
  blocked(
    assessRetryObservations(
      {},
      observations(pass([source], report(source)), ambiguous),
      ambiguous,
      configuration().snapshot.policy,
    ),
    'AmbiguousLocalReference',
  );
});

test('P1B-06 full cross-engine active manifests and ordinary unknown holds preserve all reasons', () => {
  for (const sourceFamily of ['google/indexer', 'yandex/indexer'] as const) {
    const other = sourceFamily === family ? 'yandex/indexer' : family;
    const source = projectRetryFact(sourceFamily, fields());
    const active = projectRetryFact(
      other,
      fields('active', { isCompleted: false, status: undefined }),
    );
    const snapshot = local({
      acceptedManifests: [manifest('active', [A], other)],
      holds: [
        {
          requestId: 'old-checker',
          taskFamily: 'backlink/checker',
          state: 'unknown',
          stateVersion: '2',
          urls: [{ ordinal: '0', url: A }],
        },
      ],
    });
    const result = assessRetryObservations(
      { searchEngine: sourceFamily.split('/')[0] },
      observations(pass([source, active], report(source)), snapshot),
      snapshot,
      configuration().snapshot.policy,
    );
    expect(result).toMatchObject({
      status: 'proposal',
      eligibleUrls: [B],
      excluded: [
        {
          url: A,
          reasons: ['ActiveIndexing', 'LocalUnresolvedHold'],
          references: [[other, 'active']],
        },
      ],
    });
    blocked(
      assessRetryObservations(
        { searchEngine: sourceFamily.split('/')[0] },
        observations(pass([source, active], report(source))),
        local(),
        configuration().snapshot.policy,
      ),
      'ActiveCoverageUnknown',
    );
  }
  const source = projectRetryFact(family, fields());
  const unknownRetry = {
    requestId: 'unknown',
    taskFamily: family,
    parentFamily: family,
    parentTaskId: 'different',
    sourceManifestDigest: digest,
    planFingerprint: digest,
    state: 'unknown' as const,
    stateVersion: '2',
    providerTaskId: null,
  };
  const unknown = local({ retryChildren: [unknownRetry] });
  blocked(
    assessRetryObservations(
      {},
      observations(pass([source], report(source)), unknown),
      unknown,
      configuration().snapshot.policy,
    ),
    'UnknownRetryDispatch',
  );
  const prepared = local({
    retryChildren: [{ ...unknownRetry, state: 'prepared' }],
  });
  expect(
    proposal(pass([source], report(source)), prepared).eligibleUrls,
  ).toEqual([A, B]);
  const ordinary = projectRetryFact(family, {
    id: 'ordinary',
    isCompleted: true,
    payPerIndexed: false,
  });
  expect(
    proposal(pass([source, ordinary], report(source))).eligibleUrls,
  ).toEqual([A, B]);
});

test('P1B-06 stopped drip still covers full local manifest with scheduled or active children', () => {
  const source = projectRetryFact(family, fields());
  const child = projectRetryFact(
    family,
    fields('daily', { isCompleted: false, status: undefined }),
  );
  const drip = projectRetryFact(
    family,
    fields('drip', {
      createdAt: '2026-09-01T00:00:00Z',
      payPerIndexed: false,
      isStopped: true,
      days: 3,
      daysPassed: 1,
      awaitingResult: true,
      childTaskIds: ['daily'],
      children: [fields('daily', { isCompleted: false, status: undefined })],
    }),
  );
  const data = pass([source, child, drip], report(source));
  const withDrip: RetryPass = [
    [
      data[0][0]!,
      ['google/indexer', 'drip', 0, [[0, [[family, 'drip']]]]],
      data[0][2]!,
    ],
    data[1],
    data[2],
    data[3],
    [],
  ];
  const snapshot = local({ acceptedManifests: [manifest('drip', [A])] });
  expect(proposal(withDrip, snapshot).excluded).toEqual([
    { url: A, reasons: ['ActiveDrip'], references: [[family, 'drip']] },
  ]);
});

test('P1B-07 direct final retry evidence excludes indexed URLs; incomplete child never implies absence', () => {
  const source = projectRetryFact(family, fields()),
    child = projectRetryFact(
      family,
      fields('child', { size: 2, processedCount: 2 }),
    );
  const snapshot = local({
    acceptedManifests: [manifest('child', [A, B], family, 'retry')],
    retryChildren: [
      {
        requestId: 'local-child',
        taskFamily: family,
        parentFamily: family,
        parentTaskId: 'parent',
        sourceManifestDigest: digest,
        planFingerprint: digest,
        state: 'accepted',
        stateVersion: '2',
        providerTaskId: 'child',
      },
    ],
  });
  const childReport = report(child, [A], [B]);
  expect(
    proposal(pass([source, child], report(source), [childReport]), snapshot),
  ).toMatchObject({
    eligibleUrls: [B],
    excluded: [
      {
        url: A,
        reasons: ['PriorRetryIndexed'],
        references: [[family, 'child']],
      },
    ],
  });
  for (const reports of [
    [],
    [report(child, [A], [])],
    [report(child, [A], [A])],
  ])
    blocked(
      assessRetryObservations(
        {},
        observations(pass([source, child], report(source), reports), snapshot),
        snapshot,
        configuration().snapshot.policy,
      ),
      'PriorRetryEvidenceUnknown',
    );
  const activeChild = projectRetryFact(
    family,
    fields('child', {
      size: 2,
      processedCount: 0,
      indexedCount: 0,
      isCompleted: false,
      status: undefined,
    }),
  );
  blocked(
    assessRetryObservations(
      {},
      observations(pass([source, activeChild], report(source)), snapshot),
      snapshot,
      configuration().snapshot.policy,
    ),
    'NoCandidates',
  );
  const unrelated = local({
    ...snapshot,
    retryChildren: snapshot.retryChildren.map((item) => ({
      ...item,
      parentTaskId: 'other',
    })),
  });
  expect(
    proposal(pass([source, child], report(source)), unrelated).eligibleUrls,
  ).toEqual([A, B]);
});

test('P1B-08 ordered partition and exact regular quote have independent body and digest oracles', () => {
  const value = proposal();
  expect(value.request.body).toBe(
    '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}',
  );
  expect(value.request.quote.maximumExposure).toEqual({
    tokens: 200,
    indexer: 0,
    checker: 0,
  });
  expect(value.request.request.payloadDigest).toBe(
    createHash('sha256').update(value.request.body).digest('hex'),
  );
  expect(value.partitionDigest).toBe(
    H('speedyindex-retry-partition-v1', [[A, B], [A, B], [], [0, null]]),
  );
  expect(value.safetyEvidenceDigests[1]).toBe(
    H('speedyindex-retry-local-safety-v1', [
      digest,
      family,
      'parent',
      'external_unattributed',
      value.source.manifestDigest,
    ]),
  );
  const config = configuration(),
    context = createSubmissionContext(
      config,
      value.request.quote.fingerprint,
      utc,
    );
  const identity = buildRetrySemanticIdentity(value, final(), context, local());
  expect(identity.status).toBe('comparison');
  if (identity.status !== 'comparison') throw new Error('Comparison missing.');
  expect(identity.fingerprint).toBe(
    computeRetryPlanFingerprint(identity.preimage),
  );
  for (const changed of [
    { partitionDigest: 'b'.repeat(64) },
    { revision: 'c'.repeat(64) },
    { provenance: 'legacy_unattributed' as const },
    { parent: { family, taskId: 'tampered' } },
    { policyDigest: 'd'.repeat(64) },
    { payloadDigest: 'e'.repeat(64) },
    { reservation: { tokens: 201, indexer: 0, checker: 0 } },
  ])
    expect(
      computeRetryPlanFingerprint({ ...identity.preimage, ...changed }),
    ).not.toBe(identity.fingerprint);
  const sameDay = createSubmissionContext(
    config,
    value.request.quote.fingerprint,
    utc + 10000,
  );
  expect(buildRetrySemanticIdentity(value, final(), sameDay, local())).toEqual(
    identity,
  );
  const nextDay = createSubmissionContext(
    config,
    value.request.quote.fingerprint,
    utc + 86400000,
  );
  const next = buildRetrySemanticIdentity(value, final(), nextDay, local());
  if (next.status !== 'comparison')
    throw new Error('Next-day comparison missing.');
  expect(next.fingerprint).not.toBe(identity.fingerprint);
  expect(() => (value.eligibleUrls as string[]).push(C)).toThrow();
  expect(JSON.stringify(identity.preimage)).not.toContain('synthetic-ledger');
  expect(JSON.stringify(identity.preimage)).not.toContain('pure-synthetic-key');
  expect('proof' in identity).toBe(false);
});

test('R4-3733-QUOTE-BINDING-01 rejects a real context for a different regular quote', () => {
  const config = configuration(),
    snapshot = local(),
    planning = final(snapshot);
  const value = proposal(undefined, snapshot, config.snapshot.policy);
  const other = buildCreateIndexingRequest({
    mode: 'preview',
    searchEngine: 'google',
    urls: [A],
  });
  const matching = createSubmissionContext(
    config,
    value.request.quote.fingerprint,
    utc,
  );
  const wrongQuote = createSubmissionContext(
    config,
    other.quote.fingerprint,
    utc,
  );
  const inputs = [
    config,
    snapshot,
    planning,
    value,
    other,
    matching,
    wrongQuote,
  ];
  const before = structuredClone(inputs);
  const body =
    '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}';
  const payloadDigest = createHash('sha256').update(body).digest('hex');
  const quoteVersion = 'speedyindex-indexing-batch-2026-10-20-v1';
  const providerRoute = '/v2/task/google/indexer/create';
  const reservation = { tokens: 200, indexer: 0, checker: 0 };
  const quoteFingerprint = H('speedyindex-create-quote-v1', {
    version: quoteVersion,
    family,
    providerRoute,
    payloadDigest,
    urlCount: 2,
    maximumExposure: reservation,
  });
  const period = {
    id: 'utc-day:2026-10-21',
    startMs: Date.parse('2026-10-21T00:00:00Z'),
    endMs: Date.parse('2026-10-22T00:00:00Z'),
  };
  const authorizationFingerprint = H(
    'speedyindex-submission-authorization-v1',
    {
      quoteFingerprint,
      policyDigest: config.snapshot.digest,
      credentialFingerprint: config.credential.fingerprint,
      budgetScope: 'pure',
      periodId: period.id,
      periodStartMs: period.startMs,
    },
  );
  const expectedPreimage: RetryPlanFingerprintInput = {
    parent: { family, taskId: 'parent' },
    provenance: 'external_unattributed',
    originalManifestKnown: false,
    manifestProvenance: 'provider_report_observed_corpus',
    sourceManifestDigest: value.source.manifestDigest,
    safetyEvidenceDigests: value.safetyEvidenceDigests,
    partitionDigest: H('speedyindex-retry-partition-v1', [
      [A, B],
      [A, B],
      [],
      [0, null],
    ]),
    revision: digest,
    policyDigest: config.snapshot.digest,
    authorizationFingerprint,
    payloadDigest,
    quoteVersion,
    quoteFingerprint,
    period,
    providerRoute,
    urlCount: 2,
    providerBodyBytes: Buffer.byteLength(body, 'utf8'),
    reservation,
  };
  const expectedFingerprint = H('speedyindex-retry-plan-v1', [
    family,
    'parent',
    'external_unattributed',
    false,
    'provider_report_observed_corpus',
    value.source.manifestDigest,
    value.safetyEvidenceDigests,
    expectedPreimage.partitionDigest,
    digest,
    config.snapshot.digest,
    authorizationFingerprint,
    payloadDigest,
    quoteVersion,
    quoteFingerprint,
    [period.id, period.startMs, period.endMs],
    providerRoute,
    2,
    Buffer.byteLength(body, 'utf8'),
    [200, 0, 0],
  ]);
  expect(value.request.body).toBe(body);
  expect(value.request.quote.fingerprint).toBe(quoteFingerprint);
  expect(other.request.urlCount).toBe(1);
  expect(other.quote.fingerprint).not.toBe(quoteFingerprint);
  expect(
    buildRetrySemanticIdentity(value, planning, matching, snapshot),
  ).toEqual({
    status: 'comparison',
    preimage: expectedPreimage,
    fingerprint: expectedFingerprint,
  });
  const mismatched = buildRetrySemanticIdentity(
    value,
    planning,
    wrongQuote,
    snapshot,
  );
  expect(inputs).toEqual(before);
  expect(mismatched).toEqual({
    status: 'blocked',
    blockers: ['SnapshotConflict'],
  });
  for (const key of ['fingerprint', 'preimage', 'proof'])
    expect(key in mismatched).toBe(false);
});

test('P1B-08 R3-9049-PURITY1 caller can revise an unindexed URL without changing an earlier comparison', () => {
  const source = projectRetryFact(family, fields());
  const selected = report(source);
  const urls = selected[6] as string[];
  urls.push(C);
  expect(urls.pop()).toBe(C);
  expect(urls).toEqual([A, B]);
  const data = pass([source], selected);
  const config = configuration();
  const snapshot = local();
  const first = proposal(data, snapshot, config.snapshot.policy);
  const identity = buildRetrySemanticIdentity(
    first,
    final(snapshot),
    createSubmissionContext(config, first.request.quote.fingerprint, utc),
    snapshot,
  );
  expect(identity.status).toBe('comparison');
  if (identity.status !== 'comparison') throw new Error('Comparison missing.');
  expect(first.preimages.observation).toEqual(data);
  expect(first.preimages.partition).toEqual([[A, B], [A, B], [], [0, null]]);
  expect(first.partitionDigest).toBe(
    H('speedyindex-retry-partition-v1', [[A, B], [A, B], [], [0, null]]),
  );
  const original = structuredClone([first, identity]);
  const replacement = 'https://example.test/replacement';
  urls[0] = replacement;
  expect(urls).toEqual([replacement, B]);
  const next = proposal(data, snapshot, config.snapshot.policy);
  const nextIdentity = buildRetrySemanticIdentity(
    next,
    final(snapshot),
    createSubmissionContext(config, next.request.quote.fingerprint, utc),
    snapshot,
  );
  expect(nextIdentity.status).toBe('comparison');
  if (nextIdentity.status !== 'comparison')
    throw new Error('Revised comparison missing.');
  expect(next.eligibleUrls).toEqual([replacement, B]);
  expect(next.preimages.partition).toEqual([
    [replacement, B],
    [replacement, B],
    [],
    [0, null],
  ]);
  expect(JSON.parse(next.request.body).urls).toEqual([replacement, B]);
  expect(next.request.body).not.toBe(first.request.body);
  expect(next.partitionDigest).not.toBe(first.partitionDigest);
  expect(next.request.quote.fingerprint).not.toBe(
    first.request.quote.fingerprint,
  );
  expect(nextIdentity.fingerprint).not.toBe(identity.fingerprint);
  expect(nextIdentity.fingerprint).toBe(
    computeRetryPlanFingerprint(nextIdentity.preimage),
  );
  expect(() =>
    (first.preimages.observation[3]![6] as string[]).push(C),
  ).toThrow();
  expect(() => (first.eligibleUrls as string[]).push(C)).toThrow();
  expect([first, identity]).toEqual(original);
});

test('P1B-08 R3-9049-PURITY1 rich caller observations remain mutable while proposal data stays immutable', () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const childFields = fields('child', { size: 2, processedCount: 2 });
  const source = projectRetryFact(
    family,
    fields('parent', { childTaskIds: ['child'], children: [childFields] }),
  ) as Mutable<RetryFact>;
  const child = projectRetryFact(family, childFields);
  const childReport = report(child, [A], [B]);
  const data = pass([source, child], report(source), [childReport]);
  const roots = data[0][0]![3][0]![1] as [RetryFamily, string][];
  const indexed = data[4][0]![5] as string[];
  const snapshot = local({
    acceptedManifests: [manifest('child', [A, B], family, 'retry')],
    retryChildren: [
      {
        requestId: 'local-child',
        taskFamily: family,
        parentFamily: family,
        parentTaskId: 'parent',
        sourceManifestDigest: digest,
        planFingerprint: digest,
        state: 'accepted',
        stateVersion: '2',
        providerTaskId: 'child',
      },
    ],
  }) as Mutable<AvailableRetrySnapshot>;
  const config = configuration();
  const policy = config.snapshot.policy as Mutable<SubmissionPolicy>;
  const before = structuredClone(data);
  source[3] = 2;
  expect(source[3]).toBe(2);
  source[3] = 3;
  roots.push([family, 'temporary']);
  expect(roots.pop()).toEqual([family, 'temporary']);
  indexed.push(C);
  expect(indexed.pop()).toBe(C);
  expect(data).toEqual(before);
  const value = proposal(data, snapshot, policy);
  const identity = buildRetrySemanticIdentity(
    value,
    final(snapshot),
    createSubmissionContext(config, value.request.quote.fingerprint, utc),
    snapshot,
  );
  expect(identity.status).toBe('comparison');
  if (identity.status !== 'comparison') throw new Error('Comparison missing.');
  expect(value.eligibleUrls).toEqual([B]);
  expect(value.excluded).toEqual([
    { url: A, reasons: ['PriorRetryIndexed'], references: [[family, 'child']] },
  ]);
  expect(value.counts).toEqual({
    indexed: 1,
    unindexed: 2,
    eligible: 1,
    excluded: 1,
    unknown: 0,
  });
  expect(value.request.body).toBe(
    '{"urls":["https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}',
  );
  expect(value.request.quote.maximumExposure).toEqual({
    tokens: 100,
    indexer: 0,
    checker: 0,
  });
  expect(value.preimages.observation).toEqual(before);
  expect(value.safetyEvidenceDigests[0]).toBe(
    H('speedyindex-retry-observation-safety-v1', before),
  );
  const original = structuredClone([value, identity]);
  roots.push([family, 'later']);
  source[3] = 0;
  (source[7] as [number, string])[1] = '123';
  (source[15] as string[]).push('later-child');
  (source[16]![0]! as { 3: number | null })[3] = 0;
  (data[2][0]![1] as [RetryFamily, string])[1] = 'later-child';
  (data[3]![5] as string[])[0] = B;
  (data[3]![6] as string[])[0] = C;
  indexed[0] = C;
  (data[4][0]![7] as Mutable<RetryFact>)[3] = 0;
  (snapshot.acceptedManifests[0]!.submittedUrls as string[]).push(C);
  policy.caps.tokens = 10001;
  expect(roots.at(-1)).toEqual([family, 'later']);
  expect(source[3]).toBe(0);
  expect(source[7]![1]).toBe('123');
  expect(source[15]).toEqual(['child', 'later-child']);
  expect(source[16]![0]![3]).toBe(0);
  expect(data[2][0]![1]).toEqual([family, 'later-child']);
  expect(data[3]![5]).toEqual([B]);
  expect(data[3]![6]).toEqual([C, B]);
  expect(data[4][0]![5]).toEqual([C]);
  expect(data[4][0]![7][3]).toBe(0);
  expect(snapshot.acceptedManifests[0]!.submittedUrls).toEqual([A, B, C]);
  expect(policy.caps.tokens).toBe(10001);
  const returnedRoots = value.preimages.observation[0][0]![3][0]![1] as [
    RetryFamily,
    string,
  ][];
  const returnedIndexed = value.preimages.observation[4][0]![5] as string[];
  expect(() => returnedRoots.push([family, 'tampered'])).toThrow();
  expect(() => {
    returnedIndexed[0] = C;
  }).toThrow();
  expect(() => {
    (
      identity.preimage.reservation as Mutable<
        typeof identity.preimage.reservation
      >
    ).tokens = 0;
  }).toThrow();
  expect([value, identity]).toEqual(original);
  expect(identity.fingerprint).toBe(
    computeRetryPlanFingerprint(identity.preimage),
  );
});

test('P1B-08 blocked identity remains immutable under caller mutations', () => {
  const value = proposal(),
    context = createSubmissionContext(
      configuration(),
      value.request.quote.fingerprint,
      utc,
    ),
    snapshot = local(),
    capped = final();
  for (const { state, blocker } of [
    {
      state: {
        availability: 'unavailable' as const,
        reason: 'UpgradeRequired' as const,
      },
      blocker: 'UpgradeRequired',
    },
    {
      state: {
        ...capped,
        decision: {
          ...capped.decision,
          withinCaps: { tokens: false, indexer: true, checker: true },
        },
      },
      blocker: 'BudgetExceeded',
    },
  ] as const) {
    const before = JSON.stringify([value, state, context, snapshot]);
    const result = buildRetrySemanticIdentity(value, state, context, snapshot);
    const expected = { status: 'blocked', blockers: [blocker] } as const;
    expect(result).toEqual(expected);
    const mutable = result as unknown as { status: string; blockers: string[] };
    for (const mutate of [
      () => mutable.blockers.push('StateUnavailable'),
      () => (mutable.blockers[0] = 'SnapshotConflict'),
      () => (mutable.status = 'comparison'),
    ]) {
      try {
        mutate();
      } catch {
        // A rejected write must leave the same refusal intact.
      }
      expect(result).toEqual(expected);
      expect('fingerprint' in result).toBe(false);
      expect('preimage' in result).toBe(false);
    }
    expect(JSON.stringify([value, state, context, snapshot])).toBe(before);
  }
});

test('P1B-08 final revision, ledger, allowance, period and every unit cap can refuse identity', () => {
  const value = proposal(),
    context = createSubmissionContext(
      configuration(),
      value.request.quote.fingerprint,
      utc,
    );
  for (const state of [
    final(local({ revision: 'b'.repeat(64) })),
    final(local({ ledgerId: 'replacement' })),
    { ...final(), decision: { ...final().decision, periodCompatible: false } },
    {
      ...final(),
      decision: {
        ...final().decision,
        attempts: { count: 3, limit: 3, canCreate: false },
      },
    },
    ...(['tokens', 'indexer', 'checker'] as const).map((unit) => ({
      ...final(),
      decision: {
        ...final().decision,
        withinCaps: {
          tokens: true,
          indexer: true,
          checker: true,
          [unit]: false,
        },
      },
    })),
  ]) {
    expect(
      buildRetrySemanticIdentity(value, state, context, local()).status,
    ).toBe('blocked');
  }
  const huge = Array.from(
    { length: 260 },
    (_, index) =>
      'https://example.test/' +
      String(index).padStart(4, '0') +
      'x'.repeat(8100),
  );
  const fact = projectRetryFact(
    family,
    fields('large', {
      size: huge.length,
      processedCount: huge.length,
      indexedCount: 0,
    }),
  );
  expect(
    Buffer.byteLength(
      JSON.stringify({ urls: huge, pay_per_indexed: true, drip_feed: false }),
      'utf8',
    ),
  ).toBeGreaterThan(2097152);
  expect(() =>
    assessRetryObservations(
      {},
      observations(pass([fact], report(fact, [], huge))),
      local(),
      configuration().snapshot.policy,
    ),
  ).toThrow(ReadBudgetError);
});

test('P1B-09 status packing obeys independent UTF8 escaped-body and ID boundaries', () => {
  const ids = Array.from({ length: 1001 }, (_, index) => 'opaque-' + index);
  const batches = packRetryStatusIds(ids);
  expect(batches.map((batch) => batch.length)).toEqual([1000, 1]);
  expect(batches.flat()).toEqual(ids);
  const escaped = Array.from(
    { length: 25 },
    (_, index) => String(index) + 'é"\\'.repeat(600),
  );
  const packed = packRetryStatusIds(escaped);
  expect(packed.length).toBeGreaterThan(1);
  for (const batch of packed)
    expect(
      Buffer.byteLength(JSON.stringify({ task_ids: batch }), 'utf8'),
    ).toBeLessThanOrEqual(65536);
  expect(() => packRetryStatusIds(['x'.repeat(4097)])).toThrow();
  const bytes = Buffer.byteLength('{"task_ids":["é"]}', 'utf8');
  expect(packRetryStatusIds(['é'], { requestBytes: bytes })).toEqual([['é']]);
  expect(() => packRetryStatusIds(['é'], { requestBytes: bytes - 1 })).toThrow(
    ReadBudgetError,
  );
});

test('P1B-10 logical tuple exact and one-over limits include wrappers and serialized copies', () => {
  // Hand-authored empty provider tuple and snapshot make overhead observable.
  const data: RetryPass = [[], [], [], null, []];
  const providerBytes = Buffer.byteLength('[[[],[],[],null,[]]]', 'utf8');
  assertRetryProviderBytes([data], providerBytes);
  expect(() => assertRetryProviderBytes([data], providerBytes - 1)).toThrow(
    ReadBudgetError,
  );
  expect(() => assertRetryProviderBytes([data, data], providerBytes)).toThrow(
    ReadBudgetError,
  );
  const snapshot = local(),
    item = { status: 'comparison', value: 'é' };
  const combined = Buffer.byteLength(
    JSON.stringify([snapshot, data, item]),
    'utf8',
  );
  assertRetryCombinedBytes(snapshot, data, item, combined);
  expect(() =>
    assertRetryCombinedBytes(snapshot, data, item, combined - 1),
  ).toThrow(ReadBudgetError);
  const value = proposal(),
    context = createSubmissionContext(
      configuration(),
      value.request.quote.fingerprint,
      utc,
    );
  const comparison = buildRetrySemanticIdentity(
    value,
    final(),
    context,
    local(),
  );
  const realBytes = Buffer.byteLength(
    JSON.stringify([local(), value.preimages.observation, [value, comparison]]),
    'utf8',
  );
  expect(
    buildRetrySemanticIdentity(value, final(), context, local(), {
      combinedBytes: realBytes,
    }),
  ).toEqual(comparison);
  expect(() =>
    buildRetrySemanticIdentity(value, final(), context, local(), {
      combinedBytes: realBytes - 1,
    }),
  ).toThrow(ReadBudgetError);
  expect(() => assertRetryProviderBytes([data], 8 * 1024 * 1024 + 1)).toThrow(
    RangeError,
  );
  expect(() =>
    assertRetryCombinedBytes(snapshot, data, item, 24 * 1024 * 1024 + 1),
  ).toThrow(RangeError);
});

test('P1B-08 explicit canonical safety tuple and actual semantic mutations determine identity', () => {
  const fact: RetryFact = [
    family,
    'parent',
    3,
    3,
    1,
    true,
    'completed',
    [Date.parse('2026-10-01T00:00:00Z'), ''],
    true,
    [Date.parse('2026-10-08T00:00:00Z'), ''],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const expected: RetryPass = [
    [
      ['google/indexer', 'regular', 0, [[0, [[family, 'parent']]]]],
      ['google/indexer', 'drip', 0, [[0, []]]],
      ['yandex/indexer', 'regular', 0, [[0, []]]],
    ],
    [fact],
    [],
    [family, 'parent', 3, 3, 1, [C], [A, B], fact],
    [],
  ];
  const value = proposal();
  expect(value.preimages.observation).toEqual(expected);
  expect(value.safetyEvidenceDigests[0]).toBe(
    H('speedyindex-retry-observation-safety-v1', expected),
  );
  const revised = projectRetryFact(
    family,
    fields('parent', { checkAfter: '2026-10-09T00:00:00Z' }),
  );
  const changed = proposal(pass([revised], report(revised)));
  expect(changed.safetyEvidenceDigests[0]).not.toBe(
    value.safetyEvidenceDigests[0],
  );
  const config = configuration();
  const a = buildRetrySemanticIdentity(
    value,
    final(),
    createSubmissionContext(config, value.request.quote.fingerprint, utc),
    local(),
  );
  const b = buildRetrySemanticIdentity(
    changed,
    final(),
    createSubmissionContext(config, changed.request.quote.fingerprint, utc),
    local(),
  );
  expect(a).not.toEqual(b);
});

test('P1B-10 combined oracle measures large local or provider side and repeated serialized occurrences', () => {
  const snapshot = local({ capturedAt: 'local-data-'.repeat(100) }),
    data: RetryPass = [[], [], [], null, []],
    result = { source: 'é'.repeat(200) };
  const exact = Buffer.byteLength(
    JSON.stringify([snapshot, data, result]),
    'utf8',
  );
  assertRetryCombinedBytes(snapshot, data, result, exact);
  expect(() =>
    assertRetryCombinedBytes(snapshot, data, result, exact - 1),
  ).toThrow(ReadBudgetError);
  const value = proposal(),
    bytes = Buffer.byteLength(
      JSON.stringify([local(), value.preimages.observation, value]),
      'utf8',
    );
  expect(bytes).toBeGreaterThan(
    Buffer.byteLength(
      JSON.stringify([local(), value.preimages.observation, null]),
      'utf8',
    ),
  );
  expect(() =>
    assessRetryObservations(
      {},
      observations(value.preimages.observation),
      local(),
      configuration().snapshot.policy,
      { combinedBytes: bytes - 1 },
    ),
  ).toThrow(ReadBudgetError);
});

test('P1B-02 strict instants preserve fractional chronology and never mature a sub-millisecond future', () => {
  expect(retryInstant('2026-10-01T02:00:00.0001000+02:00')).toEqual(
    retryInstant('2026-10-01T00:00:00.0001Z'),
  );
  const older = projectRetryFact(
    family,
    fields('z-older', { createdAt: '2026-10-01T00:00:00.0001Z' }),
  );
  const newer = projectRetryFact(
    family,
    fields('a-newer', { createdAt: '2026-10-01T00:00:00.0002Z' }),
  );
  expect(
    classifyRetryPass(pass([older, newer]), local(), 'google', utc),
  ).toEqual({ kind: 'selected', reference: [family, 'a-newer'] });
  const future = projectRetryFact(
    family,
    fields('parent', { checkAfter: '2026-10-21T12:00:00.0001Z' }),
  );
  blocked(
    assessRetryObservations(
      {},
      observations(pass([future], report(future))),
      local(),
      configuration().snapshot.policy,
    ),
    'UnprovenLatest',
  );
});

test('P1B-05 report omission cannot erase an indexed count supplied by status', () => {
  const fact = projectRetryFact(family, fields());
  const data: RetryReportFact = [
    family,
    'parent',
    3,
    3,
    null,
    [C, A],
    [B],
    fact,
  ];
  blocked(
    assessRetryObservations(
      {},
      observations(pass([fact], data)),
      local(),
      configuration().snapshot.policy,
    ),
    'SourceManifestConflict',
  );
});

type PublicReady = Extract<PlanRetryResult, { status: 'ready' }>;
function publicReadyFixture(
  options: {
    engine?: 'google' | 'yandex';
    provenance?: PublicReady['source']['provenance'];
    urls?: readonly string[];
    exclusions?: 'local' | 'active';
  } = {},
) {
  const engine = options.engine ?? 'google';
  const sourceFamily: RetryFamily = `${engine}/indexer`;
  const provenance = options.provenance ?? 'local_standalone';
  const urls = options.urls ?? [A, B];
  const fact = projectRetryFact(
    sourceFamily,
    fields('parent', {
      size: urls.length + 1,
      processedCount: urls.length + 1,
      indexedCount: 1,
    }),
  );
  const activeFacts =
    options.exclusions === 'active'
      ? (['google/indexer', 'yandex/indexer'] as const).map((engine) =>
          projectRetryFact(
            engine,
            fields('active-é', {
              createdAt: '2026-09-01T00:00:00Z',
              isCompleted: false,
              status: undefined,
            }),
          ),
        )
      : [];
  const snapshot = local({
    acceptedManifests: [
      ...(provenance === 'external_unattributed'
        ? []
        : [
            manifest(
              'parent',
              [C, ...urls],
              sourceFamily,
              provenance === 'legacy_unattributed' ? provenance : 'standalone',
            ),
          ]),
      ...activeFacts.map((f) => manifest(f[1], [urls[1]!], f[0])),
    ],
    holds: options.exclusions
      ? [
          {
            requestId: 'private-checker',
            taskFamily: 'backlink/checker',
            state: 'unknown',
            stateVersion: '2',
            urls: [{ ordinal: '0', url: urls[1]! }],
          },
        ]
      : [],
  });
  const original = configuration();
  const policy: SubmissionPolicy = {
    ...original.snapshot.policy,
    caps: { tokens: 1_000_000, indexer: 10_000, checker: 10_000 },
  };
  const config: ConfiguredSubmission = {
    ...original,
    snapshot: { policy, digest: H('synthetic-policy', policy) },
  };
  const assessed = assessRetryObservations(
    { searchEngine: engine },
    observations(
      pass([fact, ...activeFacts], report(fact, [C], [...urls])),
      snapshot,
    ),
    snapshot,
    policy,
  );
  if (assessed.status !== 'proposal')
    throw new Error(
      'Pure result fixture needs a real proposal: ' + assessed.status,
    );
  const context = createSubmissionContext(
    config,
    assessed.request.quote.fingerprint,
    utc,
  );
  const identity = buildRetrySemanticIdentity(
    assessed,
    final(snapshot),
    context,
    snapshot,
  );
  if (identity.status !== 'comparison')
    throw new Error('Pure result fixture needs comparison data.');
  const view = {
    status: 'ready' as const,
    source: assessed.source,
    eligibleUrls: assessed.eligibleUrls,
    excluded: assessed.excluded,
    counts: assessed.counts,
    request: assessed.request.request,
    quote: assessed.request.quote,
    authorization: { ...context.authorization, stateChecked: true },
    identity,
  };
  const value = retryPlanResultFromView(engine, view);
  if (value.status !== 'ready')
    throw new Error('Expected a valid pure ready result.');
  return { value, view, proposal: assessed };
}
function changedResult<T>(
  value: T,
  path: readonly (string | number)[],
  replacement: unknown,
): T {
  const copy = structuredClone(value);
  let parent: unknown = copy;
  for (const key of path.slice(0, -1))
    parent = (parent as Record<string | number, unknown>)[key];
  (parent as Record<string | number, unknown>)[path.at(-1)!] = replacement;
  return copy;
}
const envelopeBytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').length;
function expectInternalResult(value: unknown) {
  const result = planRetryToolResult(value);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({
    status: 'error',
    error: {
      code: 'InternalError',
      message: 'Retry planning failed internally.',
    },
  });
  expect(
    planRetryResultSchema.safeParse(result.structuredContent).success,
  ).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
  return result;
}
function independentPublicFingerprint(value: PublicReady) {
  const p = value.identity.preimage;
  return H('speedyindex-retry-plan-v1', [
    value.source.reference[0],
    value.source.reference[1],
    value.source.provenance,
    value.source.originalManifestKnown,
    value.source.manifestProvenance,
    value.source.manifestDigest,
    p.safetyEvidenceDigests,
    p.partitionDigest,
    p.revision,
    value.authorization.policyDigest,
    value.authorization.fingerprint,
    value.request.payloadDigest,
    value.quote.version,
    value.quote.fingerprint,
    [
      value.authorization.period.id,
      value.authorization.period.startMs,
      value.authorization.period.endMs,
    ],
    value.request.providerRoute,
    value.request.urlCount,
    value.request.providerBodyBytes,
    [
      value.quote.maximumExposure.tokens,
      value.quote.maximumExposure.indexer,
      value.quote.maximumExposure.checker,
    ],
  ]);
}

test('P2-02 pure four variants and every fixed blocker/error are locally validated with exact isError', () => {
  const ready = publicReadyFixture().value;
  const noSource = retryPlanResultFromView('yandex', { status: 'no_source' });
  expect(noSource).toEqual({ status: 'no_source', searchEngine: 'yandex' });
  const codes = [
    'UnprovenLatest',
    'AmbiguousLatest',
    'ConflictingEvidence',
    'IncompleteScan',
    'SourceReportIncomplete',
    'SourceManifestConflict',
    'UnattributedParentPermissionRequired',
    'ActiveCoverageUnknown',
    'PriorRetryEvidenceUnknown',
    'AmbiguousLocalReference',
    'UnknownRetryDispatch',
    'RetryPolicyRequired',
    'WritesDisabled',
    'SnapshotConflict',
    'StateUnavailable',
    'UpgradeRequired',
    'SnapshotLimitExceeded',
    'RetryAllowanceExceeded',
    'BudgetExceeded',
    'StalePeriodContext',
    'NoCandidates',
  ];
  for (const value of [
    ready,
    noSource,
    ...codes.map((code) =>
      retryPlanResultFromView('google', {
        status: 'blocked',
        blockers: [code],
      }),
    ),
  ]) {
    const result = planRetryToolResult(value);
    expect(result.structuredContent).toEqual(value);
    expect(result.isError).toBe(false);
    expect(
      planRetryResultSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
  }
  const blocked = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['WritesDisabled', 'StateUnavailable'],
  });
  expect(blocked).toMatchObject({
    blockers: [{ code: 'StateUnavailable' }, { code: 'WritesDisabled' }],
  });
  for (const code of [
    'InvalidInput',
    'MissingCredentials',
    'SubmissionBusy',
    'Cancelled',
    'DeadlineExceeded',
    'ReadFailed',
    'ResourceLimitExceeded',
    'InternalError',
  ]) {
    const value = retryPlanResultFromView('google', {
      status: 'error',
      code,
      phase: 'report',
      ...(code === 'ReadFailed' ? { cause: 'response' } : {}),
    });
    const result = planRetryToolResult(value);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      error: { code, phase: 'report' },
    });
    expect(
      planRetryResultSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
    expect(envelopeBytes(result)).toBeLessThanOrEqual(2_097_152);
  }
});

test('P2-02 correlated missing metadata preserves local, external and zero-unknown incomplete reports', () => {
  const source = projectRetryFact(family, fields());
  const snapshot = local({
    acceptedManifests: [manifest('parent', [A, B, C])],
  });
  for (const [state, expectedMissing] of [
    [snapshot, [B]],
    [local(), null],
  ] as const) {
    const assessed = assessRetryObservations(
      {},
      observations(pass([source], report(source, [C], [A])), state),
      state,
      configuration().snapshot.policy,
    );
    const value = retryPlanResultFromView('google', assessed);
    expect(value).toMatchObject({
      status: 'blocked',
      unknownUrlCount: 1,
      knownMissingLocalUrls: expectedMissing,
    });
    expect(planRetryToolResult(value).isError).toBe(false);
  }
  const incomplete = projectRetryFact(
    family,
    fields('parent', { processedCount: 2 }),
  );
  const assessed = assessRetryObservations(
    {},
    observations(pass([incomplete], report(incomplete)), snapshot),
    snapshot,
    configuration().snapshot.policy,
  );
  const zero = retryPlanResultFromView('google', assessed);
  expect(zero).toMatchObject({
    status: 'blocked',
    unknownUrlCount: 0,
    knownMissingLocalUrls: [],
  });
  expect(planRetryToolResult(zero).isError).toBe(false);
  const bare = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['SourceReportIncomplete'],
  });
  expect(bare).not.toHaveProperty('unknownUrlCount');
  expect(bare).not.toHaveProperty('knownMissingLocalUrls');
  const valid = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['SourceReportIncomplete'],
    unknownUrlCount: 1,
    knownMissingLocalUrls: [B],
  });
  const unrelated = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['NoCandidates'],
  });
  if (unrelated.status !== 'blocked')
    throw new Error('Expected pure blocker data.');
  expectInternalResult({ ...valid, blockers: unrelated.blockers });
  for (const [path, replacement] of [
    [['unknownUrlCount'], undefined],
    [['knownMissingLocalUrls'], undefined],
    [['unknownUrlCount'], 2],
    [['knownMissingLocalUrls'], [B, B]],
    [['knownMissingLocalUrls'], ['javascript:bad']],
    [['unknownUrlCount'], -1],
    [['blockers', 0, 'code'], 'NoCandidates'],
  ] as const)
    expectInternalResult(changedResult(valid, path, replacement));
});

test('P2-02 closed variants and nested objects reject malformed isError payloads and redact exceptional values', () => {
  const ready = publicReadyFixture().value;
  const noSource = retryPlanResultFromView('google', { status: 'no_source' });
  const blocked = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['WritesDisabled'],
  });
  const readError = retryPlanResultFromView('google', {
    status: 'error',
    code: 'ReadFailed',
    phase: 'report',
    cause: 'http',
  });
  const multiple = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['WritesDisabled', 'StateUnavailable'],
  });
  if (multiple.status !== 'blocked')
    throw new Error('Expected ordered pure blockers.');
  expectInternalResult({
    ...multiple,
    blockers: [...multiple.blockers].reverse(),
  });
  for (const value of [
    null,
    [],
    'SYNTHETIC-SECRET',
    { status: 'invented' },
    { ...ready, proof: 'SYNTHETIC-SECRET' },
    { ...noSource, identity: ready.identity },
    { ...blocked, quote: ready.quote },
    changedResult(blocked, ['blockers'], []),
    changedResult(
      blocked,
      ['blockers'],
      [
        ...(blocked.status === 'blocked' ? blocked.blockers : []),
        ...(blocked.status === 'blocked' ? blocked.blockers : []),
      ],
    ),
    changedResult(blocked, ['blockers', 0, 'code'], 'Unknown'),
    changedResult(blocked, ['blockers', 0, 'message'], 'SYNTHETIC-SECRET'),
    changedResult(readError, ['error', 'code'], undefined),
    changedResult(readError, ['error', 'message'], 'SYNTHETIC-SECRET'),
    changedResult(readError, ['error', 'cause'], 'SYNTHETIC-SECRET'),
    changedResult(readError, ['error', 'phase'], 'unknown'),
    changedResult(readError, ['error', 'phase'], undefined),
    changedResult(readError, ['error', 'cause'], undefined),
    changedResult(readError, ['error', 'raw'], 'SYNTHETIC-SECRET'),
    changedResult(readError, ['error', 'code'], 'Cancelled'),
    changedResult(ready, ['authorization'], undefined),
    changedResult(ready, ['counts', 'raw'], 'SYNTHETIC-SECRET'),
    changedResult(
      ready,
      ['identity', 'preimage', 'parent', 'raw'],
      'SYNTHETIC-SECRET',
    ),
  ])
    expectInternalResult(value);
  const cyclic = { ...noSource, cycle: null as unknown };
  cyclic.cycle = cyclic;
  expectInternalResult(cyclic);
  const throwing = Object.defineProperty({}, 'status', {
    enumerable: true,
    get() {
      throw new Error('SYNTHETIC-SECRET /private/path provider-body');
    },
  });
  expectInternalResult(throwing);
  expectInternalResult(retryPlanResultFromView('google', throwing));
  for (const view of [
    { status: 'complete', observations: 'SYNTHETIC-SECRET' },
    { status: 'error', code: 'ReadFailed', raw: 'SYNTHETIC-SECRET' },
    { status: 'blocked', blockers: ['Unknown'] },
    { status: 'blocked', blockers: ['WritesDisabled', 'WritesDisabled'] },
    {
      status: 'blocked',
      blockers: ['SourceReportIncomplete'],
      unknownUrlCount: 0,
    },
  ])
    expectInternalResult(retryPlanResultFromView('google', view));
  const stringify = JSON.stringify;
  let failure: ReturnType<typeof planRetryToolResult>;
  try {
    JSON.stringify = () => {
      throw new Error('SYNTHETIC-SECRET serialization');
    };
    failure = planRetryToolResult(noSource);
  } finally {
    JSON.stringify = stringify;
  }
  expectInternalResult(failure.structuredContent);
});

test('P2-03 real local Google, external Yandex and legacy proposals have independent body/quote/fingerprint oracles', () => {
  for (const [engine, provenance] of [
    ['google', 'local_standalone'],
    ['yandex', 'external_unattributed'],
    ['google', 'legacy_unattributed'],
  ] as const) {
    const { value, proposal } = publicReadyFixture({ engine, provenance });
    const body =
      engine === 'google'
        ? '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}'
        : '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"]}';
    const payloadDigest = createHash('sha256')
      .update(body, 'utf8')
      .digest('hex');
    const maximumExposure =
      engine === 'google'
        ? { tokens: 200, indexer: 0, checker: 0 }
        : { tokens: 40, indexer: 2, checker: 0 };
    const quoteFingerprint = createHash('sha256')
      .update(
        'speedyindex-create-quote-v1\0' +
          JSON.stringify({
            version: 'speedyindex-indexing-batch-2026-10-20-v1',
            family: `${engine}/indexer`,
            providerRoute: `/v2/task/${engine}/indexer/create`,
            payloadDigest,
            urlCount: 2,
            maximumExposure,
          }),
        'utf8',
      )
      .digest('hex');
    expect(proposal.request.body).toBe(body);
    expect(value.eligibleUrls).toEqual([A, B]);
    expect(value.request).toEqual({
      family: `${engine}/indexer`,
      providerRoute: `/v2/task/${engine}/indexer/create`,
      urlCount: 2,
      providerBodyBytes: Buffer.from(body, 'utf8').length,
      payloadDigest,
    });
    expect(value.quote).toEqual({
      version: 'speedyindex-indexing-batch-2026-10-20-v1',
      fingerprint: quoteFingerprint,
      maximumExposure,
      basis: 'documented_independent_maxima',
      providerEnforced: false,
    });
    expect(value.source).toMatchObject({
      provenance,
      originalManifestKnown: provenance !== 'external_unattributed',
      manifestProvenance:
        provenance === 'external_unattributed'
          ? 'provider_report_observed_corpus'
          : 'durable_local_intent_ack',
    });
    expect(value.identity.fingerprint).toBe(
      independentPublicFingerprint(value),
    );
    expect(value.authorization).toMatchObject({
      state: 'configured',
      stateChecked: true,
      mode: 'operator_policy',
      period: {
        id: 'utc-day:2026-10-21',
        startMs: Date.parse('2026-10-21T00:00:00Z'),
        endMs: Date.parse('2026-10-22T00:00:00Z'),
      },
    });
    expect(planRetryToolResult(value).structuredContent).toEqual(value);
  }
});

test('P2-03 visible source, partition, body, quote, authorization and comparison contradictions fail closed', () => {
  const value = publicReadyFixture().value;
  const mutations: readonly (readonly [
    readonly (string | number)[],
    unknown,
  ])[] = [
    [['searchEngine'], 'yandex'],
    [['source', 'reference', 0], 'yandex/indexer'],
    [['source', 'reference', 1], 'different'],
    [['source', 'provenance'], 'external_unattributed'],
    [['source', 'originalManifestKnown'], false],
    [['source', 'manifestProvenance'], 'provider_report_observed_corpus'],
    [['source', 'manifestDigest'], 'b'.repeat(64)],
    [['source', 'reference', 1], 'x'.repeat(4097)],
    [['eligibleUrls'], [B, A]],
    [['eligibleUrls'], [A, A]],
    [['eligibleUrls'], ['https://EXAMPLE.test/a?A=2', B]],
    [['eligibleUrls'], []],
    [
      ['excluded'],
      [{ url: A, reasons: ['LocalUnresolvedHold'], references: [] }],
    ],
    [['counts', 'eligible'], 1],
    [['counts', 'excluded'], 1],
    [['counts', 'unindexed'], 3],
    [['counts', 'unknown'], 1],
    [['counts', 'indexed'], 10_000],
    [['counts', 'indexed'], -1],
    [['request', 'family'], 'yandex/indexer'],
    [['request', 'providerRoute'], '/v2/task/yandex/indexer/create'],
    [['request', 'providerBodyBytes'], value.request.providerBodyBytes + 1],
    [['request', 'urlCount'], 1],
    [['request', 'payloadDigest'], 'c'.repeat(64)],
    [['quote', 'version'], 'other'],
    [['quote', 'fingerprint'], 'd'.repeat(64)],
    [['quote', 'basis'], 'wallet'],
    [['quote', 'providerEnforced'], true],
    [['quote', 'maximumExposure', 'tokens'], 199],
    [['quote', 'maximumExposure', 'indexer'], 1],
    [['quote', 'maximumExposure', 'checker'], 1],
    [['authorization', 'state'], 'unconfigured'],
    [['authorization', 'stateChecked'], false],
    [['authorization', 'mode'], undefined],
    [['authorization', 'policyRevision'], undefined],
    [['authorization', 'budgetScope'], undefined],
    [['authorization', 'caps', 'tokens'], 199],
    [['authorization', 'policyDigest'], 'e'.repeat(64)],
    [['authorization', 'fingerprint'], 'f'.repeat(64)],
    [['authorization', 'period', 'id'], 'utc-day:2026-02-30'],
    [
      ['authorization', 'period', 'startMs'],
      Date.parse('2026-10-21T01:00:00Z'),
    ],
    [['identity', 'status'], 'ready'],
    [['identity', 'preimage', 'parent', 'taskId'], 'different'],
    [['identity', 'preimage', 'originalManifestKnown'], false],
    [['identity', 'preimage', 'sourceManifestDigest'], '1'.repeat(64)],
    [['identity', 'preimage', 'policyDigest'], '2'.repeat(64)],
    [['identity', 'preimage', 'authorizationFingerprint'], '3'.repeat(64)],
    [['identity', 'preimage', 'payloadDigest'], '4'.repeat(64)],
    [['identity', 'preimage', 'quoteFingerprint'], '5'.repeat(64)],
    [['identity', 'preimage', 'quoteVersion'], 'other'],
    [['identity', 'preimage', 'period', 'id'], 'utc-day:2026-10-22'],
    [['identity', 'preimage', 'urlCount'], 1],
    [['identity', 'preimage', 'providerBodyBytes'], 1],
    [['identity', 'preimage', 'reservation', 'tokens'], 201],
    [['identity', 'preimage', 'partitionDigest'], '6'.repeat(64)],
    [['identity', 'preimage', 'revision'], '7'.repeat(64)],
    [['identity', 'preimage', 'safetyEvidenceDigests'], []],
    [['identity', 'fingerprint'], '8'.repeat(64)],
  ];
  for (const [path, replacement] of mutations) {
    const changed = changedResult(value, path, replacement);
    expect(
      planRetryResultSchema.safeParse(changed).success,
      path.join('.'),
    ).toBe(false);
    expectInternalResult(changed);
  }
  const incoherent = changedResult(
    value,
    ['identity', 'preimage', 'parent', 'taskId'],
    'fabricated',
  );
  incoherent.identity.fingerprint = computeRetryPlanFingerprint(
    incoherent.identity.preimage,
  );
  expectInternalResult(incoherent);
});

test('P2-03 exclusions retain exact canonical reasons/references and permit reference-free local checker holds', () => {
  const localOnly = publicReadyFixture({ exclusions: 'local' }).value;
  expect(localOnly.excluded).toEqual([
    { url: B, reasons: ['LocalUnresolvedHold'], references: [] },
  ]);
  expect(planRetryToolResult(localOnly).isError).toBe(false);
  const active = publicReadyFixture({ exclusions: 'active' }).value;
  expect(active.excluded).toEqual([
    {
      url: B,
      reasons: ['ActiveIndexing', 'LocalUnresolvedHold'],
      references: [
        ['google/indexer', 'active-é'],
        ['yandex/indexer', 'active-é'],
      ],
    },
  ]);
  for (const [path, replacement] of [
    [['excluded'], [active.excluded[0]!, active.excluded[0]!]],
    [
      ['excluded', 0, 'reasons'],
      ['LocalUnresolvedHold', 'ActiveIndexing'],
    ],
    [
      ['excluded', 0, 'reasons'],
      ['ActiveIndexing', 'ActiveIndexing'],
    ],
    [['excluded', 0, 'reasons'], []],
    [['excluded', 0, 'reasons'], ['Unknown']],
    [
      ['excluded', 0, 'references'],
      [...active.excluded[0]!.references].reverse(),
    ],
    [
      ['excluded', 0, 'references'],
      [active.excluded[0]!.references[0]!, active.excluded[0]!.references[0]!],
    ],
    [['excluded', 0, 'references'], []],
    [['excluded', 0, 'references', 0, 0], 'google/checker'],
  ] as const)
    expectInternalResult(changedResult(active, path, replacement));
});

test('P2-03 self-consistent changed opaque commitments remain pure comparison data without proof', () => {
  const value = structuredClone(publicReadyFixture().value);
  value.identity.preimage.safetyEvidenceDigests = ['9'.repeat(64)];
  value.identity.preimage.partitionDigest = '0'.repeat(64);
  value.identity.fingerprint = independentPublicFingerprint(value);
  expect(planRetryToolResult(value).structuredContent).toEqual(value);
  expect(value).not.toHaveProperty('proof');
  expect(value.identity).not.toHaveProperty('ledgerId');
});

test('P2-04 exact N versus N-1 counts the complete UTF8 escaped and duplicated envelope', () => {
  const { value } = publicReadyFixture({
    urls: ['https://example.test/é"\\?A=1', 'https://example.test/é/"\\?A=1'],
  });
  const expected = {
    isError: false,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
  const n = Buffer.from(JSON.stringify(expected), 'utf8').length;
  expect(n).toBeGreaterThan(
    2 * Buffer.from(JSON.stringify(value), 'utf8').length,
  );
  expect(n).toBeGreaterThan(JSON.stringify(expected).length);
  const exact = planRetryToolResult(value, { maxBytes: n });
  expect(exact).toEqual(expected);
  expect(envelopeBytes(exact)).toBe(n);
  const overflow = planRetryToolResult(value, { maxBytes: n - 1 });
  expect(overflow.structuredContent).toMatchObject({
    status: 'error',
    error: { code: 'ResourceLimitExceeded' },
  });
  expect(overflow.isError).toBe(true);
  expect(envelopeBytes(overflow)).toBeLessThanOrEqual(n - 1);
  expect(overflow.structuredContent).not.toHaveProperty('eligibleUrls');
});

test('P2-04 legal create body and valid blocked missing URLs cross the real production envelope ceiling without truncation', () => {
  const urls = Array.from(
    { length: 250 },
    (_, i) => 'https://example.test/' + i + '/' + 'é"\\'.repeat(600),
  );
  const { value, proposal } = publicReadyFixture({
    urls,
    provenance: 'external_unattributed',
  });
  expect(Buffer.from(proposal.request.body, 'utf8').length).toBeLessThanOrEqual(
    2_097_152,
  );
  const blocked = retryPlanResultFromView('google', {
    status: 'blocked',
    blockers: ['SourceReportIncomplete'],
    unknownUrlCount: urls.length,
    knownMissingLocalUrls: urls,
  });
  expect(blocked.status).toBe('blocked');
  for (const payload of [value, blocked]) {
    expect(planRetryResultSchema.safeParse(payload).success).toBe(true);
    const expected = {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
    expect(envelopeBytes(expected)).toBeGreaterThan(2_097_152);
    const result = planRetryToolResult(payload);
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'ResourceLimitExceeded' },
    });
    expect(Object.keys(result.structuredContent).sort()).toEqual([
      'error',
      'status',
    ]);
    expect(
      planRetryResultSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
    expect(envelopeBytes(result)).toBeLessThanOrEqual(2_097_152);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
  }
});

test('P2-04 admitted output is copied and deeply immutable; trusted lower-only limits keep both fallbacks bounded', () => {
  const value = structuredClone(publicReadyFixture().value);
  const admitted = planRetryToolResult(value);
  const before = JSON.stringify(admitted);
  value.eligibleUrls[0] = 'https://example.test/changed';
  value.authorization.caps.tokens = 0;
  expect(JSON.stringify(admitted)).toBe(before);
  const frozen = (value: unknown) => {
    if (value && typeof value === 'object') {
      expect(Object.isFrozen(value)).toBe(true);
      for (const item of Object.values(value)) frozen(item);
    }
  };
  frozen(admitted);
  expect(() =>
    admitted.content.push({ type: 'text', text: 'changed' }),
  ).toThrow();
  expect(() => {
    admitted.structuredContent.status = 'error';
  }).toThrow();
  const internal = expectInternalResult({ status: 'invalid' });
  const resource = planRetryToolResult(
    retryPlanResultFromView('google', {
      status: 'error',
      code: 'ResourceLimitExceeded',
    }),
  );
  const minimum = Math.max(envelopeBytes(internal), envelopeBytes(resource));
  for (const payload of [
    internal.structuredContent,
    resource.structuredContent,
  ]) {
    const result = planRetryToolResult(payload, { maxBytes: minimum });
    expect(result.structuredContent).toEqual(payload);
    expect(envelopeBytes(result)).toBeLessThanOrEqual(minimum);
    frozen(result);
  }
  for (const maxBytes of [minimum - 1, 2_097_153, 0, -1, 1.5, NaN, Infinity])
    expect(() =>
      planRetryToolResult(internal.structuredContent, { maxBytes }),
    ).toThrow(RangeError);
  expectInternalResult(value);
});
