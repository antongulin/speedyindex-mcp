import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildCreateBacklinkCheckRequest,
  CreateBacklinkCheckError,
  createBacklinkCheckError,
  createBacklinkCheckInputSchema,
  createBacklinkCheckResultSchema,
  createBacklinkCheckToolResult,
  normalizeCreateBacklinkCheckOutcome,
  quoteBacklinkCheckRequest,
} from '../src/create-backlink-check';
import type { BacklinkCheckReservationSource } from '../src/submission-contract';

const urls = [
  'HTTPS://Example.TEST/%2f?b=2&a=1#fragment',
  'https://donor.test/白🦊/',
];
const targetDomains = [' Example.COM ', '例え.テスト', ' Example.COM '];
const title = '  白 "title" \\ 🦊  ';
const expectedBody =
  '{"title":"  白 \\"title\\" \\\\ 🦊  ","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment","https://donor.test/白🦊/"],"target_domains":[" Example.COM ","例え.テスト"," Example.COM "]}';
const input = { mode: 'preview', urls, targetDomains, title } as const;
// Synthetic local declarations only; these numbers are not provider fees.
const perUrlReservation = { tokens: 3, indexer: 0, checker: 7 };
const source: BacklinkCheckReservationSource = {
  state: 'loaded',
  profile: perUrlReservation,
};

function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(value: unknown) {
  expect(createBacklinkCheckInputSchema.safeParse(value).success).toBe(false);
  let caught: unknown;
  try {
    buildCreateBacklinkCheckRequest(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CreateBacklinkCheckError);
  expect((caught as CreateBacklinkCheckError).code).toBe('InvalidInput');
  expect((caught as Error).message).toBe(
    'Invalid create-backlink-check request.',
  );
}

test('BC01 PURE: exact provider wire order preserves donor and target text, order, and duplicates', () => {
  const original = {
    ...input,
    urls: [...urls],
    targetDomains: [...targetDomains],
  };
  const prepared = buildCreateBacklinkCheckRequest(original);
  expect(prepared.body).toBe(expectedBody);
  expect(prepared.request).toEqual({
    family: 'backlink/checker',
    providerRoute: '/v2/task/backlink/checker/create',
    urlCount: 2,
    targetDomainCount: 3,
    providerBodyBytes: Buffer.byteLength(expectedBody, 'utf8'),
    payloadDigest: sha(expectedBody),
  });
  expect(prepared.input.urls).toEqual(urls);
  expect(prepared.input.targetDomains).toEqual(targetDomains);
  original.urls.reverse();
  original.targetDomains[0] = 'mutated.test';
  expect(prepared.input.urls).toEqual(urls);
  expect(prepared.input.targetDomains).toEqual(targetDomains);
  expect(() =>
    (prepared.input.targetDomains as string[]).push('other.test'),
  ).toThrow();
  expect(() => Object.assign(prepared.input, { title: 'changed' })).toThrow();
  expect(() =>
    Object.assign(prepared.request, { targetDomainCount: 1 }),
  ).toThrow();

  const omittedTitle = buildCreateBacklinkCheckRequest({
    mode: 'preview',
    urls: [urls[0]!],
    targetDomains: ['Example.test'],
  });
  const emptyTitle = buildCreateBacklinkCheckRequest({
    ...omittedTitle.input,
    title: '',
  });
  expect(omittedTitle.body).toBe(
    '{"urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment"],"target_domains":["Example.test"]}',
  );
  expect(emptyTitle.body).toBe(
    '{"title":"","urls":["HTTPS://Example.TEST/%2f?b=2&a=1#fragment"],"target_domains":["Example.test"]}',
  );
  expect(emptyTitle.request.payloadDigest).not.toBe(
    omittedTitle.request.payloadDigest,
  );
});

test('BC01 PURE: bounded target text accepts exact UTF-8 edge and rejects malformed or unsafe text', () => {
  const exactDomain = 'é'.repeat(4_096);
  expect(Buffer.byteLength(exactDomain, 'utf8')).toBe(8_192);
  const accepted = buildCreateBacklinkCheckRequest({
    mode: 'preview',
    urls: [urls[0]!],
    targetDomains: [exactDomain],
  });
  expect(accepted.input.targetDomains).toEqual([exactDomain]);
  expect(() =>
    buildCreateBacklinkCheckRequest({
      mode: 'preview',
      urls: [urls[0]!],
      targetDomains: ['é'.repeat(4_096) + 'x'],
    }),
  ).toThrow('Invalid create-backlink-check request.');

  for (const badDomains of [
    [],
    [''],
    ['   '],
    ['\u00a0'],
    ['a\0b'],
    ['a\tb'],
    ['a\nb'],
    ['a\x7fb'],
    ['\ud800'],
    Array.from({ length: 51 }, () => 'example.test'),
  ])
    invalid({ ...input, targetDomains: badDomains });

  const fifty = buildCreateBacklinkCheckRequest({
    mode: 'preview',
    urls: [urls[0]!],
    targetDomains: Array.from({ length: 50 }, (_, index) => `d${index}.test`),
  });
  expect(fifty.request.targetDomainCount).toBe(50);
});

test('BC01 PURE: exact 2 MiB body is accepted and one extra byte is rejected', () => {
  const limit = 2 * 1_024 * 1_024;
  const urlOfLength = (index: number, length: number) => {
    const prefix = `https://length.test/${String(index).padStart(4, '0')}/`;
    if (prefix.length > length)
      throw new Error('URL boundary fixture too short.');
    return prefix + 'a'.repeat(length - prefix.length);
  };
  const prefixUrls = Array.from({ length: 255 }, (_, index) =>
    urlOfLength(index, 8_192),
  );
  const shortUrl = 'https://length.test/x';
  const shortBody = JSON.stringify({
    urls: [...prefixUrls, shortUrl],
    target_domains: ['target.test'],
  });
  const lastUrlLength =
    Buffer.byteLength(shortUrl, 'utf8') +
    limit -
    Buffer.byteLength(shortBody, 'utf8');
  expect(lastUrlLength).toBeGreaterThan(0);
  expect(lastUrlLength).toBeLessThan(8_192);
  const urlsAtLimit = [...prefixUrls, urlOfLength(255, lastUrlLength)];
  const exact = buildCreateBacklinkCheckRequest({
    mode: 'preview',
    urls: urlsAtLimit,
    targetDomains: ['target.test'],
  });
  expect(exact.request.providerBodyBytes).toBe(limit);
  invalid({
    mode: 'preview',
    urls: [...prefixUrls, urlOfLength(255, lastUrlLength + 1)],
    targetDomains: ['target.test'],
  });
});

test('BC01 PURE: strict input rejects missing/duplicate donors, authority in preview, and unknown fields', () => {
  invalid({ ...input, targetDomains: undefined });
  invalid({ ...input, urls: [urls[0]!, urls[0]!] });
  invalid({ ...input, urls: [] });
  invalid({ ...input, extra: true });
  invalid({ ...input, requestId: undefined });
  invalid({ ...input, acknowledgement: undefined });
  invalid({ ...input, mode: 'submit' });
  invalid({ ...input, mode: 'submit', requestId: 'local-id', extra: true });
});

test('BC01 PURE: donor count accepts 10,000 exact ordered URLs and rejects 10,001', () => {
  const donors = Array.from(
    { length: 10_000 },
    (_, index) => `https://donor.test/${index}`,
  );
  const boundaryInput = {
    mode: 'preview',
    urls: donors,
    targetDomains: ['target.test'],
  };
  expect(createBacklinkCheckInputSchema.safeParse(boundaryInput).success).toBe(
    true,
  );
  const request = buildCreateBacklinkCheckRequest(boundaryInput);
  expect(request.request.urlCount).toBe(10_000);
  expect(request.input.urls).toEqual(donors);
  expect(JSON.parse(request.body)).toEqual({
    urls: donors,
    target_domains: ['target.test'],
  });
  invalid({
    ...boundaryInput,
    urls: [...donors, 'https://donor.test/10000'],
  });
});

test('BC02 PURE: quote binds exact body, both counts, family, route, and selected vector in the accepted field order', () => {
  const prepared = buildCreateBacklinkCheckRequest(input);
  const expectedReservation = { tokens: 6, indexer: 0, checker: 14 };
  const fingerprint = sha(
    'speedyindex-create-backlink-check-reservation-v1\0' +
      JSON.stringify({
        version: 'speedyindex-backlink-check-reservation-2026-10-21-v1',
        family: 'backlink/checker',
        providerRoute: '/v2/task/backlink/checker/create',
        payloadDigest: sha(expectedBody),
        urlCount: 2,
        targetDomainCount: 3,
        perUrlReservation: { tokens: 3, indexer: 0, checker: 7 },
        reservation: expectedReservation,
      }),
  );
  const quote = quoteBacklinkCheckRequest(prepared, source);
  expect(quote).toEqual({
    version: 'speedyindex-backlink-check-reservation-2026-10-21-v1',
    basis: 'operator_configured_reservation',
    providerEnforced: false,
    providerFeesKnown: false,
    availability: 'available',
    perUrlReservation,
    reservation: expectedReservation,
    fingerprint,
  });
  expect(() => Object.assign(quote, { providerFeesKnown: true })).toThrow();
  if (quote.availability !== 'available')
    throw new Error('Expected an explicit synthetic reservation.');
  expect(() =>
    Object.assign(quote.perUrlReservation, { checker: 0 }),
  ).toThrow();
  expect(() => Object.assign(quote.reservation, { tokens: 0 })).toThrow();

  const submitted = buildCreateBacklinkCheckRequest({
    ...input,
    mode: 'submit',
    requestId: 'synthetic-request',
    acknowledgement: {
      quoteFingerprint: 'a'.repeat(64),
      authorizationFingerprint: 'b'.repeat(64),
    },
  });
  expect(quoteBacklinkCheckRequest(submitted, source)).toEqual(quote);
  for (const changed of [
    { ...input, targetDomains: [' example.com ', ...targetDomains.slice(1)] },
    {
      ...input,
      targetDomains: [targetDomains[1]!, targetDomains[2]!, targetDomains[0]!],
    },
    { ...input, targetDomains: targetDomains.slice(0, 2) },
    { ...input, urls: [...urls].reverse() },
    { ...input, title: '' },
  ])
    expect(
      quoteBacklinkCheckRequest(
        buildCreateBacklinkCheckRequest(changed),
        source,
      ),
    ).not.toEqual(quote);
  for (const unit of ['tokens', 'indexer', 'checker'] as const)
    expect(
      quoteBacklinkCheckRequest(prepared, {
        state: 'loaded',
        profile: { ...perUrlReservation, [unit]: perUrlReservation[unit] + 1 },
      }),
    ).not.toEqual(quote);
});

test.each([
  { source: { state: 'unconfigured' }, reason: 'policy_unconfigured' },
  { source: { state: 'invalid' }, reason: 'policy_invalid' },
  { source: { state: 'loaded' }, reason: 'profile_missing' },
] as const)(
  'BC02 PURE: $reason quote omits invented units and fingerprints',
  ({ source: missing, reason }) => {
    const quote = quoteBacklinkCheckRequest(
      buildCreateBacklinkCheckRequest(input),
      missing,
    );
    expect(quote).toEqual({
      version: 'speedyindex-backlink-check-reservation-2026-10-21-v1',
      basis: 'operator_configured_reservation',
      providerEnforced: false,
      providerFeesKnown: false,
      availability: 'unavailable',
      reason,
    });
    for (const field of [
      'perUrlReservation',
      'reservation',
      'fingerprint',
      'intent',
      'observation',
      'authorization',
    ])
      expect(Object.hasOwn(quote, field)).toBe(false);
  },
);

test('BC02 PURE: exact BigInt products are retained and each overflowing unit makes the quote unavailable', () => {
  const prepared = buildCreateBacklinkCheckRequest(input);
  const safeHalf = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  const safe = quoteBacklinkCheckRequest(prepared, {
    state: 'loaded',
    profile: { tokens: safeHalf, indexer: safeHalf, checker: safeHalf },
  });
  expect(safe).toMatchObject({
    availability: 'available',
    reservation: {
      tokens: safeHalf * 2,
      indexer: safeHalf * 2,
      checker: safeHalf * 2,
    },
  });
  for (const unit of ['tokens', 'indexer', 'checker'] as const) {
    const overflow = quoteBacklinkCheckRequest(prepared, {
      state: 'loaded',
      profile: {
        tokens: safeHalf,
        indexer: safeHalf,
        checker: safeHalf,
        [unit]: safeHalf + 1,
      },
    });
    expect(overflow).toMatchObject({
      availability: 'unavailable',
      reason: 'reservation_overflow',
    });
    for (const field of ['perUrlReservation', 'reservation', 'fingerprint'])
      expect(Object.hasOwn(overflow, field)).toBe(false);
  }
});

test('BC04 PURE: only the exact root backlink ACK is accepted and provider extras are discarded', () => {
  const prepared = buildCreateBacklinkCheckRequest(input);
  const taskId = '  opaque /白🦊?%2f  ';
  const ack = { code: 0, task_id: taskId, type: 'backlink/checker' };
  const accepted = {
    kind: 'accepted',
    taskId,
    type: 'backlink/checker',
  } as const;
  expect(normalizeCreateBacklinkCheckOutcome(prepared, 200, ack)).toEqual(
    accepted,
  );
  expect(
    normalizeCreateBacklinkCheckOutcome(prepared, 200, {
      ...ack,
      pay_per_indexed: false,
      drip_feed: false,
      ignored: 'provider text is not returned',
    }),
  ).toEqual(accepted);
  for (const field of ['pay_per_indexed', 'drip_feed'])
    for (const value of [true, null, 0, 'false', undefined])
      expect(
        normalizeCreateBacklinkCheckOutcome(prepared, 200, {
          ...ack,
          [field]: value,
        }),
      ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  for (const drip_feed_days of [undefined, null, false, 2])
    expect(
      normalizeCreateBacklinkCheckOutcome(prepared, 200, {
        ...ack,
        drip_feed_days,
      }),
    ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
});

test('BC04 PURE: malformed ACKs, unsafe IDs, wrong type, and ambiguous HTTP outcomes stay unknown', () => {
  const prepared = buildCreateBacklinkCheckRequest(input);
  const ack = {
    code: 0,
    task_id: 'opaque-task',
    type: 'backlink/checker',
  };
  for (const response of [
    null,
    [],
    { code: 0, result: ack },
    { ...ack, code: '0' },
    { ...ack, type: 'google/checker' },
    ...['', ' ', '\ud800', 'a\n', null, 1].map((task_id) => ({
      ...ack,
      task_id,
    })),
  ])
    expect(
      normalizeCreateBacklinkCheckOutcome(prepared, 200, response),
    ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  for (const code of [1, 2] as const) {
    for (const status of [200, 401, 402, 413])
      expect(
        normalizeCreateBacklinkCheckOutcome(prepared, status, { code }),
      ).toEqual({ kind: 'rejected', code });
    expect(
      normalizeCreateBacklinkCheckOutcome(prepared, 200, {
        code,
        task_id: undefined,
      }),
    ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
  }
  for (const status of [201, 301, 400, 429, 500])
    expect(normalizeCreateBacklinkCheckOutcome(prepared, status, ack)).toEqual({
      kind: 'unknown',
      cause: 'http',
    });
  expect(
    normalizeCreateBacklinkCheckOutcome(prepared, 200, { code: 3 }),
  ).toEqual({ kind: 'unknown', cause: 'invalid_ack' });
});

const prepared = buildCreateBacklinkCheckRequest(input);
const quoted = quoteBacklinkCheckRequest(prepared, source);
if (quoted.availability !== 'available')
  throw new Error('Expected an explicit synthetic quote.');
const authorization = {
  state: 'configured',
  stateChecked: true,
  mode: 'operator_policy',
  policyRevision: 'synthetic-v1',
  policyDigest: 'c'.repeat(64),
  budgetScope: 'synthetic-scope',
  caps: { tokens: 100, indexer: 100, checker: 100 },
  period: { id: 'utc-day:2026-10-21', startMs: 0, endMs: 86_400_000 },
  fingerprint: 'd'.repeat(64),
} as const;
const acceptedIntent = {
  requestId: 'synthetic-request',
  state: 'accepted',
  stateVersion: 1,
  createdAtMs: 1,
  periodId: 'utc-day:2026-10-21',
  periodStartMs: 0,
  policyRevision: authorization.policyRevision,
  policyDigest: authorization.policyDigest,
  reservation: quoted.reservation,
  providerTaskId: 'opaque-provider-task',
  providerType: 'backlink/checker',
} as const;
const acceptedResult = {
  mode: 'submit',
  status: 'accepted',
  request: prepared.request,
  quote: quoted,
  authorization,
  intent: acceptedIntent,
  observation: {
    kind: 'accepted_ack',
    recorded: true,
    taskId: acceptedIntent.providerTaskId,
    type: 'backlink/checker',
  },
} as const;

test('BC04 PURE: accepted intents allow durable replay without observation but reject unrecorded or mismatched ACKs', () => {
  expect(
    createBacklinkCheckResultSchema.safeParse(acceptedResult).success,
  ).toBe(true);
  expect(
    createBacklinkCheckResultSchema.safeParse({
      ...acceptedResult,
      observation: { ...acceptedResult.observation, recorded: false },
    }).success,
  ).toBe(false);
  const unobserved = { ...acceptedResult } as Record<string, unknown>;
  delete unobserved.observation;
  expect(createBacklinkCheckResultSchema.safeParse(unobserved).success).toBe(
    true,
  );
  expect(
    createBacklinkCheckResultSchema.safeParse({
      ...unobserved,
      replayed: true,
    }).success,
  ).toBe(true);
  expect(
    createBacklinkCheckResultSchema.safeParse({
      ...acceptedResult,
      observation: {
        ...acceptedResult.observation,
        taskId: 'different-synthetic-task',
      },
    }).success,
  ).toBe(false);
  expect(
    createBacklinkCheckResultSchema.safeParse({
      ...acceptedResult,
      observation: {
        ...acceptedResult.observation,
        type: 'google/checker',
      },
    }).success,
  ).toBe(false);
  const replay = {
    mode: 'submit',
    status: 'accepted',
    request: prepared.request,
    quote: quoted,
    authorization,
    replayed: true,
    intent: acceptedIntent,
  };
  expect(createBacklinkCheckResultSchema.safeParse(replay).success).toBe(true);
});

test('BC04 PURE: tool formatter reports safe application errors and text/structured parity', () => {
  const preview = {
    mode: 'preview',
    status: 'preview',
    request: prepared.request,
    quote: quoted,
    authorization: { state: 'credential_missing', stateChecked: false },
  } as const;
  const formattedPreview = createBacklinkCheckToolResult(preview);
  expect(formattedPreview.isError).toBe(false);
  expect(formattedPreview.content[0]?.text).toBe(
    JSON.stringify(formattedPreview.structuredContent),
  );
  expect(formattedPreview.structuredContent).toEqual(preview);

  const formattedAccepted = createBacklinkCheckToolResult(acceptedResult);
  expect(formattedAccepted.isError).toBe(false);
  expect(formattedAccepted.content[0]?.text).toBe(
    JSON.stringify(formattedAccepted.structuredContent),
  );

  const blocked = createBacklinkCheckToolResult({
    status: 'blocked',
    error: createBacklinkCheckError('InvalidInput'),
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.structuredContent.error?.code).toBe('InvalidInput');
  expect(blocked.content[0]?.text).toBe(
    JSON.stringify(blocked.structuredContent),
  );

  const secret = 'synthetic-key-and-private-path';
  const malformed = createBacklinkCheckToolResult({
    ...acceptedResult,
    error: { code: 'ProviderRejected', message: secret },
  });
  expect(malformed.isError).toBe(true);
  expect(malformed.structuredContent.error?.code).toBe('InternalError');
  expect(malformed.content[0]?.text).toBe(
    JSON.stringify(malformed.structuredContent),
  );
  expect(JSON.stringify(malformed)).not.toContain(secret);

  for (const corrupt of [
    {
      ...acceptedResult,
      request: { ...prepared.request, family: 'google/checker' },
    },
    {
      ...acceptedResult,
      request: { ...prepared.request, targetDomainCount: 51 },
    },
    { ...acceptedResult, quote: { ...quoted, fingerprint: 'f'.repeat(64) } },
  ]) {
    const sanitized = createBacklinkCheckToolResult(corrupt);
    expect(sanitized.structuredContent.error?.code).toBe('InternalError');
    expect(sanitized.content[0]?.text).toBe(
      JSON.stringify(sanitized.structuredContent),
    );
  }
});
