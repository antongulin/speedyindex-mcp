import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  lowerRetryHistoryResultByteLimit,
  parseRetryHistoryInput,
  RetryHistoryError,
  retryHistoryBlocked,
  retryHistoryError,
  retryHistoryFromSnapshot,
  retryHistoryResultSchema,
  retryHistoryToolResult,
  type RetryHistoryResult,
} from '../src/get-retry-history';
import type { AvailableRetrySnapshot } from '../src/retry-ledger-snapshot';

type Child = AvailableRetrySnapshot['retryChildren'][number];
type History = AvailableRetrySnapshot['unresolvedHistory'][number];
type Manifest = AvailableRetrySnapshot['acceptedManifests'][number];
type Ok = Extract<RetryHistoryResult, { status: 'ok' }>;
type Entry = Ok['entries'][number];
const states = [
  'prepared',
  'dispatching',
  'accepted',
  'rejected',
  'unknown',
  'cancelled',
] as const;
const revision = 'a'.repeat(64);
const sourceDigest = 'b'.repeat(64);
const planDigest = 'c'.repeat(64);
const ledger = 'private-ledger-SENTINEL';
const binding = 'private-key-binding-SENTINEL';
const parentId = ' Parent / exact Ω ';

// Independent preimages: concatenate the literal domain and complete tuple bytes once.
function ref(
  requestId: string,
  ledgerId = ledger,
  keyBinding = binding,
): string {
  return createHash('sha256')
    .update(
      Buffer.from(
        'speedyindex-retry-history-attempt-v1\0' +
          JSON.stringify([ledgerId, keyBinding, requestId]),
        'utf8',
      ),
    )
    .digest('hex');
}
function query(
  engine: string | null = null,
  parent: string | null = null,
  state: string | null = null,
  limit = 25,
): string {
  return createHash('sha256')
    .update(
      Buffer.from(
        'speedyindex-retry-history-query-v1\0' +
          JSON.stringify([engine, parent, state, limit]),
        'utf8',
      ),
    )
    .digest('hex');
}
function cursor(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ v: 1, revision, query: query(), offset: 1, ...overrides }),
    'utf8',
  ).toString('base64url');
}
function child(
  requestId: string,
  state: Child['state'] = 'prepared',
  overrides: Partial<Child> = {},
): Child {
  return {
    requestId,
    taskFamily: 'google/indexer',
    parentFamily: 'google/indexer',
    parentTaskId: parentId,
    sourceManifestDigest: sourceDigest,
    planFingerprint: planDigest,
    state,
    stateVersion:
      state === 'prepared'
        ? '0'
        : state === 'dispatching' || state === 'cancelled'
          ? '1'
          : '2',
    providerTaskId:
      state === 'accepted' ? ' Provider ' + requestId + ' Ω ' : null,
    ...overrides,
  };
}
function detail(row: Child, overrides: Partial<History> = {}): History {
  const kinds: readonly Child['state'][] =
    row.state === 'prepared'
      ? ['prepared']
      : row.state === 'cancelled'
        ? ['prepared', 'cancelled']
        : row.state === 'dispatching'
          ? ['prepared', 'dispatching']
          : ['prepared', 'dispatching', row.state];
  return {
    requestId: row.requestId,
    taskFamily: row.taskFamily,
    state: row.state,
    stateVersion: row.stateVersion,
    budgetScope: 'PRIVATE-SCOPE',
    periodId: 'PRIVATE-PERIOD',
    periodStartMs: '-100',
    policyRevision: 'PRIVATE-POLICY-LABEL',
    policyDigest: 'd'.repeat(64),
    providerRoute: '/private-route',
    payloadDigest: 'e'.repeat(64),
    quoteVersion: 'PRIVATE-QUOTE-VERSION',
    quoteFingerprint: 'f'.repeat(64),
    reservation: {
      tokens: '9223372036854775807',
      indexer: '9007199254740993',
      checker: '0',
    },
    createdAtMs: '-9223372036854775808',
    providerTaskId: row.providerTaskId,
    providerType: row.state === 'accepted' ? row.taskFamily : null,
    context: {
      originKind: 'retry',
      parentFamily: row.parentFamily,
      parentTaskId: row.parentTaskId,
      sourceManifestDigest: row.sourceManifestDigest,
      planFingerprint: row.planFingerprint,
    },
    urls: [{ ordinal: '0', url: 'https://private-url-SENTINEL.test/body' }],
    events: kinds.map((kind, index) => ({
      eventId: String(index + 1),
      stateVersion: String(index),
      kind,
      occurredAtMs:
        index === 0
          ? '-9223372036854775808'
          : index === 1
            ? '9223372036854775807'
            : '-9',
      providerTaskId: kind === 'accepted' ? row.providerTaskId : null,
      providerType: kind === 'accepted' ? row.taskFamily : null,
    })),
    ...overrides,
  };
}
function manifest(id: string, overrides: Partial<Manifest> = {}): Manifest {
  return {
    taskFamily: 'google/indexer',
    providerTaskId: id,
    requestId: 'local-source-' + id,
    originKind: 'standalone',
    payloadDigest: 'd'.repeat(64),
    manifestDigest: sourceDigest,
    submittedUrls: ['https://private-manifest-SENTINEL.test/A'],
    provenance: 'durable_local_intent_ack',
    ...overrides,
  };
}
function snapshot(
  rows: readonly Child[] = [],
  overrides: Partial<AvailableRetrySnapshot> = {},
): AvailableRetrySnapshot {
  const unresolved = rows
    .filter((row) => ['prepared', 'dispatching', 'unknown'].includes(row.state))
    .map((row) => detail(row));
  return {
    availability: 'available',
    schemaVersion: 2,
    ledgerId: ledger,
    revision,
    capturedAt: '2026-10-23T17:20:25.000Z',
    coverage: {
      localStore: true,
      keyBindingOnly: true,
      allBudgetScopes: true,
      allFamilies: true,
      globalProviderAccount: false,
      ancestry: 'cooperating_v2_retry_contexts_only',
    },
    holds: unresolved.map((row) => ({
      requestId: row.requestId,
      taskFamily: row.taskFamily,
      state: row.state,
      stateVersion: row.stateVersion,
      urls: row.urls,
    })),
    retryChildren: rows,
    unresolvedHistory: unresolved,
    acceptedManifests: rows
      .filter((row) => row.state === 'accepted')
      .map((row) => {
        if (row.providerTaskId === null)
          throw new Error('Invalid accepted fixture.');
        return manifest(row.providerTaskId, {
          requestId: row.requestId,
          taskFamily: row.taskFamily,
          originKind: 'retry',
        });
      }),
    attributionGaps: [],
    ambiguousProviderRefs: [],
    ...overrides,
  };
}
function ok(value: RetryHistoryResult): Ok {
  expect(value.status).toBe('ok');
  if (value.status !== 'ok')
    throw new Error('Expected history success: ' + JSON.stringify(value));
  return value;
}
function errorCode(
  value: RetryHistoryResult,
  code: Extract<RetryHistoryResult, { status: 'error' }>['error']['code'],
): void {
  expect(value.status).toBe('error');
  if (value.status !== 'error') throw new Error('Expected history error.');
  expect(value.error.code).toBe(code);
}
function entryFor(value: Ok, requestId: string): Entry {
  const found = value.entries.find(
    (entry) => entry.attemptRef === ref(requestId),
  );
  if (found === undefined) throw new Error('Missing expected history entry.');
  return found;
}
function invalidInput(value: unknown): void {
  try {
    parseRetryHistoryInput(value);
  } catch (error) {
    expect(error).toBeInstanceOf(RetryHistoryError);
    if (!(error instanceof RetryHistoryError)) throw error;
    expect(error.code).toBe('InvalidInput');
    expect(error.message).toBe('Invalid retry-history input.');
    return;
  }
  throw new Error('Unexpected accepted input.');
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const [key, nested] of Object.entries(value)) {
      expect(Reflect.set(value, key, 'MUTATION-SENTINEL')).toBe(false);
      frozen(nested);
    }
  }
}
function freezeFixture<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeFixture(nested);
    Object.freeze(value);
  }
  return value;
}
function expectedEntry(requestId: string, state: Child['state']): Entry {
  const hasDetail =
    state === 'prepared' || state === 'dispatching' || state === 'unknown';
  return {
    attemptRef: ref(requestId),
    family: 'google/indexer',
    state,
    stateVersion:
      state === 'prepared'
        ? 0
        : state === 'dispatching' || state === 'cancelled'
          ? 1
          : 2,
    providerTaskId:
      state === 'accepted' ? ' Provider ' + requestId + ' Ω ' : null,
    providerReferenceAmbiguous: false,
    source: {
      family: 'google/indexer',
      taskId: parentId,
      attribution: 'unattributed_manifest',
      originalAncestry: 'unknown',
      recordedAttempts: 6,
    },
    createdAtMs: hasDetail ? '-9223372036854775808' : null,
    latestStateAtMs:
      state === 'prepared'
        ? '-9223372036854775808'
        : state === 'dispatching'
          ? '9223372036854775807'
          : state === 'unknown'
            ? '-9'
            : null,
    reservation: hasDetail
      ? {
          tokens: '9223372036854775807',
          indexer: '9007199254740993',
          checker: '0',
        }
      : null,
    submittedUrlCount: hasDetail || state === 'accepted' ? 1 : null,
    unresolvedHold: hasDetail,
  };
}

test('GRH-01 selectors preserve exact IDs, both-engine omission and finite states/limits', () => {
  expect(parseRetryHistoryInput({})).toEqual({
    searchEngine: null,
    parentTaskId: null,
    state: null,
    limit: 25,
    cursor: null,
  });
  for (const searchEngine of ['google', 'yandex'] as const) {
    for (const state of states) {
      const parsed = parseRetryHistoryInput({
        searchEngine,
        parentTaskId: parentId,
        state,
        limit: 1,
      });
      expect(parsed).toEqual({
        searchEngine,
        parentTaskId: parentId,
        state,
        limit: 1,
        cursor: null,
      });
      frozen(parsed);
    }
  }
  const boundary = 'é'.repeat(2_048);
  expect(
    parseRetryHistoryInput({
      searchEngine: 'yandex',
      parentTaskId: boundary,
      limit: 25,
    }).parentTaskId,
  ).toBe(boundary);
});

test('GRH-01 rejects extra authority, wrong types, unsafe IDs and ambiguous parents without reflection', () => {
  const values: readonly unknown[] = [
    null,
    [],
    'input',
    3,
    undefined,
    { parentTaskId: parentId },
    { searchEngine: 'Google' },
    { state: 'completed' },
    ...[null, '25', 0, 26, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (limit) => ({ limit }),
    ),
    ...['', '  ', '\nID', 'ID\u007f', '\ud800', 'é'.repeat(2_049)].map(
      (parentTaskId) => ({ searchEngine: 'google', parentTaskId }),
    ),
    ...[
      'key',
      'path',
      'policy',
      'requestId',
      'proof',
      'refresh',
      'maxBytes',
      'byteLimit',
      'authorization',
      'ledgerId',
      'clock',
    ].map((key) => ({ [key]: 'PRIVATE-INPUT-SENTINEL' })),
    { cursor: null },
    { cursor: [] },
  ];
  for (const value of values) invalidInput(value);
});

test('GRH-01 cursors require closed canonical UTF8 JSON and unpadded bounded base64url', () => {
  expect(query()).toBe(
    'fe227671627c47d2db702d1779c685b1e167f2350fc546b6254883df0be74240',
  );
  const canonical = cursor();
  expect(parseRetryHistoryInput({ cursor: canonical }).cursor).toEqual({
    v: 1,
    revision,
    query: query(),
    offset: 1,
  });
  const json = JSON.stringify({ v: 1, revision, query: query(), offset: 1 });
  const invalid: readonly unknown[] = [
    '',
    canonical + '=',
    canonical + '\n',
    '+/',
    'a'.repeat(513),
    cursor({ v: 2 }),
    cursor({ extra: true }),
    cursor({ revision: 'A'.repeat(64) }),
    cursor({ query: null }),
    ...[0, -1, 2001, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((offset) =>
      cursor({ offset }),
    ),
    Buffer.from(' ' + json).toString('base64url'),
    Buffer.from(
      JSON.stringify({ revision, v: 1, query: query(), offset: 1 }),
    ).toString('base64url'),
    Buffer.from(json.replace('"offset":1', '"offset":1.0')).toString(
      'base64url',
    ),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(json),
    ]).toString('base64url'),
    Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString('base64url'),
    Buffer.from(json.replace('"v":1', '"v":1,"v":1')).toString('base64url'),
  ];
  for (const value of invalid) invalidInput({ cursor: value });
});

test('GRH-02 every state has independent exact entry semantics and intentionally unavailable terminal metadata', () => {
  const rows = states.map((state) => child('state-' + state, state));
  const value = ok(
    retryHistoryFromSnapshot(freezeFixture(snapshot(rows)), binding),
  );
  expect(value.entries).toEqual(
    states
      .map((state) => expectedEntry('state-' + state, state))
      .sort((a, b) => (a.attemptRef < b.attemptRef ? -1 : 1)),
  );
  expect(value.counts).toEqual({
    localRetryAttempts: 6,
    matchingRetryAttempts: 6,
    legacyUnattributedLocalRecords: 0,
    ambiguousLocalProviderReferences: 0,
  });
  expect(value.coverage).toEqual({
    scope: 'selected_key_local_v2',
    validated: 'all_local_families_scopes_policies_periods',
    returned: 'recorded_v2_retry_contexts_only',
    providerCoverage: 'unknown',
    originalAncestry: 'unknown',
    earlierDiscardedHistory: 'unknown',
    coverageInception: 'unknown',
  });
  expect(entryFor(value, 'state-unknown').latestStateAtMs).toBe('-9');
  expect(entryFor(value, 'state-accepted').latestStateAtMs).toBeNull();
  expect(entryFor(value, 'state-accepted').submittedUrlCount).toBe(1);
});

test('GRH-02 ambiguous accepted records retain exact detail and the provider ambiguity flag', () => {
  const row = child('accepted-ambiguous', 'accepted', {
    providerTaskId: ' Duplicate Provider Ω ',
  });
  const first = detail(row);
  const second: History = {
    ...first,
    requestId: 'standalone-duplicate',
    context: {
      originKind: 'standalone',
      parentFamily: null,
      parentTaskId: null,
      sourceManifestDigest: null,
      planFingerprint: null,
    },
  };
  const value = ok(
    retryHistoryFromSnapshot(
      snapshot([row], {
        acceptedManifests: [],
        ambiguousProviderRefs: [
          {
            taskFamily: 'google/indexer',
            providerTaskId: ' Duplicate Provider Ω ',
            requestIds: [row.requestId, second.requestId],
            records: [first, second],
          },
        ],
      }),
      binding,
    ),
  );
  expect(value.entries).toEqual([
    {
      ...expectedEntry('accepted-ambiguous', 'accepted'),
      providerTaskId: ' Duplicate Provider Ω ',
      providerReferenceAmbiguous: true,
      source: {
        ...expectedEntry('accepted-ambiguous', 'accepted').source,
        recordedAttempts: 1,
      },
      createdAtMs: '-9223372036854775808',
      latestStateAtMs: '-9',
      reservation: {
        tokens: '9223372036854775807',
        indexer: '9007199254740993',
        checker: '0',
      },
      submittedUrlCount: 1,
    },
  ]);
  expect(value.counts.ambiguousLocalProviderReferences).toBe(1);
});

test('GRH-02 rejects contradictory joins and incompatible IDs in the complete projection before a disjoint filter', () => {
  const row = child('stored-bad', 'accepted', { providerTaskId: 'bad\nID' });
  const other = child('good', 'prepared', {
    taskFamily: 'yandex/indexer',
    parentFamily: 'yandex/indexer',
  });
  errorCode(
    retryHistoryFromSnapshot(snapshot([row, other]), binding, {
      searchEngine: 'yandex',
      limit: 1,
    }),
    'StateUnavailable',
  );
  const safe = child('safe', 'accepted');
  const base = snapshot([safe]);
  for (const changed of [
    snapshot([safe, safe]),
    snapshot([safe], { acceptedManifests: [] }),
    snapshot([safe], {
      acceptedManifests: base.acceptedManifests.map((m): Manifest => ({
        ...m,
        taskFamily: 'yandex/indexer',
      })),
    }),
    snapshot([child('wrong-version', 'prepared', { stateVersion: '2' })]),
    snapshot([
      child('wrong-family', 'prepared', { parentFamily: 'yandex/indexer' }),
    ]),
    snapshot([child('unknown-missing', 'unknown')], { unresolvedHistory: [] }),
    snapshot([safe], {
      acceptedManifests: [
        ...base.acceptedManifests,
        manifest('UNRELATED\u007fID'),
      ],
    }),
    snapshot([
      child('bad-parent', 'cancelled', { parentTaskId: 'é'.repeat(2_049) }),
    ]),
  ])
    errorCode(
      retryHistoryFromSnapshot(changed, binding, { state: 'rejected' }),
      'StateUnavailable',
    );
  const pending = child('conflict');
  errorCode(
    retryHistoryFromSnapshot(
      snapshot([pending], {
        unresolvedHistory: [
          detail(pending, {
            context: {
              originKind: 'retry',
              parentFamily: 'google/indexer',
              parentTaskId: 'other',
              sourceManifestDigest: sourceDigest,
              planFingerprint: planDigest,
            },
          }),
        ],
      }),
      binding,
    ),
    'StateUnavailable',
  );
});

test('GRH-02 stored provider and parent IDs preserve the inclusive 4096-byte Unicode boundary exactly', () => {
  const id = 'é'.repeat(2_048);
  const row = child('exact-boundary', 'accepted', {
    providerTaskId: id,
    parentTaskId: id + 'x',
  });
  errorCode(
    retryHistoryFromSnapshot(snapshot([row]), binding),
    'StateUnavailable',
  );
  const safeParent = 'Ω'.repeat(2_048);
  const safe = { ...row, parentTaskId: safeParent };
  const value = ok(retryHistoryFromSnapshot(snapshot([safe]), binding));
  expect(value.entries[0]?.providerTaskId).toBe(id);
  expect(value.entries[0]?.source.taskId).toBe(safeParent);
});

test('GRH-03 private-domain refs are stable across revision and change across ledger/key without exposing preimages', () => {
  const privateId =
    'raw-request-SENTINEL-https://body.test/?secret=DO-NOT-ENUMERATE';
  expect(ref(privateId)).toBe(
    '0ec356ece2a2a08325d6c463cb17d8f8b1febf3ba0acee4cdf3efcef10b62f13',
  );
  const row = child(privateId, 'prepared');
  const s = snapshot([row], { acceptedManifests: [manifest(parentId)] });
  const value = ok(retryHistoryFromSnapshot(s, binding));
  expect(value.entries.map((entry) => entry.attemptRef)).toEqual([
    ref(privateId),
  ]);
  expect(
    ok(retryHistoryFromSnapshot({ ...s, revision: 'd'.repeat(64) }, binding))
      .entries[0]?.attemptRef,
  ).toBe(ref(privateId));
  expect(
    ok(
      retryHistoryFromSnapshot(
        { ...s, ledgerId: 'different-private-ledger' },
        binding,
      ),
    ).entries[0]?.attemptRef,
  ).toBe(ref(privateId, 'different-private-ledger'));
  expect(
    ok(retryHistoryFromSnapshot(s, 'different-key')).entries[0]?.attemptRef,
  ).toBe(ref(privateId, ledger, 'different-key'));
  const serialized = JSON.stringify(retryHistoryToolResult(value));
  for (const secret of [
    privateId,
    ledger,
    binding,
    'PRIVATE-SCOPE',
    'PRIVATE-PERIOD',
    'PRIVATE-POLICY-LABEL',
    'PRIVATE-QUOTE-VERSION',
    'private-url-SENTINEL',
    'private-manifest-SENTINEL',
    sourceDigest,
    planDigest,
    'd'.repeat(64),
    'f'.repeat(64),
  ])
    expect(serialized).not.toContain(secret);
  expect(value.entries[0]?.source.taskId).toBe(parentId);
  expect(Object.keys(value.entries[0] ?? {})).toEqual([
    'attemptRef',
    'family',
    'state',
    'stateVersion',
    'providerTaskId',
    'providerReferenceAmbiguous',
    'source',
    'createdAtMs',
    'latestStateAtMs',
    'reservation',
    'submittedUrlCount',
    'unresolvedHold',
  ]);
  const paged = ok(
    retryHistoryFromSnapshot(
      snapshot([row, child('second-private-request')]),
      binding,
      { limit: 1 },
    ),
  );
  if (paged.page.nextCursor === null)
    throw new Error('Expected private cursor fixture.');
  const decoded = Buffer.from(paged.page.nextCursor, 'base64url').toString(
    'utf8',
  );
  for (const secret of [
    privateId,
    ledger,
    binding,
    parentId,
    'second-private-request',
  ])
    expect(decoded).not.toContain(secret);
});

test('GRH-03 every result/envelope branch is a deep frozen copy independent of mutable source objects', () => {
  const row = child('copied');
  const reservation = { tokens: '17', indexer: '19', checker: '23' };
  const original = {
    ...snapshot([row]),
    unresolvedHistory: [detail(row, { reservation })],
  };
  const projected = ok(retryHistoryFromSnapshot(original, binding));
  reservation.tokens = '999';
  original.capturedAt = '2027-01-01T00:00:00.000Z';
  expect(projected.entries[0]?.reservation).toEqual({
    tokens: '17',
    indexer: '19',
    checker: '23',
  });
  expect(projected.snapshot.capturedAt).toBe('2026-10-23T17:20:25.000Z');
  const mutable = { ...projected, counts: { ...projected.counts } };
  const copied = retryHistoryToolResult(mutable);
  mutable.counts.localRetryAttempts = 99;
  expect(copied.structuredContent).toEqual(projected);
  for (const value of [
    projected,
    copied,
    retryHistoryToolResult(retryHistoryError('StateUnavailable')),
    retryHistoryToolResult(retryHistoryBlocked('StateMissing')),
  ])
    frozen(value);
});

test('GRH-04 lifetime exact-parent counts precede state/engine filters and legacy records remain separate', () => {
  const rows = [
    ...states.map((state) => child('all-' + state, state)),
    child('other-case', 'cancelled', { parentTaskId: parentId.toLowerCase() }),
    child('other-space', 'rejected', { parentTaskId: parentId.trim() }),
    child('other-engine', 'cancelled', {
      taskFamily: 'yandex/indexer',
      parentFamily: 'yandex/indexer',
    }),
  ];
  const initial = snapshot(rows);
  const s = {
    ...initial,
    unresolvedHistory: initial.unresolvedHistory.map((row, index) => ({
      ...row,
      budgetScope: 'PRIVATE-SCOPE-' + index,
      policyRevision: 'PRIVATE-POLICY-' + index,
      periodId: 'PRIVATE-PERIOD-' + index,
    })),
    attributionGaps: [
      {
        requestId: 'legacy-not-a-retry',
        taskFamily: 'backlink/checker' as const,
        reason: 'legacy_unattributed' as const,
      },
    ],
  };
  const result = ok(
    retryHistoryFromSnapshot(s, binding, {
      searchEngine: 'google',
      parentTaskId: parentId,
      state: 'accepted',
    }),
  );
  expect(result.counts).toEqual({
    localRetryAttempts: 9,
    matchingRetryAttempts: 1,
    legacyUnattributedLocalRecords: 1,
    ambiguousLocalProviderReferences: 0,
  });
  expect(result.entries[0]?.source.recordedAttempts).toBe(6);
  const yandex = ok(
    retryHistoryFromSnapshot(s, binding, { searchEngine: 'yandex' }),
  );
  expect(yandex.entries[0]?.source.recordedAttempts).toBe(1);
  expect(yandex.counts.localRetryAttempts).toBe(9);
});

test('GRH-04 exact unique parent manifests retain their stated local origin without inferring original ancestry', () => {
  for (const [originKind, attribution] of [
    ['standalone', 'local_standalone_manifest'],
    ['legacy_unattributed', 'local_legacy_manifest'],
    ['retry', 'local_retry_manifest'],
  ] as const) {
    const rows = [child('descendant')];
    const parent = child('recorded-parent', 'accepted', {
      providerTaskId: parentId,
      parentTaskId: 'older-exact-parent',
    });
    if (originKind === 'retry') rows.push(parent);
    const parentManifest = manifest(parentId, {
      originKind,
      requestId:
        originKind === 'retry' ? parent.requestId : 'independent-local-parent',
    });
    const result = ok(
      retryHistoryFromSnapshot(
        snapshot(rows, {
          acceptedManifests: [parentManifest],
          attributionGaps:
            originKind === 'legacy_unattributed'
              ? [
                  {
                    requestId: parentManifest.requestId,
                    taskFamily: parentManifest.taskFamily,
                    reason: 'legacy_unattributed',
                  },
                ]
              : [],
        }),
        binding,
      ),
    );
    expect(entryFor(result, 'descendant').source).toEqual({
      family: 'google/indexer',
      taskId: parentId,
      attribution,
      originalAncestry: 'unknown',
      recordedAttempts: 1,
    });
  }
});

test('GRH-04 digest-only, mismatched, case/space and other-engine parents never invent attribution', () => {
  const row = child('unattributed');
  for (const parents of [
    [],
    [manifest('different-ID')],
    [manifest(parentId, { manifestDigest: 'd'.repeat(64) })],
    [manifest(parentId.toLowerCase())],
    [manifest(parentId.trim())],
    [manifest(parentId, { taskFamily: 'yandex/indexer' })],
  ]) {
    const value = ok(
      retryHistoryFromSnapshot(
        snapshot([row], { acceptedManifests: parents }),
        binding,
      ),
    );
    expect(value.entries[0]?.source.attribution).toBe('unattributed_manifest');
    expect(value.entries[0]?.source.originalAncestry).toBe('unknown');
  }
});

test('GRH-04 ambiguous local source reference wins over a matching saved digest and contradictory groups fail', () => {
  const row = child('descendant');
  const parent = child('local-parent', 'accepted', {
    providerTaskId: parentId,
    parentTaskId: 'older-parent',
  });
  const first: History = {
    ...detail(parent),
    context: {
      originKind: 'standalone',
      parentFamily: null,
      parentTaskId: null,
      sourceManifestDigest: null,
      planFingerprint: null,
    },
  };
  const second = { ...first, requestId: 'second-parent' };
  const group = {
    taskFamily: 'google/indexer' as const,
    providerTaskId: parentId,
    requestIds: [first.requestId, second.requestId],
    records: [first, second],
  };
  const s = snapshot([row], { ambiguousProviderRefs: [group] });
  expect(
    ok(retryHistoryFromSnapshot(s, binding)).entries[0]?.source.attribution,
  ).toBe('ambiguous_local_reference');
  errorCode(
    retryHistoryFromSnapshot(
      { ...s, acceptedManifests: [manifest(parentId)] },
      binding,
    ),
    'StateUnavailable',
  );
  errorCode(
    retryHistoryFromSnapshot(
      { ...s, ambiguousProviderRefs: [{ ...group, records: [first, first] }] },
      binding,
    ),
    'StateUnavailable',
  );
});

test('GRH-05 a reverse-insertion multi-page walk matches the independent hash order exactly once', () => {
  const rows = Array.from({ length: 61 }, (_, index) => child('page-' + index));
  const s = snapshot(rows);
  const expected = rows.map((row) => ref(row.requestId)).sort();
  const found: string[] = [];
  const sizes: number[] = [];
  let next: string | null = null;
  do {
    const selectors: { cursor?: string } =
      next === null ? {} : { cursor: next };
    const page = ok(retryHistoryFromSnapshot(s, binding, selectors));
    const reversed = ok(
      retryHistoryFromSnapshot(
        snapshot([...rows].reverse()),
        binding,
        selectors,
      ),
    );
    expect(reversed).toEqual(page);
    found.push(...page.entries.map((entry) => entry.attemptRef));
    sizes.push(page.page.returnedCount);
    next = page.page.nextCursor;
    if (next !== null) {
      const payload: unknown = JSON.parse(
        Buffer.from(next, 'base64url').toString('utf8'),
      );
      expect(payload).toEqual({
        v: 1,
        revision,
        query: query(),
        offset: found.length,
      });
      expect(JSON.stringify(payload)).not.toContain(parentId);
      expect(JSON.stringify(payload)).not.toContain(ledger);
    }
  } while (next !== null);
  expect(sizes).toEqual([25, 25, 11]);
  expect(found).toEqual(expected);
  expect(new Set(found).size).toBe(61);
});

test('GRH-05 cursor query mismatch precedes revision mismatch, which precedes offset semantics', () => {
  const s = snapshot(
    Array.from({ length: 7 }, (_, index) => child('offset-' + index)),
  );
  const selectors = {
    searchEngine: 'google',
    parentTaskId: parentId,
    state: 'prepared',
    limit: 2,
  };
  const first = ok(retryHistoryFromSnapshot(s, binding, selectors));
  const next = first.page.nextCursor;
  if (next === null) throw new Error('Expected continuation fixture.');
  const nextPage = ok(
    retryHistoryFromSnapshot(s, binding, { ...selectors, cursor: next }),
  );
  const recaptured = ok(
    retryHistoryFromSnapshot(
      { ...s, capturedAt: '2026-10-24T00:00:00.000Z' },
      binding,
      { ...selectors, cursor: next },
    ),
  );
  expect(recaptured).toEqual({
    ...nextPage,
    snapshot: { revision, capturedAt: '2026-10-24T00:00:00.000Z' },
  });
  for (const changed of [
    { searchEngine: 'yandex' },
    { parentTaskId: 'different-parent' },
    { state: 'accepted' },
    { limit: 3 },
  ]) {
    errorCode(
      retryHistoryFromSnapshot({ ...s, revision: 'd'.repeat(64) }, binding, {
        ...selectors,
        ...changed,
        cursor: next,
      }),
      'CursorMismatch',
    );
  }
  const q = query('google', parentId, 'prepared', 2);
  errorCode(
    retryHistoryFromSnapshot({ ...s, revision: 'd'.repeat(64) }, binding, {
      ...selectors,
      cursor: cursor({ query: q, offset: 2_000 }),
    }),
    'SnapshotChanged',
  );
  errorCode(
    retryHistoryFromSnapshot(s, binding, {
      ...selectors,
      cursor: cursor({ query: q, offset: 7 }),
    }),
    'CursorMismatch',
  );
  const edited = ok(
    retryHistoryFromSnapshot(s, binding, {
      ...selectors,
      cursor: cursor({ query: q, offset: 3 }),
    }),
  );
  const ordered = s.retryChildren.map((row) => ref(row.requestId)).sort();
  expect(edited.entries.map((entry) => entry.attemptRef)).toEqual(
    ordered.slice(3, 5),
  );
});

test('GRH-05 empty matching histories succeed and store/key revision changes never silently recompute a page', () => {
  const empty = ok(
    retryHistoryFromSnapshot(snapshot([child('existing')]), binding, {
      state: 'rejected',
    }),
  );
  expect(empty.entries).toEqual([]);
  expect(empty.page).toEqual({ limit: 25, returnedCount: 0, nextCursor: null });
  expect(empty.counts.matchingRetryAttempts).toBe(0);
  const q = query(null, null, null, 1);
  const s = snapshot([child('one'), child('two')]);
  errorCode(
    retryHistoryFromSnapshot(
      { ...s, revision: 'd'.repeat(64), ledgerId: 'replaced-store' },
      'replaced-key',
      { limit: 1, cursor: cursor({ query: q }) },
    ),
    'SnapshotChanged',
  );
  errorCode(
    retryHistoryFromSnapshot(snapshot(), binding, { cursor: cursor() }),
    'CursorMismatch',
  );
});

function literalOk(): Ok {
  const id = 'é"\\'.repeat(900);
  const entries: Entry[] = Array.from({ length: 25 }, (_, index) => ({
    attemptRef: (index + 1).toString(16).padStart(64, '0'),
    family: 'google/indexer',
    state: 'accepted',
    stateVersion: 2,
    providerTaskId: id + index,
    providerReferenceAmbiguous: false,
    source: {
      family: 'google/indexer',
      taskId: id,
      attribution: 'local_standalone_manifest',
      originalAncestry: 'unknown',
      recordedAttempts: 25,
    },
    createdAtMs: null,
    latestStateAtMs: null,
    reservation: null,
    submittedUrlCount: 1,
    unresolvedHold: false,
  }));
  return {
    status: 'ok',
    snapshot: { revision, capturedAt: '2026-10-23T17:20:25.000Z' },
    coverage: {
      scope: 'selected_key_local_v2',
      validated: 'all_local_families_scopes_policies_periods',
      returned: 'recorded_v2_retry_contexts_only',
      providerCoverage: 'unknown',
      originalAncestry: 'unknown',
      earlierDiscardedHistory: 'unknown',
      coverageInception: 'unknown',
    },
    counts: {
      localRetryAttempts: 25,
      matchingRetryAttempts: 25,
      legacyUnattributedLocalRecords: 0,
      ambiguousLocalProviderReferences: 0,
    },
    page: { limit: 25, returnedCount: 25, nextCursor: null },
    entries,
  };
}

test('GRH-06 inclusive actual E/E-1 bound measures the whole escaped and duplicated envelope without truncation', () => {
  const value = literalOk();
  const expected = {
    isError: false,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength;
  expect(bytes).toBeGreaterThan(
    new TextEncoder().encode(JSON.stringify(value)).byteLength * 2,
  );
  expect(bytes).toBeLessThan(2_097_152);
  const exact = retryHistoryToolResult(value, { maxBytes: bytes });
  expect(exact).toEqual(expected);
  expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
    bytes,
  );
  const overflow = retryHistoryToolResult(value, { maxBytes: bytes - 1 });
  expect(overflow).toEqual({
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'error',
          error: {
            code: 'ResourceLimitExceeded',
            message: 'Retry history exceeded a resource limit.',
          },
        }),
      },
    ],
    structuredContent: {
      status: 'error',
      error: {
        code: 'ResourceLimitExceeded',
        message: 'Retry history exceeded a resource limit.',
      },
    },
  });
  expect(JSON.stringify(overflow)).not.toContain('entries');
  expect(lowerRetryHistoryResultByteLimit()).toBe(2_097_152);
  for (const maxBytes of [2_097_153, Infinity, NaN, 0, bytes + 0.5])
    expect(() => lowerRetryHistoryResultByteLimit(maxBytes)).toThrow(
      RangeError,
    );
});

test('GRH-06 semantic counts/page/ref/state/attribution violations become a fixed private-error-free InternalError', () => {
  const value = literalOk();
  const first = value.entries[0];
  if (first === undefined) throw new Error('Missing literal fixture entry.');
  const bad: readonly unknown[] = [
    { ...value, privateProof: 'SECRET-CAUSE-SENTINEL' },
    { ...value, counts: { ...value.counts, localRetryAttempts: 24 } },
    { ...value, counts: { ...value.counts, matchingRetryAttempts: 0 } },
    { ...value, page: { ...value.page, returnedCount: 24 } },
    { ...value, page: { ...value.page, limit: 24 } },
    { ...value, page: { ...value.page, nextCursor: cursor() } },
    ...[
      { stateVersion: 1 },
      { providerTaskId: null },
      { unresolvedHold: true },
      { createdAtMs: '1' },
      { reservation: { tokens: '0', indexer: '0', checker: '0' } },
      { submittedUrlCount: null },
      { attemptRef: 'NOT-A-DIGEST' },
      { source: { ...first.source, recordedAttempts: 24 } },
      { source: { ...first.source, family: 'yandex/indexer' } },
      { source: { ...first.source, attribution: 'external_adopted' } },
      { source: { ...first.source, originalAncestry: 'known' } },
      { rawRequestId: 'SECRET-CAUSE-SENTINEL' },
    ].map((change) => ({
      ...value,
      entries: [{ ...first, ...change }, ...value.entries.slice(1)],
    })),
    { ...value, entries: [first, first, ...value.entries.slice(2)] },
    {
      status: 'error',
      error: { code: 'StateUnavailable', message: 'SECRET-CAUSE-SENTINEL' },
    },
    {
      status: 'error',
      error: { code: 'FutureError', message: 'SECRET-CAUSE-SENTINEL' },
    },
    {
      status: 'blocked',
      reason: { code: 'StateMissing', message: 'SECRET-CAUSE-SENTINEL' },
    },
  ];
  for (const invalid of bad) {
    expect(retryHistoryResultSchema.safeParse(invalid).success).toBe(false);
    const envelope = retryHistoryToolResult(invalid);
    expect(envelope.structuredContent).toEqual({
      status: 'error',
      error: {
        code: 'InternalError',
        message: 'Retry history failed internally.',
      },
    });
    expect(envelope.isError).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain('SECRET-CAUSE-SENTINEL');
    frozen(envelope);
  }
});

test('GRH-06 exact decimal strings reject rounding, noncanonical and out-of-range representations', () => {
  const row = child('numeric', 'unknown');
  for (const createdAtMs of [
    '-0',
    '01',
    '1.5',
    '9223372036854775808',
    '-9223372036854775809',
  ]) {
    errorCode(
      retryHistoryFromSnapshot(
        snapshot([row], { unresolvedHistory: [detail(row, { createdAtMs })] }),
        binding,
      ),
      'StateUnavailable',
    );
  }
  for (const tokens of ['-1', '00', '1e3', '9223372036854775808']) {
    errorCode(
      retryHistoryFromSnapshot(
        snapshot([row], {
          unresolvedHistory: [
            detail(row, {
              reservation: { tokens, indexer: '0', checker: '0' },
            }),
          ],
        }),
        binding,
      ),
      'StateUnavailable',
    );
  }
});

test('GRH-06 every fixed closed branch has identical text/structured data and isError exactly for errors', () => {
  const values = [
    retryHistoryFromSnapshot(snapshot(), binding),
    ...(
      ['ReadConfigurationUnavailable', 'StateMissing', 'V2Required'] as const
    ).map((code) => retryHistoryBlocked(code)),
    ...(
      [
        'InvalidInput',
        'CursorMismatch',
        'SnapshotChanged',
        'StateUnavailable',
        'HistoryBusy',
        'ResourceLimitExceeded',
        'Cancelled',
        'DeadlineExceeded',
        'InternalError',
      ] as const
    ).map((code) => retryHistoryError(code)),
  ];
  for (const value of values) {
    const envelope = retryHistoryToolResult(value);
    expect(envelope.isError).toBe(value.status === 'error');
    expect(envelope.structuredContent).toEqual(value);
    const text = envelope.content[0]?.text;
    if (text === undefined) throw new Error('Missing application text.');
    const decoded: unknown = JSON.parse(text);
    expect(decoded).toEqual(value);
    frozen(envelope);
  }
});

test('GRH-R1-01 the accepted minimum fits all twelve literal fixed envelopes and refuses minimum minus one', () => {
  const variants = [
    {
      status: 'error',
      error: { code: 'InvalidInput', message: 'Invalid retry-history input.' },
    },
    {
      status: 'error',
      error: {
        code: 'CursorMismatch',
        message: 'The cursor does not match this history query.',
      },
    },
    {
      status: 'error',
      error: {
        code: 'SnapshotChanged',
        message: 'Local history changed. Start a new history query.',
      },
    },
    {
      status: 'error',
      error: {
        code: 'StateUnavailable',
        message: 'The complete local retry history is unavailable.',
      },
    },
    {
      status: 'error',
      error: {
        code: 'HistoryBusy',
        message:
          'Another history read or incompatible state operation is active.',
      },
    },
    {
      status: 'error',
      error: {
        code: 'ResourceLimitExceeded',
        message: 'Retry history exceeded a resource limit.',
      },
    },
    {
      status: 'error',
      error: { code: 'Cancelled', message: 'Retry history was cancelled.' },
    },
    {
      status: 'error',
      error: {
        code: 'DeadlineExceeded',
        message: 'Retry history exceeded its observation deadline.',
      },
    },
    {
      status: 'error',
      error: {
        code: 'InternalError',
        message: 'Retry history failed internally.',
      },
    },
    {
      status: 'blocked',
      reason: {
        code: 'ReadConfigurationUnavailable',
        message: 'Retry history requires configured local state.',
      },
    },
    {
      status: 'blocked',
      reason: {
        code: 'StateMissing',
        message: 'The configured local state does not exist.',
      },
    },
    {
      status: 'blocked',
      reason: {
        code: 'V2Required',
        message: 'Retry history requires existing V2 local state.',
      },
    },
  ] as const;
  const expected = variants.map((value) => {
    const envelope = {
      isError: value.status === 'error',
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value,
    };
    return {
      envelope,
      bytes: new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
    };
  });
  const minimum = Math.max(...expected.map(({ bytes }) => bytes));
  expect(minimum).toBe(346);
  expect(lowerRetryHistoryResultByteLimit(minimum)).toBe(minimum);
  expect(() => lowerRetryHistoryResultByteLimit(minimum - 1)).toThrow(
    RangeError,
  );
  for (const { envelope, bytes } of expected) {
    const actual = retryHistoryToolResult(envelope.structuredContent, {
      maxBytes: minimum,
    });
    expect(actual).toEqual(envelope);
    expect(new TextEncoder().encode(JSON.stringify(actual)).byteLength).toBe(
      bytes,
    );
    expect(bytes).toBeLessThanOrEqual(minimum);
    frozen(actual);
  }
});
