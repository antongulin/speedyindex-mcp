import { expect } from 'bun:test';
import { z } from 'zod';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { Database, constants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCreateIndexingRequest } from '../src/create-indexing-task';
import { planRetryResultSchema } from '../src/plan-retry-result';
import {
  initializeLedgerV2,
  openLedger,
  readRetrySnapshot,
} from '../src/submission-ledger';
import {
  createSubmissionContext,
  loadSubmissionConfiguration,
  type ConfiguredSubmission,
} from '../src/submission-policy';
import {
  bounded,
  connectOwnedStdio,
  deferred,
  dummyKey,
  fixture,
} from './helpers';

type Engine = 'google' | 'yandex';
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  default?: unknown;
  enum?: unknown;
  const?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
};
const A = 'https://example.test/A?b=1&a=2';
const ASlash = 'https://example.test/A/?b=1&a=2';
const C = 'https://example.test/C';
const parent = 'sdk-parent';
const created = '2020-01-01T00:00:00Z';
const checked = '2020-01-08T00:00:00Z';
const credential = createHash('sha256')
  .update('speedyindex-credential-v1\0' + dummyKey)
  .digest('hex');
const H = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(domain + '\0' + JSON.stringify(value))
    .digest('hex');
function record(root: string, name: string, value: unknown) {
  writeFileSync(
    join(root, name + '.json'),
    JSON.stringify(value, null, 2) + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
}
function logicalState(state: string) {
  const db = new Database(
    join(state, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  try {
    const schema = db
      .query<{ name: string; type: string; sql: string | null }, []>(
        'SELECT name,type,sql FROM sqlite_schema ORDER BY name',
      )
      .all();
    const tables = schema
      .filter((row) => row.type === 'table')
      .map((row) => {
        const columns = db
          .query<{ name: string; type: string }, []>(
            'PRAGMA table_info(' + quote(row.name) + ')',
          )
          .all();
        const fields = columns
          .map((column) =>
            column.type === 'INTEGER' || column.name === 'seq'
              ? 'CAST(' +
                quote(column.name) +
                ' AS TEXT) AS ' +
                quote(column.name)
              : quote(column.name),
          )
          .join(',');
        return [
          row.name,
          db
            .query(
              'SELECT ' +
                fields +
                ' FROM ' +
                quote(row.name) +
                ' ORDER BY rowid',
            )
            .all(),
        ];
      });
    return { version: db.query('PRAGMA user_version').get(), schema, tables };
  } finally {
    db.close();
  }
}
function seedLocal(config: ConfiguredSubmission, now: number) {
  const request = buildCreateIndexingRequest({
    mode: 'preview',
    searchEngine: 'google',
    urls: [A, ASlash, C],
  });
  const ledger = openLedger({ stateDirectory: config.stateDirectory });
  try {
    const prepared = ledger.prepareIntent({
      requestId: 'sdk-seed-parent',
      budget: createSubmissionContext(config, request.quote.fingerprint, now)
        .budget,
      taskFamily: 'google/indexer',
      providerRoute: request.request.providerRoute,
      payloadDigest: request.request.payloadDigest,
      submittedUrls: request.input.urls,
      quoteVersion: request.quote.version,
      quoteFingerprint: request.quote.fingerprint,
      reservation: request.quote.maximumExposure,
    });
    if (prepared.kind !== 'created')
      throw new Error('SDK seed creator missing.');
    const claimed = ledger.claimDispatch(prepared.dispatchCapability, 0);
    if (claimed.kind !== 'claimed') throw new Error('SDK seed owner missing.');
    ledger.recordDispatchOutcome({
      credentialFingerprint: credential,
      requestId: 'sdk-seed-parent',
      expectedStateVersion: claimed.stateVersion,
      outcomeToken: claimed.outcomeToken,
      outcome: {
        kind: 'accepted',
        providerTaskId: parent,
        providerType: 'google/indexer',
      },
    });
  } finally {
    ledger.close();
  }
}
function advertised(tool: {
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}) {
  const input = tool.inputSchema as Schema;
  expect(input.type).toBe('object');
  expect(input.additionalProperties).toBe(false);
  expect(Object.keys(input.properties ?? {})).toEqual(['searchEngine']);
  expect(input.properties?.searchEngine).toMatchObject({
    type: 'string',
    enum: ['google', 'yandex'],
    default: 'google',
  });
  expect(input.required ?? []).not.toContain('searchEngine');
  expect(tool.annotations).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  const output = tool.outputSchema as Schema;
  expect(output.type).toBe('object');
  expect(output.properties ?? {}).not.toHaveProperty('result');
  const branches = output.oneOf ?? output.anyOf ?? [];
  expect(branches).toHaveLength(4);
  expect(
    branches.map((branch) => branch.properties?.status?.const).sort(),
  ).toEqual(['blocked', 'error', 'no_source', 'ready']);
  for (const branch of branches) {
    expect(branch.type).toBe('object');
    expect(branch.additionalProperties).toBe(false);
    expect(branch.required).toContain('status');
  }
  const ready = branches.find(
    (branch) => branch.properties?.status?.const === 'ready',
  );
  expect(ready?.required?.slice().sort()).toEqual([
    'authorization',
    'counts',
    'eligibleUrls',
    'excluded',
    'identity',
    'quote',
    'request',
    'searchEngine',
    'source',
    'status',
  ]);
  function closed(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(closed);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node.type === 'object' &&
      !['oneOf', 'anyOf', 'allOf'].some((key) => Array.isArray(node[key]))
    )
      expect(node.additionalProperties).toBe(false);
    Object.values(node).forEach(closed);
  }
  closed(output);
}
function oracle(config: ConfiguredSubmission, engine: Engine, now: number) {
  const family = (engine + '/indexer') as 'google/indexer' | 'yandex/indexer';
  const local = readRetrySnapshot(
    { stateDirectory: config.stateDirectory },
    credential,
  );
  if (local.availability !== 'available')
    throw new Error('SDK oracle snapshot unavailable.');
  expect(local.retryChildren).toEqual([]);
  if (engine === 'yandex') expect(local.acceptedManifests).toEqual([]);
  const originalManifestKnown = engine === 'google';
  const provenance = originalManifestKnown
    ? 'local_standalone'
    : 'external_unattributed';
  const manifestProvenance = originalManifestKnown
    ? 'durable_local_intent_ack'
    : 'provider_report_observed_corpus';
  const manifestDigest = originalManifestKnown
    ? H('speedyindex-intent-url-manifest-v1', [family, [A, ASlash, C]])
    : H('speedyindex-provider-report-url-manifest-v1', [
        family,
        parent,
        [C, A, ASlash],
      ]);
  const fact = [
    family,
    parent,
    3,
    3,
    1,
    true,
    'completed',
    [Date.parse(created), ''],
    originalManifestKnown ? true : null,
    [Date.parse(checked), ''],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  const pass = [
    [
      [
        'google/indexer',
        'regular',
        0,
        [[0, engine === 'google' ? [[family, parent]] : []]],
      ],
      ['google/indexer', 'drip', 0, [[0, []]]],
      [
        'yandex/indexer',
        'regular',
        0,
        [[0, engine === 'yandex' ? [[family, parent]] : []]],
      ],
    ],
    [fact],
    [],
    [family, parent, 3, 3, 1, [C], [A, ASlash], fact],
    [],
  ];
  const safetyEvidenceDigests = [
    H('speedyindex-retry-observation-safety-v1', pass),
    H('speedyindex-retry-local-safety-v1', [
      local.revision,
      family,
      parent,
      provenance,
      manifestDigest,
    ]),
  ];
  const partitionDigest = H('speedyindex-retry-partition-v1', [
    [A, ASlash],
    [A, ASlash],
    [],
    [0, originalManifestKnown ? [] : null],
  ]);
  // Independent ordinary request and canonical fingerprint oracles.
  const body = JSON.stringify(
    engine === 'google'
      ? { urls: [A, ASlash], pay_per_indexed: true, drip_feed: false }
      : { urls: [A, ASlash] },
  );
  const payloadDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const quoteVersion = 'speedyindex-indexing-batch-2026-10-20-v1';
  const providerRoute = '/v2/task/' + family + '/create';
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
  const startMs = Math.floor(now / 86400000) * 86400000;
  const period = {
    id: 'utc-day:' + new Date(startMs).toISOString().slice(0, 10),
    startMs,
    endMs: startMs + 86400000,
  };
  const authorizationFingerprint = H(
    'speedyindex-submission-authorization-v1',
    {
      quoteFingerprint,
      policyDigest: config.snapshot.digest,
      credentialFingerprint: credential,
      budgetScope: config.snapshot.policy.budgetScope,
      periodId: period.id,
      periodStartMs: startMs,
    },
  );
  const preimage = {
    parent: { family, taskId: parent },
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
    providerBodyBytes: Buffer.byteLength(body),
    reservation,
  };
  const fingerprint = H('speedyindex-retry-plan-v1', [
    family,
    parent,
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
    [period.id, startMs, period.endMs],
    providerRoute,
    2,
    Buffer.byteLength(body),
    [reservation.tokens, reservation.indexer, reservation.checker],
  ]);
  return {
    status: 'ready',
    searchEngine: engine,
    source: {
      reference: [family, parent],
      provenance,
      originalManifestKnown,
      manifestProvenance,
      manifestDigest,
    },
    eligibleUrls: [A, ASlash],
    excluded: [],
    counts: { indexed: 1, unindexed: 2, eligible: 2, excluded: 0, unknown: 0 },
    request: {
      family,
      providerRoute,
      payloadDigest,
      urlCount: 2,
      providerBodyBytes: Buffer.byteLength(body),
    },
    quote: {
      version: quoteVersion,
      fingerprint: quoteFingerprint,
      maximumExposure: reservation,
      basis: 'documented_independent_maxima',
      providerEnforced: false,
    },
    authorization: {
      state: 'configured',
      stateChecked: true,
      mode: config.snapshot.policy.mode,
      policyRevision: config.snapshot.policy.policyRevision,
      policyDigest: config.snapshot.digest,
      budgetScope: config.snapshot.policy.budgetScope,
      caps: config.snapshot.policy.caps,
      period,
      fingerprint: authorizationFingerprint,
    },
    identity: { status: 'comparison', preimage, fingerprint },
  };
}
const retryPhaseSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('BOOT_READY') }),
  z.strictObject({
    event: z.literal('SIGNAL_ABORTED'),
    operation: z.number().int().min(1).max(2),
  }),
  z.strictObject({
    event: z.literal('AFTER_CLOSE'),
    operation: z.number().int().min(1).max(2),
  }),
  z.strictObject({
    event: z.literal('OWNER_SETTLED'),
    operation: z.number().int().min(1).max(2),
    aborted: z.boolean(),
    status: z.enum(['ready', 'no_source', 'blocked', 'error']),
    code: z
      .enum([
        'InvalidInput',
        'MissingCredentials',
        'SubmissionBusy',
        'Cancelled',
        'DeadlineExceeded',
        'ReadFailed',
        'ResourceLimitExceeded',
        'InternalError',
      ])
      .nullable(),
  }),
  z.strictObject({ event: z.literal('FIXTURE_ERROR') }),
  z.strictObject({ event: z.literal('PROTOCOL_ERROR') }),
]);
type RetryPhase = z.infer<typeof retryPhaseSchema>;
export function createPlanRetryPhaseReceiver(
  onPhase?: (phase: RetryPhase) => void,
) {
  const messages: RetryPhase[] = [],
    errors: string[] = [];
  const waiters: {
    event: RetryPhase['event'];
    operation?: number;
    resolve: (phase: RetryPhase) => void;
    reject: (error: Error) => void;
  }[] = [];
  let buffer = '',
    raw = '',
    bytes = 0,
    finished = false;
  function fail() {
    if (!errors.length) errors.push('Invalid retry fixture phase stream.');
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(errors[0]));
  }
  const matches = (
    phase: RetryPhase,
    event: RetryPhase['event'],
    operation?: number,
  ) =>
    phase.event === event &&
    (operation === undefined ||
      ('operation' in phase && phase.operation === operation));
  return {
    get messages() {
      return messages.slice();
    },
    get errors() {
      return errors.slice();
    },
    get raw() {
      return raw;
    },
    receive(chunk: string) {
      if (finished || errors.length) {
        fail();
        return;
      }
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 8192) {
        fail();
        return;
      }
      raw += chunk;
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 512 || !line.startsWith('RETRY_PHASE ')) {
          fail();
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(line.slice('RETRY_PHASE '.length));
        } catch {
          fail();
          return;
        }
        const parsed = retryPhaseSchema.safeParse(value);
        if (!parsed.success) {
          fail();
          return;
        }
        const phase = parsed.data;
        if (
          phase.event === 'FIXTURE_ERROR' ||
          phase.event === 'PROTOCOL_ERROR' ||
          (phase.event === 'OWNER_SETTLED' &&
            (phase.status === 'error') !== (phase.code !== null)) ||
          messages.length >= 12 ||
          messages.some((m) =>
            matches(
              m,
              phase.event,
              'operation' in phase ? phase.operation : undefined,
            ),
          )
        ) {
          fail();
          return;
        }
        messages.push(phase);
        onPhase?.(phase);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i];
          if (waiter && matches(phase, waiter.event, waiter.operation)) {
            waiters.splice(i, 1);
            waiter.resolve(phase);
          }
        }
      }
    },
    wait(event: RetryPhase['event'], operation?: number) {
      const found = messages.find((m) => matches(m, event, operation));
      if (errors.length) return Promise.reject(new Error(errors[0]));
      if (found) return Promise.resolve(found);
      if (finished || waiters.length >= 8)
        return Promise.reject(new Error('Missing retry fixture phase.'));
      return new Promise<RetryPhase>((resolve, reject) =>
        waiters.push({
          event,
          ...(operation === undefined ? {} : { operation }),
          resolve,
          reject,
        }),
      );
    },
    finish() {
      finished = true;
      if (buffer.length || waiters.length) fail();
      return errors.slice();
    },
  };
}
export const planRetryFiniteCases = [
  'no_source',
  'permission',
  'omission',
  'read_error_recovery',
] as const;
type FiniteCase = (typeof planRetryFiniteCases)[number];
function finiteExpected(kind: FiniteCase, engine: Engine): unknown {
  if (kind === 'no_source')
    return { status: 'no_source', searchEngine: engine };
  if (kind === 'read_error_recovery')
    return {
      status: 'error',
      error: {
        code: 'ReadFailed',
        message: 'A required provider read failed.',
        phase: 'list',
        cause: 'http',
      },
    };
  return kind === 'permission'
    ? {
        status: 'blocked',
        searchEngine: engine,
        blockers: [
          {
            code: 'UnattributedParentPermissionRequired',
            message:
              'The source requires explicit private permission for unattributed parents.',
          },
        ],
      }
    : {
        status: 'blocked',
        searchEngine: engine,
        blockers: [
          {
            code: 'SourceReportIncomplete',
            message:
              'The selected source report is incomplete. Obtain complete source evidence.',
          },
        ],
        unknownUrlCount: 1,
        knownMissingLocalUrls: null,
      };
}
async function journey(
  entry: string,
  engine: Engine,
  finiteCase?: FiniteCase,
  cancellation = false,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'speedyindex-p2-sdk-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const state = join(root, 'state'),
    policyPath = join(root, 'policy.json');
  const family = engine + '/indexer';
  const wires: { method: string; path: string; body: string }[] = [];
  const receivers: Promise<void>[] = [],
    errors: unknown[] = [],
    cleanup: unknown[] = [];
  const sessions: (() => Promise<void>)[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const stdout: Buffer[] = [];
  let firstReadFailure = finiteCase === 'read_error_recovery';
  const cancellationEvents: string[] = [];
  const phaseReceiver = cancellation
    ? createPlanRetryPhaseReceiver((phase) => {
        cancellationEvents.push(
          'phase:' +
            phase.event +
            ':' +
            ('operation' in phase ? phase.operation : 0),
        );
      })
    : undefined;
  const arrival = deferred<void>(),
    peerClosed = deferred<void>();
  const controller = cancellation ? new AbortController() : undefined;
  const peer = {
    arrived: false,
    closed: false,
    beforeTeardown: false,
    headersSent: false,
    responseEnded: false,
  };
  let holdFirstRead = cancellation,
    teardownStarted = false,
    receiptsComplete = false;
  let api: Awaited<ReturnType<typeof fixture>> | undefined;
  let session: Awaited<ReturnType<typeof connectOwnedStdio>> | undefined;
  try {
    const initialized = initializeLedgerV2({ stateDirectory: state });
    initialized.close();
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'operator_policy',
        policyRevision: 'p2-sdk',
        budgetScope: 'p2-sdk',
        credentialFingerprint: credential,
        period: { kind: 'utc_day' },
        caps: { tokens: 10000, indexer: 100, checker: 100 },
        retry: {
          enabled: true,
          allowUnattributedParents:
            engine === 'yandex' && finiteCase !== 'permission',
          maxAttemptsPerSource: 3,
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const config = loadSubmissionConfiguration({
      apiKey: dummyKey,
      policyPath,
      stateDirectory: state,
    });
    if (config.state !== 'configured')
      throw new Error('SDK configuration unavailable.');
    const now = Date.now();
    if (engine === 'google' && !finiteCase) seedLocal(config, now);
    const expected =
      finiteCase && finiteCase !== 'read_error_recovery'
        ? finiteExpected(finiteCase, engine)
        : oracle(config, engine, now);
    const before = logicalState(state);
    record(root, 'before', before);
    const task = {
      id: parent,
      size: 3,
      processed_count: 3,
      indexed_count: 1,
      is_completed: true,
      status: 'completed',
      created_at: created,
      check_after: checked,
      ...(engine === 'google' ? { pay_per_indexed: true } : {}),
      title: 'PRIVATE_PROVIDER_TITLE_SENTINEL',
    };
    api = await fixture((req, res) => {
      const receiving = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const wire = {
          method: req.method ?? '',
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        };
        wires.push(wire);
        let response: unknown;
        if (
          wire.method === 'GET' &&
          [
            '/v2/task/google/indexer/list/0',
            '/v2/task/google/indexer/list/0?filter=drip_feed',
            '/v2/task/yandex/indexer/list/0',
          ].includes(wire.path)
        ) {
          if (holdFirstRead) {
            holdFirstRead = false;
            expect(wire).toEqual({
              method: 'GET',
              path: '/v2/task/google/indexer/list/0',
              body: '',
            });
            expect(req.headers.authorization).toBe(dummyKey);
            res.once('close', () => {
              peer.closed = true;
              peer.beforeTeardown = !teardownStarted;
              peer.headersSent = res.headersSent;
              peer.responseEnded = res.writableEnded;
              cancellationEvents.push('peer_closed');
              peerClosed.resolve();
            });
            peer.arrived = true;
            cancellationEvents.push('http_arrived');
            arrival.resolve();
            return; // Deliberately no headers, body, end, destroy or teardown.
          }
          if (firstReadFailure) {
            firstReadFailure = false;
            const body = [
              dummyKey,
              root,
              policyPath,
              'PRIVATE_READ_BODY_SENTINEL',
            ].join('|');
            record(root, 'failed-read', { wire, status: 503, body });
            res.writeHead(503);
            res.end(body);
            return;
          }
          response = {
            code: 0,
            page: 0,
            last_page: 0,
            result:
              finiteCase !== 'no_source' &&
              wire.path === '/v2/task/' + family + '/list/0'
                ? [task]
                : [],
          };
        } else if (
          wire.method === 'POST' &&
          wire.path === '/v2/task/' + family + '/status'
        ) {
          expect(wire.body).toBe(JSON.stringify({ task_ids: [parent] }));
          response = { code: 0, result: [task] };
        } else if (
          wire.method === 'POST' &&
          wire.path === '/v2/task/' + family + '/report'
        ) {
          expect(wire.body).toBe(JSON.stringify({ task_id: parent }));
          response = {
            code: 0,
            result: {
              ...task,
              type: 'indexer',
              indexed_links: [C],
              unindexed_links:
                finiteCase === 'omission'
                  ? [A]
                  : engine === 'google'
                    ? [A, ASlash, A]
                    : [A, ASlash],
            },
          };
        } else throw new Error('Unexpected retry SDK HTTP request.');
        res.end(JSON.stringify(response));
      })();
      receivers.push(receiving);
      void receiving.catch(() => res.destroy());
    });
    session = await connectOwnedStdio(
      cancellation
        ? [entry]
        : [
            entry,
            '--submission-policy',
            policyPath,
            '--submission-state',
            state,
          ],
      {
        HOME: home,
        SPEEDYINDEX_API_KEY: dummyKey,
        TEST_ACCOUNT_ORIGIN: api.origin,
        TZ: 'UTC',
        ...(cancellation
          ? {
              TMPDIR: root,
              TEST_SUBMISSION_POLICY: policyPath,
              TEST_SUBMISSION_STATE: state,
            }
          : {}),
      },
      (child) => children.push(child),
      {
        register: (close) => sessions.push(close),
        onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
        ...(phaseReceiver
          ? { onStderr: (chunk: string) => phaseReceiver.receive(chunk) }
          : {}),
      },
    );
    const listed = await bounded(session.client.listTools());
    const tool = listed.tools.find((item) => item.name === 'plan_retry');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('SDK registration missing.');
    advertised(tool);
    record(root, 'tools-list', {
      names: listed.tools.map((item) => item.name),
      planRetry: tool,
    });
    if (engine === 'google' && !finiteCase) {
      const rejected = await bounded(
        session.client.callTool({
          name: 'plan_retry',
          arguments: { expectedPlan: { proof: 'PRIVATE_ASSERTED_AUTHORITY' } },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(JSON.stringify(rejected.content)).toContain(
        'Input validation error: Invalid arguments for tool plan_retry',
      );
      expect(wires).toEqual([]);
      expect(logicalState(state)).toEqual(before);
      record(root, 'sdk-argument-rejection', rejected);
    }
    if (cancellation) {
      if (!phaseReceiver || !controller)
        throw new Error('Missing cancellation fixture.');
      await bounded(phaseReceiver.wait('BOOT_READY'), 8000);
      expect(wires).toEqual([]);
      expect(logicalState(state)).toEqual(before);
      cancellationEvents.push('cancel_call');
      const cancelled = session.client
        .callTool(
          { name: 'plan_retry', arguments: { searchEngine: 'yandex' } },
          { signal: controller.signal },
        )
        .then(
          () => ({
            rejected: false,
            sdkError: false,
            code: null,
            aborted: controller.signal.aborted,
          }),
          (error: unknown) => {
            cancellationEvents.push('client_rejected');
            return {
              rejected: true,
              sdkError: error instanceof SdkError,
              code: error instanceof SdkError ? String(error.code) : null,
              aborted: controller.signal.aborted,
            };
          },
        );
      await bounded(arrival.promise, 8000);
      expect(peer.arrived).toBe(true);
      cancellationEvents.push('abort_sent');
      controller.abort();
      const [clientReceipt, signalReceipt, , closeReceipt, ownerReceipt] =
        await bounded(
          Promise.all([
            cancelled,
            phaseReceiver.wait('SIGNAL_ABORTED', 1),
            peerClosed.promise,
            phaseReceiver.wait('AFTER_CLOSE', 1),
            phaseReceiver.wait('OWNER_SETTLED', 1),
          ]),
          8000,
        );
      record(root, 'cancel-client', clientReceipt);
      record(root, 'cancel-receipts', {
        signalReceipt,
        closeReceipt,
        ownerReceipt,
        peer,
        events: cancellationEvents.slice(),
        childPids: children.map((child) => child.pid),
      });
      expect(clientReceipt).toEqual({
        rejected: true,
        sdkError: true,
        code: SdkErrorCode.RequestTimeout,
        aborted: true,
      });
      const actualOwner: unknown = ownerReceipt;
      expect(actualOwner).toEqual({
        event: 'OWNER_SETTLED',
        operation: 1,
        aborted: true,
        status: 'error',
        code: 'Cancelled',
      });
      expect(peer).toEqual({
        arrived: true,
        closed: true,
        beforeTeardown: true,
        headersSent: false,
        responseEnded: false,
      });
      expect(wires).toEqual([
        { method: 'GET', path: '/v2/task/google/indexer/list/0', body: '' },
      ]);
      const afterCancel = logicalState(state);
      record(root, 'after-cancel', afterCancel);
      expect(afterCancel).toEqual(before);
      expect(phaseReceiver.errors).toEqual([]);
      receiptsComplete = true;
    }
    if (finiteCase) {
      const lists = [
        { method: 'GET', path: '/v2/task/google/indexer/list/0', body: '' },
        {
          method: 'GET',
          path: '/v2/task/google/indexer/list/0?filter=drip_feed',
          body: '',
        },
        { method: 'GET', path: '/v2/task/yandex/indexer/list/0', body: '' },
      ];
      const pass = [
        ...lists,
        {
          method: 'POST',
          path: '/v2/task/' + family + '/status',
          body: JSON.stringify({ task_ids: [parent] }),
        },
        {
          method: 'POST',
          path: '/v2/task/' + family + '/report',
          body: JSON.stringify({ task_id: parent }),
        },
      ];
      const phases =
        finiteCase === 'read_error_recovery'
          ? ['failure', 'recovery']
          : ['finite'];
      const order: string[] = [];
      for (const phase of phases) {
        order.push(phase + '_call');
        const phaseExpected: unknown =
          phase === 'failure' ? finiteExpected(finiteCase, engine) : expected;
        const result = await bounded(
          session.client.callTool({
            name: 'plan_retry',
            arguments: engine === 'google' ? {} : { searchEngine: 'yandex' },
          }),
          8000,
        );
        order.push(phase + '_reply');
        const label = phase === 'finite' ? '' : phase + '-';
        record(root, label + 'result', result);
        record(root, label + 'expected', phaseExpected);
        expect(result.isError).toBe(phase === 'failure');
        expect(result.content).toHaveLength(1);
        const text = result.content[0];
        if (text?.type !== 'text') throw new Error('SDK JSON text missing.');
        expect(text.text).toBe(JSON.stringify(result.structuredContent));
        expect(JSON.parse(text.text)).toEqual(result.structuredContent);
        expect(
          Buffer.byteLength(JSON.stringify(result), 'utf8'),
        ).toBeLessThanOrEqual(2097152);
        const actual: unknown = planRetryResultSchema.parse(
          result.structuredContent,
        );
        expect(actual).toEqual(phaseExpected);
        const encoded = JSON.stringify(result);
        for (const secret of [
          dummyKey,
          credential,
          root,
          state,
          policyPath,
          'PRIVATE_PROVIDER_TITLE_SENTINEL',
          'PRIVATE_READ_BODY_SENTINEL',
          'retry-read-only-inspection',
        ])
          expect(encoded).not.toContain(secret);
        const after = logicalState(state);
        record(root, label + 'after', after);
        expect(after).toEqual(before);
        expect(api.requests.every((request) => request.auth === dummyKey)).toBe(
          true,
        );
        const expectedWires =
          phase === 'failure'
            ? lists.slice(0, 1)
            : phase === 'recovery'
              ? [...lists.slice(0, 1), ...pass, ...pass]
              : finiteCase === 'no_source'
                ? [...lists, ...lists]
                : [...pass, ...pass];
        record(root, label + 'expected-wires', expectedWires);
        expect(wires).toEqual(expectedWires);
      }
      record(root, 'call-order', {
        order,
        childPids: children.map((child) => child.pid),
      });
    } else {
      if (cancellation) cancellationEvents.push('recovery_call');
      const result = await bounded(
        session.client.callTool({
          name: 'plan_retry',
          arguments: engine === 'google' ? {} : { searchEngine: 'yandex' },
        }),
        8000,
      );
      if (cancellation) cancellationEvents.push('recovery_reply');
      record(root, 'result', result);
      record(root, 'expected', expected);
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      const text = result.content[0];
      if (text?.type !== 'text') throw new Error('SDK JSON text missing.');
      expect(text.text).toBe(JSON.stringify(result.structuredContent));
      expect(JSON.parse(text.text)).toEqual(result.structuredContent);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(2097152);
      const actual: unknown = planRetryResultSchema.parse(
        result.structuredContent,
      );
      expect(actual).toEqual(expected);
      const encoded = JSON.stringify(result);
      for (const secret of [
        dummyKey,
        credential,
        root,
        state,
        policyPath,
        'PRIVATE_PROVIDER_TITLE_SENTINEL',
        'retry-read-only-inspection',
      ])
        expect(encoded).not.toContain(secret);
      const pass = [
        { method: 'GET', path: '/v2/task/google/indexer/list/0', body: '' },
        {
          method: 'GET',
          path: '/v2/task/google/indexer/list/0?filter=drip_feed',
          body: '',
        },
        { method: 'GET', path: '/v2/task/yandex/indexer/list/0', body: '' },
        {
          method: 'POST',
          path: '/v2/task/' + family + '/status',
          body: JSON.stringify({ task_ids: [parent] }),
        },
        {
          method: 'POST',
          path: '/v2/task/' + family + '/report',
          body: JSON.stringify({ task_id: parent }),
        },
      ];
      expect(wires).toEqual(
        cancellation
          ? [
              {
                method: 'GET',
                path: '/v2/task/google/indexer/list/0',
                body: '',
              },
              ...pass,
              ...pass,
            ]
          : [...pass, ...pass],
      );
      const after = logicalState(state);
      expect(after).toEqual(before);
      record(root, 'after', after);
      if (cancellation && phaseReceiver) {
        const ownerReady: unknown = await bounded(
          phaseReceiver.wait('OWNER_SETTLED', 2),
          8000,
        );
        expect(ownerReady).toEqual({
          event: 'OWNER_SETTLED',
          operation: 2,
          aborted: false,
          status: 'ready',
          code: null,
        });
        await bounded(phaseReceiver.wait('AFTER_CLOSE', 2), 8000);
        expect(receiptsComplete).toBe(true);
        record(root, 'recovery-order', {
          events: cancellationEvents.slice(),
          childPids: children.map((child) => child.pid),
          sameHost: children.length === 1,
          receiptsBeforeRecovery: receiptsComplete,
        });
      }
    }
  } catch (error) {
    errors.push(error);
  } finally {
    teardownStarted = true;
    controller?.abort();
    const closed = await Promise.allSettled(sessions.map((close) => close()));
    for (const item of closed)
      if (item.status === 'rejected') cleanup.push(item.reason);
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await bounded(child.exited, 5000);
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await api?.close();
    } catch (error) {
      cleanup.push(error);
    }
    const received = await Promise.allSettled(receivers);
    for (const item of received)
      if (item.status === 'rejected') cleanup.push(item.reason);
  }
  try {
    if (cancellation && phaseReceiver) {
      const phaseErrors = phaseReceiver.finish();
      record(root, 'cancellation-phases', {
        raw: phaseReceiver.raw,
        messages: phaseReceiver.messages,
        errors: phaseErrors,
        events: cancellationEvents,
        peer,
        receiptsComplete,
        teardownStarted,
      });
      expect(phaseErrors).toEqual([]);
      const actualPhases: unknown = phaseReceiver.messages;
      expect(actualPhases).toEqual([
        { event: 'BOOT_READY' },
        { event: 'SIGNAL_ABORTED', operation: 1 },
        { event: 'AFTER_CLOSE', operation: 1 },
        {
          event: 'OWNER_SETTLED',
          operation: 1,
          aborted: true,
          status: 'error',
          code: 'Cancelled',
        },
        { event: 'AFTER_CLOSE', operation: 2 },
        {
          event: 'OWNER_SETTLED',
          operation: 2,
          aborted: false,
          status: 'ready',
          code: null,
        },
      ]);
    } else expect(session?.stderr()).toBe('');
    for (const child of children) {
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      expect((child.stdout as ReadableStream).locked).toBe(false);
      expect((child.stderr as ReadableStream).locked).toBe(false);
    }
    const protocol = Buffer.concat(stdout).toString('utf8');
    expect(protocol.endsWith('\n')).toBe(true);
    for (const line of protocol.trimEnd().split('\n'))
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  } catch (error) {
    errors.push(error);
  }
  record(root, 'wires', wires);
  record(root, 'resources', {
    entry,
    engine,
    ...(finiteCase ? { finiteCase } : {}),
    ...(cancellation ? { cancellation: true } : {}),
    passed: errors.length === 0 && cleanup.length === 0,
    settled: cleanup.length === 0,
    sessionsClosed: sessions.length,
    children: children.map((child) => ({
      pid: child.pid,
      code: child.exitCode,
      signal: child.signalCode,
    })),
    pipesUnlocked: children.every(
      (child) =>
        !(child.stdout as ReadableStream).locked &&
        !(child.stderr as ReadableStream).locked,
    ),
    receiverSettled: cleanup.length === 0,
    errors: [...errors, ...cleanup].map((error) => String(error)),
  });
  console.error(
    'P2_SDK_FIXTURE ' +
      JSON.stringify({
        root,
        entry,
        engine,
        ...(finiteCase ? { finiteCase } : {}),
        ...(cancellation ? { cancellation: true } : {}),
        passed: errors.length === 0 && cleanup.length === 0,
        settled: cleanup.length === 0,
      }),
  );
  if (errors.length || cleanup.length)
    throw new AggregateError(
      [...errors, ...cleanup],
      'Retry SDK journey failed; preserving ' + root,
    );
}
export async function verifyPlanRetrySdk(entry: string) {
  for (const engine of ['google', 'yandex'] as const)
    await journey(entry, engine);
}

export async function verifyPlanRetryFiniteSdk(
  entry: string,
  kind: FiniteCase,
) {
  await journey(entry, kind === 'no_source' ? 'google' : 'yandex', kind);
}

export async function verifyPlanRetryCancellationSdk() {
  await journey(
    'tests/fixtures/plan-retry-sdk-child.ts',
    'yandex',
    undefined,
    true,
  );
}
