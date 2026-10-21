import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildCreateIndexCheckRequest,
  CreateIndexCheckError,
  createIndexCheckError,
  createIndexCheckInputSchema,
  createIndexCheckResultSchema,
  createIndexCheckToolResult,
  normalizeCreateIndexCheckOutcome,
  quoteIndexCheckRequest,
} from '../src/create-index-check';
import type { IndexCheckReservationSource } from '../src/submission-contract';

const urls = [
  'HTTPS://Example.TEST/%2f?b=2&a=1#fragment',
  'https://example.test/白🦊/',
];
const title = '  白 "title" \\ 🦊  ';
const body =
  '{"title":"  白 \\"title\\" \\\\ 🦊  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://example.test/白🦊/"]}';
const input = { mode: 'preview', searchEngine: 'google', urls, title } as const;
// Synthetic local declarations; these numbers do not represent provider fees.
const perUrl = { tokens: 7, indexer: 5, checker: 11 };
const source: IndexCheckReservationSource = {
  state: 'loaded',
  profiles: { google: perUrl, yandex: perUrl, bing: perUrl },
};
function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
const families = [
  {
    engine: 'google',
    family: 'google/checker',
    route: '/v2/task/google/checker/create',
  },
  {
    engine: 'yandex',
    family: 'yandex/checker',
    route: '/v2/task/yandex/checker/create',
  },
  {
    engine: 'bing',
    family: 'bing/checker',
    route: '/v2/task/bing/checker/create',
  },
] as const;

test.each(families)(
  'IC02 PURE: $engine exact frozen request and non-unit three-component quote',
  (vector) => {
    const original = { ...input, searchEngine: vector.engine, urls: [...urls] };
    const prepared = buildCreateIndexCheckRequest(original);
    expect(Object.keys(prepared)).toEqual(['input', 'body', 'request']);
    expect(prepared.body).toBe(body);
    expect(prepared.request).toEqual({
      family: vector.family,
      providerRoute: vector.route,
      urlCount: 2,
      providerBodyBytes: Buffer.byteLength(body, 'utf8'),
      payloadDigest: sha(body),
    });
    const expectedFingerprint = sha(
      'speedyindex-create-index-check-reservation-v1\0' +
        JSON.stringify({
          version: 'speedyindex-index-check-reservation-2026-10-21-v1',
          family: vector.family,
          providerRoute: vector.route,
          payloadDigest: sha(body),
          urlCount: 2,
          perUrlReservation: { tokens: 7, indexer: 5, checker: 11 },
          reservation: { tokens: 14, indexer: 10, checker: 22 },
        }),
    );
    const quote = quoteIndexCheckRequest(prepared, source);
    expect(quote).toEqual({
      version: 'speedyindex-index-check-reservation-2026-10-21-v1',
      basis: 'operator_configured_reservation',
      providerEnforced: false,
      providerFeesKnown: false,
      availability: 'available',
      perUrlReservation: perUrl,
      reservation: { tokens: 14, indexer: 10, checker: 22 },
      fingerprint: expectedFingerprint,
    });
    original.urls.reverse();
    original.urls.push('https://example.test/mutated');
    expect(prepared.input.urls).toEqual(urls);
    expect(() =>
      (prepared.input.urls as string[]).push('https://example.test/mutated'),
    ).toThrow();
    expect(() =>
      Object.assign(prepared.request, { payloadDigest: 'f'.repeat(64) }),
    ).toThrow();
    expect(() => Object.assign(prepared.input, { title: 'mutated' })).toThrow();
    if (quote.availability !== 'available')
      throw new Error('Expected local reservation.');
    expect(() =>
      Object.assign(quote.perUrlReservation, { checker: 0 }),
    ).toThrow();
    expect(() => Object.assign(quote.reservation, { tokens: 0 })).toThrow();
  },
);

test('IC02/IC05 PURE: quote binds selected vector and exact body/family/count, excluding local authority and other profiles', () => {
  const prepared = buildCreateIndexCheckRequest(input);
  const quote = quoteIndexCheckRequest(prepared, source);
  const acknowledgement = {
    quoteFingerprint: 'a'.repeat(64),
    authorizationFingerprint: 'b'.repeat(64),
  };
  const submitted = buildCreateIndexCheckRequest({
    ...input,
    mode: 'submit',
    requestId: 'other-id',
    acknowledgement,
  });
  expect(quoteIndexCheckRequest(submitted, source)).toEqual(quote);
  acknowledgement.quoteFingerprint = 'c'.repeat(64);
  expect(submitted.input.acknowledgement?.quoteFingerprint).toBe(
    'a'.repeat(64),
  );
  expect(() =>
    Object.assign(submitted.input.acknowledgement!, {
      quoteFingerprint: 'd'.repeat(64),
    }),
  ).toThrow();
  expect(
    quoteIndexCheckRequest(prepared, {
      state: 'loaded',
      profiles: {
        google: perUrl,
        bing: { tokens: 100, indexer: 0, checker: 4 },
      },
    }),
  ).toEqual(quote);
  for (const change of [
    { ...input, title: '' },
    { ...input, title: 'changed' },
    { ...input, urls: [...urls].reverse() },
    { ...input, urls: [urls[0]!] },
    { ...input, searchEngine: 'yandex' },
  ])
    expect(
      quoteIndexCheckRequest(buildCreateIndexCheckRequest(change), source),
    ).not.toEqual(quote);
  for (const unit of ['tokens', 'indexer', 'checker'] as const)
    expect(
      quoteIndexCheckRequest(prepared, {
        state: 'loaded',
        profiles: { google: { ...perUrl, [unit]: perUrl[unit] + 1 } },
      }),
    ).not.toEqual(quote);
  const omitted = buildCreateIndexCheckRequest({
    mode: 'preview',
    searchEngine: 'bing',
    urls: [urls[0]!],
  });
  const empty = buildCreateIndexCheckRequest({ ...omitted.input, title: '' });
  expect(omitted.body).toBe(
    '{"urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment"]}',
  );
  expect(empty.body).toBe(
    '{"title":"","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment"]}',
  );
  expect(empty.request.payloadDigest).not.toBe(omitted.request.payloadDigest);
});

test.each([
  { source: { state: 'unconfigured' }, reason: 'policy_unconfigured' },
  { source: { state: 'invalid' }, reason: 'policy_invalid' },
  { source: { state: 'loaded' }, reason: 'profile_missing' },
  { source: { state: 'loaded', profiles: {} }, reason: 'profile_missing' },
  {
    source: { state: 'loaded', profiles: { bing: perUrl } },
    reason: 'profile_missing',
  },
] as const)(
  'IC02/IC05 PURE: $reason quote has no fabricated units or fingerprint',
  ({ source, reason }) => {
    const quote = quoteIndexCheckRequest(
      buildCreateIndexCheckRequest(input),
      source,
    );
    expect(quote).toEqual({
      version: 'speedyindex-index-check-reservation-2026-10-21-v1',
      basis: 'operator_configured_reservation',
      providerEnforced: false,
      providerFeesKnown: false,
      availability: 'unavailable',
      reason,
    });
    const result = {
      mode: 'preview',
      status: 'preview',
      request: buildCreateIndexCheckRequest(input).request,
      quote,
      authorization: { state: 'unconfigured', stateChecked: false },
    } as const;
    expect(createIndexCheckToolResult(result).structuredContent).toEqual(
      result,
    );
    expect(createIndexCheckToolResult(result).isError).toBe(false);
  },
);

test('IC02/IC03 PURE: exact BigInt products accept safe totals and mark each overflowing component unavailable', () => {
  const prepared = buildCreateIndexCheckRequest(input);
  const safe = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  expect(
    quoteIndexCheckRequest(prepared, {
      state: 'loaded',
      profiles: { google: { tokens: safe, indexer: safe, checker: safe } },
    }),
  ).toMatchObject({
    availability: 'available',
    reservation: { tokens: safe * 2, indexer: safe * 2, checker: safe * 2 },
  });
  const one = buildCreateIndexCheckRequest({ ...input, urls: [urls[0]!] });
  expect(
    quoteIndexCheckRequest(one, {
      state: 'loaded',
      profiles: {
        google: {
          tokens: Number.MAX_SAFE_INTEGER,
          indexer: 0,
          checker: Number.MAX_SAFE_INTEGER,
        },
      },
    }),
  ).toMatchObject({
    availability: 'available',
    reservation: {
      tokens: Number.MAX_SAFE_INTEGER,
      indexer: 0,
      checker: Number.MAX_SAFE_INTEGER,
    },
  });
  for (const unit of ['tokens', 'indexer', 'checker'] as const) {
    const quote = quoteIndexCheckRequest(prepared, {
      state: 'loaded',
      profiles: { google: { ...perUrl, [unit]: safe + 1 } },
    });
    expect(quote).toMatchObject({
      availability: 'unavailable',
      reason: 'reservation_overflow',
    });
    for (const forbidden of ['fingerprint', 'reservation', 'perUrlReservation'])
      expect(Object.hasOwn(quote, forbidden)).toBe(false);
  }
});

function invalid(value: unknown) {
  expect(createIndexCheckInputSchema.safeParse(value).success).toBe(false);
  try {
    buildCreateIndexCheckRequest(value);
    throw new Error('Expected input rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(CreateIndexCheckError);
    expect((error as CreateIndexCheckError).code).toBe('InvalidInput');
    expect((error as Error).message).toBe(
      'Invalid create-index-check request.',
    );
  }
}
test('IC02 PURE: checker input accepts inclusive counts and rejects new authority/drip and malformed ack', () => {
  const many = Array.from(
    { length: 10_000 },
    (_, i) => `https://example.test/${i}`,
  );
  expect(
    buildCreateIndexCheckRequest({ ...input, urls: [urls[0]!] }).request
      .urlCount,
  ).toBe(1);
  expect(
    buildCreateIndexCheckRequest({ ...input, urls: many }).input.urls,
  ).toEqual(many);
  for (const badUrls of [
    [],
    [...many, 'https://example.test/10000'],
    [urls[0], urls[0]],
  ])
    invalid({ ...input, urls: badUrls });
  for (const field of [
    'dripFeedDays',
    'drip_feed_days',
    'pay_per_indexed',
    'payPerIndexed',
    'drip_feed',
    'providerRoute',
    'policy',
    'caps',
    'reservation',
    'perUrlReservation',
    'price',
    'allowIndexChecks',
    'stateDirectory',
    'credentialFingerprint',
  ])
    invalid({ ...input, [field]: true });
  invalid({ ...input, searchEngine: 'backlink' });
  invalid({ ...input, requestId: 'preview-authority' });
  invalid({
    ...input,
    acknowledgement: {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    },
  });
  invalid({ ...input, mode: 'submit' });
  for (const acknowledgement of [
    null,
    { quoteFingerprint: 'a'.repeat(64) },
    {
      quoteFingerprint: 'A'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    },
    {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
      extra: true,
    },
  ])
    invalid({ ...input, mode: 'submit', requestId: 'id', acknowledgement });
});
test('IC02 PURE: checker escaped body accepts exactly 2 MiB and rejects one extra byte', () => {
  const many = Array.from({ length: 256 }, (_, i) => {
    const head = `https://example.test/${i}/"\\`;
    return head + 'a'.repeat(8_192 - head.length);
  });
  const shell = () =>
    '{"title":"é\\"\\\\","urls":[' +
    many.map((url) => JSON.stringify(url)).join(',') +
    ']}';
  const overflow = Buffer.byteLength(shell(), 'utf8') - 2_097_152;
  expect(overflow).toBeGreaterThan(0);
  many[255] = many[255]!.slice(0, -overflow);
  expect(Buffer.byteLength(shell(), 'utf8')).toBe(2_097_152);
  const built = buildCreateIndexCheckRequest({
    ...input,
    urls: many,
    title: 'é"\\',
  });
  expect(built.body).toBe(shell());
  expect(built.request.payloadDigest).toBe(sha(shell()));
  const over = [...many];
  over[255] += 'a';
  invalid({ ...input, urls: over, title: 'é"\\' });
});

test.each(families)(
  'IC04 PURE: $engine exact root checker ACK permits absent or false flags only',
  (vector) => {
    const prepared = buildCreateIndexCheckRequest({
      ...input,
      searchEngine: vector.engine,
    });
    const taskId = '  opaque /白🦊?%2f  ';
    const ack = { code: 0, task_id: taskId, type: vector.family };
    const expected = { kind: 'accepted', taskId, type: vector.family } as const;
    expect(normalizeCreateIndexCheckOutcome(prepared, 200, ack)).toEqual(
      expected,
    );
    expect(
      normalizeCreateIndexCheckOutcome(prepared, 200, {
        ...ack,
        pay_per_indexed: false,
        drip_feed: false,
        unknown: 'discarded',
      }),
    ).toEqual(expected);
    for (const field of ['pay_per_indexed', 'drip_feed'])
      for (const value of [true, null, 0, 'false', undefined])
        expect(
          normalizeCreateIndexCheckOutcome(prepared, 200, {
            ...ack,
            [field]: value,
          }),
        ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
    for (const drip_feed_days of [undefined, null, false, 2])
      expect(
        normalizeCreateIndexCheckOutcome(prepared, 200, {
          ...ack,
          drip_feed_days,
        }),
      ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  },
);
test('IC04 PURE: malformed/root/type/status/opaque-ID boundaries remain conservative', () => {
  const prepared = buildCreateIndexCheckRequest(input);
  const ack = { code: 0, task_id: 'é'.repeat(2_048), type: 'google/checker' };
  expect(normalizeCreateIndexCheckOutcome(prepared, 200, ack).kind).toBe(
    'accepted',
  );
  for (const bad of [
    null,
    [],
    [ack],
    { code: 0, result: ack },
    { ...ack, code: '0' },
    { ...ack, type: 'google/indexer' },
    { ...ack, type: 'bing/checker' },
    { ...ack, task_id: ack.task_id + 'a' },
    ...['', ' ', '\ud800', 'a\n', null, 1].map((id) => ({
      ...ack,
      task_id: id,
    })),
  ])
    expect(normalizeCreateIndexCheckOutcome(prepared, 200, bad)).toEqual({
      kind: 'unknown',
      cause: 'invalid_ack',
    });
  for (const code of [1, 2] as const) {
    for (const status of [200, 401, 402, 413])
      expect(
        normalizeCreateIndexCheckOutcome(prepared, status, { code }),
      ).toEqual({ kind: 'rejected', code });
    expect(
      normalizeCreateIndexCheckOutcome(prepared, 200, {
        code,
        task_id: undefined,
      }),
    ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  }
  for (const status of [201, 301, 400, 429, 500]) {
    expect(normalizeCreateIndexCheckOutcome(prepared, status, ack)).toEqual({
      kind: 'unknown',
      cause: 'http',
    });
    expect(
      normalizeCreateIndexCheckOutcome(prepared, status, { code: 1 }),
    ).toEqual({ kind: 'unknown', cause: 'http' });
  }
  expect(normalizeCreateIndexCheckOutcome(prepared, 200, { code: 3 })).toEqual({
    kind: 'unknown',
    cause: 'invalid_ack',
  });
});

const prepared = buildCreateIndexCheckRequest(input);
const quoted = quoteIndexCheckRequest(prepared, source);
if (quoted.availability !== 'available')
  throw new Error('Expected synthetic reservation.');
const available = quoted;
const authorization = {
  state: 'configured',
  stateChecked: true,
  mode: 'operator_policy',
  policyRevision: 'synthetic-v1',
  policyDigest: 'c'.repeat(64),
  budgetScope: 'synthetic-scope',
  caps: { tokens: 1000, indexer: 1000, checker: 1000 },
  period: {
    id: 'utc-day:2026-10-21',
    startMs: 1792540800000,
    endMs: 1792627200000,
  },
  fingerprint: 'd'.repeat(64),
} as const;
const intent = {
  requestId: 'synthetic-id',
  state: 'accepted',
  stateVersion: 2,
  createdAtMs: 1792497600000,
  periodId: 'utc-day:2026-10-20',
  periodStartMs: 1792454400000,
  policyRevision: authorization.policyRevision,
  policyDigest: authorization.policyDigest,
  reservation: { tokens: 14, indexer: 10, checker: 22 },
  providerTaskId: ' opaque 白 ',
  providerType: 'google/checker',
} as const;
const accepted = {
  mode: 'submit',
  status: 'accepted',
  request: prepared.request,
  quote: available,
  authorization,
  intent,
} as const;
const observation = {
  kind: 'accepted_ack',
  recorded: true,
  taskId: intent.providerTaskId,
  type: intent.providerType,
} as const;
const unpriced = {
  mode: 'preview',
  status: 'preview',
  request: prepared.request,
  quote: quoteIndexCheckRequest(prepared, { state: 'loaded' }),
  authorization: { state: 'reservation_unavailable', stateChecked: false },
} as const;
function validates(value: unknown, isError: boolean) {
  const result = createIndexCheckToolResult(value);
  expect(result.structuredContent as unknown).toEqual(value);
  expect(result.isError).toBe(isError);
  expect(JSON.parse(result.content[0]!.text)).toEqual(value);
}
function rejects(value: unknown) {
  expect(createIndexCheckResultSchema.safeParse(value).success).toBe(false);
  const result = createIndexCheckToolResult(value);
  expect(result.structuredContent).toEqual({
    status: 'blocked',
    error: createIndexCheckError('InternalError'),
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
}
test('IC05 PURE: available/unavailable preview, fixed errors, durable accepted reads and replay validate with JSON parity', () => {
  validates(unpriced, false);
  validates(
    {
      ...accepted,
      mode: 'preview',
      status: 'preview',
      intent: undefined,
      authorization: { ...authorization, stateChecked: false },
    },
    false,
  );
  validates(accepted, false);
  validates({ ...accepted, observation }, false);
  validates({ ...accepted, replayed: true }, false);
  validates(
    {
      ...unpriced,
      mode: 'submit',
      status: 'blocked',
      error: createIndexCheckError('ReservationProfileRequired'),
    },
    true,
  );
  validates(
    {
      ...unpriced,
      mode: 'submit',
      status: 'blocked',
      authorization: { state: 'disabled', stateChecked: false },
      error: createIndexCheckError('WritesDisabled'),
    },
    true,
  );
  validates(
    { status: 'blocked', error: createIndexCheckError('InvalidInput') },
    true,
  );
  validates(
    {
      ...unpriced,
      mode: 'submit',
      status: 'blocked',
      quote: quoteIndexCheckRequest(prepared, {
        state: 'loaded',
        profiles: { google: { ...perUrl, tokens: Number.MAX_SAFE_INTEGER } },
      }),
      error: createIndexCheckError('ReservationOverflow'),
    },
    true,
  );
});
test('IC05 PURE: unavailable quote cannot invent units/hash/authority or claim any execution state', () => {
  for (const quote of [
    { ...unpriced.quote, fingerprint: 'a'.repeat(64) },
    { ...unpriced.quote, fingerprint: null },
    { ...unpriced.quote, reservation: { tokens: 0, indexer: 0, checker: 0 } },
    { ...unpriced.quote, perUrlReservation: perUrl },
    { ...unpriced.quote, providerFeesKnown: true },
    { ...unpriced.quote, maximumExposure: perUrl },
  ])
    rejects({ ...unpriced, quote });
  for (const invalid of [
    { ...unpriced, intent },
    { ...unpriced, replayed: true },
    { ...unpriced, authorization: { ...authorization, stateChecked: false } },
    { ...accepted, quote: unpriced.quote },
    {
      ...unpriced,
      mode: 'submit',
      status: 'blocked',
      observation,
      error: createIndexCheckError('ReservationProfileRequired'),
    },
    {
      ...unpriced,
      authorization: {
        state: 'reservation_unavailable',
        stateChecked: false,
        fingerprint: 'a'.repeat(64),
      },
    },
  ])
    rejects(invalid);
});
test('IC05 PURE: quote/intent/family/authority/error corruption sanitizes application output', () => {
  for (const invalid of [
    { ...accepted, quote: { ...available, reason: 'profile_missing' } },
    { ...accepted, quote: { ...available, fingerprint: 'f'.repeat(64) } },
    {
      ...accepted,
      quote: {
        ...available,
        reservation: { ...available.reservation, checker: 1 },
      },
    },
    {
      ...accepted,
      quote: { ...available, perUrlReservation: { ...perUrl, tokens: 1 } },
    },
    { ...accepted, request: { ...prepared.request, urlCount: 3 } },
    {
      ...accepted,
      request: {
        ...prepared.request,
        providerRoute: '/v2/task/bing/checker/create',
      },
    },
    {
      ...accepted,
      intent: {
        ...intent,
        reservation: { tokens: 14, indexer: 10, checker: 0 },
      },
    },
    { ...accepted, intent: { ...intent, providerType: 'bing/checker' } },
    { ...accepted, intent: { ...intent, policyDigest: 'e'.repeat(64) } },
    { ...accepted, intent: { ...intent, policyRevision: 'other' } },
    { ...accepted, intent: undefined },
    { ...accepted, replayed: false },
    { ...accepted, observation, replayed: true },
    { ...accepted, observation: { ...observation, taskId: 'mismatch' } },
    { ...accepted, observation: { ...observation, recorded: false } },
    {
      ...accepted,
      observation: { kind: 'ambiguous', recorded: false, cause: 'transport' },
    },
    { ...accepted, authorization: { ...authorization, stateChecked: false } },
    { ...accepted, authorization: { ...authorization, state: 'disabled' } },
    { ...accepted, rawBody: 'private' },
    {
      ...unpriced,
      mode: 'submit',
      status: 'blocked',
      error: { code: 'WritesDisabled', message: 'raw private/path/key' },
    },
  ])
    rejects(invalid);
});
test('IC05 PURE: unrecorded HTTP evidence requires a held claim or an unavailable postclaim reread', () => {
  const { providerTaskId: _id, providerType: _type, ...held } = intent;
  const pending = {
    ...accepted,
    status: 'dispatching',
    intent: { ...held, state: 'dispatching', stateVersion: 1 },
    observation: { ...observation, taskId: _id, type: _type, recorded: false },
    error: createIndexCheckError('OutcomePersistenceFailed'),
  };
  validates(pending, true);
  const unavailable = {
    ...pending,
    status: 'blocked',
    intent: undefined,
    error: {
      ...createIndexCheckError('StateUnavailable'),
      lastObservedState: 'dispatching',
    },
  };
  validates(unavailable, true);
  for (const invalid of [
    { ...pending, error: createIndexCheckError('OutcomeUnknown') },
    { ...pending, observation: { ...observation, recorded: true } },
    { ...unavailable, error: createIndexCheckError('StateUnavailable') },
    { ...unavailable, observation: undefined },
    {
      ...unavailable,
      authorization: { state: 'disabled', stateChecked: false },
    },
    { ...pending, error: { ...pending.error, unit: 'tokens' } },
  ])
    rejects(invalid);
  validates(
    {
      ...pending,
      status: 'unknown',
      intent: { ...held, state: 'unknown', stateVersion: 2 },
      observation: { kind: 'ambiguous', recorded: true, cause: 'transport' },
      error: createIndexCheckError('OutcomeUnknown'),
    },
    true,
  );
});
