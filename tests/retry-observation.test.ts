import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { SpeedyIndexClient } from '../src/client';
import {
  SubmissionHost,
  type SubmissionHostOptions,
} from '../src/submission-host';
import type {
  RetryPlanReady,
  RetryProof,
  RetryPlanFingerprintInput,
  RetryCreatedOwner,
} from '../src/submission-ledger';
import {
  planRetryResultSchema,
  type PlanRetryResult,
  type PlanRetryToolResult,
} from '../src/plan-retry-result';
import {
  createInvocationReadBudget,
  ReadBudgetError,
  type InvocationReadBudget,
} from '../src/read-budget';

const fixtureKey = 'p1b-synthetic-key';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('P1B fixture hang guard.')),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Wire = {
  path: string;
  method: string;
  body: string;
  ids: string[];
  signal: AbortSignal;
};
type Handler = (
  wire: Wire,
  req: IncomingMessage,
  res: ServerResponse,
) => unknown | Promise<unknown>;
async function receiver(
  handler: Handler,
  decorate?: (response: Response, wire: Wire) => Response | Promise<Response>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'speedyindex-p1b-')));
  const previous = globalThis.fetch;
  const operations: Promise<unknown>[] = [],
    releases: (() => void)[] = [],
    errors: unknown[] = [];
  const budgets: InvocationReadBudget[] = [];
  const wires: Wire[] = [],
    onWire: Wire[] = [],
    terminations: Promise<void>[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.username ||
        url.password
      )
        throw new Error('P1B nonloopback guard.');
      return previous(input, init);
    },
    {
      preconnect() {
        throw new Error('P1B preconnect guard.');
      },
    },
  ) as typeof fetch;
  const guarded = globalThis.fetch;
  const server = createServer((req, res) => {
    const wire = onWire.shift();
    const closed = deferred();
    terminations.push(closed.promise);
    res.once('close', () => closed.resolve());
    const work = (async () => {
      if (!wire) throw new Error('Unscheduled P1B arrival.');
      let body = '';
      for await (const chunk of req) body += String(chunk);
      expect(req.url).toBe(wire.path);
      expect(req.method).toBe(wire.method);
      expect(body).toBe(wire.body);
      const payload = await handler(wire, req, res);
      if (!res.writableEnded && !res.destroyed && payload !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
        );
      }
    })();
    operations.push(
      work.catch((error) => {
        errors.push(error);
        res.destroy();
      }),
    );
  });
  let origin = '';
  const fetchFixture = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.speedyindex.com');
      expect(url.username + url.password + url.hash).toBe('');
      const list =
        /^\/v2\/task\/(google|yandex)\/indexer\/list\/(0|[1-9]\d*)$/.exec(
          url.pathname,
        );
      const read =
        /^\/v2\/task\/(google|yandex)\/indexer\/(status|report)$/.exec(
          url.pathname,
        );
      expect(Boolean(list || read)).toBe(true);
      if (!list && !read) throw new Error('P1B route violation.');
      expect(
        url.search === '' ||
          (list?.[1] === 'google' && url.search === '?filter=drip_feed'),
      ).toBe(true);
      expect(init?.method).toBe(list ? 'GET' : 'POST');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(fixtureKey);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('user-agent')).toBe('speedyindex-mcp/0.1.0');
      expect([...headers.keys()].sort()).toEqual(
        list
          ? ['accept', 'authorization', 'user-agent']
          : ['accept', 'authorization', 'content-type', 'user-agent'],
      );
      const body = String(init?.body ?? '');
      let ids: string[] = [];
      if (read) {
        expect(headers.get('content-type')).toBe('application/json');
        const parsed = JSON.parse(body) as {
          task_id?: string;
          task_ids?: string[];
        };
        expect(Object.keys(parsed)).toEqual(
          parsed.task_id === undefined ? ['task_ids'] : ['task_id'],
        );
        expect(
          read[2] === 'report' ? typeof parsed.task_id === 'string' : true,
        ).toBe(true);
        ids =
          parsed.task_id === undefined ? parsed.task_ids! : [parsed.task_id];
        expect(ids.every((id) => typeof id === 'string')).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(body).toBe(JSON.stringify(parsed));
      } else {
        expect(body).toBe('');
        expect(headers.has('content-type')).toBe(false);
      }
      const wire: Wire = {
        path: url.pathname + url.search,
        method: init!.method!,
        body,
        ids,
        signal: init!.signal!,
      };
      wires.push(wire);
      onWire.push(wire);
      const response = await guarded(new URL(wire.path, origin), init);
      return decorate ? await decorate(response, wire) : response;
    },
    {
      preconnect() {
        throw new Error('P1B preconnect guard.');
      },
    },
  ) as typeof fetch;
  let started = false;
  const close = async (success = true) => {
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await bounded(work());
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      for (const release of releases) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      await attempt(async () => {
        const outcomes = await Promise.allSettled([
          ...operations,
          ...budgets.map((budget) => budget.close()),
        ]);
        for (const outcome of outcomes)
          if (outcome.status === 'rejected') errors.push(outcome.reason);
      });
      await attempt(() => Promise.all(terminations));
      if (started) {
        server.closeIdleConnections();
        if (errors.length) server.closeAllConnections();
        await attempt(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      }
    } finally {
      globalThis.fetch = previous;
    }
    if (errors.length) {
      writeFileSync(
        join(root, 'closed-errors.json'),
        JSON.stringify(
          errors.map((error) =>
            error instanceof Error ? error.message : 'Fixture failure',
          ),
        ),
      );
      throw new AggregateError(errors, 'P1B fixture cleanup failed.');
    }
    if (success) rmSync(root, { recursive: true });
  };
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          started = true;
          resolve();
        });
      }),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('P1B receiver address.');
    origin = `http://127.0.0.1:${address.port}`;
    return {
      root,
      fetch: fetchFixture,
      wires,
      releases,
      operations,
      budgets,
      terminations,
      close,
    };
  } catch (error) {
    await close(false);
    throw error;
  }
}

test('P1B-10 raw hook charges actual invalid array entries before normalization', async () => {
  const api = await receiver(() => ({
    code: 0,
    result: {
      id: 'raw',
      indexed_links: [null, null, null],
      unindexed_links: ['duplicate', 'duplicate'],
    },
  }));
  const client = new SpeedyIndexClient(fixtureKey, api.fetch);
  const budget = createInvocationReadBudget({ startedAtMs: performance.now() });
  api.budgets.push(budget);
  const counts: number[] = [];
  let success = false;
  try {
    // The test intentionally calls the fourth argument before its baseline implementation.
    const call = client.getTaskReport as unknown as (
      input: unknown,
      signal: undefined,
      budget: InvocationReadBudget,
      meter: { chargeRawEntries(count: number): void },
    ) => Promise<unknown>;
    await expect(
      call.call(
        client,
        { family: 'google/indexer', taskId: 'raw' },
        undefined,
        budget,
        {
          chargeRawEntries(count) {
            counts.push(count);
            throw new ReadBudgetError('ResourceLimitExceeded');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ResourceLimitExceeded' });
    expect(counts).toEqual([5]);
    expect(api.wires).toHaveLength(1);
    success = true;
  } finally {
    await api.close(success);
  }
});

import { Database, constants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  createRetryObservationCollector,
  type RetryCollectorLimits,
  type RetryInvocation,
} from '../src/retry-observation';
import {
  assessRetryObservations,
  assertRetryProviderBytes,
  buildRetrySemanticIdentity,
  type RetryFamily,
  type RetryPass,
} from '../src/plan-retry';
import { buildCreateIndexingRequest } from '../src/create-indexing-task';
import {
  composeVerifiedRetryAdmission,
  initializeLedger,
  initializeLedgerV2,
  migrateLedgerV2,
  openLedger,
  readRetrySnapshot,
  readRetryPlanningState,
  readRetryReplay,
  type PrepareIntentInput,
  type SubmissionLedger,
  type PrepareResult,
} from '../src/submission-ledger';
import {
  createSubmissionContext,
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
  type SubmissionPolicy,
  type ConfiguredSubmission,
} from '../src/submission-policy';
import {
  fixtureRetryEvidence,
  fixtureRetryVerifier,
} from './fixtures/retry-verifier';
import type { AvailableRetrySnapshot } from '../src/retry-ledger-snapshot';

const utc = Date.parse('2026-10-21T12:00:00Z');
const A = 'https://example.test/A?b=1&a=2',
  B = 'https://example.test/A/?b=1&a=2',
  C = 'https://example.test/C';
const fingerprint = submissionCredentialFingerprint(fixtureKey);
const H = (domain: string, tuple: unknown) =>
  createHash('sha256')
    .update(domain + '\0' + JSON.stringify(tuple))
    .digest('hex');
class Clock {
  mono = 100;
  wall = utc;
  monotonicMs() {
    return this.mono;
  }
  utcMs() {
    return this.wall;
  }
  now() {
    return this.mono;
  }
  setTimeout(callback: () => void, delay: number) {
    return setTimeout(callback, delay);
  }
  clearTimeout(handle: unknown) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
type Api = Awaited<ReturnType<typeof receiver>>;
function fixtureConfiguration(
  api: Api,
  overrides: Partial<SubmissionPolicy> = {},
  schemaVersion: 1 | 2 = 2,
) {
  const stateDirectory = join(api.root, 'state');
  const ledger = (schemaVersion === 1 ? initializeLedger : initializeLedgerV2)({
    stateDirectory,
  });
  ledger.close();
  const policyPath = join(api.root, 'policy.json');
  const policy: SubmissionPolicy = {
    version: 1,
    enabled: true,
    mode: 'operator_policy',
    policyRevision: 'p1b',
    budgetScope: 'p1b',
    credentialFingerprint: fingerprint,
    period: { kind: 'utc_day' },
    caps: { tokens: 10000, indexer: 100, checker: 100 },
    retry: {
      enabled: true,
      allowUnattributedParents: true,
      maxAttemptsPerSource: 3,
    },
    ...overrides,
  };
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const configuration = loadSubmissionConfiguration({
    apiKey: fixtureKey,
    policyPath,
    stateDirectory,
  });
  if (configuration.state !== 'configured')
    throw new Error('P1B synthetic configuration.');
  return configuration;
}
function localSnapshot(
  configuration: ConfiguredSubmission,
): AvailableRetrySnapshot {
  const view = readRetrySnapshot(
    { stateDirectory: configuration.stateDirectory },
    fingerprint,
  );
  if (view.availability !== 'available')
    throw new Error('P1B synthetic snapshot unavailable.');
  return view;
}
function invocation(
  api: Api,
  clock = new Clock(),
  maxReads = 64,
  signal?: AbortSignal,
): RetryInvocation {
  const budget = createInvocationReadBudget(
    { startedAtMs: clock.monotonicMs(), ...(signal ? { signal } : {}) },
    { runtime: clock, limits: { maxAttempts: maxReads } },
  );
  api.budgets.push(budget);
  return { startedAtMs: clock.monotonicMs(), budget, clock };
}
async function withReceiver(
  handler: Handler,
  run: (api: Api) => Promise<void>,
  decorate?: (response: Response, wire: Wire) => Response | Promise<Response>,
) {
  const api = await receiver(handler, decorate);
  let success = false;
  try {
    await run(api);
    success = true;
  } finally {
    await api.close(success);
  }
}
type ProviderTask = Record<string, unknown> & { id: string };
function task(
  id = 'parent',
  changes: Record<string, unknown> = {},
): ProviderTask {
  return {
    id,
    size: 3,
    processed_count: 3,
    indexed_count: 1,
    is_completed: true,
    status: 'completed',
    created_at: '2026-10-01T00:00:00Z',
    pay_per_indexed: true,
    check_after: '2026-10-08T00:00:00Z',
    ...changes,
  };
}
function taskReport(
  value = task(),
  indexed = [C],
  unindexed = [A, B, A],
): ProviderTask {
  return {
    ...value,
    type: 'indexer',
    title: 'SYNTHETIC_IGNORED_TITLE',
    indexed_links: indexed,
    unindexed_links: unindexed,
  };
}
function script(
  options: {
    google?: ProviderTask[][];
    drip?: ProviderTask[][];
    yandex?: ProviderTask[][];
    statuses?: Record<string, ProviderTask>;
    reports?: Record<string, ProviderTask>;
    change?: (wire: Wire, payload: unknown, occurrence: number) => unknown;
  } = {},
): Handler {
  const occurrences = new Map<string, number>();
  return (wire) => {
    const occurrence = (occurrences.get(wire.path) ?? 0) + 1;
    occurrences.set(wire.path, occurrence);
    const list = /\/(google|yandex)\/indexer\/list\/(\d+)/.exec(wire.path);
    let payload: unknown;
    if (list) {
      const pages =
        list[1] === 'yandex'
          ? (options.yandex ?? [[]])
          : wire.path.endsWith('?filter=drip_feed')
            ? (options.drip ?? [[]])
            : (options.google ?? [[]]);
      const page = Number(list[2]);
      payload = {
        code: 0,
        page,
        last_page: pages.length - 1,
        result: pages[page] ?? [],
      };
    } else {
      const engine = wire.path.includes('/google/') ? 'google' : 'yandex';
      const lookup = wire.path.endsWith('/status')
        ? (options.statuses ?? {})
        : (options.reports ?? {});
      const result = wire.ids.flatMap((id) =>
        lookup[engine + ':' + id] ? [lookup[engine + ':' + id]!] : [],
      );
      payload = {
        code: 0,
        result: wire.path.endsWith('/report') ? result[0] : result,
      };
    }
    return options.change ? options.change(wire, payload, occurrence) : payload;
  };
}
function singleSource(
  engine: 'google' | 'yandex' = 'google',
  changes: Record<string, unknown> = {},
): Parameters<typeof script>[0] {
  const value = task('parent', {
    ...(engine === 'yandex' ? { pay_per_indexed: undefined } : {}),
    ...changes,
  });
  return {
    ...(engine === 'google' ? { google: [[value]] } : { yandex: [[value]] }),
    statuses: { [engine + ':parent']: value },
    reports: { [engine + ':parent']: taskReport(value) },
  };
}
async function collect(
  api: Api,
  configuration: ConfiguredSubmission,
  input: unknown = {},
  limits: RetryCollectorLimits = {},
  owner = invocation(api),
) {
  const collector = createRetryObservationCollector({
    configuration,
    fetch: api.fetch,
    limits,
  });
  const pending = collector.collect(input, localSnapshot(configuration), owner);
  api.operations.push(pending);
  return await bounded(pending);
}
function assessment(
  value: Awaited<ReturnType<typeof collect>>,
  configuration: ConfiguredSubmission,
  input: unknown = {},
) {
  expect(value.status).toBe('complete');
  if (value.status !== 'complete')
    throw new Error('P1B collection failed: ' + JSON.stringify(value));
  return assessRetryObservations(
    input,
    value.observations,
    localSnapshot(configuration),
    configuration.snapshot.policy,
  );
}

test('P1B-01 trusted construction and invalid input deny I/O; captured methods and key resist mutation', async () => {
  await withReceiver(script(), async (api) => {
    const config = fixtureConfiguration(api),
      owner = invocation(api),
      local = localSnapshot(config);
    expect(() =>
      createRetryObservationCollector({
        configuration: config,
        limits: { roots: 2001 },
      }),
    ).toThrow();
    const mutable = { ...config, credential: { ...config.credential } };
    const collector = createRetryObservationCollector({
      configuration: mutable,
      fetch: api.fetch,
    });
    mutable.credential.effectiveKey = 'mutated';
    expect(
      await collector.collect({ proof: 'not-authority' }, local, owner),
    ).toEqual({ status: 'error', code: 'InvalidInput' });
    expect(api.wires).toHaveLength(0);
    const original = SpeedyIndexClient.prototype.listTasks;
    SpeedyIndexClient.prototype.listTasks = async () => {
      throw new Error('MUTATED_METHOD_SENTINEL');
    };
    try {
      expect((await collector.collect({}, local, owner)).status).toBe(
        'complete',
      );
    } finally {
      SpeedyIndexClient.prototype.listTasks = original;
    }
    expect(api.wires).toHaveLength(6);
    const client = new SpeedyIndexClient(fixtureKey, api.fetch);
    await expect(
      client.getTaskReport(
        { family: 'google/indexer', taskId: 'raw' },
        undefined,
        undefined,
        { chargeRawEntries() {} },
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      client.getTaskReport(
        { family: 'google/indexer', taskId: 'raw' },
        undefined,
        owner.budget,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(api.wires).toHaveLength(6);
  });
});

test('P1B-04 stable empty scan has exactly six native list reads', async () => {
  await withReceiver(script(), async (api) => {
    const config = fixtureConfiguration(api),
      result = await collect(api, config);
    expect(assessment(result, config)).toEqual({ status: 'no_source' });
    expect(api.wires.map((wire) => wire.path)).toEqual(
      Array.from({ length: 2 }, () => [
        '/v2/task/google/indexer/list/0',
        '/v2/task/google/indexer/list/0?filter=drip_feed',
        '/v2/task/yandex/indexer/list/0',
      ]).flat(),
    );
    expect(result).toMatchObject({
      meters: { reads: 6, roots: 0, statusVisits: 0 },
    });
  });
});

test('P1B-04 simple source has ten reads, first-unique report and complete same-range fence', async () => {
  await withReceiver(script(singleSource()), async (api) => {
    const config = fixtureConfiguration(api),
      result = await collect(api, config);
    expect(assessment(result, config)).toMatchObject({
      status: 'proposal',
      eligibleUrls: [A, B],
    });
    expect(result).toMatchObject({
      meters: { reads: 10, roots: 1, statusVisits: 2, rawEntries: 8 },
    });
    expect(api.wires.map((wire) => wire.path.split('/').at(-1))).toEqual([
      '0',
      '0?filter=drip_feed',
      '0',
      'status',
      'report',
      '0',
      '0?filter=drip_feed',
      '0',
      'status',
      'report',
    ]);
    if (result.status !== 'complete') throw new Error('Missing observations.');
    expect(result.observations.nonAtomic).toBe(true);
    expect(result.observations.finality).toBe('provider_observed');
    expect(JSON.stringify(result.observations.facts)).not.toContain(
      'SYNTHETIC_IGNORED_TITLE',
    );
  });
});

test('P1B-04 inclusive three-page range visits empty INTERIOR page 1 twice', async () => {
  const p = task('parent');
  await withReceiver(
    script({ ...singleSource(), google: [[p], [], []] }),
    async (api) => {
      const config = fixtureConfiguration(api),
        result = await collect(api, config);
      expect(assessment(result, config).status).toBe('proposal');
      expect(
        api.wires
          .filter((wire) => /google\/indexer\/list\/\d+$/.test(wire.path))
          .map((wire) => wire.path.at(-1)),
      ).toEqual(['0', '1', '2', '0', '1', '2']);
    },
  );
});

test('P1B-04 local accepted ACK absent from all lists gets exact status in both passes', async () => {
  const value = task();
  await withReceiver(
    script({
      statuses: { 'google:parent': value },
      reports: { 'google:parent': taskReport(value) },
    }),
    async (api) => {
      const config = fixtureConfiguration(api);
      seedStandalone(config, 'parent', [A, B, C]);
      const result = await collect(api, config);
      expect(assessment(result, config)).toMatchObject({
        status: 'proposal',
        source: { provenance: 'local_standalone', originalManifestKnown: true },
      });
      expect(
        api.wires
          .filter((wire) => wire.path.endsWith('/status'))
          .map((wire) => wire.ids),
      ).toEqual([['parent'], ['parent']]);
      expect(result).toMatchObject({ meters: { roots: 1, reads: 10 } });
    },
  );
});

for (const change of [
  'page',
  'lastPage',
  'membership',
  'order',
  'olderStatus',
  'selectedStatus',
  'report',
  'childSet',
  'omission',
] as const) {
  test(`P1B-04 fence ${change} denies complete observation without a third pass`, async () => {
    const older = task('old', {
      created_at: '2026-09-01T00:00:00Z',
      pay_per_indexed: false,
    });
    const opts = singleSource()!;
    opts.google = [[task(), older]];
    opts.statuses!['google:old'] = older;
    let listPass = 0;
    opts.change = (wire, payload, occurrence) => {
      const value = structuredClone(payload) as {
        page?: number;
        last_page?: number;
        result: ProviderTask | ProviderTask[];
      };
      if (wire.path === '/v2/task/google/indexer/list/0') listPass++;
      if (listPass < 2) return value;
      if (wire.path === '/v2/task/google/indexer/list/0') {
        if (change === 'page') value.page = 1;
        if (change === 'lastPage') value.last_page = 1;
        if (change === 'membership') value.result = [task()];
        if (change === 'order') value.result = [older, task()];
      }
      if (wire.path.endsWith('/status') && occurrence === 2) {
        const tasks = value.result as ProviderTask[];
        if (change === 'olderStatus')
          tasks.find((t) => t.id === 'old')!.is_completed = false;
        if (change === 'selectedStatus')
          tasks.find((t) => t.id === 'parent')!.check_after =
            '2026-10-09T00:00:00Z';
        if (change === 'childSet')
          tasks.find((t) => t.id === 'parent')!.child_task_ids = ['new-child'];
        if (change === 'omission')
          value.result = tasks.filter((t) => t.id !== 'old');
      }
      if (
        wire.path.endsWith('/report') &&
        occurrence === 2 &&
        change === 'report'
      )
        (value.result as ProviderTask).unindexed_links = [B, A];
      return value;
    };
    await withReceiver(script(opts), async (api) => {
      const config = fixtureConfiguration(api),
        result = await collect(api, config);
      expect(['blocked', 'error']).toContain(result.status);
      expect('observations' in result).toBe(false);
      expect(listPass).toBe(2);
      expect(api.wires.length).toBeLessThanOrEqual(10);
    });
  });
}

function intent(
  configuration: ConfiguredSubmission,
  id: string,
  urls: readonly string[],
  family: RetryFamily = 'google/indexer',
): PrepareIntentInput {
  const request = buildCreateIndexingRequest({
    mode: 'preview',
    searchEngine: family.split('/')[0],
    urls,
  });
  return {
    requestId: id,
    budget: createSubmissionContext(
      configuration,
      request.quote.fingerprint,
      utc,
    ).budget,
    taskFamily: family,
    providerRoute: request.request.providerRoute,
    payloadDigest: request.request.payloadDigest,
    submittedUrls: request.input.urls,
    quoteVersion: request.quote.version,
    quoteFingerprint: request.quote.fingerprint,
    reservation: request.quote.maximumExposure,
  };
}
function accept(
  ledger: Pick<SubmissionLedger, 'claimDispatch' | 'recordDispatchOutcome'>,
  prepared: PrepareResult,
  id: string,
  requestId: string,
  family: RetryFamily = 'google/indexer',
) {
  if (prepared.kind !== 'created') throw new Error('Expected fixture creator.');
  const claimed = ledger.claimDispatch(prepared.dispatchCapability, 0);
  if (claimed.kind !== 'claimed') throw new Error('Expected fixture owner.');
  ledger.recordDispatchOutcome({
    credentialFingerprint: fingerprint,
    requestId,
    expectedStateVersion: claimed.stateVersion,
    outcomeToken: claimed.outcomeToken,
    outcome: { kind: 'accepted', providerTaskId: id, providerType: family },
  });
}
function seedStandalone(
  configuration: ConfiguredSubmission,
  id: string,
  urls: readonly string[],
  family: RetryFamily = 'google/indexer',
) {
  const ledger = openLedger({ stateDirectory: configuration.stateDirectory });
  try {
    const request = intent(configuration, 'seed-' + id, urls, family);
    accept(
      ledger,
      ledger.prepareIntent(request),
      id,
      request.requestId,
      family,
    );
  } finally {
    ledger.close();
  }
}

test('P1B-03 all three streams, single drip status and legitimate child/list overlap preserve exact families', async () => {
  const daily = task('same', {
    size: 1,
    processed_count: 1,
    created_at: '2026-10-20T00:00:00Z',
  });
  const drip = task('drip', {
    drip_feed: true,
    days: 2,
    days_passed: 2,
    awaiting_result: false,
    child_task_ids: ['same'],
    children: [{ ...daily, day: 1 }],
  });
  const yandex = task('same', { pay_per_indexed: undefined });
  await withReceiver(
    script({
      google: [[daily]],
      drip: [[drip]],
      yandex: [[yandex]],
      statuses: {
        'google:same': daily,
        'google:drip': drip,
        'yandex:same': yandex,
      },
      reports: { 'google:drip': taskReport(drip) },
    }),
    async (api) => {
      const config = fixtureConfiguration(api),
        result = await collect(
          api,
          config,
          {},
          { roots: 3, children: 1, statusVisits: 6 },
        );
      expect(assessment(result, config)).toMatchObject({
        status: 'proposal',
        source: { reference: ['google/indexer', 'drip'] },
      });
      expect(result).toMatchObject({
        meters: { roots: 3, children: 1, statusVisits: 6 },
      });
      expect(
        api.wires
          .filter((wire) => wire.ids.includes('drip'))
          .map((wire) => wire.body),
      ).toEqual([
        '{"task_id":"drip"}',
        '{"task_id":"drip"}',
        '{"task_id":"drip"}',
        '{"task_id":"drip"}',
      ]);
      expect(
        api.wires.some((wire) => wire.path.includes('pay_per_indexed')),
      ).toBe(false);
    },
  );
});

test('P1B-03 supplementary child details are fixed work in both passes; omission is uncertainty', async () => {
  for (const omit of [false, true]) {
    const drip = task('drip', {
      drip_feed: true,
      days: 2,
      days_passed: 2,
      awaiting_result: false,
      child_task_ids: ['daily'],
    });
    const daily = task('daily', { size: 1, processed_count: 1 });
    await withReceiver(
      script({
        drip: [[drip]],
        statuses: {
          'google:drip': drip,
          ...(omit ? {} : { 'google:daily': daily }),
        },
        reports: { 'google:drip': taskReport(drip) },
      }),
      async (api) => {
        const config = fixtureConfiguration(api),
          result = await collect(api, config);
        if (omit)
          expect(result).toMatchObject({
            status: 'blocked',
            blockers: ['IncompleteScan'],
          });
        else {
          expect(assessment(result, config).status).toBe('proposal');
          expect(result).toMatchObject({
            meters: { roots: 1, children: 1, statusVisits: 4 },
          });
        }
        expect(
          api.wires.filter(
            (wire) =>
              wire.path.endsWith('/status') && wire.ids.includes('daily'),
          ).length,
        ).toBe(omit ? 1 : 2);
      },
    );
  }
});

for (const kind of [
  'duplicatePage',
  'duplicateRoot',
  'regularDrip',
  'relationConflict',
  'selfRelation',
] as const)
  test(`P1B-03 ${kind} cannot disappear through deduplication`, async () => {
    const p = task(
      'parent',
      kind === 'relationConflict'
        ? { child_task_ids: ['child'], children: [task('other')] }
        : kind === 'selfRelation'
          ? { child_task_ids: ['parent'] }
          : {},
    );
    await withReceiver(
      script({
        google:
          kind === 'duplicatePage'
            ? [[p], [p]]
            : kind === 'duplicateRoot'
              ? [[p, p]]
              : kind === 'regularDrip'
                ? [[p]]
                : [[]],
        drip:
          kind === 'duplicatePage' || kind === 'duplicateRoot' ? [[]] : [[p]],
        statuses: { 'google:parent': p },
      }),
      async (api) => {
        const result = await collect(api, fixtureConfiguration(api));
        expect(result).toMatchObject({
          status: 'blocked',
          blockers: ['ConflictingEvidence'],
        });
      },
    );
  });

test('P1B-09 actual status batches cross ID and escaped UTF8 byte bounds independently', async () => {
  for (const ids of [
    Array.from({ length: 1001 }, (_, i) => 'id-' + i),
    Array.from({ length: 25 }, (_, i) => String(i) + 'é"\\'.repeat(600)),
  ]) {
    const values = ids.map((id) => task(id, { pay_per_indexed: false }));
    await withReceiver(
      script({
        google: [
          values.slice(0, 1000),
          ...(values.length > 1000 ? [values.slice(1000)] : []),
        ],
        statuses: Object.fromEntries(
          values.map((value) => ['google:' + value.id, value]),
        ),
      }),
      async (api) => {
        const config = fixtureConfiguration(api),
          result = await collect(api, config);
        expect(assessment(result, config)).toEqual({ status: 'no_source' });
        const status = api.wires.filter((wire) =>
          wire.path.endsWith('/status'),
        );
        expect(status.length).toBe(4);
        for (const wire of status) {
          expect(wire.ids.length).toBeLessThanOrEqual(1000);
          expect(Buffer.byteLength(wire.body, 'utf8')).toBeLessThanOrEqual(
            65536,
          );
        }
        expect(
          status
            .slice(0, 2)
            .flatMap((wire) => wire.ids)
            .sort(),
        ).toEqual([...ids].sort());
        expect(result).toMatchObject({
          meters: { roots: ids.length, statusVisits: 2 * ids.length },
        });
      },
    );
  }
});

test('P1B-09 lower read, distinct-reference and repeated-status limits reserve a full fence', async () => {
  for (const spec of [
    { limits: { maxReads: 6 }, empty: true, complete: true, reads: 6 },
    { limits: { maxReads: 5 }, empty: true, complete: false, reads: 0 },
    { limits: { maxReads: 9 }, complete: false, reads: 4 },
    { limits: { roots: 1, statusVisits: 2 }, complete: true, reads: 10 },
    { limits: { statusVisits: 1 }, complete: false, reads: 3 },
  ]) {
    await withReceiver(
      script(spec.empty ? {} : singleSource()),
      async (api) => {
        const config = fixtureConfiguration(api),
          owner = invocation(api, new Clock(), spec.limits.maxReads ?? 64);
        const result = await collect(api, config, {}, spec.limits, owner);
        expect(result.status).toBe(spec.complete ? 'complete' : 'error');
        if (!spec.complete)
          expect(result).toMatchObject({ code: 'ResourceLimitExceeded' });
        expect(api.wires.length).toBe(spec.reads);
      },
    );
  }
  await withReceiver(
    script({
      change: (_wire, payload) => ({
        ...(payload as object),
        last_page: Number.MAX_SAFE_INTEGER,
      }),
    }),
    async (api) => {
      expect(await collect(api, fixtureConfiguration(api))).toMatchObject({
        code: 'ResourceLimitExceeded',
      });
      expect(api.wires).toHaveLength(1);
    },
  );
  const second = task('second');
  await withReceiver(
    script({ ...singleSource(), google: [[task(), second]] }),
    async (api) => {
      expect(
        await collect(api, fixtureConfiguration(api), {}, { roots: 1 }),
      ).toMatchObject({ code: 'ResourceLimitExceeded' });
      expect(api.wires).toHaveLength(1);
    },
  );
});

test('P1B-10 raw per-report and invocation meters charge duplicates and repeated fence reports', async () => {
  for (const [limits, expectedReads, complete] of [
    [{ rawPerReport: 4, rawTotal: 8 }, 10, true],
    [{ rawPerReport: 3 }, 5, false],
    [{ rawTotal: 7 }, 10, false],
  ] as const)
    await withReceiver(script(singleSource()), async (api) => {
      const result = await collect(api, fixtureConfiguration(api), {}, limits);
      expect(result.status).toBe(complete ? 'complete' : 'error');
      if (!complete)
        expect(result).toMatchObject({ code: 'ResourceLimitExceeded' });
      expect(api.wires.length).toBe(expectedReads);
    });
});

test('P1B-10 raw hook captures method/receiver, redacts unexpected failure and preserves omitted-hook behavior', async () => {
  let calls = 0;
  const captured = deferred();
  const release = deferred();
  await withReceiver(
    async () => {
      captured.resolve();
      await release.promise;
      return {
        code: 0,
        result: { indexed_links: [null], unindexed_links: [null, null] },
      };
    },
    async (api) => {
      api.releases.push(() => release.resolve());
      const client = new SpeedyIndexClient(fixtureKey, api.fetch),
        owner = invocation(api);
      const meter = {
        calls: 0,
        chargeRawEntries(count: number) {
          expect(this).toBe(meter);
          this.calls += count;
          calls++;
        },
      };
      const result = client.getTaskReport(
        { family: 'google/indexer', taskId: 'raw' },
        undefined,
        owner.budget,
        meter,
      );
      api.operations.push(result.catch(() => undefined));
      await bounded(captured.promise);
      meter.chargeRawEntries = () => {
        throw new Error('MUTATED_SECRET');
      };
      release.resolve();
      await expect(result).rejects.toMatchObject({ kind: 'response' });
      expect(meter.calls).toBe(3);
      expect(calls).toBe(1);
    },
  );
});

test('P1B-10 native retained provider tuples include wrappers and both simultaneous fence copies', async () => {
  const tuple: RetryPass = [
    [
      ['google/indexer', 'regular', 0, [[0, []]]],
      ['google/indexer', 'drip', 0, [[0, []]]],
      ['yandex/indexer', 'regular', 0, [[0, []]]],
    ],
    [],
    [],
    null,
    [],
  ];
  const bytes = Buffer.byteLength(JSON.stringify([tuple, tuple]), 'utf8');
  assertRetryProviderBytes([tuple, tuple], bytes);
  for (const exact of [true, false])
    await withReceiver(script(), async (api) => {
      const result = await collect(
        api,
        fixtureConfiguration(api),
        {},
        { providerBytes: bytes - (exact ? 0 : 1) },
      );
      expect(result.status).toBe(exact ? 'complete' : 'error');
      if (result.status === 'complete')
        expect(result.observations.facts).toEqual(tuple);
      else expect(result).toMatchObject({ code: 'ResourceLimitExceeded' });
    });
});

for (const failure of [
  'http',
  'provider',
  'redirect',
  'malformed',
  'wrongId',
  'unrequested',
  'duplicate',
  'omission',
  'network',
] as const)
  test(`P1B-11 fixed ${failure} failure stops scheduling and a fresh invocation recovers`, async () => {
    let failed = false;
    const normal = script(singleSource());
    await withReceiver(
      async (wire, req, res) => {
        if (
          !failed &&
          ((['http', 'redirect'].includes(failure) &&
            wire.path.includes('/list/')) ||
            (['provider', 'unrequested', 'duplicate', 'omission'].includes(
              failure,
            ) &&
              wire.path.endsWith('/status')) ||
            (['malformed', 'wrongId', 'network'].includes(failure) &&
              wire.path.endsWith('/report')))
        ) {
          failed = true;
          if (failure === 'http') {
            res.statusCode = 429;
            return { message: '/PRIVATE_HTTP_SECRET' };
          }
          if (failure === 'redirect') {
            res.statusCode = 302;
            res.setHeader('location', '/forbidden-redirect-target');
            return '/PRIVATE_REDIRECT_SECRET';
          }
          if (failure === 'provider')
            return { code: 7, message: '/PRIVATE_PROVIDER_SECRET' };
          if (failure === 'malformed') return '{bad /PRIVATE_BODY_SECRET';
          if (failure === 'wrongId')
            return { code: 0, result: taskReport(task('wrong')) };
          if (failure === 'unrequested')
            return { code: 0, result: [task('unrequested')] };
          if (failure === 'duplicate')
            return { code: 0, result: [task(), task()] };
          if (failure === 'omission') return { code: 0, result: [] };
          req.socket.destroy();
          return undefined;
        }
        return normal(wire, req, res);
      },
      async (api) => {
        const config = fixtureConfiguration(api),
          owner = invocation(api),
          first = await collect(api, config, {}, {}, owner);
        if (failure === 'omission')
          expect(first).toMatchObject({
            status: 'blocked',
            blockers: ['IncompleteScan'],
          });
        else
          expect(first).toMatchObject({
            status: 'error',
            code: 'ReadFailed',
            cause:
              failure === 'http'
                ? 'http'
                : failure === 'provider'
                  ? 'provider'
                  : failure === 'network' || failure === 'redirect'
                    ? 'network'
                    : 'response',
          });
        expect(JSON.stringify(first)).not.toContain('PRIVATE');
        expect('observations' in first).toBe(false);
        const atFailure = api.wires.length;
        await owner.budget.close();
        expect(await collect(api, config, {}, {}, owner)).toMatchObject({
          code: 'Cancelled',
        });
        expect(api.wires.length).toBe(atFailure);
        expect(assessment(await collect(api, config), config).status).toBe(
          'proposal',
        );
        expect(api.wires.length).toBe(atFailure + 10);
      },
    );
  });

// Delay only the receipt returned by native cancel; captured reader.closed remains native.
function holdCancellation(
  response: Response,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): Response {
  const body = response.body;
  if (!body) return response;
  const cancel = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } finally {
      entered.resolve();
      await release.promise;
    }
  };
  const decorated = new Proxy(body, {
    get(target, field) {
      if (field === 'cancel') return () => cancel(() => target.cancel());
      if (field === 'getReader')
        return () => {
          const reader = target.getReader();
          return new Proxy(reader, {
            get(actual, key) {
              if (key === 'cancel') return () => cancel(() => actual.cancel());
              const value = Reflect.get(actual, key, actual) as unknown;
              return typeof value === 'function' ? value.bind(actual) : value;
            },
          });
        };
      const value = Reflect.get(target, field, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(response, {
    get(target, field) {
      if (field === 'body') return decorated;
      const value = Reflect.get(target, field, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('P1B-12 actual collector and close remain pending through held native cancellation settlement', async () => {
  const entered = deferred(),
    release = deferred(),
    tail = deferred();
  const controller = new AbortController();
  const normal = script(singleSource());
  await withReceiver(
    async (wire, req, res) => {
      if (wire.path.endsWith('/report')) {
        res.writeHead(503);
        res.write('SYNTHETIC_OWNED_BODY');
        await tail.promise;
        if (!res.destroyed) res.end();
        return undefined;
      }
      return normal(wire, req, res);
    },
    async (api) => {
      api.releases.push(
        () => release.resolve(),
        () => tail.resolve(),
      );
      const config = fixtureConfiguration(api),
        owner = invocation(api, new Clock(), 64, controller.signal);
      const collector = createRetryObservationCollector({
        configuration: config,
        fetch: api.fetch,
      });
      let operationDone = false,
        closeDone = false;
      const operation = collector.collect(
        {},
        localSnapshot(config),
        owner,
        controller.signal,
      );
      api.operations.push(operation);
      void operation.then(() => {
        operationDone = true;
      });
      await bounded(entered.promise);
      await bounded(Promise.all(api.terminations));
      controller.abort();
      const closing = owner.budget.close();
      void closing.then(() => {
        closeDone = true;
      });
      await Promise.resolve();
      expect(operationDone).toBe(false);
      expect(closeDone).toBe(false);
      expect(api.wires.length).toBe(5);
      expect(owner.budget.close()).toBe(closing);
      release.resolve();
      expect(await bounded(operation)).toMatchObject({
        status: 'error',
        code: 'ReadFailed',
        cause: 'http',
        phase: 'report',
      });
      await bounded(closing);
      expect(operationDone).toBe(true);
      expect(closeDone).toBe(true);
      expect(() => owner.budget.checkpoint()).toThrow(ReadBudgetError);
    },
    (response, wire) =>
      wire.path.endsWith('/report')
        ? holdCancellation(response, entered, release)
        : response,
  );
});

test('P1B-12 pre-abort, status arrival cancellation and between-read expiry stop the actual collector', async () => {
  for (const phase of ['pre', 'status', 'between', 'horizon'] as const) {
    const controller = new AbortController(),
      arrival = deferred(),
      tail = deferred(),
      clock = new Clock();
    const normal = script(singleSource());
    await withReceiver(
      async (wire, req, res) => {
        if (phase === 'status' && wire.path.endsWith('/status')) {
          res.writeHead(200);
          res.write('{"code":0,"result":');
          arrival.resolve();
          await tail.promise;
          if (!res.destroyed) res.end('[]}');
          return undefined;
        }
        return normal(wire, req, res);
      },
      async (api) => {
        api.releases.push(() => tail.resolve());
        const config = fixtureConfiguration(api),
          owner = invocation(api, clock, 64, controller.signal);
        if (phase === 'pre') controller.abort();
        const operation = createRetryObservationCollector({
          configuration: config,
          fetch: api.fetch,
        }).collect({}, localSnapshot(config), owner, controller.signal);
        api.operations.push(operation);
        if (phase === 'status') {
          await bounded(arrival.promise);
          controller.abort();
        }
        const result = await bounded(operation);
        expect(result).toMatchObject({
          status: 'error',
          code: phase === 'horizon' ? 'DeadlineExceeded' : 'Cancelled',
        });
        expect(api.wires.length).toBe(
          phase === 'pre' ? 0 : phase === 'status' ? 4 : 3,
        );
      },
      (response, wire) => {
        if (wire.path === '/v2/task/yandex/indexer/list/0') {
          // Delivered native body has settled before collector's post-await checkpoint.
          const body = response.body!;
          const decorated = new Proxy(body, {
            get(target, field) {
              if (field === 'getReader')
                return () => {
                  const reader = target.getReader();
                  return new Proxy(reader, {
                    get(actual, key) {
                      if (key === 'releaseLock')
                        return () => {
                          actual.releaseLock();
                          if (phase === 'between') controller.abort();
                          if (phase === 'horizon') clock.mono += 60000;
                        };
                      const value = Reflect.get(actual, key, actual) as unknown;
                      return typeof value === 'function'
                        ? value.bind(actual)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(target, field, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return new Proxy(response, {
            get(target, field) {
              if (field === 'body') return decorated;
              const value = Reflect.get(target, field, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
        return response;
      },
    );
  }
});

test('P1B-12 captured caller clock persists and successful collect leaves final-reader budget open', async () => {
  let mutate: (() => void) | undefined;
  const normal = script();
  await withReceiver(
    (wire, req, res) => {
      mutate?.();
      return normal(wire, req, res);
    },
    async (api) => {
      const clock = new Clock(),
        owner = invocation(api, clock),
        config = fixtureConfiguration(api);
      mutate = () => {
        clock.monotonicMs = () => {
          throw new Error('MUTATED_CLOCK');
        };
        clock.utcMs = () => {
          throw new Error('MUTATED_CLOCK');
        };
      };
      const result = await collect(api, config, {}, {}, owner);
      expect(result.status).toBe('complete');
      owner.budget.checkpoint(); // Same owned budget is still available for a final local reader.
      const local = localSnapshot(config);
      expect(local.availability).toBe('available');
      clock.mono += 60000;
      expect(() => owner.budget.checkpoint()).toThrow(ReadBudgetError);
    },
  );
});

function logicalProjection(configuration: ConfiguredSubmission) {
  const db = new Database(
    join(configuration.stateDirectory, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const schema = db
      .query<{ name: string; type: string; sql: string | null }, []>(
        'SELECT name,type,sql FROM sqlite_schema ORDER BY name',
      )
      .all();
    const tables = schema
      .filter((row) => row.type === 'table')
      .map((row) => [
        row.name,
        db
          .query(
            `SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid`,
          )
          .all(),
      ]);
    return { version: db.query('PRAGMA user_version').get(), schema, tables };
  } finally {
    db.close();
  }
}
async function internalOwner(
  api: Api,
  config: ConfiguredSubmission,
  input: unknown = {},
  options: {
    clock?: Clock;
    beforeFinal?: () => void;
    expireAfterSerialization?: boolean;
  } = {},
) {
  const args = parseInputBeforeRead(input);
  const owner = invocation(api, options.clock ?? new Clock());
  try {
    owner.budget.checkpoint();
    const initial = readRetrySnapshot(
      { stateDirectory: config.stateDirectory },
      fingerprint,
    );
    owner.budget.checkpoint();
    if (initial.availability !== 'available')
      return { status: 'blocked', blockers: ['StateUnavailable'] };
    const collecting = createRetryObservationCollector({
      configuration: config,
      fetch: api.fetch,
    }).collect(args, initial, owner);
    api.operations.push(collecting);
    const observed = await collecting;
    owner.budget.checkpoint();
    if (observed.status !== 'complete') return observed;
    owner.budget.checkpoint();
    const proposed = assessRetryObservations(
      args,
      observed.observations,
      initial,
      config.snapshot.policy,
    );
    owner.budget.checkpoint();
    if (proposed.status !== 'proposal') return proposed;
    const context = createSubmissionContext(
      config,
      proposed.request.quote.fingerprint,
      owner.clock.utcMs(),
    );
    const inspection: PrepareIntentInput = {
      requestId: 'read-only-inspection',
      budget: context.budget,
      taskFamily: proposed.request.request.family,
      providerRoute: proposed.request.request.providerRoute,
      payloadDigest: proposed.request.request.payloadDigest,
      submittedUrls: proposed.eligibleUrls,
      quoteVersion: proposed.request.quote.version,
      quoteFingerprint: proposed.request.quote.fingerprint,
      reservation: proposed.request.quote.maximumExposure,
    };
    options.beforeFinal?.();
    owner.budget.checkpoint();
    const final = readRetryPlanningState(
      { stateDirectory: config.stateDirectory },
      fingerprint,
      {
        intent: inspection,
        parent: {
          family: proposed.source.reference[0],
          taskId: proposed.source.reference[1],
        },
        maxAttemptsPerSource:
          config.snapshot.policy.retry!.maxAttemptsPerSource,
      },
      { now: () => owner.clock.utcMs() },
    );
    owner.budget.checkpoint();
    const identity = buildRetrySemanticIdentity(
      proposed,
      final,
      context,
      initial,
    );
    JSON.stringify([proposed, identity]);
    if (options.expireAfterSerialization) (owner.clock as Clock).mono += 60000;
    owner.budget.checkpoint();
    return { status: 'internal', proposal: proposed, identity };
  } finally {
    await owner.budget.close();
  }
}
import { parseRetryPlanInput as parseInputBeforeRead } from '../src/plan-retry';

for (const engine of ['google', 'yandex'] as const)
  test(`P1B-13 real ${engine === 'google' ? 'local' : 'external'} read-only configuration/readers/native HTTP proposal and comparison`, async () => {
    await withReceiver(script(singleSource(engine)), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: engine === 'yandex',
          maxAttemptsPerSource: 3,
        },
      });
      if (engine === 'google') seedStandalone(config, 'parent', [A, B, C]);
      const before = logicalProjection(config),
        result = await internalOwner(api, config, { searchEngine: engine });
      expect(result).toMatchObject({
        status: 'internal',
        proposal: {
          eligibleUrls: [A, B],
          source: {
            originalManifestKnown: engine === 'google',
            provenance:
              engine === 'google'
                ? 'local_standalone'
                : 'external_unattributed',
            manifestDigest:
              engine === 'google'
                ? H('speedyindex-intent-url-manifest-v1', [
                    'google/indexer',
                    [A, B, C],
                  ])
                : H('speedyindex-provider-report-url-manifest-v1', [
                    'yandex/indexer',
                    'parent',
                    [C, A, B],
                  ]),
          },
          request: {
            quote: {
              maximumExposure:
                engine === 'google'
                  ? { tokens: 200, indexer: 0, checker: 0 }
                  : { tokens: 40, indexer: 2, checker: 0 },
            },
          },
        },
        identity: { status: 'comparison' },
      });
      expect(logicalProjection(config)).toEqual(before);
      expect(api.wires.length).toBe(10);
      if (engine === 'yandex') {
        expect(localSnapshot(config).acceptedManifests).toEqual([]);
        expect(localSnapshot(config).retryChildren).toEqual([]);
      }
    });
  });

async function seedExternalChild(
  config: ConfiguredSubmission,
  parent: { family: RetryFamily; taskId: string },
  state:
    'accepted' | 'rejected' | 'cancelled' | 'prepared' | 'unknown' = 'accepted',
  evidenceUrls: readonly string[] = [C, A, B],
  options: { requestId?: string; utcMs?: number } = {},
) {
  const composition = composeVerifiedRetryAdmission({
    configuration: config,
    verifier: fixtureRetryVerifier(fixtureRetryEvidence(evidenceUrls)),
    clock: { utcMs: () => options.utcMs ?? utc, monotonicMs: () => 100 },
  });
  const selected = await composition.collect({
    requestId: options.requestId ?? 'real-retry-child',
    parent,
  });
  if (selected.kind !== 'candidate')
    throw new Error('Expected controlled fixture candidate: ' + selected.code);
  const writer = composition.open();
  try {
    const prepared = writer.prepareVerifiedRetryIntent(
      selected.input,
      selected.proof,
    );
    if (prepared.kind !== 'created')
      throw new Error('Expected fixture retry creation.');
    if (state === 'accepted')
      accept(
        writer,
        prepared,
        'child',
        selected.input.intent.requestId,
        parent.family,
      );
    if (state === 'cancelled')
      writer.cancelPrepared(fingerprint, selected.input.intent.requestId, 0);
    if (state === 'rejected' || state === 'unknown') {
      const claimed = writer.claimDispatch(prepared.dispatchCapability, 0);
      if (claimed.kind !== 'claimed') throw new Error('Expected owner.');
      writer.recordDispatchOutcome({
        credentialFingerprint: fingerprint,
        requestId: selected.input.intent.requestId,
        expectedStateVersion: claimed.stateVersion,
        outcomeToken: claimed.outcomeToken,
        outcome: { kind: state },
      });
    }
  } finally {
    writer.close();
  }
}

test('P1B-07 P1B-13 real external direct child final report excludes indexed URL without inventing a parent', async () => {
  const parent = task('parent', { pay_per_indexed: undefined }),
    child = task('child', {
      size: 2,
      processed_count: 2,
      pay_per_indexed: undefined,
    });
  await withReceiver(
    script({
      yandex: [[parent]],
      statuses: { 'yandex:parent': parent, 'yandex:child': child },
      reports: {
        'yandex:parent': taskReport(parent),
        'yandex:child': taskReport(child, [A], [B]),
      },
    }),
    async (api) => {
      const config = fixtureConfiguration(api);
      await seedExternalChild(config, {
        family: 'yandex/indexer',
        taskId: 'parent',
      });
      const before = logicalProjection(config),
        result = await internalOwner(api, config, { searchEngine: 'yandex' });
      expect(result).toMatchObject({
        status: 'internal',
        proposal: {
          eligibleUrls: [B],
          excluded: [{ url: A, reasons: ['PriorRetryIndexed'] }],
        },
        identity: { status: 'comparison' },
      });
      expect(
        api.wires
          .filter((wire) => wire.path.endsWith('/report'))
          .map((wire) => wire.ids),
      ).toEqual([['parent'], ['child'], ['parent'], ['child']]);
      expect(
        localSnapshot(config).acceptedManifests.map(
          (item) => item.providerTaskId,
        ),
      ).toEqual(['child']);
      expect(logicalProjection(config)).toEqual(before);
    },
  );
});

test('P1B-13 permission, visible omission, active unknown and real final cap/period decisions refuse identity', async () => {
  for (const variant of [
    'permission',
    'omission',
    'active',
    'capTokens',
    'capIndexer',
    'period',
    'missing',
  ] as const) {
    const opts = singleSource('yandex')!;
    if (variant === 'omission')
      opts.reports!['yandex:parent'] = taskReport(
        task('parent', { pay_per_indexed: undefined }),
        [C],
        [A],
      );
    if (variant === 'active') {
      const active = task('active', {
        pay_per_indexed: undefined,
        is_completed: false,
        status: undefined,
      });
      opts.google = [[active]];
      opts.statuses!['google:active'] = active;
    }
    await withReceiver(script(opts), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: variant !== 'permission',
          maxAttemptsPerSource: 3,
        },
        caps: {
          tokens: variant === 'capTokens' ? 39 : 10000,
          indexer: variant === 'capIndexer' ? 1 : 100,
          checker: 100,
        },
      });
      const before = logicalProjection(config),
        clock = new Clock();
      const selectedConfig =
        variant === 'missing'
          ? { ...config, stateDirectory: join(api.root, 'missing-state') }
          : config;
      const result = await internalOwner(
        api,
        selectedConfig,
        { searchEngine: 'yandex' },
        {
          clock,
          beforeFinal: () => {
            if (variant === 'period') clock.wall += 86400000;
          },
        },
      );
      const expected =
        variant === 'permission'
          ? 'UnattributedParentPermissionRequired'
          : variant === 'omission'
            ? 'SourceReportIncomplete'
            : variant === 'active'
              ? 'ActiveCoverageUnknown'
              : variant === 'period'
                ? 'StalePeriodContext'
                : variant === 'missing'
                  ? 'StateUnavailable'
                  : 'BudgetExceeded';
      expect('identity' in result ? result.identity : result).toMatchObject({
        status: 'blocked',
        blockers: [expected],
      });
      expect(logicalProjection(config)).toEqual(before);
      if (variant === 'missing') expect(api.wires.length).toBe(0);
    });
  }
});

test('P1B-13 real all-state lifetime allowance and revision change refuse the final comparison', async () => {
  for (const state of ['rejected', 'cancelled', 'prepared'] as const)
    await withReceiver(script(singleSource('yandex')), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: true,
          maxAttemptsPerSource: 1,
        },
      });
      await seedExternalChild(
        config,
        { family: 'yandex/indexer', taskId: 'parent' },
        state,
      );
      const before = logicalProjection(config),
        result = await internalOwner(api, config, { searchEngine: 'yandex' });
      expect('identity' in result ? result.identity : result).toMatchObject({
        status: 'blocked',
        blockers: [
          state === 'prepared' ? 'NoCandidates' : 'RetryAllowanceExceeded',
        ],
      });
      expect(logicalProjection(config)).toEqual(before);
    });
  await withReceiver(script(singleSource()), async (api) => {
    const config = fixtureConfiguration(api);
    let afterConcurrentWriter: ReturnType<typeof logicalProjection> | undefined;
    const result = await internalOwner(
      api,
      config,
      {},
      {
        beforeFinal: () => {
          const writer = openLedger({ stateDirectory: config.stateDirectory });
          try {
            writer.prepareIntent(
              intent(config, 'concurrent', ['https://example.test/disjoint']),
            );
          } finally {
            writer.close();
          }
          afterConcurrentWriter = logicalProjection(config);
        },
      },
    );
    expect('identity' in result ? result.identity : result).toMatchObject({
      status: 'blocked',
      blockers: ['SnapshotConflict'],
    });
    expect(logicalProjection(config)).toEqual(afterConcurrentWriter!);
  });
});

test('P1B-12 P1B-13 actual owner checkpoints after proposal/identity serialization before returning', async () => {
  await withReceiver(script(singleSource()), async (api) => {
    const config = fixtureConfiguration(api),
      before = logicalProjection(config);
    await expect(
      internalOwner(api, config, {}, { expireAfterSerialization: true }),
    ).rejects.toMatchObject({ code: 'DeadlineExceeded' });
    expect(logicalProjection(config)).toEqual(before);
    expect(api.wires.length).toBe(10);
    expect(() => api.budgets[0]!.checkpoint()).toThrow(ReadBudgetError);
  });
});

test('P1B-13 complete known unfinished-only observations return no_source with active work still present', async () => {
  await withReceiver(
    script(
      singleSource('google', {
        is_completed: false,
        status: undefined,
        processed_count: 0,
        indexed_count: 0,
      }),
    ),
    async (api) => {
      const config = fixtureConfiguration(api),
        before = logicalProjection(config),
        result = await internalOwner(api, config);
      expect(result).toEqual({ status: 'no_source' });
      expect(
        api.wires.filter((wire) => wire.path.endsWith('/report')),
      ).toHaveLength(0);
      expect(logicalProjection(config)).toEqual(before);
      expect(api.wires.length).toBe(8);
    },
  );
});

for (const hook of [false, true])
  test(`P1B-10 ${hook ? 'unexpected hook is fixed/redacted' : 'omitted hook retains legacy domain error'}`, async () => {
    await withReceiver(
      () => ({
        code: 0,
        result: { indexed_links: [null], unindexed_links: [null, null] },
      }),
      async (api) => {
        const client = new SpeedyIndexClient(fixtureKey, api.fetch);
        const pending = hook
          ? client.getTaskReport(
              { family: 'google/indexer', taskId: 'raw' },
              undefined,
              invocation(api).budget,
              {
                chargeRawEntries() {
                  throw new Error('/PRIVATE_SECRET_HOOK');
                },
              },
            )
          : client.getTaskReport({ family: 'google/indexer', taskId: 'raw' });
        await expect(pending).rejects.toMatchObject({ kind: 'response' });
      },
    );
  });

test('P1B-03 missing-list local drip ACK discovers and fences its required single-ID status', async () => {
  const drip = task('drip', {
    drip_feed: true,
    days: 2,
    days_passed: 2,
    awaiting_result: false,
    child_task_ids: [],
    children: [],
  });
  await withReceiver(
    script({
      statuses: { 'google:drip': drip },
      reports: { 'google:drip': taskReport(drip) },
    }),
    async (api) => {
      const config = fixtureConfiguration(api);
      seedStandalone(config, 'drip', [A, B, C]);
      const result = await collect(api, config);
      expect(assessment(result, config)).toMatchObject({
        status: 'proposal',
        source: { reference: ['google/indexer', 'drip'] },
      });
      expect(
        api.wires
          .filter((wire) => wire.path.endsWith('/status'))
          .map((wire) => wire.body),
      ).toEqual([
        '{"task_ids":["drip"]}',
        '{"task_id":"drip"}',
        '{"task_ids":["drip"]}',
        '{"task_id":"drip"}',
      ]);
      expect(result).toMatchObject({ meters: { roots: 1, statusVisits: 4 } });
    },
  );
});

test('P1B-03 regular/drip status contradiction and child-reference excess block before report work', async () => {
  await withReceiver(
    script(singleSource('google', { drip_feed: true })),
    async (api) => {
      expect(await collect(api, fixtureConfiguration(api))).toMatchObject({
        status: 'blocked',
        blockers: ['ConflictingEvidence'],
      });
      expect(
        api.wires.filter((wire) => wire.path.endsWith('/report')),
      ).toHaveLength(0);
    },
  );
  const drip = task('drip', { child_task_ids: ['one', 'two'] });
  await withReceiver(
    script({ drip: [[drip]], statuses: { 'google:drip': drip } }),
    async (api) => {
      expect(
        await collect(api, fixtureConfiguration(api), {}, { children: 1 }),
      ).toMatchObject({ code: 'ResourceLimitExceeded' });
      expect(api.wires.length).toBe(4);
    },
  );
});

test('P1B-04 a first-pass lastPage change cannot become truncated complete coverage', async () => {
  await withReceiver(
    script({
      google: [[], [], []],
      change: (wire, payload) =>
        wire.path === '/v2/task/google/indexer/list/1'
          ? { ...(payload as object), last_page: 1 }
          : payload,
    }),
    async (api) => {
      expect(await collect(api, fixtureConfiguration(api))).toMatchObject({
        status: 'blocked',
        blockers: ['IncompleteScan'],
      });
      expect(api.wires.length).toBe(2);
    },
  );
});

function seedOrdinaryUnknown(
  configuration: ConfiguredSubmission,
  urls: readonly string[],
) {
  const writer = openLedger({ stateDirectory: configuration.stateDirectory });
  try {
    const request = intent(configuration, 'ordinary-unknown', urls);
    const prepared = writer.prepareIntent({
      ...request,
      taskFamily: 'backlink/checker',
      providerRoute: '/v2/task/backlink/checker/create',
      budget: {
        ...request.budget,
        budgetScope: 'old-other-scope',
        periodId: 'old-private-period',
        periodStartMs: 1000,
      },
      reservation: { tokens: 2, indexer: 0, checker: 1 },
    });
    if (prepared.kind !== 'created')
      throw new Error('Expected ordinary fixture creator.');
    const claim = writer.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed') throw new Error('Expected fixture claim.');
    writer.recordDispatchOutcome({
      credentialFingerprint: fingerprint,
      requestId: request.requestId,
      expectedStateVersion: claim.stateVersion,
      outcomeToken: claim.outcomeToken,
      outcome: { kind: 'unknown' },
    });
  } finally {
    writer.close();
  }
}

test('P1B-06 P1B-13 real old all-family ordinary unknown and no-ID retry unknown retain distinct meanings', async () => {
  for (const state of [
    'ordinaryOverlap',
    'ordinaryDisjoint',
    'preparedRetry',
    'unknownRetry',
  ] as const)
    await withReceiver(script(singleSource('yandex')), async (api) => {
      const config = fixtureConfiguration(api),
        disjoint = [
          'https://example.test/other-I',
          'https://example.test/other-U1',
          'https://example.test/other-U2',
        ];
      if (state.startsWith('ordinary'))
        seedOrdinaryUnknown(
          config,
          state === 'ordinaryOverlap' ? [A] : [disjoint[1]!],
        );
      else
        await seedExternalChild(
          config,
          { family: 'yandex/indexer', taskId: 'unrelated' },
          state === 'preparedRetry' ? 'prepared' : 'unknown',
          disjoint,
        );
      const before = logicalProjection(config),
        result = await internalOwner(api, config, { searchEngine: 'yandex' });
      if (state === 'unknownRetry')
        expect(result).toMatchObject({
          status: 'blocked',
          blockers: ['UnknownRetryDispatch'],
        });
      else
        expect(result).toMatchObject({
          status: 'internal',
          proposal: {
            eligibleUrls: state === 'ordinaryOverlap' ? [B] : [A, B],
          },
          identity: { status: 'comparison' },
        });
      expect(logicalProjection(config)).toEqual(before);
    });
});

test('P1B-07 P1B-10 final-child raw rereads count again and failed child evidence never produces a partial proposal', async () => {
  for (const variant of ['exactRaw', 'overRaw', 'wrongChildReport'] as const) {
    const parent = task('parent', { pay_per_indexed: undefined }),
      child = task('child', {
        size: 2,
        processed_count: 2,
        pay_per_indexed: undefined,
      });
    await withReceiver(
      script({
        yandex: [[parent]],
        statuses: { 'yandex:parent': parent, 'yandex:child': child },
        reports: {
          'yandex:parent': taskReport(parent),
          'yandex:child': taskReport(
            variant === 'wrongChildReport' ? task('wrong') : child,
            [A],
            [B],
          ),
        },
      }),
      async (api) => {
        const config = fixtureConfiguration(api);
        await seedExternalChild(config, {
          family: 'yandex/indexer',
          taskId: 'parent',
        });
        const result = await collect(
          api,
          config,
          { searchEngine: 'yandex' },
          { rawTotal: variant === 'overRaw' ? 11 : 12 },
        );
        if (variant === 'exactRaw')
          expect(result).toMatchObject({
            status: 'complete',
            meters: { rawEntries: 12 },
          });
        else
          expect(result).toMatchObject({
            status: 'error',
            code:
              variant === 'overRaw' ? 'ResourceLimitExceeded' : 'ReadFailed',
            phase: variant === 'overRaw' ? 'fence' : 'report',
          });
      },
    );
  }
});

test('P1B-08 matching equivalent-offset instants and ignored title/fees produce stable real comparison identity', async () => {
  const opts = singleSource()!;
  opts.change = (wire, payload, occurrence) => {
    if (wire.path.includes('/list/') || occurrence === 1) return payload;
    const value = structuredClone(payload) as {
      result: ProviderTask | ProviderTask[];
    };
    for (const fact of Array.isArray(value.result)
      ? value.result
      : [value.result]) {
      fact.created_at = '2026-10-01T02:00:00+02:00';
      fact.check_after = '2026-10-08T02:00:00+02:00';
      fact.title = 'VOLATILE_CHANGED';
      fact.tokens_refunded = 123;
    }
    return value;
  };
  await withReceiver(script(opts), async (api) => {
    const config = fixtureConfiguration(api),
      first = await internalOwner(api, config),
      second = await internalOwner(api, config);
    expect(first).toMatchObject({
      status: 'internal',
      identity: { status: 'comparison' },
    });
    expect(second).toMatchObject({
      status: 'internal',
      identity: { status: 'comparison' },
    });
    if (!('identity' in first) || !('identity' in second))
      throw new Error('Expected comparisons.');
    expect(first.identity).toEqual(second.identity);
  });
});

for (const mode of [true, false])
  test(`P1B-02 selected report fills missing Google PPR mode with ${mode}`, async () => {
    const opts = singleSource('google', {
      pay_per_indexed: undefined,
      status: undefined,
      check_after: undefined,
    })!;
    opts.reports!['google:parent'] = taskReport(
      task('parent', { pay_per_indexed: mode }),
    );
    await withReceiver(script(opts), async (api) => {
      const config = fixtureConfiguration(api),
        result = assessment(await collect(api, config), config);
      if (mode)
        expect(result).toMatchObject({
          status: 'proposal',
          eligibleUrls: [A, B],
        });
      else
        expect(result).toMatchObject({
          status: 'blocked',
          blockers: ['UnprovenLatest'],
        });
    });
  });

for (const reportChange of [
  { drip_feed: true },
  { child_task_ids: ['new-uninspected-child'] },
])
  test(`P1B-03 report-only relationship facts cannot bypass required status work: ${Object.keys(reportChange)[0]}`, async () => {
    const opts = singleSource()!;
    opts.reports!['google:parent'] = taskReport(task('parent', reportChange));
    await withReceiver(script(opts), async (api) => {
      const config = fixtureConfiguration(api),
        result = await collect(api, config);
      expect(result).toMatchObject({
        status: 'blocked',
        blockers: ['ConflictingEvidence'],
      });
      expect(api.wires.length).toBe(5);
    });
  });

test('P1B-09 P1B-12 the same budget cannot reset semantic meters via a recreated collector', async () => {
  await withReceiver(script(), async (api) => {
    const config = fixtureConfiguration(api),
      owner = invocation(api),
      local = localSnapshot(config);
    expect(
      (
        await createRetryObservationCollector({
          configuration: config,
          fetch: api.fetch,
        }).collect({}, local, owner)
      ).status,
    ).toBe('complete');
    owner.budget.checkpoint();
    expect(
      await createRetryObservationCollector({
        configuration: config,
        fetch: api.fetch,
      }).collect({}, local, owner),
    ).toEqual({ status: 'error', code: 'InternalError' });
    expect(api.wires.length).toBe(6);
    owner.budget.checkpoint();
  });
});

test('P1B-12 an invalid throwing monotonic clock expires before native provider I/O', async () => {
  await withReceiver(script(), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new Clock(),
      owner = invocation(api, clock);
    clock.monotonicMs = () => {
      throw new Error('PRIVATE_INVALID_CLOCK');
    };
    expect(
      await createRetryObservationCollector({
        configuration: config,
        fetch: api.fetch,
      }).collect({}, localSnapshot(config), owner),
    ).toMatchObject({ status: 'error', code: 'DeadlineExceeded' });
    expect(api.wires.length).toBe(0);
  });
});

test('P1B-11 a native failure in the final fence report has fixed phase and no partial identity', async () => {
  let reports = 0;
  const normal = script(singleSource());
  await withReceiver(
    (wire, req, res) => {
      if (wire.path.endsWith('/report') && ++reports === 2) {
        res.statusCode = 429;
        return { message: '/PRIVATE_FENCE_SECRET' };
      }
      return normal(wire, req, res);
    },
    async (api) => {
      const result = await collect(api, fixtureConfiguration(api));
      expect(result).toEqual({
        status: 'error',
        code: 'ReadFailed',
        cause: 'http',
        phase: 'fence',
      });
      expect(api.wires.length).toBe(10);
      expect('observations' in result).toBe(false);
    },
  );
});

test('P1B-12 expiry after the first report settlement prevents any fence dispatch', async () => {
  const clock = new Clock();
  await withReceiver(
    script(singleSource()),
    async (api) => {
      const owner = invocation(api, clock),
        result = await collect(api, fixtureConfiguration(api), {}, {}, owner);
      expect(result).toMatchObject({
        status: 'error',
        code: 'DeadlineExceeded',
      });
      expect(api.wires.length).toBe(5);
    },
    (response, wire) => {
      if (!wire.path.endsWith('/report')) return response;
      const body = response.body!;
      const decorated = new Proxy(body, {
        get(target, field) {
          if (field === 'getReader')
            return () => {
              const reader = target.getReader();
              return new Proxy(reader, {
                get(actual, key) {
                  if (key === 'releaseLock')
                    return () => {
                      actual.releaseLock();
                      clock.mono += 60000;
                    };
                  const value = Reflect.get(actual, key, actual) as unknown;
                  return typeof value === 'function'
                    ? value.bind(actual)
                    : value;
                },
              });
            };
          const value = Reflect.get(target, field, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return new Proxy(response, {
        get(target, field) {
          if (field === 'body') return decorated;
          const value = Reflect.get(target, field, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  );
});

async function withProductionReceiver(
  handler: Handler,
  run: (api: Api) => Promise<void>,
  decorate?: Parameters<typeof receiver>[1],
) {
  const api = await receiver(handler, decorate);
  let passed = false,
    settled = false;
  try {
    await run(api);
    passed = true;
  } finally {
    try {
      await api.close(false);
      settled = true;
    } finally {
      writeFileSync(
        join(api.root, 'p1c-wires.json'),
        JSON.stringify(
          api.wires.map(({ path, method, body, ids }) => ({
            path,
            method,
            body,
            ids,
          })),
        ),
      );
      writeFileSync(
        join(api.root, 'p1c-resource-status.json'),
        JSON.stringify({ passed, settled, pid: process.pid }),
      );
      console.error(
        'P1C_FIXTURE ' + JSON.stringify({ root: api.root, passed, settled }),
      );
    }
  }
}

function p1cProjection(api: Api, config: ConfiguredSubmission, label: string) {
  const state = logicalProjection(config);
  writeFileSync(
    join(api.root, `p1c-logical-${label}.json`),
    JSON.stringify(state),
  );
  return state;
}

// P1C oracles spell out the synthetic wire facts and canonical hash tuple. They
// do not call the proposal/comparison/fingerprint builders being integrated.
function productionOracle(
  config: ConfiguredSubmission,
  engine: 'google' | 'yandex',
) {
  const family = `${engine}/indexer` as RetryFamily;
  const local = localSnapshot(config);
  const provenance =
    engine === 'google' ? 'local_standalone' : 'external_unattributed';
  const originalManifestKnown = engine === 'google';
  const manifestProvenance = originalManifestKnown
    ? 'durable_local_intent_ack'
    : 'provider_report_observed_corpus';
  const manifestDigest = originalManifestKnown
    ? H('speedyindex-intent-url-manifest-v1', [family, [A, B, C]])
    : H('speedyindex-provider-report-url-manifest-v1', [
        family,
        'parent',
        [C, A, B],
      ]);
  const fact: RetryPass[1][number] = [
    family,
    'parent',
    3,
    3,
    1,
    true,
    'completed',
    [Date.parse('2026-10-01T00:00:00Z'), ''],
    engine === 'google' ? true : null,
    [Date.parse('2026-10-08T00:00:00Z'), ''],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const pass: RetryPass = [
    [
      [
        'google/indexer',
        'regular',
        0,
        [[0, engine === 'google' ? [[family, 'parent']] : []]],
      ],
      ['google/indexer', 'drip', 0, [[0, []]]],
      [
        'yandex/indexer',
        'regular',
        0,
        [[0, engine === 'yandex' ? [[family, 'parent']] : []]],
      ],
    ],
    [fact],
    [],
    [family, 'parent', 3, 3, 1, [C], [A, B], fact],
    [],
  ];
  const safetyEvidenceDigests = [
    H('speedyindex-retry-observation-safety-v1', pass),
    H('speedyindex-retry-local-safety-v1', [
      local.revision,
      family,
      'parent',
      provenance,
      manifestDigest,
    ]),
  ];
  const partitionDigest = H('speedyindex-retry-partition-v1', [
    [A, B],
    [A, B],
    [],
    [0, originalManifestKnown ? [] : null],
  ]);
  const body =
    engine === 'google'
      ? '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"],"pay_per_indexed":true,"drip_feed":false}'
      : '{"urls":["https://example.test/A?b=1&a=2","https://example.test/A/?b=1&a=2"]}';
  const payloadDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const quoteVersion = 'speedyindex-indexing-batch-2026-10-20-v1';
  const providerRoute = `/v2/task/${family}/create` as const;
  const reservation =
    engine === 'google'
      ? { tokens: 200, indexer: 0, checker: 0 }
      : { tokens: 40, indexer: 2, checker: 0 };
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
      credentialFingerprint: fingerprint,
      budgetScope: config.snapshot.policy.budgetScope,
      periodId: period.id,
      periodStartMs: period.startMs,
    },
  );
  const preimage: RetryPlanFingerprintInput = {
    parent: { family, taskId: 'parent' },
    provenance,
    originalManifestKnown,
    manifestProvenance,
    sourceManifestDigest: manifestDigest,
    safetyEvidenceDigests,
    partitionDigest,
    revision: local.revision,
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
  const planFingerprint = H('speedyindex-retry-plan-v1', [
    family,
    'parent',
    provenance,
    originalManifestKnown,
    manifestProvenance,
    manifestDigest,
    safetyEvidenceDigests,
    partitionDigest,
    local.revision,
    config.snapshot.digest,
    authorizationFingerprint,
    payloadDigest,
    quoteVersion,
    quoteFingerprint,
    [period.id, period.startMs, period.endMs],
    providerRoute,
    2,
    Buffer.byteLength(body, 'utf8'),
    [reservation.tokens, reservation.indexer, reservation.checker],
  ]);
  const source: RetryPlanReady['source'] = {
    reference: [family, 'parent'],
    provenance,
    originalManifestKnown,
    manifestProvenance,
    manifestDigest,
  };
  return { body, preimage, planFingerprint, source };
}
function expectProductionReady(
  view: RetryPlanReady | Extract<PlanRetryResult, { status: 'ready' }>,
  oracle: ReturnType<typeof productionOracle>,
  config: ConfiguredSubmission,
  publicOutput = false,
) {
  expect(view.source).toEqual(oracle.source);
  expect(view.eligibleUrls).toEqual([A, B]);
  expect(view.excluded).toEqual([]);
  expect(view.counts).toEqual({
    indexed: 1,
    unindexed: 2,
    eligible: 2,
    excluded: 0,
    unknown: 0,
  });
  expect(view.request).toEqual({
    family: oracle.preimage.parent.family,
    providerRoute: `/v2/task/${oracle.preimage.parent.family}/create`,
    payloadDigest: oracle.preimage.payloadDigest,
    urlCount: 2,
    providerBodyBytes: Buffer.byteLength(oracle.body),
  });
  expect(view.quote).toEqual({
    version: 'speedyindex-indexing-batch-2026-10-20-v1',
    fingerprint: oracle.preimage.quoteFingerprint,
    maximumExposure: oracle.preimage.reservation,
    basis: 'documented_independent_maxima',
    providerEnforced: false,
  });
  expect(view.authorization).toEqual({
    state: 'configured',
    stateChecked: true,
    mode: config.snapshot.policy.mode,
    policyRevision: config.snapshot.policy.policyRevision,
    policyDigest: config.snapshot.digest,
    budgetScope: config.snapshot.policy.budgetScope,
    caps: config.snapshot.policy.caps,
    period: oracle.preimage.period,
    fingerprint: oracle.preimage.authorizationFingerprint,
  });
  expect(view.identity).toEqual({
    status: 'comparison',
    preimage: oracle.preimage,
    fingerprint: oracle.planFingerprint,
  });
  const inspect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    for (const [key, item] of Object.entries(value)) {
      expect([
        'proof',
        'input',
        'body',
        'ledgerId',
        'stateDirectory',
        'credential',
        'binding',
        'callback',
        'preimages',
        'observations',
        'requestId',
        'inspectionId',
      ]).not.toContain(key);
      expect(typeof item).not.toBe('function');
      inspect(item);
    }
  };
  inspect(view);
  if (publicOutput)
    expect(
      'searchEngine' in view &&
        view.searchEngine === oracle.preimage.parent.family.split('/')[0],
    ).toBe(true);
  expect(Object.keys(view).sort()).toEqual(
    [
      'authorization',
      'counts',
      'eligibleUrls',
      'excluded',
      'identity',
      'quote',
      'request',
      'source',
      'status',
      ...(publicOutput ? ['searchEngine'] : []),
    ].sort(),
  );
  for (const privateValue of [
    fixtureKey,
    fingerprint,
    config.stateDirectory,
    localSnapshot(config).ledgerId,
    'retry-read-only-inspection',
  ])
    expect(JSON.stringify(view)).not.toContain(privateValue);
}
function retryHost(
  api: Api,
  config: ConfiguredSubmission,
  clock = new Clock(),
) {
  return new SubmissionHost(config, {
    fetchRequest: api.fetch,
    clock: () => clock.utcMs(),
    retry: { monotonicMs: () => clock.monotonicMs(), runtime: clock },
  });
}
function productionComposition(
  api: Api,
  config: ConfiguredSubmission,
  clock = new Clock(),
) {
  return composeVerifiedRetryAdmission({
    configuration: config,
    transport: { fetch: api.fetch },
    clock,
    owner: { runtime: clock },
  });
}
function expectProductionWires(api: Api, engine: 'google' | 'yandex') {
  const pass = [
    { path: '/v2/task/google/indexer/list/0', method: 'GET', body: '' },
    {
      path: '/v2/task/google/indexer/list/0?filter=drip_feed',
      method: 'GET',
      body: '',
    },
    { path: '/v2/task/yandex/indexer/list/0', method: 'GET', body: '' },
    {
      path: `/v2/task/${engine}/indexer/status`,
      method: 'POST',
      body: '{"task_ids":["parent"]}',
    },
    {
      path: `/v2/task/${engine}/indexer/report`,
      method: 'POST',
      body: '{"task_id":"parent"}',
    },
  ];
  expect(
    api.wires.map(({ path, method, body }) => ({ path, method, body })),
  ).toEqual([...pass, ...pass]);
}
for (const engine of ['google', 'yandex'] as const)
  test(`P1C-01 actual host ${engine === 'google' ? 'local Google' : 'permitted external Yandex'} ready is frozen, independently identified and logically read-only`, async () => {
    await withProductionReceiver(script(singleSource(engine)), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: engine === 'yandex',
          maxAttemptsPerSource: 3,
        },
      });
      if (engine === 'google') seedStandalone(config, 'parent', [A, B, C]);
      const before = p1cProjection(api, config, 'before'),
        oracle = productionOracle(config, engine);
      const host = retryHost(api, config);
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before); // Constructor opened no state.
      expect(api.wires).toHaveLength(0);
      const operation = host.planRetry({ searchEngine: engine });
      api.operations.push(operation);
      const result = await bounded(operation);
      expect(result.status).toBe('ready');
      if (result.status !== 'ready')
        throw new Error(
          'Expected production host ready: ' + JSON.stringify(result),
        );
      expectProductionReady(result, oracle, config);
      expectProductionWires(api, engine);
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
      expect(localSnapshot(config).retryChildren).toEqual([]);
      if (engine === 'yandex')
        expect(localSnapshot(config).acceptedManifests).toEqual([]);
    });
  });

test('P1C-02 strict authority/preabort/inactive/binding/mixed construction reject before SQL or HTTP and retain preview', async () => {
  await withProductionReceiver(script(singleSource()), async (api) => {
    const config = fixtureConfiguration(api);
    const before = p1cProjection(api, config, 'before'),
      phases: string[] = [];
    let opens = 0;
    const options: SubmissionHostOptions = {
      fetchRequest: api.fetch,
      clock: () => utc,
      openLedger(value) {
        opens++;
        return openLedger(value);
      },
      retry: {
        monotonicMs: () => 100,
        hooks: {
          onOwnerPhase(phase) {
            phases.push(phase);
          },
        },
      },
    };
    const host = new SubmissionHost(config, options);
    expect(await host.planRetry({ proof: {} })).toEqual({
      status: 'error',
      code: 'InvalidInput',
    });
    const abort = new AbortController();
    abort.abort();
    expect(await host.planRetry({}, abort.signal)).toEqual({
      status: 'error',
      code: 'Cancelled',
    });
    const inactive = new SubmissionHost(
      loadSubmissionConfiguration({ apiKey: '' }),
      options,
    );
    expect(await inactive.planRetry({})).toEqual({
      status: 'blocked',
      blockers: ['StateUnavailable'],
    });
    expect(
      await inactive.createIndexingTask({
        mode: 'preview',
        searchEngine: 'google',
        urls: [A],
      }),
    ).toMatchObject({
      status: 'preview',
      authorization: { state: 'unconfigured', stateChecked: false },
    });
    // Use the actual loader's mismatched-key result as well as a malformed trusted binding.
    const mismatch = loadSubmissionConfiguration({
      apiKey: 'different-synthetic-key',
      policyPath: join(api.root, 'policy.json'),
      stateDirectory: config.stateDirectory,
    });
    expect(mismatch.state).toBe('credential_mismatch');
    expect(await new SubmissionHost(mismatch, options).planRetry({})).toEqual({
      status: 'blocked',
      blockers: ['StateUnavailable'],
    });
    const malformed = structuredClone(config);
    (malformed.credential as { fingerprint: string }).fingerprint = '0'.repeat(
      64,
    );
    expect(await new SubmissionHost(malformed, options).planRetry({})).toEqual({
      status: 'error',
      code: 'InternalError',
    });
    const mixed = {
      configuration: config,
      transport: { fetch: api.fetch },
      verifier: fixtureRetryVerifier(fixtureRetryEvidence([C, A, B])),
      clock: new Clock(),
    };
    expect(() => composeVerifiedRetryAdmission(mixed as never)).toThrow(
      'Invalid submission ledger input.',
    );
    const composition = productionComposition(api, config);
    expect(
      await composition.collectLatest(
        { binding: fingerprint },
        'synthetic-invalid',
      ),
    ).toEqual({ status: 'error', code: 'InvalidInput' });
    expect(
      await composition.collectLatest({}, 'synthetic-preabort', abort.signal),
    ).toEqual({ status: 'error', code: 'Cancelled' });
    expect(phases).toEqual([]);
    expect(opens).toBe(0);
    expect(api.wires).toEqual([]);
    expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
  });
});
for (const retry of [
  undefined,
  { enabled: false, allowUnattributedParents: false, maxAttemptsPerSource: 3 },
])
  test(`P1C-02 ${retry ? 'disabled' : 'absent'} retry preserves ordinary configured construction and preview`, async () => {
    await withProductionReceiver(script(), async (api) => {
      const config = fixtureConfiguration(api, { retry });
      const before = p1cProjection(api, config, 'before'),
        host = retryHost(api, config);
      expect(await host.planRetry({})).toEqual({
        status: 'blocked',
        blockers: ['RetryPolicyRequired'],
      });
      expect(
        await host.createIndexingTask({
          mode: 'preview',
          searchEngine: 'google',
          urls: [A],
        }),
      ).toMatchObject({
        status: 'preview',
        authorization: { state: 'configured', stateChecked: false },
      });
      expect(api.wires).toEqual([]);
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
    });
  });

for (const route of ['host', 'composition'] as const)
  test(`P1C-02 immutable ${route} capture keeps original methods, receivers, key, state and policy before and during real HTTP`, async () => {
    const arrived = deferred(),
      release = deferred();
    const normal = script(singleSource('yandex'));
    let once = false;
    await withProductionReceiver(
      async (wire, req, res) => {
        if (!once) {
          once = true;
          arrived.resolve();
          await release.promise;
        }
        return normal(wire, req, res);
      },
      async (api) => {
        api.releases.push(() => release.resolve());
        const original = fixtureConfiguration(api),
          config = structuredClone(original),
          clock = new Clock();
        const before = p1cProjection(api, original, 'before'),
          oracle = productionOracle(original, 'yandex');
        const runtime = {
          setTimeout(callback: () => void, delay: number) {
            expect(this).toBe(runtime);
            return clock.setTimeout(callback, delay);
          },
          clearTimeout(handle: unknown) {
            expect(this).toBe(runtime);
            clock.clearTimeout(handle);
          },
        };
        const retry = {
          monotonicMs() {
            expect(this).toBe(retry);
            return clock.mono;
          },
          runtime,
        };
        const options = {
          fetchRequest(input: RequestInfo | URL, init?: RequestInit) {
            expect(this).toBe(options);
            return api.fetch(input, init);
          },
          clock() {
            expect(this).toBe(options);
            return clock.wall;
          },
          retry,
        };
        const transport = {
          fetch(input: RequestInfo | URL, init?: RequestInit) {
            expect(this).toBe(transport);
            return api.fetch(input, init);
          },
        };
        const ownerClock = {
          utcMs() {
            expect(this).toBe(ownerClock);
            return clock.wall;
          },
          monotonicMs() {
            expect(this).toBe(ownerClock);
            return clock.mono;
          },
        };
        const owner =
          route === 'host'
            ? new SubmissionHost(config, options as SubmissionHostOptions)
            : composeVerifiedRetryAdmission({
                configuration: config,
                transport: transport as { fetch: typeof fetch },
                clock: ownerClock,
                owner: { runtime },
              });
        const failMutation = () => {
          throw new Error('MUTATED_PRIVATE_DEPENDENCY');
        };
        const mutate = () => {
          transport.fetch = failMutation;
          ownerClock.utcMs = failMutation;
          ownerClock.monotonicMs = failMutation;
          options.fetchRequest = failMutation;
          options.clock = failMutation;
          retry.monotonicMs = failMutation;
          runtime.setTimeout = failMutation;
          runtime.clearTimeout = failMutation;
          (config as { stateDirectory: string }).stateDirectory = join(
            api.root,
            'missing-mutated-state',
          );
          (config.credential as { effectiveKey: string }).effectiveKey =
            'mutated-synthetic-key';
          (config.snapshot.policy.caps as { tokens: number }).tokens = 1;
          (config.snapshot.policy.retry as { enabled: boolean }).enabled =
            false;
        };
        mutate();
        const operation =
          owner instanceof SubmissionHost
            ? owner.planRetry({ searchEngine: 'yandex' })
            : owner.planLatest({ searchEngine: 'yandex' });
        api.operations.push(operation);
        await bounded(arrived.promise);
        mutate();
        release.resolve();
        const result = await bounded(operation);
        expect(result.status).toBe('ready');
        if (result.status !== 'ready')
          throw new Error(
            'Expected captured production ready: ' + JSON.stringify(result),
          );
        expectProductionReady(result, oracle, original);
        expectProductionWires(api, 'yandex');
        expect(p1cProjection(api, original, 'unchanged')).toEqual(before);
      },
    );
  });

for (const engine of ['google', 'yandex'] as const)
  test(`P1C-07 actual ${engine} production candidate is consumed only by its owning writer after measured no-write`, async () => {
    await withProductionReceiver(script(singleSource(engine)), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: engine === 'yandex',
          maxAttemptsPerSource: 3,
        },
      });
      if (engine === 'google') seedStandalone(config, 'parent', [A, B, C]);
      const clock = new Clock(),
        oracle = productionOracle(config, engine),
        before = p1cProjection(api, config, 'before');
      const composition = productionComposition(api, config, clock);
      const operation = composition.collectLatest(
        { searchEngine: engine },
        'synthetic-retry',
      );
      api.operations.push(operation);
      const candidate = await bounded(operation);
      expect('kind' in candidate && candidate.kind).toBe('candidate');
      if (!('kind' in candidate))
        throw new Error(
          'Expected real production candidate: ' + JSON.stringify(candidate),
        );
      expectProductionReady(candidate.view, oracle, config);
      expect(candidate.request.body).toBe(oracle.body);
      expect(candidate.input.intent.submittedUrls).toEqual([A, B]);
      expect(candidate.input.planFingerprint).toBe(oracle.planFingerprint);
      expect(candidate.input.sourceManifestDigest).toBe(
        oracle.source.manifestDigest,
      );
      expectProductionWires(api, engine);
      expect(
        p1cProjection(api, config, 'after-collection-before-prepare'),
      ).toEqual(before); // BEFORE any explicit synthetic prepare.
      const foreign = productionComposition(api, config, clock).open();
      try {
        expect(() =>
          foreign.prepareVerifiedRetryIntent(candidate.input, candidate.proof),
        ).toThrow('Retry admission proof is unavailable or mismatched.');
      } finally {
        foreign.close();
      }
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
      const writer = composition.open();
      try {
        const impostor = JSON.parse(
          JSON.stringify(candidate.proof),
        ) as RetryProof;
        expect(() =>
          writer.prepareVerifiedRetryIntent(candidate.input, impostor),
        ).toThrow('Retry admission proof is unavailable or mismatched.');
        expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
        const prepared = writer.prepareVerifiedRetryIntent(
          candidate.input,
          candidate.proof,
        );
        expect(prepared.kind).toBe('created');
        expect(prepared.intent).toMatchObject({
          requestId: 'synthetic-retry',
          state: 'prepared',
          stateVersion: 0,
          taskFamily: `${engine}/indexer`,
          payloadDigest: oracle.preimage.payloadDigest,
          quoteFingerprint: oracle.preimage.quoteFingerprint,
          reservation: oracle.preimage.reservation,
          urlCount: 2,
          periodId: oracle.preimage.period.id,
        });
        const after = p1cProjection(api, config, 'after-explicit-prepare');
        const db = new Database(
          join(config.stateDirectory, 'ledger.sqlite'),
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
        );
        try {
          expect(
            db
              .query(
                `SELECT origin_kind,parent_family,parent_task_id,source_manifest_digest,plan_fingerprint FROM intent_context WHERE request_id='synthetic-retry'`,
              )
              .get(),
          ).toEqual({
            origin_kind: 'retry',
            parent_family: `${engine}/indexer`,
            parent_task_id: 'parent',
            source_manifest_digest: oracle.source.manifestDigest,
            plan_fingerprint: oracle.planFingerprint,
          });
          expect(
            db
              .query(
                `SELECT url_text FROM intent_urls WHERE request_id='synthetic-retry' ORDER BY ordinal`,
              )
              .all(),
          ).toEqual([{ url_text: A }, { url_text: B }]);
          expect(
            db
              .query(
                `SELECT state,CAST(state_version AS TEXT) AS version,CAST(reserved_tokens AS TEXT) AS tokens,CAST(reserved_indexer AS TEXT) AS indexer,CAST(reserved_checker AS TEXT) AS checker,provider_task_id,provider_type FROM intents WHERE request_id='synthetic-retry'`,
              )
              .get(),
          ).toEqual({
            state: 'prepared',
            version: '0',
            tokens: engine === 'google' ? '200' : '40',
            indexer: engine === 'google' ? '0' : '2',
            checker: '0',
            provider_task_id: null,
            provider_type: null,
          });
          expect(
            db
              .query(
                `SELECT COUNT(*) AS n FROM intent_events WHERE request_id='synthetic-retry'`,
              )
              .get(),
          ).toEqual({ n: 1 });
          expect(db.query(`SELECT COUNT(*) AS n FROM intents`).get()).toEqual({
            n: engine === 'google' ? 2 : 1,
          });
          expect(
            db.query(`SELECT COUNT(*) AS n FROM intent_context`).get(),
          ).toEqual({ n: engine === 'google' ? 2 : 1 });
        } finally {
          db.close();
        }
        expect(
          localSnapshot(config).acceptedManifests.map(
            (row) => row.providerTaskId,
          ),
        ).toEqual(engine === 'google' ? ['parent'] : []);
        expect(() =>
          writer.prepareVerifiedRetryIntent(
            {
              ...candidate.input,
              intent: {
                ...candidate.input.intent,
                requestId: 'consumed-new-id',
              },
            },
            candidate.proof,
          ),
        ).toThrow('Retry admission proof is unavailable or mismatched.');
        expect(logicalProjection(config)).toEqual(after);
        clock.mono += 60000;
        const replay = writer.prepareVerifiedRetryIntent(candidate.input);
        expect(replay.kind).toBe('replay');
        expect('dispatchCapability' in replay).toBe(false);
        expect(logicalProjection(config)).toEqual(after);
        expect(api.wires).toHaveLength(10); // No dispatch or repeat scan.
      } finally {
        writer.close();
      }
    });
  });

test('P1C-07 private request identity mismatch consumes no rows and cannot restore the consumed proof', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api),
      before = p1cProjection(api, config, 'before');
    const composition = productionComposition(api, config);
    const operation = composition.collectLatest(
      { searchEngine: 'yandex' },
      'private-original-id',
    );
    api.operations.push(operation);
    const candidate = await bounded(operation);
    if (!('kind' in candidate))
      throw new Error('Expected private identity candidate.');
    expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
    const writer = composition.open();
    try {
      expect(() =>
        writer.prepareVerifiedRetryIntent(
          {
            ...candidate.input,
            intent: {
              ...candidate.input.intent,
              requestId: 'private-altered-id',
            },
          },
          candidate.proof,
        ),
      ).toThrow('Retry admission proof is unavailable or mismatched.');
      expect(() =>
        writer.prepareVerifiedRetryIntent(candidate.input, candidate.proof),
      ).toThrow('Retry admission proof is unavailable or mismatched.');
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
      expect(api.wires).toHaveLength(10);
    } finally {
      writer.close();
    }
  });
});

// B1 native helpers begin. The private sanity entry executes these exact bytes.
class NativeOwnerClock extends Clock {
  arms: { at: number; delay: number; fired: boolean; cleared: boolean }[] = [];
  handles = new Map<unknown, (typeof this.arms)[number]>();
  breakClear = false;
  override setTimeout(callback: () => void, delay: number) {
    const record = { at: this.mono, delay, fired: false, cleared: false };
    const handle = setTimeout(() => {
      record.fired = true;
      this.handles.delete(handle);
      this.mono = Math.max(this.mono, record.at + record.delay);
      callback();
    }, delay);
    this.arms.push(record);
    this.handles.set(handle, record);
    return handle;
  }
  override clearTimeout(handle: unknown) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
    const record = this.handles.get(handle);
    if (record) record.cleared = true;
    this.handles.delete(handle);
    if (this.breakClear) {
      this.breakClear = false;
      throw new Error('PRIVATE_CLEANUP_SENTINEL');
    }
  }
}
function trackOwnerSignal(signal: AbortSignal) {
  const active = new Set<EventListenerOrEventListenerObject>();
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'abort') active.add(listener);
      add(type, listener, options);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      if (type === 'abort') active.delete(listener);
      remove(type, listener, options);
    },
  });
  return {
    active,
    restore() {
      Reflect.deleteProperty(signal, 'addEventListener');
      Reflect.deleteProperty(signal, 'removeEventListener');
    },
  };
}
// B1 native helpers end.

const allCreatePolicy: Partial<SubmissionPolicy> = {
  allowIndexChecks: true,
  indexCheckReservations: { google: { tokens: 3, indexer: 0, checker: 1 } },
  allowBacklinkChecks: true,
  backlinkCheckReservations: { tokens: 2, indexer: 0, checker: 1 },
};
async function expectAllFreshBlocked(
  host: SubmissionHost,
  code: 'SubmissionBusy' | 'StateUnavailable' = 'SubmissionBusy',
) {
  const inputs = [
    host.createIndexingTask({
      mode: 'submit',
      searchEngine: 'google',
      requestId: 'new-indexing',
      urls: ['https://example.test/new-indexing'],
    }),
    host.createIndexCheck({
      mode: 'submit',
      searchEngine: 'google',
      requestId: 'new-check',
      urls: ['https://example.test/new-check'],
    }),
    host.createBacklinkCheck({
      mode: 'submit',
      requestId: 'new-backlink',
      urls: ['https://example.test/new-backlink'],
      targetDomains: ['synthetic.test'],
    }),
  ];
  for (const result of await Promise.all(inputs))
    expect(result.error?.code).toBe(code);
}
function b1Host(
  api: Api,
  config: ConfiguredSubmission,
  clock: NativeOwnerClock,
  options: NonNullable<SubmissionHostOptions['retry']> = {},
) {
  return new SubmissionHost(config, {
    fetchRequest: api.fetch,
    clock: () => clock.wall,
    retry: { monotonicMs: () => clock.mono, runtime: clock, ...options },
  });
}
function expectSafeFailure(value: unknown) {
  const json = JSON.stringify(value);
  for (const sentinel of [
    fixtureKey,
    fingerprint,
    'PRIVATE_',
    'dispatchCapability',
    'proof',
    'ledgerId',
    'stateDirectory',
    'retry-read-only-inspection',
  ])
    expect(json).not.toContain(sentinel);
  expect('identity' in (value as object)).toBe(false);
  expect('kind' in (value as object)).toBe(false);
}

test('P1C-03 actual shared host guard excludes planner and all three fresh creates while preview/exact replay remain pure', async () => {
  const arrived = deferred(),
    release = deferred();
  let held = false;
  const normal = script(singleSource());
  await withProductionReceiver(
    async (wire, req, res) => {
      if (!held && wire.path.endsWith('/report')) {
        held = true;
        arrived.resolve();
        await release.promise;
      }
      return normal(wire, req, res);
    },
    async (api) => {
      api.releases.push(() => release.resolve());
      const config = fixtureConfiguration(api, {
        ...allCreatePolicy,
        mode: 'caller_acknowledgement',
      });
      seedStandalone(config, 'parent', [A, B, C]);
      const clock = new NativeOwnerClock(),
        phases: string[] = [];
      const host = b1Host(api, config, clock, {
        hooks: {
          onOwnerPhase(phase) {
            phases.push(phase);
          },
        },
      });
      const before = p1cProjection(api, config, 'before');
      const planning = host.planRetry({});
      api.operations.push(planning);
      await bounded(arrived.promise);
      const wireCount = api.wires.length,
        initialReads = phases.filter((p) => p === 'before_initial_read').length;
      expect(await host.planRetry({})).toEqual({
        status: 'error',
        code: 'SubmissionBusy',
      });
      await expectAllFreshBlocked(host);
      expect(
        await host.createIndexingTask({
          mode: 'preview',
          searchEngine: 'google',
          urls: [A, B],
        }),
      ).toMatchObject({
        status: 'preview',
        authorization: { stateChecked: false },
      });
      const replay = await host.createIndexingTask({
        mode: 'submit',
        searchEngine: 'google',
        requestId: 'seed-parent',
        urls: [A, B, C],
      });
      expect(replay).toMatchObject({
        status: 'accepted',
        replayed: true,
        intent: { requestId: 'seed-parent', providerTaskId: 'parent' },
      });
      expect('dispatchCapability' in replay).toBe(false);
      expect(api.wires).toHaveLength(wireCount);
      expect(phases.filter((p) => p === 'before_initial_read')).toHaveLength(
        initialReads,
      );
      expect(p1cProjection(api, config, 'held-unchanged')).toEqual(before);
      release.resolve();
      expect((await bounded(planning)).status).toBe('ready');
      const next = host.planRetry({});
      api.operations.push(next);
      expect((await bounded(next)).status).toBe('ready');
      expect(clock.handles.size).toBe(0);
      expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
    },
  );
});

for (const remaining of [0, 1])
  test(`P1C-04 real initial snapshot spends original lowered horizon with ${remaining} ticks remaining`, async () => {
    const tail = deferred();
    await withProductionReceiver(
      async () => {
        await tail.promise;
        return undefined;
      },
      async (api) => {
        api.releases.push(() => tail.resolve());
        const config = fixtureConfiguration(api),
          clock = new NativeOwnerClock();
        const before = p1cProjection(api, config, 'before');
        const phases: string[] = [];
        const origin = clock.mono,
          horizon = 101,
          spent = horizon - remaining;
        const host = b1Host(api, config, clock, {
          limits: { horizonMs: horizon },
          hooks: {
            onOwnerPhase(phase) {
              phases.push(phase);
              // Charge the native reader phase at its actual return; no snapshot is supplied.
              if (phase === 'after_initial_read') clock.mono += spent;
            },
          },
        });
        const operation = host.planRetry({});
        api.operations.push(operation);
        const result = await bounded(operation);
        expect(phases).toContain('after_initial_read');
        expect(result).toMatchObject({
          status: 'error',
          code: 'DeadlineExceeded',
        });
        expectSafeFailure(result);
        expect(api.wires.length).toBe(remaining);
        expect(clock.arms.length).toBe(remaining);
        if (remaining) {
          expect(clock.arms[0]).toEqual({
            at: origin + spent,
            delay: horizon - spent,
            fired: true,
            cleared: false,
          });
          expect(clock.mono).toBe(origin + horizon);
        }
        expect(clock.handles.size).toBe(0);
        expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
        writeFileSync(
          join(api.root, 'p1c-clock.json'),
          JSON.stringify({ origin, horizon, spent, phases, arms: clock.arms }),
        );
      },
    );
  });

for (const boundary of [
  'scan_day',
  'identity_expiry',
  'result_expiry',
  'close_day',
  'owner_bad_clock',
] as const)
  test(`P1C-06 original day and final owner fence refuse ${boundary} without identity/proof`, async () => {
    const clock = new NativeOwnerClock(),
      normal = script(singleSource('yandex'));
    let moved = false;
    await withProductionReceiver(
      (wire, req, res) => {
        if (
          boundary === 'scan_day' &&
          !moved &&
          wire.path.endsWith('/report')
        ) {
          moved = true;
          clock.wall += 86400000;
        }
        return normal(wire, req, res);
      },
      async (api) => {
        const config = fixtureConfiguration(api),
          before = p1cProjection(api, config, 'before'),
          phases: string[] = [];
        const hooks = {
          onOwnerPhase(
            phase: import('../src/submission-ledger').RetryOwnerPhase,
          ) {
            phases.push(phase);
            if (boundary === 'identity_expiry' && phase === 'after_identity')
              clock.mono += 60000;
            if (boundary === 'result_expiry' && phase === 'after_serialization')
              clock.mono += 60000;
            if (boundary === 'owner_bad_clock' && phase === 'after_identity')
              clock.mono = Number.NaN;
            if (boundary === 'close_day' && phase === 'before_close')
              queueMicrotask(() => {
                clock.wall += 86400000;
              });
          },
        };
        const host = b1Host(api, config, clock, { hooks });
        const operation = host.planRetry({ searchEngine: 'yandex' });
        api.operations.push(operation);
        const result = await bounded(operation);
        if (boundary.endsWith('day'))
          expect(result).toEqual({
            status: 'blocked',
            blockers: ['StalePeriodContext'],
          });
        else
          expect(result).toMatchObject({
            status: 'error',
            code: 'DeadlineExceeded',
          });
        expectSafeFailure(result);
        expect(api.wires).toHaveLength(10);
        expect(phases).toContain('after_close');
        if (boundary === 'close_day') {
          expect(phases).toContain('after_serialization');
          expect(phases.indexOf('after_serialization')).toBeLessThan(
            phases.indexOf('before_close'),
          );
        }
        expect(clock.handles.size).toBe(0);
        expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
        writeFileSync(
          join(api.root, 'p1c-phases.json'),
          JSON.stringify(phases),
        );
      },
    );
  });

for (const boundary of [
  'headers_deadline',
  'pending_body',
  'eof_cancel',
] as const)
  test(`P1C-08 actual ${boundary} keeps shared guard through native settlement`, async () => {
    const arrived = deferred(),
      tail = deferred(),
      entered = deferred(),
      release = deferred(),
      nativeClosed = deferred(),
      pendingRead = deferred();
    const controller = new AbortController(),
      signal = trackOwnerSignal(controller.signal),
      clock = new NativeOwnerClock();
    const normal = script(singleSource('yandex'));
    let once = false,
      done = false,
      nativeClosedCount = 0,
      nativeReadCalls = 0;
    try {
      await withProductionReceiver(
        async (wire, req, res) => {
          if (!once) {
            once = true;
            arrived.resolve();
            if (boundary === 'headers_deadline') {
              await tail.promise;
              return undefined;
            }
            if (boundary === 'pending_body') {
              res.writeHead(200);
              res.write('{"code":0,');
              await tail.promise;
              return undefined;
            }
          }
          return normal(wire, req, res);
        },
        async (api) => {
          api.releases.push(
            () => tail.resolve(),
            () => release.resolve(),
          );
          const config = fixtureConfiguration(api),
            before = p1cProjection(api, config, 'before');
          const host = new SubmissionHost(config, {
            fetchRequest:
              boundary === 'headers_deadline'
                ? (Object.assign(
                    async (input: RequestInfo | URL, init?: RequestInit) => {
                      try {
                        return await api.fetch(input, init);
                      } catch (error) {
                        entered.resolve();
                        await release.promise;
                        throw error;
                      }
                    },
                    {
                      preconnect() {
                        throw new Error('Unexpected preconnect.');
                      },
                    },
                  ) as typeof fetch)
                : api.fetch,
            clock: () => clock.wall,
            retry: {
              monotonicMs: () => clock.mono,
              runtime: clock,
              ...(boundary === 'headers_deadline'
                ? { limits: { horizonMs: 150 } }
                : {}),
            },
          });
          const operation = host.planRetry(
            { searchEngine: 'yandex' },
            controller.signal,
          );
          api.operations.push(operation);
          void operation.then(() => {
            done = true;
          });
          await bounded(arrived.promise);
          if (boundary === 'headers_deadline') {
            // A pre-header fetch has no response/body to decorate. Hold its actual
            // rejected native fetch receipt below, after the peer observes abort.
            await bounded(entered.promise);
          } else {
            if (boundary === 'pending_body') {
              await bounded(pendingRead.promise);
              controller.abort();
            }
            await bounded(entered.promise);
          }
          await bounded(Promise.all(api.terminations));
          if (boundary !== 'headers_deadline')
            await bounded(nativeClosed.promise);
          expect(done).toBe(false);
          expect(await host.planRetry({})).toEqual({
            status: 'error',
            code: 'SubmissionBusy',
          });
          const blocked = await host.createIndexingTask({
            mode: 'submit',
            searchEngine: 'google',
            requestId: 'blocked-during-settlement',
            urls: [A],
          });
          expect(blocked.error?.code).toBe('SubmissionBusy');
          expect(api.wires).toHaveLength(1);
          release.resolve();
          tail.resolve();
          const result = await bounded(operation);
          expect(result).toMatchObject({
            status: 'error',
            code:
              boundary === 'headers_deadline'
                ? 'DeadlineExceeded'
                : 'Cancelled',
          });
          expectSafeFailure(result);
          expect(clock.handles.size).toBe(0);
          expect(signal.active.size).toBe(0);
          if (boundary !== 'headers_deadline')
            expect(nativeClosedCount).toBe(1);
          expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
          // Actual settled failure permits this same host to plan again.
          const recovery = host.planRetry({ searchEngine: 'yandex' });
          api.operations.push(recovery);
          expect((await bounded(recovery)).status).toBe('ready');
        },
        (response) => {
          if (boundary === 'headers_deadline' || !once) return response;
          const body = response.body;
          if (!body) return response;
          const decorated = new Proxy(body, {
            get(target, field) {
              if (field === 'getReader')
                return () => {
                  const reader = target.getReader();
                  void reader.closed.then(
                    () => {
                      nativeClosedCount++;
                      nativeClosed.resolve();
                    },
                    () => {
                      nativeClosedCount++;
                      nativeClosed.resolve();
                    },
                  );
                  return new Proxy(reader, {
                    get(actual, key) {
                      if (key === 'read')
                        return async () => {
                          const reading = actual.read();
                          if (++nativeReadCalls === 2) pendingRead.resolve();
                          const value = await reading;
                          if (boundary === 'eof_cancel' && value.done)
                            controller.abort();
                          return value;
                        };
                      const value = Reflect.get(actual, key, actual) as unknown;
                      return typeof value === 'function'
                        ? value.bind(actual)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(target, field, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const wrapped = new Proxy(response, {
            get(target, field) {
              if (field === 'body') return decorated;
              const value = Reflect.get(target, field, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return holdCancellation(wrapped, entered, release);
        },
      );
    } finally {
      signal.restore();
    }
  });

for (const cleanupFailure of [false, true])
  test(`P1C-10 actual ${cleanupFailure ? 'unverified cleanup poisons new work until restart' : 'clean domain failure permits reuse'} and preserves preview/exact replay`, async () => {
    const source = singleSource('yandex');
    const replayParent = task('replay-parent', {
      size: 1,
      processed_count: 1,
      indexed_count: 1,
      created_at: '2026-09-01T00:00:00Z',
    });
    const clock = new NativeOwnerClock(),
      normal = script({
        ...source,
        google: [[replayParent]],
        statuses: { ...source?.statuses, 'google:replay-parent': replayParent },
      });
    let once = false;
    await withProductionReceiver(
      (wire, req, res) => {
        if (!once) {
          once = true;
          clock.breakClear = cleanupFailure;
          res.statusCode = 503;
          return 'PRIVATE_BODY_SENTINEL /PRIVATE_PATH_SENTINEL';
        }
        return normal(wire, req, res);
      },
      async (api) => {
        const config = fixtureConfiguration(api, allCreatePolicy),
          beforeSeed = logicalProjection(config);
        seedStandalone(config, 'replay-parent', [
          'https://example.test/replay-source',
        ]);
        const before = p1cProjection(api, config, 'before');
        expect(before).not.toEqual(beforeSeed);
        const host = b1Host(api, config, clock);
        const first = host.planRetry({ searchEngine: 'yandex' });
        api.operations.push(first);
        const result = await bounded(first);
        if (cleanupFailure)
          expect(result).toMatchObject({
            status: 'error',
            code: 'InternalError',
          });
        else
          expect(result).toMatchObject({
            status: 'error',
            code: 'ReadFailed',
            cause: 'http',
          });
        expectSafeFailure(result);
        expect(clock.handles.size).toBe(0);
        const count = api.wires.length;
        expect(
          await host.createIndexingTask({
            mode: 'preview',
            searchEngine: 'google',
            urls: [A],
          }),
        ).toMatchObject({ status: 'preview' });
        const replay = await host.createIndexingTask({
          mode: 'submit',
          searchEngine: 'google',
          requestId: 'seed-replay-parent',
          urls: ['https://example.test/replay-source'],
        });
        expect(replay).toMatchObject({ status: 'accepted', replayed: true });
        expect('dispatchCapability' in replay).toBe(false);
        if (cleanupFailure) {
          expect(await host.planRetry({})).toMatchObject({
            status: 'error',
            code: 'InternalError',
          });
          await expectAllFreshBlocked(host, 'StateUnavailable');
          expect(api.wires.length).toBe(count);
          expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
          const replacement = b1Host(api, config, clock),
            next = replacement.planRetry({ searchEngine: 'yandex' });
          api.operations.push(next);
          expect((await bounded(next)).status).toBe('ready');
        } else {
          const next = host.planRetry({ searchEngine: 'yandex' });
          api.operations.push(next);
          expect((await bounded(next)).status).toBe('ready');
        }
        expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
        expect(clock.handles.size).toBe(0);
      },
    );
  });

for (const boundary of ['result_expiry', 'close_day'] as const)
  test(`P1C-06 production candidate path invalidates its own ${boundary} before handoff`, async () => {
    await withProductionReceiver(
      script(singleSource('yandex')),
      async (api) => {
        const config = fixtureConfiguration(api),
          clock = new NativeOwnerClock();
        const before = p1cProjection(api, config, 'before'),
          phases: string[] = [];
        const composition = composeVerifiedRetryAdmission({
          configuration: config,
          transport: { fetch: api.fetch },
          clock,
          owner: {
            runtime: clock,
            hooks: {
              onOwnerPhase(phase) {
                phases.push(phase);
                if (
                  boundary === 'result_expiry' &&
                  phase === 'after_serialization'
                )
                  clock.mono += 60000;
                if (boundary === 'close_day' && phase === 'before_close')
                  queueMicrotask(() => {
                    clock.wall += 86400000;
                  });
              },
            },
          },
        });
        const operation = composition.collectLatest(
          { searchEngine: 'yandex' },
          'private-candidate-expiry',
        );
        api.operations.push(operation);
        const result = await bounded(operation);
        expectSafeFailure(result);
        expect(phases).toContain('after_serialization');
        expect(phases).toContain('after_close');
        if (boundary === 'close_day')
          expect(result).toEqual({
            status: 'blocked',
            blockers: ['StalePeriodContext'],
          });
        else
          expect(result).toMatchObject({
            status: 'error',
            code: 'DeadlineExceeded',
          });
        expect(composition.isNewWorkAvailable()).toBe(true);
        expect(clock.handles.size).toBe(0);
        expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
        writeFileSync(
          join(api.root, 'p1c-result.json'),
          JSON.stringify({ result, phases }),
        );
      },
    );
  });

test('P1C-10 owning production writer retains exact replay after real cleanup poison and denies all new admission', async () => {
  const clock = new NativeOwnerClock(),
    normal = script(singleSource('yandex'));
  let fail = false;
  await withProductionReceiver(
    (wire, req, res) => {
      if (fail) {
        fail = false;
        clock.breakClear = true;
        res.statusCode = 503;
        return 'PRIVATE_ORIGINAL_HTTP_CAUSE';
      }
      return normal(wire, req, res);
    },
    async (api) => {
      const config = fixtureConfiguration(api),
        before = p1cProjection(api, config, 'before');
      const composition = composeVerifiedRetryAdmission({
        configuration: config,
        transport: { fetch: api.fetch },
        clock,
        owner: { runtime: clock },
      });
      const collecting = composition.collectLatest(
        { searchEngine: 'yandex' },
        'private-replay-before-poison',
      );
      api.operations.push(collecting);
      const candidate = await bounded(collecting);
      if (!('kind' in candidate))
        throw new Error('Expected real owning candidate before poison.');
      expect(
        p1cProjection(api, config, 'after-collection-before-prepare'),
      ).toEqual(before);
      const writer = composition.open();
      try {
        expect(
          writer.prepareVerifiedRetryIntent(candidate.input, candidate.proof)
            .kind,
        ).toBe('created');
      } finally {
        writer.close();
      }
      const stored = p1cProjection(api, config, 'after-explicit-prepare');
      fail = true;
      const poisoning = composition.collectLatest(
        { searchEngine: 'yandex' },
        'private-poisoning-collection',
      );
      api.operations.push(poisoning);
      expect(await bounded(poisoning)).toMatchObject({
        status: 'error',
        code: 'InternalError',
      });
      expect(composition.isNewWorkAvailable()).toBe(false);
      expect(clock.handles.size).toBe(0);
      clock.mono += 60000;
      const replayWriter = composition.open();
      try {
        expect(
          replayWriter.readIntent(fingerprint, candidate.input.intent.requestId)
            ?.state,
        ).toBe('prepared');
        const replay = replayWriter.prepareVerifiedRetryIntent(candidate.input);
        expect(replay.kind).toBe('replay');
        expect('dispatchCapability' in replay).toBe(false);
        let refusal: unknown;
        try {
          replayWriter.prepareVerifiedRetryIntent(
            {
              ...candidate.input,
              intent: {
                ...candidate.input.intent,
                requestId: 'private-unavailable-new-id',
              },
            },
            candidate.proof,
          );
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toMatchObject({ code: 'LedgerUnavailable' });
      } finally {
        replayWriter.close();
      }
      const reads = api.wires.length;
      expect(
        await composition.collectLatest({}, 'private-still-unavailable'),
      ).toMatchObject({ status: 'error', code: 'InternalError' });
      expect(api.wires).toHaveLength(reads);
      expect(logicalProjection(config)).toEqual(stored);
      expect(api.wires).toHaveLength(11);
    },
  );
});

function withP1cReadDb<T>(
  config: ConfiguredSubmission,
  inspect: (db: Database) => T,
): T {
  const db = new Database(
    join(config.stateDirectory, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

for (const engine of ['google', 'yandex'] as const)
  test(`SR-A2-L01 actual ${engine} created-only owner retains original time, units and historical replay`, async () => {
    await withProductionReceiver(script(singleSource(engine)), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: engine === 'yandex',
          maxAttemptsPerSource: 3,
        },
      });
      if (engine === 'google') seedStandalone(config, 'parent', [A, B, C]);
      const clock = new NativeOwnerClock(),
        controller = new AbortController(),
        listeners = trackOwnerSignal(controller.signal),
        phases: string[] = [],
        oracle = productionOracle(config, engine),
        before = p1cProjection(api, config, 'sr-l01-before');
      const composition = composeVerifiedRetryAdmission({
        configuration: config,
        transport: { fetch: api.fetch },
        clock,
        owner: {
          runtime: clock,
          hooks: {
            onOwnerPhase(phase) {
              phases.push(phase);
              if (phase === 'after_close') clock.mono = 200;
            },
          },
        },
      });
      const pending = composition.collectLatest(
        { searchEngine: engine },
        'sr-l01-child',
        controller.signal,
      );
      api.operations.push(pending);
      try {
        const candidate = await bounded(pending);
        if (!('kind' in candidate))
          throw new Error('SR-L01 requires a real production candidate.');
        expectProductionReady(candidate.view, oracle, config);
        expectProductionWires(api, engine);
        expect(p1cProjection(api, config, 'sr-l01-collected')).toEqual(before);
        expect(phases.at(-1)).toBe('after_close');
        expect(clock.handles.size).toBe(0);
        expect(listeners.active.size).toBe(0);
        const readTimerCount = clock.arms.length;
        clock.mono = 230;
        composition.checkpointCandidate(candidate.proof);
        const writer = composition.openForSubmission();
        let owner: RetryCreatedOwner | undefined;
        try {
          expect(() => composition.open()).toThrow(
            'Submission ledger is busy.',
          );
          expect(await composition.collectLatest({}, 'sr-l01-busy')).toEqual({
            status: 'error',
            code: 'SubmissionBusy',
          });
          clock.mono = 250;
          const prepared = writer.prepare(candidate.input, candidate.proof);
          expect(prepared.kind).toBe('created');
          if (prepared.kind !== 'created')
            throw new Error('SR-L01 created owner missing.');
          owner = prepared.owner;
          expect(Object.keys(prepared).sort()).toEqual(['kind', 'owner']);
          expect(Object.isFrozen(owner)).toBe(true);
          composition.discardCandidate(candidate.proof);
          expect(() =>
            composition.checkpointCandidate(candidate.proof),
          ).toThrow('Retry admission proof is unavailable or mismatched.');
          const preparedReceipt = owner.lastObservedIntent();
          expect(Object.isFrozen(preparedReceipt)).toBe(true);
          expect(Object.isFrozen(preparedReceipt.reservation)).toBe(true);
          expect('credentialFingerprint' in preparedReceipt).toBe(false);
          expect(preparedReceipt).toMatchObject({
            requestId: 'sr-l01-child',
            state: 'prepared',
            stateVersion: 0,
            taskFamily: `${engine}/indexer`,
            payloadDigest: oracle.preimage.payloadDigest,
            quoteFingerprint: oracle.preimage.quoteFingerprint,
            reservation:
              engine === 'google'
                ? { tokens: 200, indexer: 0, checker: 0 }
                : { tokens: 40, indexer: 2, checker: 0 },
            urlCount: 2,
            periodId: 'utc-day:2026-10-21',
            createdAtMs: utc,
          });
          expect(localSnapshot(config).revision).not.toBe(
            candidate.input.expectedRevision,
          );
          expect(owner.checkpoint()).toBe(59850); // Origin 100, never the writer's 250.
          const sql = withP1cReadDb(config, (db) => ({
            core: db
              .query(
                `SELECT state,state_version,reserved_tokens,reserved_indexer,reserved_checker,provider_task_id,provider_type FROM intents WHERE request_id='sr-l01-child'`,
              )
              .get(),
            context: db
              .query(
                `SELECT origin_kind,parent_family,parent_task_id,source_manifest_digest,plan_fingerprint FROM intent_context WHERE request_id='sr-l01-child'`,
              )
              .get(),
            urls: db
              .query(
                `SELECT ordinal,url_text FROM intent_urls WHERE request_id='sr-l01-child' ORDER BY ordinal`,
              )
              .all(),
            events: db
              .query(
                `SELECT event_kind AS state,state_version FROM intent_events WHERE request_id='sr-l01-child' ORDER BY state_version`,
              )
              .all(),
            counts: db
              .query(
                `SELECT (SELECT COUNT(*) FROM intents) AS intents,(SELECT COUNT(*) FROM intent_context) AS contexts`,
              )
              .get(),
          }));
          expect(sql.core).toEqual({
            state: 'prepared',
            state_version: 0,
            reserved_tokens: engine === 'google' ? 200 : 40,
            reserved_indexer: engine === 'google' ? 0 : 2,
            reserved_checker: 0,
            provider_task_id: null,
            provider_type: null,
          });
          expect(sql.context).toEqual({
            origin_kind: 'retry',
            parent_family: `${engine}/indexer`,
            parent_task_id: 'parent',
            source_manifest_digest: oracle.source.manifestDigest,
            plan_fingerprint: oracle.planFingerprint,
          });
          expect(sql.urls).toEqual([
            { ordinal: 0, url_text: A },
            { ordinal: 1, url_text: B },
          ]);
          expect(sql.events).toEqual([{ state: 'prepared', state_version: 0 }]);
          expect(sql.counts).toEqual({
            intents: engine === 'google' ? 2 : 1,
            contexts: engine === 'google' ? 2 : 1,
          });
          expect(owner.refreshIntent()).toEqual(preparedReceipt);
          if (engine === 'google')
            expect(owner.cancelPrepared()).toEqual({
              kind: 'cancelled',
              stateVersion: 1,
            });
          else {
            expect(owner.claim()).toEqual({ kind: 'claimed', stateVersion: 1 });
            expect(owner.beginPost()).toBe(59850);
            expect(() => owner!.beginPost()).toThrow(
              'Submission dispatch claim is no longer available.',
            );
            // This tests only the one-attempt entry fence. No fetch is entered.
            expect(owner.recordOutcome({ kind: 'rejected' })).toMatchObject({
              state: 'rejected',
              stateVersion: 2,
            });
          }
          const terminal = owner.refreshIntent();
          if (terminal === null)
            throw new Error(
              'SR-L01 requires an actual stored terminal intent.',
            );
          expect(terminal).toMatchObject({
            state: engine === 'google' ? 'cancelled' : 'rejected',
            stateVersion: engine === 'google' ? 1 : 2,
          });
          owner.finish();
          expect(owner.lastObservedIntent()).toEqual(terminal);
          expect(() => owner!.refreshIntent()).toThrow(
            'Submission ledger is unavailable.',
          );
          expect(() => owner!.checkpoint()).toThrow(
            'Submission ledger is unavailable.',
          );
          expect(() => owner!.claim()).toThrow(
            'Submission ledger is unavailable.',
          );
          expect(() => owner!.beginPost()).toThrow(
            'Submission ledger is unavailable.',
          );
          expect(() => owner!.cancelPrepared()).toThrow(
            'Submission ledger is unavailable.',
          );
          expect(() => owner!.recordOutcome({ kind: 'rejected' })).toThrow(
            'Submission ledger is unavailable.',
          );
          const after = p1cProjection(api, config, 'sr-l01-terminal');
          expect(
            withP1cReadDb(config, (db) =>
              db
                .query(
                  `SELECT COUNT(*) AS n FROM intent_context WHERE origin_kind='retry' AND parent_task_id='parent'`,
                )
                .get(),
            ),
          ).toEqual({ n: 1 });
          clock.mono += 60000;
          clock.wall += 86400000;
          const replayWriter = composition.openForSubmission();
          let replay;
          try {
            replay = replayWriter.prepare(candidate.input, candidate.proof);
            expect(replay).toEqual({ kind: 'replay', intent: terminal });
            expect('owner' in replay || 'dispatchCapability' in replay).toBe(
              false,
            );
          } finally {
            replayWriter.close();
          }
          expect(p1cProjection(api, config, 'sr-l01-replay')).toEqual(after);
          expect(clock.arms.length).toBe(readTimerCount); // The closed read budget was never reopened.
          expect(clock.handles.size).toBe(0);
          expect(api.wires).toHaveLength(10);
          writeFileSync(
            join(api.root, 'sr-a2-l01-receipt.json'),
            JSON.stringify({
              engine,
              phases,
              origin: 100,
              preparedAtMono: 250,
              remaining: 59850,
              readTimerCount,
              sql,
              terminal,
              replay,
              closedReadTimers: clock.handles.size,
              listeners: listeners.active.size,
              createRequests: 0,
            }),
          );
        } finally {
          writer.close();
        }
      } finally {
        listeners.restore();
      }
    });
  });

for (const refusal of [
  'discarded',
  'mismatch',
  'open_failure',
  'begin_busy',
  'before_context',
  'clock_regression',
] as const)
  test(`SR-A2-L02 actual ${refusal} retires its supplied proof without restoring rows or ownership`, async () => {
    await withProductionReceiver(
      script(singleSource('yandex')),
      async (api) => {
        const config = fixtureConfiguration(api),
          clock = new NativeOwnerClock();
        let beforeContext = 0;
        const composition = composeVerifiedRetryAdmission({
          configuration: config,
          transport: { fetch: api.fetch },
          clock,
          owner: { runtime: clock },
          hooks: {
            onPhase(phase) {
              if (phase === 'before_context') {
                beforeContext++;
                if (refusal === 'before_context')
                  throw new Error('SYNTHETIC_ROLLBACK_BEFORE_CONTEXT');
              }
            },
          },
        });
        const before = p1cProjection(api, config, 'sr-l02-before');
        const pending = composition.collectLatest(
          { searchEngine: 'yandex' },
          'sr-l02-child',
        );
        api.operations.push(pending);
        const candidate = await bounded(pending);
        if (!('kind' in candidate))
          throw new Error('SR-L02 requires a real production candidate.');
        expectProductionWires(api, 'yandex');
        let actualFailure: unknown;
        if (refusal === 'open_failure') {
          chmodSync(config.stateDirectory, 0o755);
          try {
            try {
              composition.openForSubmission();
            } catch (error) {
              actualFailure = error;
            }
          } finally {
            // Open has no proof argument. This caller owns disposal even here.
            composition.discardCandidate(candidate.proof);
            chmodSync(config.stateDirectory, 0o700);
          }
        } else {
          const writer = composition.openForSubmission();
          let blocker: Database | undefined;
          try {
            if (refusal === 'discarded') {
              composition.discardCandidate(candidate.proof);
              composition.discardCandidate(candidate.proof);
              composition.discardCandidate(Object.freeze({}) as RetryProof);
            }
            if (refusal === 'clock_regression') {
              clock.mono = 300;
              composition.checkpointCandidate(candidate.proof);
              clock.mono = 250;
              expect(() =>
                composition.checkpointCandidate(candidate.proof),
              ).toThrow('Retry admission observation has expired.');
            }
            if (refusal === 'begin_busy') {
              blocker = new Database(
                join(config.stateDirectory, 'ledger.sqlite'),
              );
              blocker.exec('BEGIN IMMEDIATE');
            }
            const input =
              refusal === 'mismatch'
                ? {
                    ...candidate.input,
                    intent: {
                      ...candidate.input.intent,
                      requestId: 'sr-l02-impostor',
                    },
                  }
                : candidate.input;
            try {
              writer.prepare(input, candidate.proof);
            } catch (error) {
              actualFailure = error;
            }
          } finally {
            try {
              if (blocker) {
                try {
                  blocker.exec('ROLLBACK');
                } finally {
                  blocker.close();
                }
              }
            } finally {
              writer.close();
            }
          }
        }
        const expectedCode =
          refusal === 'begin_busy'
            ? 'LedgerBusy'
            : refusal === 'open_failure' || refusal === 'before_context'
              ? 'LedgerUnavailable'
              : refusal === 'clock_regression'
                ? 'RetryProofExpired'
                : 'RetryProofInvalid';
        expect(actualFailure).toMatchObject({ code: expectedCode });
        expect(p1cProjection(api, config, 'sr-l02-refused')).toEqual(before);
        expect(beforeContext).toBe(refusal === 'before_context' ? 1 : 0);
        // Use the unchanged raw entry to distinguish disposal from a writer's
        // one-attempt latch. Even a native failed BEGIN cannot reuse this proof.
        const verifier = composition.open();
        try {
          expect(() =>
            verifier.prepareVerifiedRetryIntent(
              candidate.input,
              candidate.proof,
            ),
          ).toThrow('Retry admission proof is unavailable or mismatched.');
        } finally {
          verifier.close();
        }
        expect(p1cProjection(api, config, 'sr-l02-proof-retired')).toEqual(
          before,
        );
        expect(api.wires).toHaveLength(10);
        expect(composition.isNewWorkAvailable()).toBe(true);
        if (refusal === 'open_failure') {
          const next = composition.collectLatest(
            { searchEngine: 'yandex' },
            'sr-l02-independent',
          );
          api.operations.push(next);
          const fresh = await bounded(next);
          expect('kind' in fresh).toBe(true);
          if ('kind' in fresh) composition.discardCandidate(fresh.proof);
          expect(api.wires).toHaveLength(20);
        }
        expect(clock.handles.size).toBe(0);
        writeFileSync(
          join(api.root, 'sr-a2-l02-receipt.json'),
          JSON.stringify({
            refusal,
            actualFailure,
            beforeContext,
            retainedRows: 0,
            restoredProof: false,
            readRequests: api.wires.length,
            closedReadTimers: clock.handles.size,
            createRequests: 0,
          }),
        );
      },
    );
  });

for (const stage of ['prepared', 'claimed'] as const)
  for (const boundary of ['abort', 'expiry', 'day'] as const)
    test(`SR-A2-L03 actual ${stage} ownership survives controlled ${boundary} and records legitimate no-send SQL`, async () => {
      await withProductionReceiver(
        script(singleSource('yandex')),
        async (api) => {
          const config = fixtureConfiguration(api),
            clock = new NativeOwnerClock(),
            controller = new AbortController(),
            listeners = trackOwnerSignal(controller.signal);
          let committed: unknown;
          const composition = composeVerifiedRetryAdmission({
            configuration: config,
            transport: { fetch: api.fetch },
            clock,
            owner: { runtime: clock },
            hooks: {
              onPhase(phase) {
                if (phase !== 'after_prepare_commit') return;
                committed = withP1cReadDb(config, (db) =>
                  db
                    .query(
                      `SELECT state,state_version,reserved_tokens,reserved_indexer,reserved_checker FROM intents WHERE request_id='sr-l03-child'`,
                    )
                    .get(),
                );
                if (stage === 'prepared') {
                  if (boundary === 'abort') controller.abort();
                  if (boundary === 'expiry') clock.mono += 60000;
                  if (boundary === 'day') clock.wall += 86400000;
                }
              },
            },
          });
          const pending = composition.collectLatest(
            { searchEngine: 'yandex' },
            'sr-l03-child',
            controller.signal,
          );
          api.operations.push(pending);
          try {
            const candidate = await bounded(pending);
            if (!('kind' in candidate))
              throw new Error('SR-L03 requires a real production candidate.');
            const writer = composition.openForSubmission();
            try {
              const prepared = writer.prepare(candidate.input, candidate.proof);
              expect(prepared.kind).toBe('created');
              if (prepared.kind !== 'created')
                throw new Error('SR-L03 lost actual committed ownership.');
              const owner = prepared.owner;
              expect(committed).toEqual({
                state: 'prepared',
                state_version: 0,
                reserved_tokens: 40,
                reserved_indexer: 2,
                reserved_checker: 0,
              });
              expect(owner.lastObservedIntent()).toMatchObject({
                state: 'prepared',
                stateVersion: 0,
              });
              if (stage === 'claimed') {
                expect(owner.claim()).toEqual({
                  kind: 'claimed',
                  stateVersion: 1,
                });
                expect(owner.lastObservedIntent()).toMatchObject({
                  state: 'dispatching',
                  stateVersion: 1,
                });
                expect(owner.claim()).toEqual({ kind: 'lost' });
                if (boundary === 'abort') controller.abort();
                if (boundary === 'expiry') clock.mono += 60000;
                if (boundary === 'day') clock.wall += 86400000;
              }
              const expectedCode =
                boundary === 'abort'
                  ? 'RetryCancelled'
                  : boundary === 'expiry'
                    ? 'RetryProofExpired'
                    : 'StalePeriodContext';
              let fenceFailure: unknown;
              try {
                if (stage === 'prepared') owner.checkpoint();
                else owner.beginPost();
              } catch (error) {
                fenceFailure = error;
              }
              expect(fenceFailure).toMatchObject({ code: expectedCode });
              if (stage === 'prepared')
                expect(owner.cancelPrepared()).toEqual({
                  kind: 'cancelled',
                  stateVersion: 1,
                });
              else {
                expect(() => owner.beginPost()).toThrow(
                  'Submission dispatch claim is no longer available.',
                );
                const held = p1cProjection(api, config, 'sr-l03-held');
                expect(() => owner.recordOutcome({ kind: 'unknown' })).toThrow(
                  'Invalid submission ledger input.',
                );
                expect(
                  p1cProjection(api, config, 'sr-l03-invalid-outcome'),
                ).toEqual(held);
                expect(owner.recordOutcome({ kind: 'rejected' })).toMatchObject(
                  { state: 'rejected', stateVersion: 2 },
                );
                expect(() => owner.recordOutcome({ kind: 'rejected' })).toThrow(
                  'Submission outcome claim is no longer available.',
                );
              }
              const final = owner.refreshIntent();
              if (final === null)
                throw new Error(
                  'SR-L03 requires an actual stored final intent.',
                );
              const sql = withP1cReadDb(config, (db) => ({
                core: db
                  .query(
                    `SELECT state,state_version,reserved_tokens,reserved_indexer,reserved_checker,claim_token_digest,dispatch_outcome_token_digest,provider_task_id,provider_type FROM intents WHERE request_id='sr-l03-child'`,
                  )
                  .get(),
                events: db
                  .query(
                    `SELECT event_kind AS state,state_version FROM intent_events WHERE request_id='sr-l03-child' ORDER BY state_version`,
                  )
                  .all(),
                lifetime: db
                  .query(
                    `SELECT COUNT(*) AS n FROM intent_context WHERE origin_kind='retry' AND parent_task_id='parent'`,
                  )
                  .get(),
                held: db
                  .query(
                    `SELECT COALESCE(SUM(CASE WHEN state IN ('prepared','dispatching','unknown') THEN reserved_tokens ELSE 0 END),0) AS tokens,COALESCE(SUM(CASE WHEN state IN ('prepared','dispatching','unknown') THEN reserved_indexer ELSE 0 END),0) AS indexer,COALESCE(SUM(CASE WHEN state IN ('prepared','dispatching','unknown') THEN reserved_checker ELSE 0 END),0) AS checker FROM intents WHERE request_id='sr-l03-child'`,
                  )
                  .get(),
              }));
              expect(sql.core).toEqual({
                state: stage === 'prepared' ? 'cancelled' : 'rejected',
                state_version: stage === 'prepared' ? 1 : 2,
                reserved_tokens: 40,
                reserved_indexer: 2,
                reserved_checker: 0,
                claim_token_digest: null,
                dispatch_outcome_token_digest: null,
                provider_task_id: null,
                provider_type: null,
              });
              expect(sql.events).toEqual(
                stage === 'prepared'
                  ? [
                      { state: 'prepared', state_version: 0 },
                      { state: 'cancelled', state_version: 1 },
                    ]
                  : [
                      { state: 'prepared', state_version: 0 },
                      { state: 'dispatching', state_version: 1 },
                      { state: 'rejected', state_version: 2 },
                    ],
              );
              expect(sql.lifetime).toEqual({ n: 1 });
              expect(sql.held).toEqual({ tokens: 0, indexer: 0, checker: 0 });
              let finishFailure: unknown;
              try {
                owner.finish();
              } catch (error) {
                finishFailure = error;
              }
              expect(finishFailure).toMatchObject({ code: expectedCode });
              expect(owner.lastObservedIntent()).toEqual(final);
              expect(() => owner.refreshIntent()).toThrow(
                'Submission ledger is unavailable.',
              );
              expect(() => owner.checkpoint()).toThrow(
                'Submission ledger is unavailable.',
              );
              owner.finish(); // Retired finish is idempotent, with no second close/read.
              expect(composition.isNewWorkAvailable()).toBe(true);
              const after = p1cProjection(api, config, 'sr-l03-after-close');
              expect(
                withP1cReadDb(config, (db) =>
                  db.query('PRAGMA integrity_check').get(),
                ),
              ).toEqual({ integrity_check: 'ok' });
              expect(clock.handles.size).toBe(0);
              expect(listeners.active.size).toBe(0);
              expectProductionWires(api, 'yandex');
              writeFileSync(
                join(api.root, 'sr-a2-l03-receipt.json'),
                JSON.stringify({
                  stage,
                  boundary,
                  controlledClockAndSignal: true,
                  queuedIONativeDelayProven: false,
                  committed,
                  fenceFailure,
                  finishFailure,
                  sql,
                  final,
                  after,
                  readRequests: 10,
                  createRequests: 0,
                  closedReadTimers: clock.handles.size,
                  listeners: listeners.active.size,
                }),
              );
            } finally {
              writer.close();
            }
          } finally {
            listeners.restore();
          }
        },
      );
    });

test('SR-A2-L04 fixed private poison denies actual new collection/admission but preserves replay, preview and independent composition', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new NativeOwnerClock(),
      phases: string[] = [];
    const composition = composeVerifiedRetryAdmission({
      configuration: config,
      transport: { fetch: api.fetch },
      clock,
      owner: {
        runtime: clock,
        hooks: {
          onOwnerPhase(phase) {
            phases.push(phase);
          },
        },
      },
    });
    const pending = composition.collectLatest(
      { searchEngine: 'yandex' },
      'sr-l04-stored',
    );
    api.operations.push(pending);
    const candidate = await bounded(pending);
    if (!('kind' in candidate))
      throw new Error('SR-L04 requires a real production candidate.');
    const writer = composition.openForSubmission();
    try {
      const prepared = writer.prepare(candidate.input, candidate.proof);
      if (prepared.kind !== 'created')
        throw new Error('SR-L04 requires real created history.');
      expect(prepared.owner.cancelPrepared()).toEqual({
        kind: 'cancelled',
        stateVersion: 1,
      });
      prepared.owner.finish();
    } finally {
      writer.close();
    }
    const next = composition.collectLatest(
      { searchEngine: 'yandex' },
      'sr-l04-new',
    );
    api.operations.push(next);
    const fresh = await bounded(next);
    if (!('kind' in fresh))
      throw new Error('SR-L04 requires a real unused candidate before poison.');
    const stored = p1cProjection(api, config, 'sr-l04-before-poison'),
      reads = api.wires.length,
      phaseCount = phases.length;
    composition.poisonNewWork('writer_close');
    composition.poisonNewWork('paid_settlement');
    expect(
      await composition.collectLatest(
        { searchEngine: 'yandex' },
        'sr-l04-refused',
      ),
    ).toEqual({ status: 'error', code: 'InternalError' });
    expect(phases).toHaveLength(phaseCount); // Refusal precedes the initial SQL owner phase.
    expect(api.wires).toHaveLength(reads);
    expect(() => composition.checkpointCandidate(fresh.proof)).toThrow(
      'Submission ledger is unavailable.',
    );
    const blockedWriter = composition.openForSubmission();
    try {
      expect(() => blockedWriter.prepare(fresh.input, fresh.proof)).toThrow(
        'Submission ledger is unavailable.',
      );
    } finally {
      blockedWriter.close();
    }
    expect(p1cProjection(api, config, 'sr-l04-refused')).toEqual(stored);
    const identity = {
      intent: candidate.input.intent,
      parent: candidate.input.parent,
      sourceManifestDigest: candidate.input.sourceManifestDigest,
      planFingerprint: candidate.input.planFingerprint,
    };
    const narrow = readRetryReplay(
      { stateDirectory: config.stateDirectory },
      fingerprint,
      identity,
    );
    expect(narrow).toMatchObject({
      availability: 'available',
      kind: 'replay',
      intent: { state: 'cancelled', stateVersion: 1 },
    });
    const replayWriter = composition.openForSubmission();
    let replay;
    try {
      replay = replayWriter.prepare(candidate.input, candidate.proof);
      expect(replay).toMatchObject({
        kind: 'replay',
        intent: { state: 'cancelled', stateVersion: 1 },
      });
      expect('owner' in replay || 'dispatchCapability' in replay).toBe(false);
    } finally {
      replayWriter.close();
    }
    expect(
      await retryHost(api, config, clock).createIndexingTask({
        mode: 'preview',
        searchEngine: 'google',
        urls: [A],
      }),
    ).toMatchObject({ status: 'preview' });
    expect(api.wires).toHaveLength(reads);
    const independent = productionComposition(api, config, clock);
    const observing = independent.collectLatest(
      { searchEngine: 'yandex' },
      'sr-l04-independent',
    );
    api.operations.push(observing);
    const replacement = await bounded(observing);
    expect('kind' in replacement).toBe(true);
    if ('kind' in replacement) independent.discardCandidate(replacement.proof);
    expect(composition.isNewWorkAvailable()).toBe(false);
    expect(api.wires).toHaveLength(reads + 10);
    expect(p1cProjection(api, config, 'sr-l04-final')).toEqual(stored);
    expect(clock.handles.size).toBe(0);
    writeFileSync(
      join(api.root, 'sr-a2-l04-receipt.json'),
      JSON.stringify({
        poisonMethodOnly: true,
        actualNativeCleanupFaultProven: false,
        phases,
        refusedBeforeInitialSqlPhase: phaseCount,
        readsBeforePoison: reads,
        readsAfterIndependent: api.wires.length,
        narrow,
        replay,
        newRows: 0,
        createRequests: 0,
        closedReadTimers: clock.handles.size,
      }),
    );
  });
});

function cooperatingP1cCommit(config: ConfiguredSubmission) {
  const writer = openLedger({ stateDirectory: config.stateDirectory });
  try {
    expect(
      writer.prepareIntent(
        intent(config, 'cooperating-disjoint', [
          'https://example.test/cooperating-disjoint',
        ]),
      ).kind,
    ).toBe('created');
  } finally {
    writer.close();
  }
}

test('P1C-05 final native reader refuses an actual disjoint cooperating revision commit without rescan', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new NativeOwnerClock();
    const before = p1cProjection(api, config, 'before');
    let cooperating: ReturnType<typeof logicalProjection> | undefined;
    const host = b1Host(api, config, clock, {
      hooks: {
        onOwnerPhase(phase) {
          if (phase === 'before_final_read') {
            expect(api.wires).toHaveLength(10);
            cooperatingP1cCommit(config);
            cooperating = p1cProjection(
              api,
              config,
              'after-cooperating-commit',
            );
          }
        },
      },
    });
    const planning = host.planRetry({ searchEngine: 'yandex' });
    api.operations.push(planning);
    const result = await bounded(planning);
    expect(result).toEqual({
      status: 'blocked',
      blockers: ['SnapshotConflict'],
    });
    expectSafeFailure(result);
    expect(cooperating).toBeDefined();
    expect(cooperating).not.toEqual(before);
    expect(
      p1cProjection(api, config, 'unchanged-after-cooperating-commit'),
    ).toEqual(cooperating!);
    expect(
      withP1cReadDb(config, (db) =>
        db.query('SELECT request_id,state FROM intents').all(),
      ),
    ).toEqual([{ request_id: 'cooperating-disjoint', state: 'prepared' }]);
    expect(api.wires).toHaveLength(10);
    expect(clock.handles.size).toBe(0);
  });
});

test('P1C-05 actual current Yandex indexer exposure leaves insufficient remaining units', async () => {
  const opts = singleSource('yandex')!;
  const used = task('unit-use', {
    size: 1,
    processed_count: 1,
    indexed_count: 1,
    pay_per_indexed: undefined,
    created_at: '2026-09-01T00:00:00Z',
  });
  opts.yandex![0]!.push(used);
  opts.statuses!['yandex:unit-use'] = used;
  await withProductionReceiver(script(opts), async (api) => {
    const config = fixtureConfiguration(api, {
      caps: { tokens: 10000, indexer: 2, checker: 100 },
    });
    seedStandalone(
      config,
      'unit-use',
      ['https://example.test/used-unit'],
      'yandex/indexer',
    );
    const usage = withP1cReadDb(config, (db) =>
      db
        .query(
          "SELECT CAST(SUM(reserved_indexer) AS TEXT) AS indexer,CAST(SUM(reserved_tokens) AS TEXT) AS tokens FROM intents WHERE credential_fp=? AND budget_scope=? AND period_id=? AND state='accepted'",
        )
        .get(
          fingerprint,
          config.snapshot.policy.budgetScope,
          'utc-day:2026-10-21',
        ),
    );
    expect(usage).toEqual({ indexer: '1', tokens: '20' });
    expect(1 + 2).toBeGreaterThan(config.snapshot.policy.caps.indexer);
    const before = p1cProjection(api, config, 'before'),
      clock = new NativeOwnerClock();
    const operation = b1Host(api, config, clock).planRetry({
      searchEngine: 'yandex',
    });
    api.operations.push(operation);
    const result = await bounded(operation);
    expect(result).toMatchObject({
      status: 'blocked',
      blockers: ['BudgetExceeded'],
    });
    expectSafeFailure(result);
    expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
    expect(api.wires).toHaveLength(10);
    expect(clock.handles.size).toBe(0);
    writeFileSync(
      join(api.root, 'p1c-integer-oracle.json'),
      JSON.stringify({ usage, proposedIndexer: '2', capIndexer: '2' }),
    );
  });
});

test('P1C-05 exact-parent lifetime counts real cancelled and rejected attempts across old scope and UTC period', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api, {
      retry: {
        enabled: true,
        allowUnattributedParents: true,
        maxAttemptsPerSource: 2,
      },
    });
    const oldPath = join(api.root, 'old-scope-policy.json');
    writeFileSync(
      oldPath,
      JSON.stringify({
        ...config.snapshot.policy,
        budgetScope: 'old-scope',
        policyRevision: 'old-policy',
        retry: { ...config.snapshot.policy.retry, maxAttemptsPerSource: 3 },
      }),
      { mode: 0o600 },
    );
    const old = loadSubmissionConfiguration({
      apiKey: fixtureKey,
      policyPath: oldPath,
      stateDirectory: config.stateDirectory,
    });
    if (old.state !== 'configured')
      throw new Error('Expected old synthetic configuration.');
    for (const state of ['cancelled', 'rejected'] as const)
      await seedExternalChild(
        old,
        { family: 'yandex/indexer', taskId: 'parent' },
        state,
        [C, A, B],
        { requestId: 'old-' + state, utcMs: utc - 86400000 },
      );
    const attempts = withP1cReadDb(config, (db) =>
      db
        .query(
          "SELECT i.request_id,i.state,i.budget_scope,i.period_id,c.parent_family,c.parent_task_id FROM intents i JOIN intent_context c USING(credential_fp,request_id) WHERE c.origin_kind='retry' AND c.parent_family=? AND c.parent_task_id=? ORDER BY i.request_id",
        )
        .all('yandex/indexer', 'parent'),
    );
    expect(attempts).toEqual(
      ['cancelled', 'rejected'].map((state) => ({
        request_id: 'old-' + state,
        state,
        budget_scope: 'old-scope',
        period_id: 'utc-day:2026-10-20',
        parent_family: 'yandex/indexer',
        parent_task_id: 'parent',
      })),
    );
    const count = withP1cReadDb(config, (db) =>
      db
        .query(
          "SELECT CAST(COUNT(*) AS TEXT) AS attempts FROM intent_context WHERE credential_fp=? AND origin_kind='retry' AND parent_family=? AND parent_task_id=?",
        )
        .get(fingerprint, 'yandex/indexer', 'parent'),
    );
    expect(count).toEqual({ attempts: '2' });
    const before = p1cProjection(api, config, 'before'),
      clock = new NativeOwnerClock();
    const operation = b1Host(api, config, clock).planRetry({
      searchEngine: 'yandex',
    });
    api.operations.push(operation);
    const result = await bounded(operation);
    expect(result).toMatchObject({
      status: 'blocked',
      blockers: ['RetryAllowanceExceeded'],
    });
    expectSafeFailure(result);
    expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
    expect(api.wires).toHaveLength(10);
    expect(clock.handles.size).toBe(0);
    writeFileSync(
      join(api.root, 'p1c-integer-oracle.json'),
      JSON.stringify({ attempts, count, currentMaxAttempts: 2 }),
    );
  });
});

for (const kind of ['empty', 'unfinished', 'no_source_revision'] as const)
  test(`P1C-11 complete ${kind} uses actual final same-ledger snapshot without invented parent/quote`, async () => {
    const opts =
      kind === 'unfinished'
        ? singleSource('yandex', {
            is_completed: false,
            status: undefined,
            check_after: undefined,
            processed_count: 1,
            indexed_count: 0,
          })
        : {};
    await withProductionReceiver(script(opts), async (api) => {
      const config = fixtureConfiguration(api),
        clock = new NativeOwnerClock(),
        phases: string[] = [];
      const before = p1cProjection(api, config, 'before');
      let changed: ReturnType<typeof logicalProjection> | undefined;
      const host = b1Host(api, config, clock, {
        hooks: {
          onOwnerPhase(phase) {
            phases.push(phase);
            if (
              kind === 'no_source_revision' &&
              phase === 'before_final_read'
            ) {
              cooperatingP1cCommit(config);
              changed = p1cProjection(api, config, 'after-cooperating-commit');
            }
          },
        },
      });
      const operation = host.planRetry({});
      api.operations.push(operation);
      const result = await bounded(operation);
      expect(result).toEqual(
        kind === 'no_source_revision'
          ? { status: 'blocked', blockers: ['SnapshotConflict'] }
          : { status: 'no_source' },
      );
      expectSafeFailure(result);
      expect('source' in result).toBe(false);
      expect('quote' in result).toBe(false);
      expect(phases).toContain('after_final_read');
      expect(phases).toContain('after_close');
      expect(api.wires.filter((w) => w.path.endsWith('/report'))).toEqual([]);
      expect(api.wires).toHaveLength(kind === 'unfinished' ? 8 : 6);
      expect(
        p1cProjection(
          api,
          config,
          kind === 'no_source_revision'
            ? 'unchanged-after-cooperating-commit'
            : 'unchanged',
        ),
      ).toEqual(changed ?? before);
      expect(localSnapshot(config).acceptedManifests).toEqual([]);
      expect(localSnapshot(config).retryChildren).toEqual([]);
      expect(clock.handles.size).toBe(0);
      writeFileSync(join(api.root, 'p1c-phases.json'), JSON.stringify(phases));
    });
  });

for (const provenance of ['external', 'migrated_legacy'] as const)
  for (const allowed of [false, true])
    test(`P1C-11 ${provenance} actual private permission ${allowed} preserves attribution and no planning writes`, async () => {
      const engine = provenance === 'external' ? 'yandex' : 'google';
      await withProductionReceiver(
        script(singleSource(engine)),
        async (api) => {
          const config = fixtureConfiguration(
            api,
            {
              retry: {
                enabled: true,
                allowUnattributedParents: allowed,
                maxAttemptsPerSource: 3,
              },
            },
            provenance === 'external' ? 2 : 1,
          );
          if (provenance === 'migrated_legacy') {
            seedStandalone(config, 'parent', [A, B, C]);
            const core = () =>
              withP1cReadDb(config, (db) =>
                [
                  'intents',
                  'intent_urls',
                  'intent_events',
                  'budget_periods',
                ].map((name) => [
                  name,
                  db.query(`SELECT * FROM ${name} ORDER BY rowid`).all(),
                ]),
              );
            const original = core();
            expect(
              migrateLedgerV2({
                stateDirectory: config.stateDirectory,
                backupDirectory: join(api.root, 'v1-backup'),
              }),
            ).toEqual({
              migrated: true,
              schemaVersion: 2,
              backupVerified: true,
            });
            expect(core()).toEqual(original);
            expect(
              withP1cReadDb(config, (db) =>
                db
                  .query(
                    'SELECT origin_kind,parent_family,parent_task_id,source_manifest_digest,plan_fingerprint FROM intent_context',
                  )
                  .all(),
              ),
            ).toEqual([
              {
                origin_kind: 'legacy_unattributed',
                parent_family: null,
                parent_task_id: null,
                source_manifest_digest: null,
                plan_fingerprint: null,
              },
            ]);
          }
          const before = p1cProjection(api, config, 'before'),
            clock = new NativeOwnerClock();
          const operation = b1Host(api, config, clock).planRetry({
            searchEngine: engine,
          });
          api.operations.push(operation);
          const result = await bounded(operation);
          if (allowed) {
            expect(result).toMatchObject({
              status: 'ready',
              eligibleUrls: [A, B],
              source: {
                provenance:
                  provenance === 'external'
                    ? 'external_unattributed'
                    : 'legacy_unattributed',
                originalManifestKnown: provenance !== 'external',
                manifestProvenance:
                  provenance === 'external'
                    ? 'provider_report_observed_corpus'
                    : 'durable_local_intent_ack',
                manifestDigest:
                  provenance === 'external'
                    ? H('speedyindex-provider-report-url-manifest-v1', [
                        'yandex/indexer',
                        'parent',
                        [C, A, B],
                      ])
                    : H('speedyindex-intent-url-manifest-v1', [
                        'google/indexer',
                        [A, B, C],
                      ]),
              },
            });
            for (const privateField of [
              'proof',
              'input',
              'kind',
              'ledgerId',
              'dispatchCapability',
            ])
              expect(privateField in result).toBe(false);
          } else {
            expect(result).toEqual({
              status: 'blocked',
              blockers: ['UnattributedParentPermissionRequired'],
            });
            expectSafeFailure(result);
          }
          expect(localSnapshot(config).acceptedManifests).toHaveLength(
            provenance === 'external' ? 0 : 1,
          );
          expect(localSnapshot(config).retryChildren).toEqual([]);
          expect(p1cProjection(api, config, 'unchanged')).toEqual(before);
          expectProductionWires(api, engine);
          expect(clock.handles.size).toBe(0);
        },
      );
    });

function expectPublicEnvelope(result: PlanRetryToolResult) {
  expect(
    planRetryResultSchema.safeParse(result.structuredContent).success,
  ).toBe(true);
  expect(result.isError).toBe(result.structuredContent.status === 'error');
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
    2_097_152,
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.structuredContent)).toBe(true);
  expectSafeFailure(result);
}

function observePublicSerialization() {
  const original = JSON.stringify;
  const observed: { status: string; bytes: number }[] = [];
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const text = Reflect.apply(original, JSON, args) as string;
    const value: unknown = args[0];
    if (
      value &&
      typeof value === 'object' &&
      'isError' in value &&
      'structuredContent' in value &&
      value.structuredContent &&
      typeof value.structuredContent === 'object' &&
      'status' in value.structuredContent
    )
      observed.push({
        status: String(value.structuredContent.status),
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    return text;
  }) as typeof JSON.stringify;
  // Exact transparent entry sanity before any owner/native verification.
  expect(JSON.stringify({ value: 'é"\\' })).toBe(original({ value: 'é"\\' }));
  expect(observed).toEqual([]);
  return {
    observed,
    restore() {
      JSON.stringify = original;
    },
  };
}

test('P2-01 direct public host rejects authority/preabort/inactive before state or HTTP and normalizes Google', async () => {
  await withProductionReceiver(script(singleSource()), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new NativeOwnerClock();
    seedStandalone(config, 'parent', [A, B, C]);
    const before = p1cProjection(api, config, 'p2-before');
    let opens = 0,
      reads = 0,
      fetches = 0;
    const options: SubmissionHostOptions = {
      fetchRequest: Object.assign(
        () => {
          fetches++;
          throw new Error('PRIVATE_UNEXPECTED_FETCH');
        },
        {
          preconnect() {
            throw new Error('PRIVATE_PRECONNECT');
          },
        },
      ) as typeof fetch,
      clock: () => clock.wall,
      openLedger() {
        opens++;
        throw new Error('PRIVATE_UNEXPECTED_WRITER');
      },
      retry: {
        monotonicMs: () => clock.mono,
        runtime: clock,
        hooks: {
          onOwnerPhase() {
            reads++;
            throw new Error('PRIVATE_UNEXPECTED_STATE');
          },
        },
      },
    };
    const host = new SubmissionHost(config, options);
    const invalid = await host.planRetryToolResult({
      expectedPlan: { proof: 'PRIVATE_ASSERTED_AUTHORITY' },
    });
    expectPublicEnvelope(invalid);
    expect(invalid.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'InvalidInput' },
    });
    const abort = new AbortController();
    abort.abort();
    const cancelled = await host.planRetryToolResult({}, abort.signal);
    expectPublicEnvelope(cancelled);
    expect(cancelled.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'Cancelled' },
    });
    const inactive = await new SubmissionHost(
      loadSubmissionConfiguration({ apiKey: '' }),
      options,
    ).planRetryToolResult({ searchEngine: 'yandex' });
    expectPublicEnvelope(inactive);
    expect(inactive.structuredContent).toMatchObject({
      status: 'blocked',
      searchEngine: 'yandex',
      blockers: [{ code: 'StateUnavailable' }],
    });
    expect({ opens, reads, fetches }).toEqual({
      opens: 0,
      reads: 0,
      fetches: 0,
    });
    expect(api.wires).toEqual([]);
    expect(p1cProjection(api, config, 'p2-rejected')).toEqual(before);
    const operation = b1Host(api, config, clock).planRetryToolResult({});
    api.operations.push(operation);
    const result = await bounded(operation);
    expectPublicEnvelope(result);
    expect(result.structuredContent.status).toBe('ready');
    if (result.structuredContent.status !== 'ready')
      throw new Error('Expected real default Google ready.');
    expectProductionReady(
      result.structuredContent,
      productionOracle(config, 'google'),
      config,
      true,
    );
    expectProductionWires(api, 'google');
    expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
    expect(clock.handles.size).toBe(0);
  });
});

for (const engine of ['google', 'yandex'] as const)
  test(`P2-05 actual public owner ${engine} ready preserves independent identity and logical state`, async () => {
    await withProductionReceiver(script(singleSource(engine)), async (api) => {
      const config = fixtureConfiguration(api, {
        retry: {
          enabled: true,
          allowUnattributedParents: engine === 'yandex',
          maxAttemptsPerSource: 3,
        },
      });
      if (engine === 'google') seedStandalone(config, 'parent', [A, B, C]);
      const before = p1cProjection(api, config, 'p2-before'),
        oracle = productionOracle(config, engine),
        clock = new NativeOwnerClock();
      const operation = b1Host(api, config, clock).planRetryToolResult(
        engine === 'google' ? {} : { searchEngine: engine },
      );
      api.operations.push(operation);
      const result = await bounded(operation);
      expectPublicEnvelope(result);
      if (result.structuredContent.status !== 'ready')
        throw new Error('Expected actual public owner ready.');
      expectProductionReady(result.structuredContent, oracle, config, true);
      expectProductionWires(api, engine);
      expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
      expect(localSnapshot(config).retryChildren).toEqual([]);
      if (engine === 'yandex')
        expect(localSnapshot(config).acceptedManifests).toEqual([]);
      expect(clock.handles.size).toBe(0);
    });
  });

test('P2-05 immutable constructor output cap rejects real public overflow and leaves private view available', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new NativeOwnerClock(),
      before = p1cProjection(api, config, 'p2-before');
    const baseline = b1Host(api, config, clock).planRetryToolResult({
      searchEngine: 'yandex',
    });
    api.operations.push(baseline);
    const ready = await bounded(baseline);
    expect(ready.structuredContent.status).toBe('ready');
    const n = Buffer.byteLength(JSON.stringify(ready), 'utf8');
    const options = {
      monotonicMs: () => clock.mono,
      runtime: clock,
      publicResultBytes: n - 1,
    };
    const host = new SubmissionHost(config, {
      fetchRequest: api.fetch,
      clock: () => clock.wall,
      retry: options,
    });
    options.publicResultBytes = 2_097_152;
    const overflow = host.planRetryToolResult({ searchEngine: 'yandex' });
    api.operations.push(overflow);
    const result = await bounded(overflow);
    expectPublicEnvelope(result);
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'ResourceLimitExceeded' },
    });
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(n - 1);
    const privateView = host.planRetry({ searchEngine: 'yandex' });
    api.operations.push(privateView);
    expect((await bounded(privateView)).status).toBe('ready');
    const ownerOptions = { runtime: clock, publicResultBytes: n - 1 };
    const composition = composeVerifiedRetryAdmission({
      configuration: config,
      transport: { fetch: api.fetch },
      clock,
      owner: ownerOptions,
    });
    ownerOptions.publicResultBytes = 2_097_152;
    const publicCall = composition.planLatestToolResult({
      searchEngine: 'yandex',
    });
    api.operations.push(publicCall);
    const direct = await bounded(publicCall);
    expectPublicEnvelope(direct);
    expect(direct.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'ResourceLimitExceeded' },
    });
    const oldView = composition.planLatest({ searchEngine: 'yandex' });
    api.operations.push(oldView);
    expect((await bounded(oldView)).status).toBe('ready');
    expect(
      () =>
        new SubmissionHost(config, { retry: { publicResultBytes: 2_097_153 } }),
    ).toThrow(RangeError);
    expect(() =>
      composeVerifiedRetryAdmission({
        configuration: config,
        transport: { fetch: api.fetch },
        clock,
        owner: { publicResultBytes: 2_097_153 },
      }),
    ).toThrow(RangeError);
    expect(api.wires).toHaveLength(50);
    expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
    expect(clock.handles.size).toBe(0);
    writeFileSync(
      join(api.root, 'p2-output-cap.json'),
      JSON.stringify({
        n,
        cap: n - 1,
        publicBytes: Buffer.byteLength(JSON.stringify(result)),
        wires: api.wires.length,
      }),
    );
  });
});

test('P2-05 original horizon expires after actual public serialization before publication', async () => {
  await withProductionReceiver(script(singleSource('yandex')), async (api) => {
    const config = fixtureConfiguration(api),
      clock = new NativeOwnerClock(),
      before = p1cProjection(api, config, 'p2-before'),
      phases: string[] = [];
    const observer = observePublicSerialization();
    try {
      const host = b1Host(api, config, clock, {
        hooks: {
          onOwnerPhase(phase) {
            phases.push(phase);
            if (phase === 'after_serialization') {
              expect(
                observer.observed.some((item) => item.status === 'ready'),
              ).toBe(true);
              clock.mono += 60_000;
            }
          },
        },
      });
      const operation = host.planRetryToolResult({ searchEngine: 'yandex' });
      api.operations.push(operation);
      const result = await bounded(operation);
      expectPublicEnvelope(result);
      expect(result.structuredContent).toMatchObject({
        status: 'error',
        error: { code: 'DeadlineExceeded' },
      });
      expect(result.structuredContent).not.toHaveProperty('identity');
      expect(phases.indexOf('after_serialization')).toBeLessThan(
        phases.indexOf('before_close'),
      );
      expect(phases).toContain('after_close');
      expect(api.wires).toHaveLength(10);
      expect(clock.handles.size).toBe(0);
      expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
      writeFileSync(
        join(api.root, 'p2-serialization.json'),
        JSON.stringify({ phases, observed: observer.observed }),
      );
    } finally {
      observer.restore();
    }
  });
});

for (const kind of ['ready', 'no_source'] as const)
  test(`P2-05 close continuation cancellation invalidates prepared public ${kind}`, async () => {
    await withProductionReceiver(
      script(kind === 'ready' ? singleSource('yandex') : {}),
      async (api) => {
        const config = fixtureConfiguration(api),
          clock = new NativeOwnerClock(),
          controller = new AbortController();
        const before = p1cProjection(api, config, 'p2-before'),
          phases: string[] = [],
          observer = observePublicSerialization();
        try {
          const host = b1Host(api, config, clock, {
            hooks: {
              onOwnerPhase(phase) {
                phases.push(phase);
                if (phase === 'after_serialization')
                  expect(
                    observer.observed.some((item) => item.status === kind),
                  ).toBe(true);
                if (phase === 'before_close')
                  queueMicrotask(() => controller.abort());
              },
            },
          });
          const operation = host.planRetryToolResult(
            { searchEngine: 'yandex' },
            controller.signal,
          );
          api.operations.push(operation);
          const result = await bounded(operation);
          expectPublicEnvelope(result);
          expect(result.structuredContent).toMatchObject({
            status: 'error',
            error: { code: 'Cancelled' },
          });
          expect(result.structuredContent).not.toHaveProperty('source');
          expect(result.structuredContent).not.toHaveProperty('identity');
          expect(phases).toContain('after_close');
          expect(api.wires).toHaveLength(kind === 'ready' ? 10 : 6);
          expect(clock.handles.size).toBe(0);
          expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
          writeFileSync(
            join(api.root, 'p2-close.json'),
            JSON.stringify({ kind, phases, observed: observer.observed }),
          );
        } finally {
          observer.restore();
        }
      },
    );
  });

test('P2-05 native pending cancel receipt holds actual shared guard and clean settlement permits public recovery', async () => {
  const arrived = deferred(),
    tail = deferred(),
    entered = deferred(),
    release = deferred(),
    nativeClosed = deferred(),
    pendingRead = deferred();
  const controller = new AbortController(),
    signal = trackOwnerSignal(controller.signal),
    clock = new NativeOwnerClock(),
    normal = script(singleSource('yandex'));
  let once = false,
    decorated = false,
    done = false,
    readCalls = 0,
    closedCount = 0;
  try {
    await withProductionReceiver(
      async (wire, req, res) => {
        if (!once) {
          once = true;
          arrived.resolve();
          res.writeHead(200);
          res.write('{"code":0,');
          await tail.promise;
          return undefined;
        }
        return normal(wire, req, res);
      },
      async (api) => {
        api.releases.push(
          () => tail.resolve(),
          () => release.resolve(),
        );
        const config = fixtureConfiguration(api),
          before = p1cProjection(api, config, 'p2-before'),
          host = b1Host(api, config, clock);
        const operation = host.planRetryToolResult(
          { searchEngine: 'yandex' },
          controller.signal,
        );
        api.operations.push(operation);
        void operation.then(() => {
          done = true;
        });
        await bounded(arrived.promise);
        await bounded(pendingRead.promise);
        controller.abort();
        await bounded(entered.promise);
        await bounded(Promise.all(api.terminations));
        await bounded(nativeClosed.promise);
        expect(done).toBe(false);
        const busy = await host.planRetryToolResult({});
        expectPublicEnvelope(busy);
        expect(busy.structuredContent).toMatchObject({
          status: 'error',
          error: { code: 'SubmissionBusy' },
        });
        const create = await host.createIndexingTask({
          mode: 'submit',
          searchEngine: 'google',
          requestId: 'p2-blocked-during-settlement',
          urls: [A],
        });
        expect(create.error?.code).toBe('SubmissionBusy');
        expect(api.wires).toHaveLength(1);
        expect(p1cProjection(api, config, 'p2-held')).toEqual(before);
        release.resolve();
        tail.resolve();
        const result = await bounded(operation);
        expectPublicEnvelope(result);
        expect(result.structuredContent).toMatchObject({
          status: 'error',
          error: { code: 'Cancelled' },
        });
        expect(closedCount).toBe(1);
        expect(clock.handles.size).toBe(0);
        expect(signal.active.size).toBe(0);
        const recovery = host.planRetryToolResult({ searchEngine: 'yandex' });
        api.operations.push(recovery);
        const recovered = await bounded(recovery);
        expectPublicEnvelope(recovered);
        if (recovered.structuredContent.status !== 'ready')
          throw new Error('Expected real public recovery.');
        expectProductionReady(
          recovered.structuredContent,
          productionOracle(config, 'yandex'),
          config,
          true,
        );
        expect(api.wires).toHaveLength(11);
        expect(p1cProjection(api, config, 'p2-unchanged')).toEqual(before);
        expect(clock.handles.size).toBe(0);
        expect(signal.active.size).toBe(0);
        writeFileSync(
          join(api.root, 'p2-native.json'),
          JSON.stringify({
            peerTerminated: true,
            closedCount,
            readCalls,
            settled: done,
            timers: clock.handles.size,
            listeners: signal.active.size,
            wires: api.wires.length,
          }),
        );
      },
      (response) => {
        if (decorated || !response.body) return response;
        decorated = true;
        const body = new Proxy(response.body, {
          get(target, field) {
            if (field === 'getReader')
              return () => {
                const reader = target.getReader();
                void reader.closed.then(
                  () => {
                    closedCount++;
                    nativeClosed.resolve();
                  },
                  () => {
                    closedCount++;
                    nativeClosed.resolve();
                  },
                );
                return new Proxy(reader, {
                  get(actual, key) {
                    if (key === 'read')
                      return async () => {
                        const reading = actual.read();
                        if (++readCalls === 2) pendingRead.resolve();
                        return await reading;
                      };
                    const value = Reflect.get(actual, key, actual) as unknown;
                    return typeof value === 'function'
                      ? value.bind(actual)
                      : value;
                  },
                });
              };
            const value = Reflect.get(target, field, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return holdCancellation(
          new Proxy(response, {
            get(target, field) {
              if (field === 'body') return body;
              const value = Reflect.get(target, field, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
          entered,
          release,
        );
      },
    );
  } finally {
    signal.restore();
  }
});
