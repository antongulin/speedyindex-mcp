import { createHash } from 'node:crypto';
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
import type { AvailableRetrySnapshot } from '../src/retry-ledger-snapshot';
import {
  computeRetryPlanFingerprint,
  type RetryPlanningState,
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
