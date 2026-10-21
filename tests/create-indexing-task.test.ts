import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildCreateIndexingRequest,
  CreateIndexingTaskError,
  createIndexingTaskError,
  createIndexingTaskInputSchema,
  createIndexingTaskResultSchema,
  createIndexingTaskToolResult,
  normalizeCreateIndexingOutcome,
} from '../src/create-indexing-task';

const utf8 = new TextEncoder();
const preview = {
  mode: 'preview',
  searchEngine: 'google',
  urls: ['https://example.test/one'],
} as const;
const submit = {
  ...preview,
  mode: 'submit',
  requestId: 'fixture-request',
} as const;
const urls = [
  'HTTPS://Example.TEST/%2f?b=2&a=1#fragment',
  'https://example.test/白🦊/',
];
const title = '  白い "title" \\ 🦊  ';

function sha(value: string) {
  return createHash('sha256').update(utf8.encode(value)).digest('hex');
}

test.each([
  {
    label: 'Google PPR without drip',
    engine: 'google',
    urls,
    title,
    body: '{"title":"  白い \\"title\\" \\\\ 🦊  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"],"pay_per_indexed":true,"drip_feed":false}',
    family: 'google/indexer',
    route: '/v2/task/google/indexer/create',
    exposure: { tokens: 200, indexer: 0, checker: 0 },
  },
  {
    label: 'Google PPR with drip',
    engine: 'google',
    urls: [...urls, 'http://example.test/end'],
    title,
    dripFeedDays: 2,
    body: '{"title":"  白い \\"title\\" \\\\ 🦊  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/","http://example.test/end"],"pay_per_indexed":true,"drip_feed":true,"drip_feed_days":2}',
    family: 'google/indexer',
    route: '/v2/task/google/indexer/create',
    exposure: { tokens: 300, indexer: 0, checker: 0 },
  },
  {
    label: 'Yandex independent maxima',
    engine: 'yandex',
    urls,
    title,
    body: '{"title":"  白い \\"title\\" \\\\ 🦊  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"]}',
    family: 'yandex/indexer',
    route: '/v2/task/yandex/indexer/create',
    exposure: { tokens: 40, indexer: 2, checker: 0 },
  },
])('C02 PURE: $label exact body and independent quote', (vector) => {
  const built = buildCreateIndexingRequest({
    mode: 'submit',
    requestId: 'local-only',
    searchEngine: vector.engine,
    urls: vector.urls,
    title: vector.title,
    ...('dripFeedDays' in vector ? { dripFeedDays: vector.dripFeedDays } : {}),
    acknowledgement: {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    },
  });
  expect(built.body).toBe(vector.body);
  expect(utf8.encode(built.body)).toEqual(utf8.encode(vector.body));
  const expectedDigest = sha(vector.body);
  expect(built.request).toEqual({
    family: vector.family,
    providerRoute: vector.route,
    urlCount: vector.urls.length,
    providerBodyBytes: utf8.encode(vector.body).length,
    payloadDigest: expectedDigest,
  });
  const expectedFingerprint = sha(
    'speedyindex-create-quote-v1\0' +
      JSON.stringify({
        version: 'speedyindex-indexing-batch-2026-10-20-v1',
        family: vector.family,
        providerRoute: vector.route,
        payloadDigest: expectedDigest,
        urlCount: vector.urls.length,
        maximumExposure: vector.exposure,
      }),
  );
  expect(built.quote).toEqual({
    version: 'speedyindex-indexing-batch-2026-10-20-v1',
    fingerprint: expectedFingerprint,
    maximumExposure: vector.exposure,
    basis: 'documented_independent_maxima',
    providerEnforced: false,
  });
  expect(built.input.urls).toEqual(vector.urls);
  expect(built.input.title).toBe(title);
});

test('C02 PURE: omitted and empty title differ; local submit authority does not enter the quote', () => {
  const without = buildCreateIndexingRequest(preview);
  const empty = buildCreateIndexingRequest({ ...preview, title: '' });
  expect(without.body).toBe(
    '{"urls":["https://example.test/one"],"pay_per_indexed":true,"drip_feed":false}',
  );
  expect(empty.body).toBe(
    '{"title":"","urls":["https://example.test/one"],"pay_per_indexed":true,"drip_feed":false}',
  );
  expect(without.request.payloadDigest).not.toBe(empty.request.payloadDigest);
  expect(without.quote.fingerprint).not.toBe(empty.quote.fingerprint);
  expect(buildCreateIndexingRequest(submit).quote).toEqual(without.quote);
  expect(
    buildCreateIndexingRequest({ ...submit, requestId: 'another-id' }).body,
  ).toBe(without.body);
});

test('C03 PURE: accepted copy cannot be changed by caller mutations or through the returned value', () => {
  const source = {
    ...submit,
    urls: [...urls],
    title,
    acknowledgement: {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    },
  };
  const built = buildCreateIndexingRequest(source);
  const body = built.body;
  const digest = built.request.payloadDigest;
  source.urls.reverse();
  source.urls.push('https://example.test/changed');
  source.title = 'changed';
  source.acknowledgement.quoteFingerprint = 'c'.repeat(64);
  expect(built.input.urls).toEqual(urls);
  expect(built.input.title).toBe(title);
  expect(built.input.acknowledgement?.quoteFingerprint).toBe('a'.repeat(64));
  expect(() =>
    (built.input.urls as string[]).push('https://example.test/mutated'),
  ).toThrow();
  expect(() =>
    Object.assign(built.quote.maximumExposure, { tokens: 0 }),
  ).toThrow();
  expect(() =>
    Object.assign(built.request, { payloadDigest: 'f'.repeat(64) }),
  ).toThrow();
  expect(() =>
    Object.assign(built.input.acknowledgement!, {
      authorizationFingerprint: 'f'.repeat(64),
    }),
  ).toThrow();
  expect(built.body).toBe(body);
  expect(built.request.payloadDigest).toBe(digest);
});

function invalid(value: unknown) {
  expect(createIndexingTaskInputSchema.safeParse(value).success).toBe(false);
  try {
    buildCreateIndexingRequest(value);
    throw new Error('Expected public input rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(CreateIndexingTaskError);
    expect((error as CreateIndexingTaskError).code).toBe('InvalidInput');
    expect((error as Error).message).toBe('Invalid create-indexing request.');
  }
}

test('C03 PURE: URL count includes 1 and 10,000 without truncation or deduplication', () => {
  expect(buildCreateIndexingRequest(preview).request.urlCount).toBe(1);
  const many = Array.from(
    { length: 10_000 },
    (_, n) => `https://example.test/${n}`,
  );
  const built = buildCreateIndexingRequest({ ...preview, urls: many });
  const body = JSON.parse(built.body) as { urls: string[] };
  expect(built.quote.maximumExposure).toEqual({
    tokens: 1_000_000,
    indexer: 0,
    checker: 0,
  });
  expect(body.urls).toEqual(many);
  expect(body.urls[9_999]).toBe('https://example.test/9999');
  invalid({ ...preview, urls: [] });
  invalid({ ...preview, urls: [...many, 'https://example.test/10000'] });
  invalid({ ...preview, urls: [urls[0], urls[0]] });
});

test('C03 PURE: distinct slash, query ordering, escape spelling and Unicode remain unchanged', () => {
  const distinct = [
    'https://example.test/a',
    'https://example.test/a/',
    'https://example.test/%2f',
    'https://example.test/%2F',
    'https://example.test/?a=1&b=2',
    'https://example.test/?b=2&a=1',
    'HTTPS://白.example/🦊#片',
    'https://example.test/é',
    'https://example.test/e\u0301',
  ];
  const built = buildCreateIndexingRequest({ ...preview, urls: distinct });
  expect((JSON.parse(built.body) as { urls: string[] }).urls).toEqual(distinct);
  expect(built.input.urls).toEqual(distinct);
});

test('C03 PURE: URL/title limits count UTF-8 bytes and accept inclusive boundaries', () => {
  const prefix = 'https://example.test/';
  const remaining = 8_192 - utf8.encode(prefix).length;
  const url =
    prefix + 'é'.repeat(Math.floor(remaining / 2)) + 'a'.repeat(remaining % 2);
  expect(utf8.encode(url).length).toBe(8_192);
  const title = '🦊'.repeat(256);
  expect(utf8.encode(title).length).toBe(1_024);
  expect(
    buildCreateIndexingRequest({ ...preview, urls: [url], title }).input,
  ).toMatchObject({ urls: [url], title });
  invalid({ ...preview, urls: [url + 'a'] });
  invalid({ ...preview, title: title + 'a' });
  invalid({ ...preview, title: 'é'.repeat(513) });
});

test.each([
  '',
  '/relative',
  'ftp://example.test/a',
  'https://',
  'https://user@example.test/a',
  'https://user:pass@example.test/a',
  'https://@example.test/a',
  ' https://example.test/',
  'https://example.test/ ',
  'https://example.test/a b',
  'https://example.test/\t',
  'https://example.test/\n',
  'https://example.test/\0',
  'https://example.test/\x7f',
  '\u00a0https://example.test/',
  'https://example.test/\u00a0',
  'https://example.test/\ud800',
  'https://example.test/\udfff',
  'https://example.test/🦊\ud800',
])('C03 PURE: rejects inadmissible URL %#', (url) =>
  invalid({ ...preview, urls: [url] }),
);

test.each([
  '\0',
  '\t',
  '\r',
  '\n',
  '\x1f',
  '\x7f',
  '\ud800',
  '\udfff',
  '🦊\udfff',
])('C03 PURE: rejects title controls or malformed Unicode %#', (title) =>
  invalid({ ...preview, title }),
);

// Construct the wire fixture independently: literal field shell plus JSON string
// escaping. Each URL is below its own bound, so only aggregate bytes reject +1.
function bodyBoundaryFixture() {
  const urls = Array.from({ length: 256 }, (_, n) => {
    const head = `https://example.test/${n}/"\\`;
    return head + 'a'.repeat(8_192 - head.length);
  });
  const expected = () =>
    '{"title":"é\\"\\\\","urls":[' +
    urls.map((url) => JSON.stringify(url)).join(',') +
    '],"pay_per_indexed":true,"drip_feed":false}';
  const overflow = utf8.encode(expected()).length - 2_097_152;
  expect(overflow).toBeGreaterThan(0);
  urls[255] = urls[255]!.slice(0, -overflow);
  return { urls, title: 'é"\\', expected: expected() };
}

test('C03 PURE: actual escaped body accepts 2 MiB exactly and rejects one more byte', () => {
  const fixture = bodyBoundaryFixture();
  expect(utf8.encode(fixture.expected).length).toBe(2_097_152);
  const built = buildCreateIndexingRequest({
    ...preview,
    urls: fixture.urls,
    title: fixture.title,
  });
  expect(built.body).toBe(fixture.expected);
  expect(built.request.providerBodyBytes).toBe(2_097_152);
  expect(built.request.payloadDigest).toBe(sha(fixture.expected));
  const over = [...fixture.urls];
  over[255] += 'a';
  invalid({ ...preview, urls: over, title: fixture.title });
});

test('C03 PURE: local request IDs are exact visible ASCII with inclusive bounds', () => {
  for (const requestId of ['!', '~'.repeat(128), 'Case/opaque:%2f?'])
    expect(
      buildCreateIndexingRequest({ ...submit, requestId }).input.requestId,
    ).toBe(requestId);
  for (const requestId of [
    '',
    'a'.repeat(129),
    ' a',
    'a ',
    'a b',
    'a\t',
    '\x7f',
    'é',
    '🦊',
    '\ud800',
  ])
    invalid({ ...submit, requestId });
});

test('C03 PURE: drip accepts 2 and 30 days only for a sufficient Google batch', () => {
  for (const days of [2, 30]) {
    const urls = Array.from(
      { length: days },
      (_, n) => `https://example.test/${n}`,
    );
    const built = buildCreateIndexingRequest({
      ...preview,
      urls,
      dripFeedDays: days,
    });
    expect(
      (JSON.parse(built.body) as { drip_feed_days: number }).drip_feed_days,
    ).toBe(days);
    expect(built.quote.maximumExposure).toEqual({
      tokens: 100 * days,
      indexer: 0,
      checker: 0,
    });
  }
  for (const dripFeedDays of [1, 31, 2.5, NaN, Infinity, null, '2'])
    invalid({ ...preview, urls, dripFeedDays });
  invalid({ ...preview, dripFeedDays: 2 });
  invalid({ ...preview, searchEngine: 'yandex', urls, dripFeedDays: 2 });
});

test('C03 PURE: preview/submit and exact acknowledgement fields cannot be mixed', () => {
  const acknowledgement = {
    quoteFingerprint: 'a'.repeat(64),
    authorizationFingerprint: '0'.repeat(64),
  };
  expect(
    buildCreateIndexingRequest({ ...submit, acknowledgement }).input
      .acknowledgement,
  ).toEqual(acknowledgement);
  invalid({ ...preview, requestId: 'no-preview-id' });
  invalid({ ...preview, acknowledgement });
  invalid({ mode: 'submit', searchEngine: 'google', urls });
  invalid({ ...submit, acknowledgement: { ...acknowledgement, extra: true } });
  invalid({ ...submit, acknowledgement: { quoteFingerprint: 'a'.repeat(64) } });
  invalid({
    ...submit,
    acknowledgement: {
      ...acknowledgement,
      authorizationFingerprint: 'A'.repeat(64),
    },
  });
  invalid({
    ...submit,
    acknowledgement: { ...acknowledgement, quoteFingerprint: 'a'.repeat(63) },
  });
  invalid({ ...submit, acknowledgement: null });
});

test('C03 PURE: strict input rejects caller policy, route, PPR and lineage authority', () => {
  for (const field of [
    'providerRoute',
    'payPerIndexed',
    'pay_per_indexed',
    'caps',
    'policy',
    'policyDigest',
    'budgetScope',
    'period',
    'stateDirectory',
    'credentialFingerprint',
    'parentRequestId',
    'campaignRef',
    'extra',
  ])
    invalid({ ...preview, [field]: 'caller-controlled' });
  for (const searchEngine of [
    'bing',
    'google/checker',
    'GOOGLE',
    'backlink',
    null,
  ])
    invalid({ ...preview, searchEngine });
  for (const value of [
    null,
    [],
    {},
    { ...preview, mode: 'automatic' },
    { ...preview, urls: 'https://example.test/' },
    { ...preview, title: 1 },
  ])
    invalid(value);
});

const google = buildCreateIndexingRequest(preview);
const drip = buildCreateIndexingRequest({ ...preview, urls, dripFeedDays: 2 });
const yandex = buildCreateIndexingRequest({
  ...preview,
  searchEngine: 'yandex',
});

test('C08 PURE: root ACK accepts exact requested families, optional echoes and opaque IDs only', () => {
  const id = '  opaque /白🦊?%2f  ';
  for (const prepared of [google, drip, yandex]) {
    const response = { code: 0, task_id: id, type: prepared.request.family };
    const expected = {
      kind: 'accepted',
      taskId: id,
      type: prepared.request.family,
    } as const;
    expect(normalizeCreateIndexingOutcome(prepared, 200, response)).toEqual(
      expected,
    );
    expect(
      normalizeCreateIndexingOutcome(prepared, 200, {
        ...response,
        pay_per_indexed: true,
        drip_feed: prepared === drip,
        ...(prepared === drip ? { drip_feed_days: 2 } : {}),
        message: 'dummy-provider-private-text',
        result: { task_id: 'nested-ignored' },
        unknown: { path: '/synthetic/private', tokens: 0 },
      }),
    ).toEqual(expected);
  }
});

test('C08 PURE: root opaque ID accepts 4,096 UTF-8 bytes and rejects malformed/blank/oversized IDs', () => {
  const taskId = 'é'.repeat(2_048);
  const ack = { code: 0, task_id: taskId, type: 'google/indexer' };
  expect(normalizeCreateIndexingOutcome(google, 200, ack)).toEqual({
    kind: 'accepted',
    taskId,
    type: 'google/indexer',
  });
  for (const id of [
    taskId + 'a',
    '',
    ' ',
    '\u00a0',
    'a\0',
    'a\n',
    '\x7f',
    '\ud800',
    '\udfff',
    null,
    123,
  ])
    expect(
      normalizeCreateIndexingOutcome(google, 200, { ...ack, task_id: id }),
    ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
});

test('C08 PURE: nested or malformed apparent successes remain unknown', () => {
  const ack = { code: 0, task_id: 'job', type: 'google/indexer' };
  const bad: unknown[] = [
    null,
    [],
    [ack],
    { code: 0, result: { task_id: 'nested', type: 'google/indexer' } },
    { code: 0, id: 'legacy', type: 'google/indexer' },
    { code: 0, task_id: 'job' },
    { ...ack, type: 'yandex/indexer' },
    { ...ack, type: 'Google/indexer' },
    { ...ack, type: 'google/checker' },
    { ...ack, type: null },
    ...['0', false, null, 3, -1, 0.5, NaN].map((code) => ({ ...ack, code })),
  ];
  for (const response of bad)
    expect(normalizeCreateIndexingOutcome(google, 200, response)).toEqual({
      kind: 'unknown',
      cause: 'invalid_ack',
    });
  for (const status of [201, 301, 400, 401, 402, 413, 429, 500])
    expect(normalizeCreateIndexingOutcome(google, status, ack)).toEqual({
      kind: 'unknown',
      cause: 'http',
    });
});

test('C08 PURE: present optional echoes must be typed, consistent and valid for non-drip', () => {
  for (const prepared of [google, drip, yandex]) {
    const ack = { code: 0, task_id: 'job', type: prepared.request.family };
    const bad = [
      ...[false, null, 1, 'true', undefined].map((pay_per_indexed) => ({
        pay_per_indexed,
      })),
      ...[prepared !== drip, null, 0, 'false', undefined].map((drip_feed) => ({
        drip_feed,
      })),
      ...[null, '2', 2.5, 3, undefined, ...(prepared === drip ? [] : [2])].map(
        (drip_feed_days) => ({ drip_feed_days }),
      ),
    ];
    for (const fields of bad)
      expect(
        normalizeCreateIndexingOutcome(prepared, 200, { ...ack, ...fields }),
      ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  }
});

test('C08 PURE: documented root rejections require allowed status, integer code and no task_id field', () => {
  for (const code of [1, 2] as const) {
    for (const status of [200, 401, 402, 413])
      expect(
        normalizeCreateIndexingOutcome(google, status, {
          code,
          message: 'ignored',
        }),
      ).toEqual({ kind: 'rejected', code });
    for (const task_id of ['job', null, undefined])
      expect(
        normalizeCreateIndexingOutcome(google, 200, { code, task_id }),
      ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
    for (const status of [400, 403, 429, 500])
      expect(normalizeCreateIndexingOutcome(google, status, { code })).toEqual({
        kind: 'unknown',
        cause: 'http',
      });
  }
});

const authorization = {
  state: 'configured',
  stateChecked: true,
  mode: 'operator_policy',
  policyRevision: 'fixture-v1',
  policyDigest: 'c'.repeat(64),
  budgetScope: 'fixture-scope',
  caps: { tokens: 100_000, indexer: 100_000, checker: 0 },
  period: {
    id: 'utc-day:2026-10-20',
    startMs: 1_792_454_400_000,
    endMs: 1_792_540_800_000,
  },
  fingerprint: 'd'.repeat(64),
} as const;
const intent = {
  requestId: 'fixture-request',
  state: 'accepted',
  stateVersion: 2,
  createdAtMs: 1_792_454_400_100,
  periodId: authorization.period.id,
  periodStartMs: authorization.period.startMs,
  policyRevision: authorization.policyRevision,
  policyDigest: authorization.policyDigest,
  reservation: { tokens: 100, indexer: 0, checker: 0 },
  providerTaskId: ' opaque 白 ',
  providerType: 'google/indexer',
} as const;

test('C03/C08 PURE output: application errors are validated and text matches structured JSON', () => {
  const previewResult = {
    mode: 'preview',
    status: 'preview',
    request: google.request,
    quote: google.quote,
    authorization: { state: 'unconfigured', stateChecked: false },
  } as const;
  const accepted = {
    mode: 'submit',
    status: 'accepted',
    request: google.request,
    quote: google.quote,
    authorization,
    intent,
  } as const;
  const blocked = {
    mode: 'submit',
    status: 'blocked',
    request: google.request,
    quote: google.quote,
    authorization: { state: 'disabled', stateChecked: false },
    error: createIndexingTaskError('WritesDisabled'),
  } as const;
  for (const [result, isError] of [
    [previewResult, false],
    [accepted, false],
    [blocked, true],
  ] as const) {
    const wire = createIndexingTaskToolResult(result);
    expect(wire.structuredContent).toEqual(result);
    expect(wire.isError).toBe(isError);
    expect(JSON.parse(wire.content[0]!.text)).toEqual(wire.structuredContent);
  }
  const invalidInput = {
    mode: 'preview',
    status: 'blocked',
    error: createIndexingTaskError('InvalidInput'),
  } as const;
  expect(createIndexingTaskToolResult(invalidInput).structuredContent).toEqual(
    invalidInput,
  );
  for (const result of [
    { ...blocked, error: createIndexingTaskError('InvalidInput') },
    { ...blocked, error: createIndexingTaskError('InternalError') },
    {
      ...blocked,
      error: {
        code: 'WritesDisabled',
        message: 'dummy key/path/provider text',
      },
    },
    { ...blocked, rawBody: 'private provider text' },
    {
      ...blocked,
      error: { ...createIndexingTaskError('WritesDisabled'), unit: 'tokens' },
    },
    {
      ...blocked,
      quote: {
        ...google.quote,
        maximumExposure: { tokens: 0, indexer: 0, checker: 0 },
      },
    },
    {
      ...blocked,
      request: {
        ...google.request,
        providerRoute: '/v2/task/yandex/indexer/create',
      },
    },
    {
      ...previewResult,
      authorization: { state: 'configured', stateChecked: false },
    },
    { ...accepted, intent: { ...intent, providerType: 'yandex/indexer' } },
    { ...accepted, intent: undefined },
  ]) {
    expect(createIndexingTaskResultSchema.safeParse(result).success).toBe(
      false,
    );
    const wire = createIndexingTaskToolResult(result);
    expect(wire.structuredContent).toEqual({
      status: 'blocked',
      error: createIndexingTaskError('InternalError'),
    });
    expect(wire.isError).toBe(true);
    expect(JSON.parse(wire.content[0]!.text)).toEqual(wire.structuredContent);
  }
});

test('C08 PURE output: unrecorded ACK remains distinct from durable accepted success', () => {
  const { providerTaskId, providerType, ...dispatching } = intent;
  const result = {
    mode: 'submit',
    status: 'dispatching',
    request: google.request,
    quote: google.quote,
    authorization,
    intent: { ...dispatching, state: 'dispatching', stateVersion: 1 },
    observation: {
      kind: 'accepted_ack',
      recorded: false,
      taskId: providerTaskId,
      type: providerType,
    },
    error: createIndexingTaskError('OutcomePersistenceFailed'),
  } as const;
  const wire = createIndexingTaskToolResult(result);
  expect(wire.structuredContent).toEqual(result);
  expect(wire.isError).toBe(true);
  for (const taskId of [providerTaskId, 'different-ack-task']) {
    const invalid = {
      ...result,
      status: 'accepted',
      intent,
      observation: { ...result.observation, taskId },
      error: undefined,
    } as const;
    expect(createIndexingTaskResultSchema.safeParse(invalid).success).toBe(
      false,
    );
    const fallback = createIndexingTaskToolResult(invalid);
    expect(fallback.structuredContent).toEqual({
      status: 'blocked',
      error: createIndexingTaskError('InternalError'),
    });
    expect(fallback.isError).toBe(true);
    expect(JSON.parse(fallback.content[0]!.text)).toEqual(
      fallback.structuredContent,
    );
  }
  expect(
    createIndexingTaskResultSchema.safeParse({
      ...result,
      status: 'accepted',
      error: undefined,
    }).success,
  ).toBe(false);
  expect(
    createIndexingTaskResultSchema.safeParse({
      ...result,
      observation: { ...result.observation, recorded: true },
    }).success,
  ).toBe(false);
  const unavailable = {
    ...result,
    status: 'blocked',
    intent: undefined,
    error: {
      ...createIndexingTaskError('StateUnavailable'),
      lastObservedState: 'dispatching',
    },
  } as const;
  expect(createIndexingTaskToolResult(unavailable).structuredContent).toEqual(
    unavailable,
  );
});
