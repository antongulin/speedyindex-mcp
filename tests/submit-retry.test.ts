import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { IndexingObservation } from '../src/create-indexing-task';
import {
  retryPlanComparisonSchema,
  retryPlanPreimageSchema,
} from '../src/plan-retry-result';
import {
  lowerSubmitRetryResultByteLimit,
  parseSubmitRetryInput,
  reconstructSubmitRetry,
  SubmitRetryError,
  submitRetryError,
  submitRetryErrorSchema,
  submitRetryInputSchema,
  submitRetryResultSchema,
  submitRetryToolResult,
  type SubmitRetryInput,
} from '../src/submit-retry';
import { computeSubmissionAuthorizationFingerprint } from '../src/submission-policy';

type Preimage = SubmitRetryInput['expectedPlan']['identity']['preimage'];
type State =
  | 'prepared'
  | 'dispatching'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'cancelled';
const version = 'speedyindex-indexing-batch-2026-10-20-v1' as const;
const binding = '1'.repeat(64);
const currentCaps = { tokens: 0, indexer: 0, checker: 0 };
const trusted = () => ({
  credentialFingerprint: binding,
  currentCaps: { ...currentCaps },
});
const A = 'https://EXAMPLE.test/A?b=1&a=2';
const B = 'https://example.test/A/?b=1&a=2';
const period = {
  id: 'utc-day:2026-10-20',
  startMs: Date.parse('2026-10-20T00:00:00Z'),
  endMs: Date.parse('2026-10-21T00:00:00Z'),
};
const sha = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const H = (domain: string, value: unknown) =>
  sha(domain + '\0' + JSON.stringify(value));
// These oracles enumerate the documented bytes/tuples, never production hash functions.
function authorization(
  input: SubmitRetryInput,
  credentialFingerprint = binding,
) {
  const { expectedPlan: e } = input;
  const p = e.identity.preimage;
  return H('speedyindex-submission-authorization-v1', {
    quoteFingerprint: p.quoteFingerprint,
    policyDigest: p.policyDigest,
    credentialFingerprint,
    budgetScope: e.budgetScope,
    periodId: p.period.id,
    periodStartMs: p.period.startMs,
  });
}
function fingerprint(p: Preimage) {
  return H('speedyindex-retry-plan-v1', [
    p.parent.family,
    p.parent.taskId,
    p.provenance,
    p.originalManifestKnown,
    p.manifestProvenance,
    p.sourceManifestDigest,
    p.safetyEvidenceDigests,
    p.partitionDigest,
    p.revision,
    p.policyDigest,
    p.authorizationFingerprint,
    p.payloadDigest,
    p.quoteVersion,
    p.quoteFingerprint,
    [p.period.id, p.period.startMs, p.period.endMs],
    p.providerRoute,
    p.urlCount,
    p.providerBodyBytes,
    [p.reservation.tokens, p.reservation.indexer, p.reservation.checker],
  ]);
}
function recommit(input: SubmitRetryInput, auth = false) {
  const copy = structuredClone(input);
  if (auth)
    copy.expectedPlan.identity.preimage.authorizationFingerprint =
      authorization(copy);
  copy.expectedPlan.identity.fingerprint = fingerprint(
    copy.expectedPlan.identity.preimage,
  );
  return copy;
}
function fixture(
  engine: 'google' | 'yandex' = 'google',
  provenance: Preimage['provenance'] = engine === 'google'
    ? 'local_standalone'
    : 'external_unattributed',
  urls: readonly string[] = [A, B],
) {
  const body =
    engine === 'google'
      ? JSON.stringify({ urls, pay_per_indexed: true, drip_feed: false })
      : JSON.stringify({ urls });
  const family = `${engine}/indexer` as const;
  const providerRoute = `/v2/task/${engine}/indexer/create` as const;
  const payloadDigest = sha(body);
  const reservation =
    engine === 'google'
      ? { tokens: 100 * urls.length, indexer: 0, checker: 0 }
      : { tokens: 20 * urls.length, indexer: urls.length, checker: 0 };
  const quoteFingerprint = H('speedyindex-create-quote-v1', {
    version,
    family,
    providerRoute,
    payloadDigest,
    urlCount: urls.length,
    maximumExposure: reservation,
  });
  const p: Preimage = {
    parent: { family, taskId: 'parent-é"\\' },
    provenance,
    originalManifestKnown: provenance !== 'external_unattributed',
    manifestProvenance:
      provenance === 'external_unattributed'
        ? 'provider_report_observed_corpus'
        : 'durable_local_intent_ack',
    sourceManifestDigest: '2'.repeat(64),
    safetyEvidenceDigests: ['3'.repeat(64), '4'.repeat(64), '3'.repeat(64)],
    partitionDigest: '5'.repeat(64),
    revision: '6'.repeat(64),
    policyDigest: '7'.repeat(64),
    authorizationFingerprint: '0'.repeat(64),
    payloadDigest,
    quoteVersion: version,
    quoteFingerprint,
    period: { ...period },
    providerRoute,
    urlCount: urls.length,
    providerBodyBytes: Buffer.from(body, 'utf8').length,
    reservation,
  };
  const input: SubmitRetryInput = {
    requestId: 'retry-01',
    expectedPlan: {
      searchEngine: engine,
      eligibleUrls: [...urls],
      budgetScope: 'original-scope',
      policyRevision: 'original-policy',
      identity: {
        status: 'comparison',
        preimage: p,
        fingerprint: '0'.repeat(64),
      },
    },
  };
  input.expectedPlan.identity.preimage.authorizationFingerprint =
    authorization(input);
  input.expectedPlan.identity.fingerprint = fingerprint(p);
  return {
    input,
    body,
    request: {
      family,
      providerRoute,
      urlCount: urls.length,
      providerBodyBytes: p.providerBodyBytes,
      payloadDigest,
    },
    quote: {
      version,
      fingerprint: quoteFingerprint,
      maximumExposure: { ...reservation },
      basis: 'documented_independent_maxima' as const,
      providerEnforced: false as const,
    },
  };
}
function changed<T>(
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
function expectInvalid(value: unknown) {
  expect(() => reconstructSubmitRetry(value, trusted())).toThrow(
    SubmitRetryError,
  );
  try {
    reconstructSubmitRetry(value, trusted());
  } catch (error) {
    expect(error).toMatchObject({
      code: 'InvalidInput',
      message: 'Invalid retry-submission input.',
    });
  }
}
function expectFrozen(value: unknown) {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}
function data(f = fixture()) {
  const p = f.input.expectedPlan.identity.preimage;
  return {
    request: f.request,
    quote: f.quote,
    retry: {
      parent: { ...p.parent },
      sourceManifestDigest: p.sourceManifestDigest,
      planFingerprint: f.input.expectedPlan.identity.fingerprint,
    },
  };
}
function durable(
  state: State,
  replayed = false,
  observation?: IndexingObservation,
  f = fixture(),
) {
  const p = f.input.expectedPlan.identity.preimage;
  return {
    status: state,
    requestId: f.input.requestId,
    replayed,
    ...data(f),
    intent: {
      requestId: f.input.requestId,
      state,
      stateVersion:
        state === 'prepared'
          ? 0
          : state === 'dispatching' || state === 'cancelled'
            ? 1
            : 2,
      createdAtMs: p.period.startMs + 1_000,
      periodId: p.period.id,
      periodStartMs: p.period.startMs,
      policyRevision: f.input.expectedPlan.policyRevision,
      policyDigest: p.policyDigest,
      reservation: { ...p.reservation },
      ...(state === 'accepted'
        ? { providerTaskId: 'child-é"\\', providerType: f.request.family }
        : {}),
    },
    ...(state === 'accepted'
      ? {}
      : {
          error: submitRetryError(
            observation && !observation.recorded
              ? 'OutcomePersistenceFailed'
              : state === 'cancelled'
                ? 'Cancelled'
                : state === 'unknown'
                  ? 'OutcomeUnknown'
                  : 'DispatchClaimLost',
          ),
        }),
    ...(observation ? { observation } : {}),
  };
}
function evidence(value = durable('accepted')) {
  return {
    kind: 'durable' as const,
    request: value.request,
    quote: value.quote,
    retry: value.retry,
    intent: value.intent,
    ...(value.observation ? { observation: value.observation } : {}),
  };
}
function observed(
  kind: IndexingObservation['kind'],
  recorded: boolean,
  f = fixture(),
): IndexingObservation {
  switch (kind) {
    case 'accepted_ack':
      return { kind, recorded, taskId: 'child-é"\\', type: f.request.family };
    case 'provider_rejection':
      return { kind, recorded, code: 2 };
    case 'not_sent':
      return { kind, recorded, cause: 'local_validation' };
    case 'ambiguous':
      return { kind, recorded, cause: 'transport' };
  }
}
function expectedEnvelope(value: unknown, isError: boolean) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}
const bytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').length;
function expectGoodResult(value: unknown) {
  expect(submitRetryResultSchema.safeParse(value).success).toBe(true);
  const result = submitRetryToolResult(value);
  expect<unknown>(result.structuredContent).toEqual(value);
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]!.text)).toEqual(value);
  expectFrozen(result);
  expect(bytes(result)).toBeLessThanOrEqual(2_097_152);
  return result;
}
function expectBadResult(value: unknown) {
  expect(submitRetryResultSchema.safeParse(value).success).toBe(false);
  const result = submitRetryToolResult(value);
  expect(result.structuredContent).toEqual({
    status: 'error',
    error: {
      code: 'InternalError',
      message: 'Retry submission failed internally.',
    },
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  expect(
    submitRetryResultSchema.safeParse(result.structuredContent).success,
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
}

describe('SR-D01-A pure boundaries', () => {
  const denyIo = () => {
    throw new Error('Unexpected pure-layer I/O.');
  };
  let guards: { mock: { calls: unknown[] }; mockRestore(): void }[] = [];
  beforeEach(() => {
    guards = [
      spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(denyIo, { preconnect: denyIo }),
      ),
      spyOn(fs, 'openSync').mockImplementation(denyIo),
      spyOn(fs, 'readFileSync').mockImplementation(denyIo),
      spyOn(fs, 'lstatSync').mockImplementation(denyIo),
      spyOn(fs, 'mkdirSync').mockImplementation(denyIo),
      spyOn(fs, 'writeFileSync').mockImplementation(denyIo),
      spyOn(Database.prototype, 'query').mockImplementation(denyIo),
      spyOn(Database.prototype, 'exec').mockImplementation(denyIo),
      spyOn(Database.prototype, 'prepare').mockImplementation(denyIo),
    ];
  });
  afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    for (const guard of guards) guard.mockRestore();
    expect(calls.every((count) => count === 0)).toBe(true);
  });

  test('SR-D01-A Google local and Yandex external exact body/quote/auth/canonical tuple oracles and current caps are comparison scaffolding', () => {
    for (const [engine, provenance, body] of [
      [
        'google',
        'local_standalone',
        '{"urls":["https://EXAMPLE.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}',
      ],
      [
        'yandex',
        'external_unattributed',
        '{"urls":["https://EXAMPLE.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"]}',
      ],
      [
        'google',
        'legacy_unattributed',
        '{"urls":["https://EXAMPLE.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}',
      ],
    ] as const) {
      const f = fixture(engine, provenance);
      const input = f.input;
      input.acknowledgement = {
        quoteFingerprint: 'a'.repeat(64),
        authorizationFingerprint: 'b'.repeat(64),
      };
      const captured = trusted();
      const built = reconstructSubmitRetry(input, captured);
      expect(submitRetryInputSchema.safeParse(input).success).toBe(true);
      expect(built.request.body).toBe(body);
      expect(built.request.request).toEqual(f.request);
      expect(built.request.quote).toEqual(f.quote);
      const p = input.expectedPlan.identity.preimage;
      expect(built.replay).toEqual({
        intent: {
          requestId: 'retry-01',
          budget: {
            credentialFingerprint: binding,
            budgetScope: 'original-scope',
            periodId: period.id,
            periodStartMs: period.startMs,
            policyRevision: 'original-policy',
            policyDigest: p.policyDigest,
            caps: currentCaps,
          },
          taskFamily: f.request.family,
          providerRoute: f.request.providerRoute,
          payloadDigest: sha(body),
          submittedUrls: [A, B],
          quoteVersion: version,
          quoteFingerprint: f.quote.fingerprint,
          reservation: f.quote.maximumExposure,
        },
        parent: p.parent,
        sourceManifestDigest: p.sourceManifestDigest,
        planFingerprint: fingerprint(p),
      });
      expect(p.authorizationFingerprint).toBe(authorization(input));
      expect(
        computeSubmissionAuthorizationFingerprint({
          quoteFingerprint: p.quoteFingerprint,
          policyDigest: p.policyDigest,
          credentialFingerprint: binding,
          budgetScope: 'original-scope',
          periodId: period.id,
          periodStartMs: period.startMs,
        }),
      ).toBe(authorization(input));
      expect(built.replay.intent.reservation.tokens).toBeGreaterThan(
        built.replay.intent.budget.caps.tokens,
      );
      expect(built.replay).not.toHaveProperty('expectedRevision');
      expect(built.replay).not.toHaveProperty('proof');
      expectFrozen(built);
      input.expectedPlan.eligibleUrls.reverse();
      p.parent.taskId = 'mutated';
      p.period.startMs = 0;
      p.safetyEvidenceDigests.push('c'.repeat(64));
      captured.currentCaps.tokens = 900;
      input.acknowledgement.quoteFingerprint = 'c'.repeat(64);
      expect(built.input.expectedPlan.eligibleUrls).toEqual([A, B]);
      expect(built.replay.parent.taskId).toBe('parent-é"\\');
      expect(built.replay.intent.budget.caps.tokens).toBe(0);
      expect(built.input.acknowledgement!.quoteFingerprint).toBe(
        'a'.repeat(64),
      );
      expect(Object.isFrozen(input.expectedPlan)).toBe(false);
      expect(Object.isFrozen(captured.currentCaps)).toBe(false);
    }
  });

  test('SR-D01-A strict closed input and every nested authority/unknown field are refused without defaults', () => {
    const input = fixture().input;
    for (const key of [
      'title',
      'dripFeedDays',
      'mode',
      'override',
      'key',
      'apiKey',
      'path',
      'caps',
      'proof',
      'token',
      'ready',
      'submissionIdentity',
      'searchEngine',
    ])
      expectInvalid(changed(input, [key], 'SYNTHETIC-SECRET'));
    for (const path of [
      ['expectedPlan'],
      ['expectedPlan', 'identity'],
      ['expectedPlan', 'identity', 'preimage'],
      ['expectedPlan', 'identity', 'preimage', 'parent'],
      ['expectedPlan', 'identity', 'preimage', 'period'],
      ['expectedPlan', 'identity', 'preimage', 'reservation'],
    ])
      expectInvalid(changed(input, [...path, 'raw'], 'SYNTHETIC-SECRET'));
    for (const path of [
      ['expectedPlan', 'searchEngine'],
      ['requestId'],
      ['expectedPlan', 'identity'],
      ['expectedPlan', 'policyRevision'],
    ])
      expectInvalid(changed(input, path, undefined));
    for (const bad of ['bing', 'Google', '', null])
      expectInvalid(changed(input, ['expectedPlan', 'searchEngine'], bad));
    for (const bad of [null, undefined, [], {}, 'SYNTHETIC-SECRET'])
      expectInvalid(bad);
    expectInvalid({ ...input, acknowledgement: undefined });
    expectInvalid({
      ...input,
      acknowledgement: {
        quoteFingerprint: 'a'.repeat(64),
        authorizationFingerprint: 'b'.repeat(64),
        raw: 'SYNTHETIC-SECRET',
      },
    });
    expectInvalid({
      ...input,
      acknowledgement: {
        quoteFingerprint: 'A'.repeat(64),
        authorizationFingerprint: 'b'.repeat(64),
      },
    });
    expectInvalid({
      ...input,
      acknowledgement: { quoteFingerprint: 'a'.repeat(64) },
    });
    expect(retryPlanPreimageSchema).toBe(
      retryPlanComparisonSchema.shape.preimage,
    );
  });

  test('SR-D01-A visible labels, provider ID byte limits, safe integers and repeated ordered safety commitments retain existing bounds', () => {
    for (const size of [1, 128]) {
      const f = fixture();
      f.input.requestId = 'x'.repeat(size);
      f.input.expectedPlan.policyRevision = 'r'.repeat(size);
      f.input.expectedPlan.budgetScope = 's'.repeat(size);
      expect(
        reconstructSubmitRetry(recommit(f.input, true), trusted()).input
          .requestId,
      ).toBe('x'.repeat(size));
    }
    for (const bad of [
      '',
      'x'.repeat(129),
      'with space',
      '\u007f',
      'é',
      '\n',
    ]) {
      for (const path of [
        ['requestId'],
        ['expectedPlan', 'budgetScope'],
        ['expectedPlan', 'policyRevision'],
      ])
        expectInvalid(changed(fixture().input, path, bad));
    }
    const p = ['expectedPlan', 'identity', 'preimage'];
    const id = 'é'.repeat(2048);
    const legal = recommit(
      changed(fixture().input, [...p, 'parent', 'taskId'], id),
    );
    expect(reconstructSubmitRetry(legal, trusted()).replay.parent.taskId).toBe(
      id,
    );
    expectInvalid(changed(legal, [...p, 'parent', 'taskId'], id + 'a'));
    for (const bad of ['', ' ', '\ud800', 'a\n'])
      expectInvalid(changed(legal, [...p, 'parent', 'taskId'], bad));
    for (const n of [1, 64]) {
      const repeated = recommit(
        changed(
          fixture().input,
          [...p, 'safetyEvidenceDigests'],
          Array.from({ length: n }, (_, i) => (i % 2 ? 'a' : 'b').repeat(64)),
        ),
      );
      expect(
        reconstructSubmitRetry(repeated, trusted()).input.expectedPlan.identity
          .preimage.safetyEvidenceDigests,
      ).toEqual(repeated.expectedPlan.identity.preimage.safetyEvidenceDigests);
    }
    for (const list of [[], Array(65).fill('a'.repeat(64)), ['A'.repeat(64)]])
      expectInvalid(
        changed(fixture().input, [...p, 'safetyEvidenceDigests'], list),
      );
    for (const [field, bad] of [
      ['urlCount', 0],
      ['urlCount', 10001],
      ['urlCount', 1.5],
      ['providerBodyBytes', 0],
      ['providerBodyBytes', 2097153],
      ['providerBodyBytes', Number.MAX_SAFE_INTEGER + 1],
    ] as const)
      expectInvalid(changed(fixture().input, [...p, field], bad));
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
      expectInvalid(
        changed(fixture().input, [...p, 'reservation', 'tokens'], bad),
      );
  });

  test('SR-D01-A URL exact order, unique strings, Unicode and inclusive 8192-byte/10000-count/body boundaries', () => {
    const urls = [
      'HTTPS://EXAMPLE.test/%2f?é=雪&v="\\',
      'https://example.test/a',
      'https://example.test/a/',
    ];
    for (const engine of ['google', 'yandex'] as const) {
      const f = fixture(engine, undefined, urls);
      const result = reconstructSubmitRetry(f.input, trusted());
      expect(result.replay.intent.submittedUrls).toEqual(urls);
      expect(result.request.body).toBe(f.body);
      expect(result.request.request.providerBodyBytes).toBe(
        Buffer.from(f.body, 'utf8').length,
      );
      expect(result.request.request.providerBodyBytes).toBeGreaterThan(
        f.body.length,
      );
      const reversed = fixture(engine, undefined, [...urls].reverse());
      expect(
        reconstructSubmitRetry(reversed.input, trusted()).request.body,
      ).toBe(reversed.body);
      expect(reversed.request.payloadDigest).not.toBe(f.request.payloadDigest);
      expectInvalid(
        changed(f.input, ['expectedPlan', 'eligibleUrls'], [...urls].reverse()),
      );
      expectInvalid(
        changed(f.input, ['expectedPlan', 'eligibleUrls'], [urls[0], urls[0]]),
      );
    }
    for (const bad of [
      '',
      'ftp://example.test/a',
      'https://u:p@example.test/a',
      'https://@example.test/a',
      ' https://example.test/a',
      'https://example.test/a b',
      'https://example.test/\n',
      'https://example.test/\ud800',
      'https://example.test/\udc00',
    ])
      expectInvalid(
        changed(fixture().input, ['expectedPlan', 'eligibleUrls'], [bad]),
      );
    const prefix = 'https://example.test/';
    const atUrlLimit =
      prefix +
      'é'.repeat(Math.floor((8192 - prefix.length) / 2)) +
      'a'.repeat((8192 - prefix.length) % 2);
    expect(Buffer.from(atUrlLimit, 'utf8').length).toBe(8192);
    expect(
      parseSubmitRetryInput(fixture('google', undefined, [atUrlLimit]).input)
        .expectedPlan.eligibleUrls,
    ).toEqual([atUrlLimit]);
    expectInvalid(fixture('google', undefined, [atUrlLimit + 'a']).input);
    const count = Array.from({ length: 10000 }, (_, i) => prefix + i);
    expect(
      reconstructSubmitRetry(
        fixture('yandex', undefined, count).input,
        trusted(),
      ).request.request.urlCount,
    ).toBe(10000);
    expectInvalid(
      fixture('yandex', undefined, [...count, prefix + 'overflow']).input,
    );
    expectInvalid(fixture('google', undefined, []).input);
    for (const engine of ['google', 'yandex'] as const) {
      const large = Array.from({ length: 255 }, (_, i) => {
        const start = prefix + i + '/';
        return start + 'a'.repeat(8192 - start.length);
      });
      large.push(prefix + 'tail/');
      const initial = fixture(engine, undefined, large);
      large[255] =
        large[255]! +
        'a'.repeat(2097152 - Buffer.from(initial.body, 'utf8').length);
      const atBodyLimit = fixture(engine, undefined, large);
      expect(Buffer.from(atBodyLimit.body, 'utf8').length).toBe(2097152);
      expect(Buffer.from(large[255]!, 'utf8').length).toBeLessThanOrEqual(8192);
      expect(
        reconstructSubmitRetry(atBodyLimit.input, trusted()).request.request
          .providerBodyBytes,
      ).toBe(2097152);
      const overflow = structuredClone(atBodyLimit.input);
      overflow.expectedPlan.eligibleUrls[255] =
        overflow.expectedPlan.eligibleUrls[255]! + 'a';
      expect(
        Buffer.from(
          fixture(engine, undefined, overflow.expectedPlan.eligibleUrls).body,
          'utf8',
        ).length,
      ).toBe(2097153);
      expectInvalid(overflow);
    }
  });

  test('SR-D01-A inconsistent body/quote/provenance/hash/auth/period commitments fail even with recomputed outer fingerprints', () => {
    const input = fixture().input;
    const prefix = ['expectedPlan', 'identity', 'preimage'];
    const changes: (readonly [readonly (string | number)[], unknown])[] = [
      [['parent', 'family'], 'yandex/indexer'],
      [['originalManifestKnown'], false],
      [['manifestProvenance'], 'provider_report_observed_corpus'],
      [['provenance'], 'external_unattributed'],
      [['payloadDigest'], 'a'.repeat(64)],
      [['quoteFingerprint'], 'b'.repeat(64)],
      [['providerRoute'], '/v2/task/yandex/indexer/create'],
      [['urlCount'], 1],
      [
        ['providerBodyBytes'],
        input.expectedPlan.identity.preimage.providerBodyBytes + 1,
      ],
      [['reservation', 'tokens'], 201],
      [['reservation', 'indexer'], 1],
      [['reservation', 'checker'], 1],
      [['authorizationFingerprint'], 'c'.repeat(64)],
      [['policyDigest'], 'd'.repeat(64)],
      [['period', 'id'], 'utc-day:2026-10-21'],
      [['period', 'startMs'], period.startMs + 1],
      [['period', 'endMs'], period.endMs + 1],
    ];
    for (const [path, replacement] of changes)
      expectInvalid(
        recommit(changed(input, [...prefix, ...path], replacement)),
      );
    for (const path of [
      ['sourceManifestDigest'],
      ['partitionDigest'],
      ['revision'],
      ['parent', 'taskId'],
      ['safetyEvidenceDigests', 0],
    ])
      expectInvalid(
        changed(
          input,
          [...prefix, ...path],
          path[0] === 'parent' ? 'different' : 'e'.repeat(64),
        ),
      );
    expectInvalid(changed(input, [...prefix, 'quoteVersion'], 'other'));
    expectInvalid(
      changed(
        input,
        ['expectedPlan', 'identity', 'fingerprint'],
        'f'.repeat(64),
      ),
    );
    expectInvalid(
      changed(input, ['expectedPlan', 'budgetScope'], 'different-scope'),
    );
    expect(() =>
      reconstructSubmitRetry(input, {
        ...trusted(),
        credentialFingerprint: 'a'.repeat(64),
      }),
    ).toThrow('Invalid retry-submission input.');
    for (const bad of [
      undefined,
      { ...trusted(), currentCaps: { tokens: -1, indexer: 0, checker: 0 } },
      { ...trusted(), raw: 'SYNTHETIC-SECRET' },
    ])
      expect(() =>
        reconstructSubmitRetry(
          input,
          bad as Parameters<typeof reconstructSubmitRetry>[1],
        ),
      ).toThrow('Retry submission failed internally.');
  });

  test('SR-D01-A self-consistent opaque forgeries and changed unbound policyRevision are pure-valid comparison only', () => {
    const input = fixture().input;
    const p = ['expectedPlan', 'identity', 'preimage'];
    for (const path of [
      ['sourceManifestDigest'],
      ['partitionDigest'],
      ['revision'],
      ['parent', 'taskId'],
      ['safetyEvidenceDigests', 0],
    ]) {
      const forged = recommit(
        changed(
          input,
          [...p, ...path],
          path[0] === 'parent' ? 'invented-parent' : 'e'.repeat(64),
        ),
      );
      expect(reconstructSubmitRetry(forged, trusted()).input).toEqual(forged);
    }
    const forgedPolicy = recommit(
      changed(input, [...p, 'policyDigest'], 'a'.repeat(64)),
      true,
    );
    expect(reconstructSubmitRetry(forgedPolicy, trusted()).input).toEqual(
      forgedPolicy,
    );
    const relabeled = changed(
      input,
      ['expectedPlan', 'policyRevision'],
      'valid-but-unobserved-label',
    );
    expect(authorization(relabeled)).toBe(authorization(input));
    expect(
      reconstructSubmitRetry(relabeled, trusted()).replay.intent.budget
        .policyRevision,
    ).toBe('valid-but-unobserved-label');
    expect(relabeled.expectedPlan.identity).toEqual(
      input.expectedPlan.identity,
    );
    const forgedProvenance = structuredClone(input);
    forgedProvenance.expectedPlan.identity.preimage.provenance =
      'external_unattributed';
    forgedProvenance.expectedPlan.identity.preimage.originalManifestKnown = false;
    forgedProvenance.expectedPlan.identity.preimage.manifestProvenance =
      'provider_report_observed_corpus';
    expect(
      reconstructSubmitRetry(recommit(forgedProvenance), trusted()).input
        .expectedPlan.identity.preimage.provenance,
    ).toBe('external_unattributed');
  });

  test('SR-D01-A every durable state requires replayed and correlates exact stored projection, request, quote and parent family', () => {
    for (const state of [
      'prepared',
      'dispatching',
      'accepted',
      'rejected',
      'unknown',
      'cancelled',
    ] as const) {
      for (const replayed of [false, true]) {
        const value = durable(state, replayed);
        expect(expectGoodResult(value).isError).toBe(state !== 'accepted');
        expectBadResult(changed(value, ['replayed'], undefined));
        expectBadResult(changed(value, ['replayed'], 'true'));
        expectBadResult(changed(value, ['requestId'], 'different'));
        expectBadResult(
          changed(
            value,
            ['intent', 'state'],
            state === 'prepared' ? 'dispatching' : 'prepared',
          ),
        );
        expectBadResult(changed(value, ['intent', 'stateVersion'], 9));
        expectBadResult(
          changed(value, ['intent', 'periodId'], 'utc-day:2026-10-21'),
        );
        expectBadResult(
          changed(value, ['intent', 'periodStartMs'], period.startMs + 1),
        );
        for (const unit of ['tokens', 'indexer', 'checker'])
          expectBadResult(changed(value, ['intent', 'reservation', unit], 1));
        if (state !== 'accepted')
          expectBadResult(changed(value, ['error'], undefined));
        else
          expectBadResult(
            changed(value, ['error'], submitRetryError('Cancelled')),
          );
        expectBadResult(
          changed(value, ['retry', 'parent', 'family'], 'yandex/indexer'),
        );
        expectBadResult(
          changed(
            value,
            ['request', 'providerRoute'],
            '/v2/task/yandex/indexer/create',
          ),
        );
        expectBadResult(
          changed(value, ['quote', 'fingerprint'], 'a'.repeat(64)),
        );
        expectBadResult(
          changed(value, ['quote', 'maximumExposure', 'checker'], 1),
        );
      }
    }
    for (const path of [
      ['intent', 'providerTaskId'],
      ['intent', 'providerType'],
    ])
      expectBadResult(changed(durable('accepted'), path, undefined));
    expectBadResult(
      changed(
        durable('accepted'),
        ['intent', 'providerType'],
        'yandex/indexer',
      ),
    );
    expectBadResult(
      changed(
        durable('accepted'),
        ['intent', 'providerTaskId'],
        fixture().input.expectedPlan.identity.preimage.parent.taskId,
      ),
    );
    expectBadResult(
      changed(durable('unknown'), ['intent', 'providerTaskId'], 'invented-ack'),
    );
    expectBadResult(
      changed(durable('prepared'), ['intent', 'providerTaskId'], undefined),
    );
    expectBadResult(
      changed(
        durable('rejected', true),
        ['error'],
        submitRetryError('ProviderRejected'),
      ),
    );
  });

  test('SR-D01-A recorded versus unrecorded observations agree with actual asserted durable state and replay never invents observations', () => {
    for (const kind of [
      'accepted_ack',
      'provider_rejection',
      'not_sent',
      'ambiguous',
    ] as const) {
      const state =
        kind === 'accepted_ack'
          ? 'accepted'
          : kind === 'ambiguous'
            ? 'unknown'
            : 'rejected';
      const good = durable(state, false, observed(kind, true));
      expectGoodResult(good);
      expectBadResult(changed(good, ['replayed'], true));
      expectBadResult(changed(good, ['observation', 'recorded'], false));
      const held = durable('dispatching', false, observed(kind, false));
      expectGoodResult(held);
      expectBadResult(changed(held, ['observation', 'recorded'], true));
      expectBadResult(
        changed(held, ['error'], submitRetryError('DispatchClaimLost')),
      );
      for (const other of [
        'prepared',
        'cancelled',
        'unknown',
        'rejected',
      ] as const)
        expectBadResult(durable(other, false, observed(kind, false)));
    }
    const ack = durable('accepted', false, observed('accepted_ack', true));
    expectBadResult(changed(ack, ['observation', 'taskId'], 'different-child'));
    expectBadResult(changed(ack, ['observation', 'type'], 'yandex/indexer'));
    expectBadResult(changed(ack, ['observation', 'raw'], 'SYNTHETIC-SECRET'));
    expectBadResult(changed(ack, ['observation'], undefined));
    expectBadResult(
      changed(
        durable('rejected', false, observed('provider_rejection', true)),
        ['observation', 'code'],
        0,
      ),
    );
    expectBadResult(
      changed(
        durable('unknown', false, observed('ambiguous', true)),
        ['observation', 'cause'],
        'SYNTHETIC-SECRET',
      ),
    );
  });

  test('SR-D01-A self-parent ACK remains unrecorded evidence', () => {
    const baseline = durable(
      'dispatching',
      false,
      observed('accepted_ack', false),
    );
    const selfParent = changed(
      baseline,
      ['observation', 'taskId'],
      baseline.retry.parent.taskId,
    );
    for (const held of [baseline, selfParent]) {
      const variants = [
        held,
        {
          status: 'error',
          requestId: held.requestId,
          error: submitRetryError('StateUnavailable'),
          evidence: {
            kind: 'unrecorded',
            request: held.request,
            quote: held.quote,
            retry: held.retry,
            lastObservedState: 'dispatching',
            observation: held.observation,
          },
        },
        {
          status: 'error',
          requestId: held.requestId,
          error: submitRetryError('InternalError'),
          evidence: evidence(held),
        },
      ];
      for (const variant of variants) {
        expect(
          submitRetryResultSchema.safeParse(variant).success,
          'Unrecorded ACK must retain held dispatching evidence, including a self-parent ACK.',
        ).toBe(true);
        const result = expectGoodResult(variant);
        expect(result.content[0]!.text).toBe(
          JSON.stringify(result.structuredContent),
        );
        expect(result.isError).toBe(true);
        const current = result.structuredContent;
        if (current.status === 'dispatching') {
          expect(current.intent.state).toBe('dispatching');
          expect(current.intent).not.toHaveProperty('providerTaskId');
          expect(current.intent).not.toHaveProperty('providerType');
          expect(current.observation?.recorded).toBe(false);
        } else if (
          current.status === 'error' &&
          current.evidence?.kind === 'durable'
        ) {
          expect(current.evidence.intent.state).toBe('dispatching');
          expect(current.evidence.intent).not.toHaveProperty('providerTaskId');
          expect(current.evidence.intent).not.toHaveProperty('providerType');
          expect(current.evidence.observation?.recorded).toBe(false);
        } else if (
          current.status === 'error' &&
          current.evidence?.kind === 'unrecorded'
        ) {
          expect(current.evidence.lastObservedState).toBe('dispatching');
          expect(current.evidence).not.toHaveProperty('intent');
          expect(current.evidence.observation.recorded).toBe(false);
        } else throw new Error('Expected held unrecorded ACK evidence.');
      }
    }
    expectBadResult(changed(selfParent, ['observation', 'recorded'], true));
    expectBadResult(
      changed(selfParent, ['observation', 'type'], 'yandex/indexer'),
    );
    expectBadResult(changed(selfParent, ['replayed'], true));
    const accepted = durable('accepted', false, observed('accepted_ack', true));
    expectGoodResult(accepted);
    const acceptedSelfParent = changed(
      changed(
        accepted,
        ['intent', 'providerTaskId'],
        accepted.retry.parent.taskId,
      ),
      ['observation', 'taskId'],
      accepted.retry.parent.taskId,
    );
    expectBadResult(acceptedSelfParent);
    expectBadResult({
      status: 'error',
      requestId: acceptedSelfParent.requestId,
      error: submitRetryError('InternalError'),
      evidence: evidence(acceptedSelfParent),
    });
  });

  test('SR-D01-A fixed blocked/runtime errors close metadata and every application branch is locally validated with exact isError', () => {
    const runtime = new Set([
      'InvalidInput',
      'Cancelled',
      'DeadlineExceeded',
      'ReadFailed',
      'ResourceLimitExceeded',
      'InternalError',
    ]);
    for (const code of submitRetryErrorSchema.shape.code.options) {
      const error = submitRetryError(code);
      const value = {
        status: runtime.has(code) ? 'error' : 'blocked',
        requestId: 'retry-01',
        error,
      };
      expect(expectGoodResult(value).isError).toBe(true);
      expectGoodResult({ status: value.status, error });
      expectBadResult(
        changed(
          value,
          ['error', 'message'],
          'SYNTHETIC-SECRET /private/path provider-body',
        ),
      );
      expectBadResult(changed(value, ['error', 'raw'], 'SYNTHETIC-SECRET'));
      expectBadResult(changed(value, ['error', 'unit'], undefined));
      expectBadResult(changed(value, ['error', 'phase'], undefined));
      expectBadResult(changed(value, ['error', 'cause'], undefined));
      if (code !== 'BudgetExceeded')
        expectBadResult(changed(value, ['error', 'unit'], 'tokens'));
      if (code !== 'ReadFailed') {
        expectBadResult(changed(value, ['error', 'phase'], 'report'));
        expectBadResult(changed(value, ['error', 'cause'], 'network'));
      }
      expectBadResult({
        ...value,
        status: runtime.has(code) ? 'blocked' : 'error',
      });
    }
    for (const unit of ['tokens', 'indexer', 'checker'] as const)
      expectGoodResult({
        status: 'blocked',
        error: submitRetryError('BudgetExceeded', { unit }),
      });
    for (const phase of ['list', 'status', 'report', 'fence'] as const)
      for (const cause of [
        'http',
        'provider',
        'response',
        'network',
        'timeout',
      ] as const)
        expectGoodResult({
          status: 'error',
          error: submitRetryError('ReadFailed', { phase, cause }),
        });
    expectBadResult({
      status: 'error',
      requestId: undefined,
      error: submitRetryError('InternalError'),
    });
    expectBadResult({
      status: 'error',
      error: { code: 'RetryProofInvalid', message: 'SYNTHETIC-SECRET' },
    });
    expectBadResult({
      status: 'error',
      error: {
        ...submitRetryError('InternalError'),
        lastObservedState: 'dispatching',
      },
    });
  });

  test('SR-D01-A top-level late durable and unrecorded evidence preserves accepted ACK/unknown holds without asserting an unrecorded ACK durable', () => {
    for (const code of [
      'Cancelled',
      'DeadlineExceeded',
      'InternalError',
    ] as const) {
      for (const state of ['accepted', 'unknown'] as const) {
        const durableValue = durable(
          state,
          false,
          observed(state === 'accepted' ? 'accepted_ack' : 'ambiguous', true),
        );
        const value = {
          status: 'error',
          requestId: 'retry-01',
          error: submitRetryError(code),
          evidence: evidence(durableValue),
        };
        expect(expectGoodResult(value).isError).toBe(true);
        expectBadResult(changed(value, ['requestId'], 'different'));
        expectBadResult(changed(value, ['requestId'], undefined));
        expectBadResult(
          changed(value, ['evidence', 'intent', 'state'], 'dispatching'),
        );
        expectBadResult(
          changed(value, ['evidence', 'observation', 'recorded'], false),
        );
        expectBadResult(
          changed(value, ['evidence', 'raw'], 'SYNTHETIC-SECRET'),
        );
        expectBadResult({
          status: 'error',
          requestId: 'retry-01',
          error: { ...value.error, evidence: value.evidence },
        });
      }
    }
    for (const kind of [
      'accepted_ack',
      'provider_rejection',
      'not_sent',
      'ambiguous',
    ] as const) {
      const unrecorded = {
        kind: 'unrecorded',
        ...data(),
        lastObservedState: 'dispatching',
        observation: observed(kind, false),
      };
      const value = {
        status: 'error',
        requestId: 'retry-01',
        error: submitRetryError('StateUnavailable'),
        evidence: unrecorded,
      };
      expectGoodResult(value);
      expectBadResult(
        changed(value, ['evidence', 'observation', 'recorded'], true),
      );
      expectBadResult(
        changed(value, ['evidence', 'lastObservedState'], 'accepted'),
      );
      expectBadResult(
        changed(value, ['evidence', 'intent'], durable('accepted').intent),
      );
      expectBadResult(changed(value, ['evidence', 'observation'], undefined));
      expectGoodResult({
        ...value,
        evidence: evidence(
          durable('dispatching', false, observed(kind, false)),
        ),
      });
    }
    expectBadResult({ ...durable('accepted'), evidence: evidence() });
    expectBadResult({
      status: 'blocked',
      error: submitRetryError('StateUnavailable'),
      evidence: evidence(),
    });
    expectBadResult({
      status: 'error',
      requestId: 'retry-01',
      error: submitRetryError('InternalError'),
      evidence: undefined,
    });
  });

  test('SR-D01-A output closure, correlation and fixed fallback redact private values and raw thrown input', () => {
    const accepted = durable('accepted', false, observed('accepted_ack', true));
    for (const path of [
      [],
      ['request'],
      ['quote'],
      ['quote', 'maximumExposure'],
      ['retry'],
      ['retry', 'parent'],
      ['intent'],
      ['intent', 'reservation'],
      ['observation'],
    ])
      expectBadResult(changed(accepted, [...path, 'raw'], 'SYNTHETIC-SECRET'));
    for (const field of [
      'authorization',
      'proof',
      'capability',
      'binding',
      'path',
      'mode',
    ])
      expectBadResult(changed(accepted, [field], 'SYNTHETIC-SECRET'));
    for (const bad of [
      null,
      undefined,
      [],
      {},
      { status: 'ready' },
      { status: 'preview' },
      { status: 'no_source' },
    ])
      expectBadResult(bad);
    const hostile = Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        throw new Error('SYNTHETIC-SECRET /private/path provider-body');
      },
    });
    expect(() => parseSubmitRetryInput(hostile)).toThrow(
      'Invalid retry-submission input.',
    );
    const result = submitRetryToolResult(hostile);
    expect(result.structuredContent).toEqual({
      status: 'error',
      error: {
        code: 'InternalError',
        message: 'Retry submission failed internally.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
    const owned = submitRetryToolResult(accepted);
    accepted.intent.reservation.tokens = 900;
    expect(owned.structuredContent).not.toEqual(accepted);
    expectFrozen(owned);
  });

  test('SR-D01-A complete escaped duplicated UTF8 envelope is inclusive at reachable bounds and retains representable failure evidence', () => {
    const f = fixture('yandex');
    f.input.expectedPlan.identity.preimage.parent.taskId =
      'é"\\'.repeat(1023) + 'PPPP';
    f.input = recommit(f.input);
    const value = durable('accepted', false, undefined, f);
    value.intent.providerTaskId = 'é"\\'.repeat(1023) + 'CCCC';
    const expected = expectedEnvelope(value, false);
    const size = bytes(expected);
    expect(size).toBeGreaterThan(bytes(value) * 2);
    expect(size).toBeGreaterThan(JSON.stringify(expected).length);
    const at = submitRetryToolResult(value, { maxBytes: size });
    expect<unknown>(at).toEqual(expected);
    expect(at.isError).toBe(false);
    expect(bytes(at)).toBe(size);
    expectFrozen(at);
    const below = submitRetryToolResult(value, { maxBytes: size - 1 });
    expect(below.structuredContent).toEqual({
      status: 'error',
      error: submitRetryError('ResourceLimitExceeded'),
    });
    expect(bytes(below)).toBeLessThanOrEqual(size - 1);
    for (const kind of ['durable', 'unrecorded'] as const) {
      const facts =
        kind === 'durable'
          ? evidence(value)
          : {
              kind,
              ...data(f),
              lastObservedState: 'dispatching',
              observation: observed('accepted_ack', false, f),
            };
      const original = {
        status: 'error',
        requestId: 'retry-01',
        error: submitRetryError('ReadFailed', {
          phase: 'report',
          cause: 'network',
        }),
        evidence: facts,
      };
      const reduced = {
        ...original,
        error: submitRetryError('ResourceLimitExceeded'),
      };
      const reducedBytes = bytes(expectedEnvelope(reduced, true));
      expect(bytes(expectedEnvelope(original, true))).toBeGreaterThan(
        reducedBytes,
      );
      const retained = submitRetryToolResult(original, {
        maxBytes: reducedBytes,
      });
      expect<unknown>(retained).toEqual(expectedEnvelope(reduced, true));
      expect(bytes(retained)).toBe(reducedBytes);
      expect(
        submitRetryResultSchema.safeParse(retained.structuredContent).success,
      ).toBe(true);
      expectFrozen(retained);
      expect(
        submitRetryToolResult(original, { maxBytes: reducedBytes - 1 })
          .structuredContent,
      ).toEqual({
        status: 'error',
        error: submitRetryError('ResourceLimitExceeded'),
      });
    }
    for (const lower of [0, NaN, Infinity, 2097153, -1, 1000.5])
      expect(() => lowerSubmitRetryResultByteLimit(lower)).toThrow(RangeError);
    expect(lowerSubmitRetryResultByteLimit()).toBe(2097152);
  });
});

test('SR-A2-LATE-DAY-SHAPE permits late-day error only with coherent durable or unrecorded evidence', () => {
  const error = submitRetryError('StalePeriodContext');
  for (const state of [
    'prepared',
    'cancelled',
    'accepted',
    'unknown',
  ] as const) {
    const value = {
      status: 'error',
      requestId: 'retry-01',
      error,
      evidence: evidence(durable(state)),
    };
    expect(expectGoodResult(value).isError).toBe(true);
    expectBadResult({ status: 'error', requestId: 'retry-01', error });
    expectBadResult({ ...value, status: 'blocked' });
    expectBadResult(changed(value, ['requestId'], 'different'));
  }
  const value = {
    status: 'error',
    requestId: 'retry-01',
    error,
    evidence: {
      kind: 'unrecorded',
      ...data(),
      lastObservedState: 'dispatching',
      observation: observed('ambiguous', false),
    },
  };
  expect(expectGoodResult(value).isError).toBe(true);
  expectBadResult({ ...value, status: 'blocked' });
  expectBadResult(
    changed(value, ['evidence', 'observation', 'recorded'], true),
  );
  expectBadResult(
    changed(value, ['evidence', 'lastObservedState'], 'accepted'),
  );
  expectGoodResult({ status: 'blocked', requestId: 'retry-01', error });
});
