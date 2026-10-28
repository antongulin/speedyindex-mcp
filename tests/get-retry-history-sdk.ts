/** Source-only real SDK journeys. Direct preparation dispatch imports no product/SDK. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  HistoryPhaseDecoder,
  HistoryControlDecoder,
} from './fixtures/get-retry-history-protocol';
import type { Client, Transport } from '@modelcontextprotocol/client';
import type { Database } from 'bun:sqlite';
import type {
  DispatchCapability,
  IntentState,
  PrepareIntentInput,
  SubmissionLedger,
} from '../src/submission-ledger';
import type { ConfiguredSubmission } from '../src/submission-policy';

const key = 'synthetic-test-key-do-not-use';
const otherKey = 'synthetic-history-excluded-key';
const parentId = ' Parent "Ω\\Case" ';
const states = [
  'prepared',
  'dispatching',
  'accepted',
  'rejected',
  'unknown',
  'cancelled',
] as const;
type Engine = 'google' | 'yandex';
type SeedRow = { requestId: string; state: IntentState; engine: Engine };
const seedText =
  '{"version":1,"rows":[{"requestId":"fixture-prepared","state":"prepared","engine":"google"},{"requestId":"fixture-dispatching","state":"dispatching","engine":"google"},{"requestId":"fixture-accepted","state":"accepted","engine":"google"},{"requestId":"fixture-rejected","state":"rejected","engine":"google"},{"requestId":"fixture-unknown","state":"unknown","engine":"google"},{"requestId":"fixture-cancelled","state":"cancelled","engine":"google"},{"requestId":"fixture-yandex","state":"accepted","engine":"yandex"}]}';
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const domainHash = (domain: string, value: unknown) =>
  hash(domain + '\0' + JSON.stringify(value));
// Credential identity is raw domain + key, unlike JSON-tuple identities below.
const selected = hash('speedyindex-credential-v1\0' + key);
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function privateDirectory(path: string) {
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o777, 0o700);
  return stat;
}
function record(root: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const path = join(root, name + '.json');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  assert(readFileSync(path).equals(bytes));
  return { path, sha256: hash(bytes), bytes: bytes.length };
}
function saveSeed(root: string) {
  const path = join(root, 'seed.json');
  writeFileSync(path, seedText, { flag: 'wx', mode: 0o600 });
  assert.equal(readFileSync(path, 'utf8'), seedText);
  return path;
}
function readSeed(path: string): SeedRow[] {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(realpathSync(path), path);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.uid, process.getuid?.());
  assert(stat.size <= 8_192);
  const bytes = readFileSync(path);
  const v = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  assert.deepEqual(Object.keys(v).sort(), ['rows', 'version']);
  assert.equal(v.version, 1);
  assert(Array.isArray(v.rows) && v.rows.length === 7);
  const rows = v.rows.map((value): SeedRow => {
    const r = object(value);
    assert.deepEqual(Object.keys(r).sort(), ['engine', 'requestId', 'state']);
    assert(
      typeof r.requestId === 'string' && /^fixture-[a-z-]+$/.test(r.requestId),
    );
    const state = states.find((state) => state === r.state);
    assert(state !== undefined);
    assert(r.engine === 'google' || r.engine === 'yandex');
    return { requestId: r.requestId, state, engine: r.engine };
  });
  assert.equal(new Set(rows.map((r) => r.requestId)).size, 7);
  assert.deepEqual(
    rows.filter((r) => r.engine === 'google').map((r) => r.state),
    [...states],
  );
  assert.deepEqual(
    rows.filter((r) => r.engine === 'yandex').map((r) => r.state),
    ['accepted'],
  );
  return rows;
}
async function within<T>(promise: Promise<T>, ms = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned history fixture timed out.')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function denyHTTP() {
  const saved = globalThis.fetch;
  let attempts = 0;
  const deny = () => {
    attempts++;
    throw new Error('History fixture HTTP denied.');
  };
  globalThis.fetch = new Proxy(saved, {
    apply: deny,
    get(target, name, receiver) {
      return name === 'preconnect' ? deny : Reflect.get(target, name, receiver);
    },
  });
  return {
    attempts: () => attempts,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

/** Genuine offline fixture setup; snapshots are used for admission only, never the oracle. */
async function seedFixture(root: string, seedPath: string) {
  privateDirectory(root);
  assert(Buffer.byteLength(join(root, 'control.sock')) <= 103);
  const rows = readSeed(seedPath);
  const api = await import('../src/submission-ledger');
  const policy = await import('../src/submission-policy');
  const { buildCreateIndexingRequest } =
    await import('../src/create-indexing-task');
  const state = join(root, 'state');
  for (const name of ['home', 'tmp'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const policyPath = join(root, 'policy.json');
  function configuration(apiKey: string, suffix: string): ConfiguredSubmission {
    const path = suffix ? join(root, 'policy-' + suffix + '.json') : policyPath;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'operator_policy',
        policyRevision: 'PRIVATE-GRH-POLICY',
        budgetScope: 'PRIVATE-GRH-SCOPE',
        credentialFingerprint: hash('speedyindex-credential-v1\0' + apiKey),
        period: { kind: 'utc_day' },
        caps: { tokens: 100_000, indexer: 100_000, checker: 100_000 },
        retry: {
          enabled: true,
          allowUnattributedParents: false,
          maxAttemptsPerSource: 20,
        },
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const c = policy.loadSubmissionConfiguration({
      stateDirectory: state,
      policyPath: path,
      apiKey,
    });
    assert.equal(c.state, 'configured');
    assert(c.state === 'configured');
    return c;
  }
  const config = configuration(key, '');
  function intent(
    c: ConfiguredSubmission,
    id: string,
    urls: readonly string[],
    engine: Engine,
    index: number,
  ): PrepareIntentInput {
    const built = buildCreateIndexingRequest({
      mode: 'preview',
      searchEngine: engine,
      urls,
    });
    const context = policy.createSubmissionContext(
      c,
      built.quote.fingerprint,
      Date.UTC(2026, 9, 20) - index * 86_400_000,
    );
    return {
      requestId: id,
      budget: {
        ...context.budget,
        budgetScope: 'PRIVATE-GRH-SCOPE-' + index,
        policyRevision: 'PRIVATE-GRH-POLICY-' + index,
      },
      taskFamily: engine === 'google' ? 'google/indexer' : 'yandex/indexer',
      providerRoute: built.request.providerRoute,
      payloadDigest: built.request.payloadDigest,
      submittedUrls: urls,
      quoteVersion: built.quote.version,
      quoteFingerprint: built.quote.fingerprint,
      reservation: built.quote.maximumExposure,
    };
  }
  function transition(
    writer: SubmissionLedger,
    c: ConfiguredSubmission,
    value: PrepareIntentInput,
    capability: DispatchCapability,
    final: IntentState,
    provider: string,
  ) {
    if (final === 'prepared') return;
    if (final === 'cancelled') {
      assert.equal(
        writer.cancelPrepared(c.credential.fingerprint, value.requestId, 0)
          .kind,
        'cancelled',
      );
      return;
    }
    const claim = writer.claimDispatch(capability, 0);
    assert(claim.kind === 'claimed');
    if (final === 'dispatching') return;
    writer.recordDispatchOutcome({
      credentialFingerprint: c.credential.fingerprint,
      requestId: value.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome:
        final === 'accepted'
          ? {
              kind: 'accepted',
              providerTaskId: provider,
              providerType: value.taskFamily,
            }
          : { kind: final },
    });
  }
  // No server/child cooperates with this V1 store during explicit offline migration.
  const legacy = api.initializeLedger({ stateDirectory: state });
  try {
    const value = intent(
      config,
      'PRIVATE-GRH-REQ-legacy',
      ['https://private-history.test/legacy'],
      'google',
      0,
    );
    const prepared = legacy.prepareIntent(value);
    assert(prepared.kind === 'created');
    transition(
      legacy,
      config,
      value,
      prepared.dispatchCapability,
      'accepted',
      ' Legacy "Ω\\ack" ',
    );
  } finally {
    legacy.close();
  }
  const migration = api.migrateLedgerV2({
    stateDirectory: state,
    backupDirectory: join(root, 'backup'),
  });
  assert.equal(migration.migrated, true);
  const seedKey = (
    c: ConfiguredSubmission,
    wanted: SeedRow[],
    prefix: string,
  ) => {
    const writer = api.openRetryLedgerV2({ stateDirectory: state });
    try {
      for (const engine of ['google', 'yandex'] as const) {
        if (!wanted.some((r) => r.engine === engine)) continue;
        const urls = Array.from(
          { length: 20 },
          (_, i) => `https://private-history.test/${prefix}${engine}/${i}`,
        );
        const value = intent(
          c,
          'PRIVATE-GRH-REQ-' + prefix + 'parent-' + engine,
          urls,
          engine,
          0,
        );
        const prepared = writer.prepareIntent(value);
        assert(prepared.kind === 'created');
        transition(
          writer,
          c,
          value,
          prepared.dispatchCapability,
          'accepted',
          parentId,
        );
      }
      // Prepare every retry before any dispatching/unknown child can block admission.
      const pending = wanted.map((row, index) => {
        const snapshot = api.readRetrySnapshot(
          { stateDirectory: state },
          c.credential.fingerprint,
        );
        assert(snapshot.availability === 'available');
        const family =
          row.engine === 'google' ? 'google/indexer' : 'yandex/indexer';
        const manifest = snapshot.acceptedManifests.find(
          (m) => m.taskFamily === family && m.providerTaskId === parentId,
        );
        const url = manifest?.submittedUrls[index];
        assert(manifest && url);
        const value = intent(
          c,
          'PRIVATE-GRH-REQ-' + prefix + row.requestId,
          [url],
          row.engine,
          index,
        );
        const prepared = writer.prepareRetryIntent({
          intent: value,
          parent: { family, taskId: parentId },
          sourceManifestDigest: manifest.manifestDigest,
          planFingerprint: hash('PRIVATE-GRH-PLAN-' + prefix + index),
          expectedRevision: snapshot.revision,
        });
        assert(prepared.kind === 'created');
        return { row, value, capability: prepared.dispatchCapability };
      });
      for (const p of pending)
        transition(
          writer,
          c,
          p.value,
          p.capability,
          p.row.state,
          ` Provider "Ω\\${p.row.engine}-${p.row.state}" `,
        );
    } finally {
      writer.close();
    }
  };
  seedKey(config, rows, '');
  seedKey(
    configuration(otherKey, 'other'),
    [{ requestId: 'fixture-other', state: 'accepted', engine: 'google' }],
    'other-',
  );
  return {
    root,
    state,
    policyPath,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
  };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function logical(db: Database) {
  const schema = db
    .query<{ name: string; type: string; sql: string | null }, []>(
      'SELECT name,type,sql FROM sqlite_schema ORDER BY name',
    )
    .all();
  return {
    version: db.query('PRAGMA user_version').get(),
    schema,
    tables: schema
      .filter((r) => r.type === 'table')
      .map(({ name }) => {
        assert(/^[a-z_]+$/.test(name));
        const columns = db
          .query<{ name: string }, []>(`PRAGMA table_info("${name}")`)
          .all();
        return [
          name,
          db
            .query(
              `SELECT ${columns.map((c) => `CAST("${c.name}" AS TEXT)`).join(',')} FROM "${name}" ORDER BY rowid`,
            )
            .values(),
        ];
      }),
  };
}
const revisionTables = [
  [
    'intents',
    'credential_fp request_id budget_scope period_id period_start_ms policy_revision policy_digest task_family provider_route payload_digest quote_version quote_fingerprint reserved_tokens reserved_indexer reserved_checker state state_version claim_token_digest dispatch_outcome_token_digest created_at_ms provider_task_id provider_type',
    'request_id COLLATE BINARY',
  ],
  [
    'intent_context',
    'credential_fp request_id origin_kind parent_family parent_task_id source_manifest_digest plan_fingerprint',
    'request_id COLLATE BINARY',
  ],
  [
    'intent_urls',
    'credential_fp request_id ordinal url_text',
    'request_id COLLATE BINARY, ordinal',
  ],
  [
    'intent_events',
    'event_id credential_fp request_id state_version event_kind occurred_at_ms provider_task_id provider_type',
    'event_id',
  ],
] as const;
type SQLRow = {
  request_id: string;
  task_family: string;
  state: IntentState;
  version: string;
  provider_task_id: string | null;
  parent_family: string;
  parent_task_id: string;
  source_manifest_digest: string;
  created: string;
  latest: string;
  tokens: string;
  indexer: string;
  checker: string;
  urls: number;
  attempts: number;
};
async function oracle(f: Fixture) {
  const { Database, constants } = await import('bun:sqlite');
  const db = new Database(
    join(f.state, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const before = logical(db);
    const ledgerId = db
      .query<{ ledger_id: string }, []>(
        'SELECT ledger_id FROM retry_ledger_meta',
      )
      .get()?.ledger_id;
    assert(ledgerId);
    const tuples = revisionTables.map(([table, columns, order]) =>
      db
        .query(
          `SELECT ${columns
            .split(' ')
            .map((c) => `CAST(${c} AS TEXT)`)
            .join(',')} FROM ${table} WHERE credential_fp=? ORDER BY ${order}`,
        )
        .values(selected),
    );
    const revision = domainHash('speedyindex-retry-ledger-snapshot-v2', [
      ledgerId,
      selected,
      ...tuples,
    ]);
    const rows = db
      .query<SQLRow, [string]>(
        `SELECT i.request_id,i.task_family,i.state,CAST(i.state_version AS TEXT) AS version,i.provider_task_id,
      c.parent_family,c.parent_task_id,c.source_manifest_digest,CAST(i.created_at_ms AS TEXT) AS created,
      CAST((SELECT e.occurred_at_ms FROM intent_events e WHERE e.credential_fp=i.credential_fp AND e.request_id=i.request_id AND e.state_version=i.state_version) AS TEXT) AS latest,
      CAST(i.reserved_tokens AS TEXT) AS tokens,CAST(i.reserved_indexer AS TEXT) AS indexer,CAST(i.reserved_checker AS TEXT) AS checker,
      (SELECT COUNT(*) FROM intent_urls u WHERE u.credential_fp=i.credential_fp AND u.request_id=i.request_id) AS urls,
      (SELECT COUNT(*) FROM intent_context p WHERE p.credential_fp=c.credential_fp AND p.origin_kind='retry' AND p.parent_family=c.parent_family AND p.parent_task_id=c.parent_task_id) AS attempts
      FROM intents i JOIN intent_context c USING(credential_fp,request_id) WHERE c.credential_fp=? AND c.origin_kind='retry' ORDER BY i.request_id COLLATE BINARY`,
      )
      .all(selected);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((r) => r.state).sort(), [
      'accepted',
      'accepted',
      'cancelled',
      'dispatching',
      'prepared',
      'rejected',
      'unknown',
    ]);
    assert.equal(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM intent_context WHERE credential_fp=? AND origin_kind='legacy_unattributed'",
        )
        .get(selected)?.n,
      1,
    );
    assert.equal(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM intent_context WHERE credential_fp<>? AND origin_kind='retry'",
        )
        .get(selected)?.n,
      1,
    );
    assert.equal(
      db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(DISTINCT period_id) n FROM intents WHERE credential_fp=?',
        )
        .get(selected)?.n,
      7,
    );
    const entries = rows
      .map((r) => {
        const parents = db
          .query<
            { request_id: string; origin_kind: string },
            [string, string, string]
          >(
            `SELECT i.request_id,c.origin_kind FROM intents i JOIN intent_context c USING(credential_fp,request_id) WHERE i.credential_fp=? AND i.task_family=? AND i.provider_task_id=? AND i.state='accepted'`,
          )
          .all(selected, r.parent_family, r.parent_task_id);
        assert.equal(parents.length, 1);
        assert.equal(parents[0]?.origin_kind, 'standalone');
        const urls = db
          .query<{ url_text: string }, [string, string]>(
            'SELECT url_text FROM intent_urls WHERE credential_fp=? AND request_id=? ORDER BY ordinal',
          )
          .all(selected, parents[0]!.request_id)
          .map((r) => r.url_text);
        assert.equal(
          r.source_manifest_digest,
          domainHash('speedyindex-intent-url-manifest-v1', [
            r.parent_family,
            urls,
          ]),
        );
        const held = ['prepared', 'dispatching', 'unknown'].includes(r.state);
        return {
          attemptRef: domainHash('speedyindex-retry-history-attempt-v1', [
            ledgerId,
            selected,
            r.request_id,
          ]),
          family: r.task_family,
          state: r.state,
          stateVersion: Number(r.version),
          providerTaskId: r.provider_task_id,
          providerReferenceAmbiguous: false,
          source: {
            family: r.parent_family,
            taskId: r.parent_task_id,
            attribution: 'local_standalone_manifest',
            originalAncestry: 'unknown',
            recordedAttempts: r.attempts,
          },
          createdAtMs: held ? r.created : null,
          latestStateAtMs: held ? r.latest : null,
          reservation: held
            ? { tokens: r.tokens, indexer: r.indexer, checker: r.checker }
            : null,
          submittedUrlCount: held || r.state === 'accepted' ? r.urls : null,
          unresolvedHold: held,
        };
      })
      .sort((a, b) =>
        a.attemptRef < b.attemptRef ? -1 : a.attemptRef > b.attemptRef ? 1 : 0,
      );
    const privateValues = [
      key,
      otherKey,
      selected,
      ledgerId,
      f.root,
      'PRIVATE-GRH-REQ-',
      'PRIVATE-GRH-POLICY',
      'PRIVATE-GRH-SCOPE',
      'https://private-history.test/',
    ];
    return { before, revision, entries, privateValues, rows };
  } finally {
    db.close(true);
  }
}
type Oracle = Awaited<ReturnType<typeof oracle>>;
type Schema = {
  type?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  enum?: unknown;
  const?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
};
function advertised(tools: Awaited<ReturnType<Client['listTools']>>['tools']) {
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      'get_balance',
      'list_tasks',
      'get_task_status',
      'get_task_report',
      'create_indexing_task',
      'create_index_check',
      'create_backlink_check',
      'plan_retry',
      'get_retry_history',
      'compare_reports',
    ],
  );
  const tool = tools.find((t) => t.name === 'get_retry_history');
  assert(tool);
  const input = tool.inputSchema as Schema;
  assert.equal(input.type, 'object');
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(Object.keys(input.properties ?? {}), [
    'searchEngine',
    'parentTaskId',
    'state',
    'limit',
    'cursor',
  ]);
  assert.deepEqual(input.required ?? [], []);
  assert.deepEqual(input.properties?.searchEngine?.enum, ['google', 'yandex']);
  assert.equal(input.properties?.searchEngine?.default, undefined);
  assert.deepEqual(input.properties?.state?.enum, [...states]);
  assert.equal(input.properties?.limit?.type, 'integer');
  assert.equal(input.properties?.limit?.minimum, 1);
  assert.equal(input.properties?.limit?.maximum, 25);
  assert.equal(input.properties?.limit?.default, undefined);
  assert.equal(input.properties?.cursor?.maxLength, 512);
  assert.equal(input.properties?.cursor?.pattern, '^[A-Za-z0-9_-]+$');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const output = tool.outputSchema as Schema;
  const branches = output.oneOf ?? output.anyOf ?? [];
  assert.deepEqual(branches.map((b) => b.properties?.status?.const).sort(), [
    'blocked',
    'error',
    'ok',
  ]);
  function closed(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(closed);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = object(value);
    if (
      node.type === 'object' &&
      !['oneOf', 'anyOf', 'allOf'].some((k) => Array.isArray(node[k]))
    )
      assert.equal(node.additionalProperties, false);
    Object.values(node).forEach(closed);
  }
  closed(input);
  closed(output);
  return tool;
}
type Selectors = {
  searchEngine?: Engine;
  parentTaskId?: string;
  state?: IntentState;
  limit?: number;
  cursor?: string;
};
function checkEnvelope(value: unknown, expected: unknown, privacy: string[]) {
  const r = object(value),
    d = object(r.structuredContent);
  assert.deepEqual(d, expected);
  assert.equal(r.isError, d.status === 'error');
  assert.deepEqual(r.content, [{ type: 'text', text: JSON.stringify(d) }]);
  const envelope = {
    isError: r.isError,
    content: r.content,
    structuredContent: d,
  };
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  assert(bytes <= 2_097_152);
  const serialized = JSON.stringify(envelope);
  for (const marker of privacy)
    assert(
      !serialized.includes(marker),
      'Private fixture value reached history envelope.',
    );
  return bytes;
}
function checkOk(
  value: unknown,
  o: Oracle,
  selectors: Selectors,
  offset: number,
  before: number,
  after: number,
) {
  const d = object(object(value).structuredContent),
    snapshot = object(d.snapshot);
  assert.equal(typeof snapshot.capturedAt, 'string');
  assert.match(
    String(snapshot.capturedAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  const captured = Date.parse(String(snapshot.capturedAt));
  assert(captured >= before && captured <= after);
  const matching = o.entries.filter(
    (e) =>
      (!selectors.searchEngine ||
        e.family === selectors.searchEngine + '/indexer') &&
      (!selectors.parentTaskId || e.source.taskId === selectors.parentTaskId) &&
      (!selectors.state || e.state === selectors.state),
  );
  const limit = selectors.limit ?? 25;
  const entries = matching.slice(offset, offset + limit),
    nextOffset = offset + entries.length;
  const query = domainHash('speedyindex-retry-history-query-v1', [
    selectors.searchEngine ?? null,
    selectors.parentTaskId ?? null,
    selectors.state ?? null,
    limit,
  ]);
  const nextCursor =
    nextOffset < matching.length
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            revision: o.revision,
            query,
            offset: nextOffset,
          }),
        ).toString('base64url')
      : null;
  const expected = {
    status: 'ok',
    snapshot: { revision: o.revision, capturedAt: snapshot.capturedAt },
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
      localRetryAttempts: 7,
      matchingRetryAttempts: matching.length,
      legacyUnattributedLocalRecords: 1,
      ambiguousLocalProviderReferences: 0,
    },
    page: { limit, returnedCount: entries.length, nextCursor },
    entries,
  };
  const bytes = checkEnvelope(value, expected, o.privateValues);
  if (nextCursor)
    for (const marker of o.privateValues)
      assert(
        !Buffer.from(nextCursor, 'base64url').toString('utf8').includes(marker),
      );
  return { nextCursor, entries, bytes };
}
function sdkRejection(value: unknown) {
  const r = object(value);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent, undefined);
  assert.match(
    JSON.stringify(r.content),
    /Input validation error: Invalid arguments for tool get_retry_history/,
  );
}
function semanticRejection(value: unknown, o: Oracle) {
  if (object(value).structuredContent === undefined) {
    sdkRejection(value);
    return 'SDK input rejection';
  }
  checkEnvelope(
    value,
    {
      status: 'error',
      error: { code: 'InvalidInput', message: 'Invalid retry-history input.' },
    },
    o.privateValues,
  );
  return 'fixed application InvalidInput';
}

/** Actual public SDK framing with owned, byte-exact Bun pipes and closure receipts. */
async function openSDK(
  args: string[],
  environment: Record<string, string>,
  phase: HistoryPhaseDecoder | undefined,
  register: (close: () => Promise<void>) => void,
) {
  const { Client, ReadBuffer, serializeMessage } =
    await import('@modelcontextprotocol/client');
  const { JSONRPCMessageSchema } = await import('@modelcontextprotocol/core');
  const receipt = {
    spawned: false,
    reaped: false,
    exitCode: null as number | null,
    signalCode: null as string | number | null,
    killed: false,
    stdoutEOF: false,
    stderrEOF: false,
    stdoutClosed: false,
    stderrClosed: false,
    stdoutReleased: false,
    stderrReleased: false,
    stdoutFrameEOF: false,
    stdoutFrames: 0,
  };
  const frames = new HistoryStdoutFrames((value) => {
    JSONRPCMessageSchema.parse(value);
  });
  type SendReceipt = {
    order: number;
    method: string;
    requestId: string | number | null;
    cancellationFor: string | number | null;
    flushed: boolean;
  };
  const sent: SendReceipt[] = [];
  const cancelledFlush = Promise.withResolvers<SendReceipt>();
  const wire: unknown[] = [],
    stderr: Buffer[] = [],
    failures: unknown[] = [];
  let child: import('bun').Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let finished: Promise<unknown> = Promise.resolve(),
    closing: Promise<void> | undefined;
  const transport: Transport = {
    async start() {
      child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          '--preload',
          './tests/fixtures/redirect-fetch.ts',
          ...args,
        ],
        {
          cwd: process.cwd(),
          env: environment,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      receipt.spawned = true;
      const buffer = new ReadBuffer();
      async function drain(
        stream: ReadableStream<Uint8Array>,
        kind: 'stdout' | 'stderr',
      ) {
        const reader = stream.getReader(),
          closed = reader.closed;
        void closed.catch(() => undefined);
        let total = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) {
              if (kind === 'stdout') {
                const end = frames.finish();
                assert.equal(end.frames, wire.length);
                receipt.stdoutFrameEOF = true;
                receipt.stdoutFrames = end.frames;
              }
              receipt[`${kind}EOF`] = true;
              break;
            }
            total += part.value.byteLength;
            assert(total <= (kind === 'stdout' ? 8 * 1024 * 1024 : 16_384));
            if (kind === 'stderr') {
              stderr.push(Buffer.from(part.value));
              phase?.push(part.value);
            } else {
              const raw = frames.push(part.value);
              buffer.append(Buffer.from(part.value));
              let message = buffer.readMessage();
              while (message !== null) {
                JSONRPCMessageSchema.parse(message);
                assert.deepEqual(message, raw.shift());
                wire.push(message);
                transport.onmessage?.(message);
                message = buffer.readMessage();
              }
              assert.equal(raw.length, 0);
            }
          }
          await closed;
          receipt[`${kind}Closed`] = true;
        } finally {
          reader.releaseLock();
          receipt[`${kind}Released`] = true;
        }
      }
      const out = drain(child.stdout, 'stdout'),
        err = drain(child.stderr, 'stderr');
      finished = Promise.allSettled([child.exited, out, err]).then(
        (results) => {
          for (const r of results)
            if (r.status === 'rejected') failures.push(r.reason);
          transport.onclose?.();
        },
      );
    },
    async send(message) {
      assert(child);
      assert(sent.length < 128);
      const raw = object(message);
      assert(
        typeof raw.method === 'string' &&
          [
            'initialize',
            'notifications/initialized',
            'tools/list',
            'tools/call',
            'notifications/cancelled',
          ].includes(raw.method),
      );
      const id = raw.id;
      assert(
        id === undefined || typeof id === 'string' || typeof id === 'number',
      );
      const cancellationFor =
        raw.method === 'notifications/cancelled'
          ? object(raw.params).requestId
          : null;
      assert(
        cancellationFor === null ||
          typeof cancellationFor === 'string' ||
          typeof cancellationFor === 'number',
      );
      const observed: SendReceipt = {
        order: sent.length + 1,
        method: raw.method,
        requestId: id ?? null,
        cancellationFor,
        flushed: false,
      };
      sent.push(observed);
      child.stdin.write(serializeMessage(message));
      await child.stdin.flush();
      observed.flushed = true;
      if (observed.cancellationFor !== null) cancelledFlush.resolve(observed);
    },
    close() {
      closing ??= (async () => {
        if (!child) return;
        let failure: unknown;
        try {
          await child.stdin.end();
          await within(child.exited, 5_000);
        } catch (error) {
          failure = error;
          if (child.exitCode === null && child.signalCode === null) {
            receipt.killed = true;
            child.kill('SIGKILL');
          }
        }
        await within(child.exited, 5_000);
        receipt.reaped = true;
        receipt.exitCode = child.exitCode;
        receipt.signalCode = child.signalCode;
        await within(finished, 5_000);
        if (failure) throw failure;
        assert.equal(failures.length, 0);
        assert.equal(receipt.exitCode, 0);
        assert.equal(receipt.signalCode, null);
        assert(
          receipt.stdoutEOF &&
            receipt.stderrEOF &&
            receipt.stdoutClosed &&
            receipt.stderrClosed &&
            receipt.stdoutReleased &&
            receipt.stderrReleased &&
            receipt.stdoutFrameEOF &&
            !receipt.killed,
        );
      })();
      return closing;
    },
  };
  const client = new Client({
    name: 'synthetic-history-sdk',
    version: '1.0.0',
  });
  let clientClosing: Promise<void> | undefined;
  const close = () =>
    (clientClosing ??= (async () => {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    })());
  register(close);
  try {
    await within(client.connect(transport));
  } catch (error) {
    await close();
    throw error;
  }
  return {
    client,
    close,
    receipt,
    wire,
    sent,
    async cancellationFlushed(requestId: string | number) {
      const observed = await within(cancelledFlush.promise);
      assert.equal(observed.cancellationFor, requestId);
      assert(observed.flushed);
      return observed;
    },
    stderr: () => Buffer.concat(stderr).toString('utf8'),
  };
}
async function receiver(register: (close: () => Promise<void>) => void) {
  const { createServer } = await import('node:http');
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(500);
    res.end();
  });
  const close = async () => {
    if (!server.listening) return;
    await within(
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
    );
  };
  register(close);
  await within(
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    }),
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, requests, close };
}
async function controlSocket(
  root: string,
  phase: HistoryPhaseDecoder,
  register: (close: () => Promise<void>) => void,
) {
  const { createConnection } = await import('node:net');
  const receipt = {
    connected: false,
    closed: false,
    error: false,
    commands: 0,
    releaseReadIOFlushed: false,
  };
  const ownership: { socket: import('node:net').Socket | undefined } = {
    socket: undefined,
  };
  const closed = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const socket = ownership.socket;
      if (!socket) return;
      socket.end();
      await within(closed.promise);
      assert(!receipt.error);
    })());
  register(close);
  const socket = createConnection({ path: join(root, 'control.sock') });
  ownership.socket = socket;
  socket.on('close', () => {
    receipt.closed = true;
    closed.resolve();
  });
  socket.on('error', () => {
    receipt.error = true;
  });
  await within(
    new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => {
        receipt.connected = true;
        resolve();
      });
      socket!.once('error', reject);
    }),
  );
  let sequence = 0;
  async function barrier() {
    const n = ++sequence;
    const waiting = phase.waitFor({ event: 'BARRIER', sequence: n });
    await within(
      new Promise<void>((resolve, reject) =>
        socket!.write(
          JSON.stringify({ event: 'BARRIER', sequence: n }) + '\n',
          (error) => (error ? reject(error) : resolve()),
        ),
      ),
    );
    receipt.commands++;
    const event = await waiting;
    assert(event.event === 'BARRIER');
    return event;
  }
  async function releaseReadIO() {
    assert(!receipt.releaseReadIOFlushed);
    await within(
      new Promise<void>((resolve, reject) =>
        socket.write(
          JSON.stringify({ event: 'RELEASE_READ_IO', operation: 1 }) + '\n',
          (error) => (error ? reject(error) : resolve()),
        ),
      ),
    );
    receipt.commands++;
    receipt.releaseReadIOFlushed = true;
  }
  return { barrier, releaseReadIO, close, receipt };
}

type HistoryCLIEntry = 'src/cli.ts' | 'dist/cli.js';
function trustedHistoryEntry(entry: HistoryCLIEntry) {
  assert(entry === 'src/cli.ts' || entry === 'dist/cli.js');
  return entry;
}

async function journey(
  observed: boolean,
  entry: HistoryCLIEntry = 'src/cli.ts',
) {
  const cli = trustedHistoryEntry(entry);
  const built = cli === 'dist/cli.js';
  assert(!observed || !built);
  const evidence = mkdtempSync(
    join(
      process.env.TMPDIR ?? realpathSync('/tmp'),
      observed ? 'grh-observed-' : built ? 'grh-built-' : 'grh-source-',
    ),
  );
  chmodSync(evidence, 0o700);
  const closers: (() => Promise<void>)[] = [];
  const resources: Record<string, unknown> = {
    evidence,
    stage: 'preparation',
    shortRoot: null,
    ...(built ? { entry: cli } : {}),
  };
  const guard = denyHTTP();
  let root: string | undefined,
    success = false;
  const register = (close: () => Promise<void>) => {
    closers.push(close);
  };
  try {
    const seed = saveSeed(evidence);
    const savedHash = hash(readFileSync(seed));
    readSeed(seed);
    root = mkdtempSync(join(realpathSync('/tmp'), 'grh-sdk-'));
    chmodSync(root, 0o700);
    resources.shortRoot = root;
    const ownership = privateDirectory(root);
    record(evidence, 'ownership-before-native', {
      root,
      uid: ownership.uid,
      ino: ownership.ino,
      mode: ownership.mode & 0o777,
      socketBytes: Buffer.byteLength(join(root, 'control.sock')),
      seedHash: savedHash,
    });
    const f = await seedFixture(root, seed),
      o = await oracle(f);
    record(evidence, 'oracle-before', o);
    resources.stage = 'SDK';
    const api = await receiver(register);
    const phase = observed ? new HistoryPhaseDecoder() : undefined;
    const session = await openSDK(
      observed
        ? [
            'tests/fixtures/get-retry-history-sdk-child.ts',
            '--mode',
            'observe',
            '--control-root',
            root,
          ]
        : [
            cli,
            '--submission-policy',
            f.policyPath,
            '--submission-state',
            f.state,
          ],
      {
        PATH: '/usr/bin:/bin',
        HOME: f.home,
        TMPDIR: f.tmp,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        NO_COLOR: '1',
        SPEEDYINDEX_API_KEY: key,
        TEST_ACCOUNT_ORIGIN: api.origin,
        ...(observed
          ? {
              TEST_SUBMISSION_POLICY: f.policyPath,
              TEST_SUBMISSION_STATE: f.state,
            }
          : {}),
      },
      phase,
      register,
    );
    resources.child = session.receipt;
    record(
      evidence,
      'tools',
      advertised((await within(session.client.listTools())).tools),
    );
    let calls = 0;
    const call = async (input: Record<string, unknown>) => {
      const before = Date.now();
      const value = await within(
        session.client.callTool({
          name: 'get_retry_history',
          arguments: input,
        }),
      );
      record(evidence, 'call-' + ++calls, { input, value });
      return { value, before, after: Date.now() };
    };
    const semantic = async (input: Record<string, unknown>) => {
      const r = await call(input);
      return semanticRejection(r.value, o);
    };
    if (observed) {
      assert(phase);
      await phase.waitFor({ event: 'BOOT_READY' });
      const control = await controlSocket(root, phase, register);
      resources.control = control.receipt;
      const baseline = await control.barrier();
      assert.deepEqual(
        [
          baseline.handlerEntries,
          baseline.nativeReads,
          baseline.nativeCloses,
          baseline.budgetSettlements,
          baseline.httpAttempts,
        ],
        [0, 0, 0, 0, 0],
      );
      sdkRejection(
        (
          await call({
            expectedPlan: { proof: 'SYNTHETIC_ASSERTED_AUTHORITY' },
            policyPath: 'SYNTHETIC_NO_AUTHORITY',
          })
        ).value,
      );
      const rejected = await control.barrier();
      assert.deepEqual(
        [
          rejected.handlerEntries,
          rejected.nativeReads,
          rejected.nativeCloses,
          rejected.budgetSettlements,
          rejected.httpAttempts,
        ],
        [0, 0, 0, 0, 0],
      );
      const parentBoundary = await semantic({ parentTaskId: parentId });
      const afterParent = await control.barrier();
      assert.equal(
        afterParent.handlerEntries,
        parentBoundary === 'SDK input rejection' ? 0 : 1,
      );
      assert.deepEqual(
        [
          afterParent.nativeReads,
          afterParent.nativeCloses,
          afterParent.budgetSettlements,
          afterParent.httpAttempts,
        ],
        [0, 0, 0, 0],
      );
      const cursorBoundary = await semantic({ cursor: 'AA' });
      const afterCursor = await control.barrier();
      assert.equal(
        afterCursor.handlerEntries,
        afterParent.handlerEntries +
          (cursorBoundary === 'SDK input rejection' ? 0 : 1),
      );
      assert.deepEqual(
        [
          afterCursor.nativeReads,
          afterCursor.nativeCloses,
          afterCursor.budgetSettlements,
          afterCursor.httpAttempts,
        ],
        [0, 0, 0, 0],
      );
      const good = await call({});
      checkOk(good.value, o, {}, 0, good.before, good.after);
      const operation = afterCursor.handlerEntries + 1;
      for (const event of [
        'NATIVE_CLOSED',
        'BUDGET_CLOSED',
        'OWNER_SETTLED',
      ] as const)
        await phase.waitFor({ event, operation });
      const settled = phase.events.find(
        (e) =>
          e.event === 'OWNER_SETTLED' &&
          'operation' in e &&
          e.operation === operation,
      );
      assert.deepEqual(settled, {
        event: 'OWNER_SETTLED',
        operation,
        aborted: false,
        status: 'ok',
        code: null,
      });
      const final = await control.barrier();
      assert.deepEqual(
        [
          final.handlerEntries,
          final.nativeReads,
          final.nativeCloses,
          final.budgetSettlements,
          final.httpAttempts,
        ],
        [operation, 1, 1, 1, 0],
      );
      record(evidence, 'observations', {
        baseline,
        rejected,
        parentBoundary,
        afterParent,
        cursorBoundary,
        afterCursor,
        final,
        phases: phase.events,
      });
      await control.close();
      assert(control.receipt.closed);
    } else {
      const all = await call({});
      checkOk(all.value, o, {}, 0, all.before, all.after);
      const walk = [];
      let cursor: string | null = null,
        offset = 0;
      do {
        const input: Selectors = { limit: 2, ...(cursor ? { cursor } : {}) };
        const r = await call({ ...input });
        const page = checkOk(r.value, o, input, offset, r.before, r.after);
        walk.push(page.entries.length);
        offset += page.entries.length;
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(walk, [2, 2, 2, 1]);
      assert.equal(offset, 7);
      for (const input of [
        { searchEngine: 'google' },
        { searchEngine: 'yandex' },
        { searchEngine: 'google', parentTaskId: parentId },
        { searchEngine: 'google', parentTaskId: parentId, state: 'accepted' },
      ] satisfies Selectors[]) {
        const r = await call(input);
        checkOk(r.value, o, input, 0, r.before, r.after);
      }
      sdkRejection(
        (await call({ policy: 'SYNTHETIC_ASSERTED_AUTHORITY' })).value,
      );
      record(evidence, 'semantic-boundaries', {
        parent: await semantic({ parentTaskId: parentId }),
        cursor: await semantic({ cursor: 'AA' }),
      });
    }
    assert.deepEqual(api.requests, []);
    assert.equal(guard.attempts(), 0);
    const after = await oracle(f);
    assert.deepEqual(after.before, o.before);
    assert.equal(after.revision, o.revision);
    record(evidence, 'logical-after', after.before);
    await session.close();
    phase?.finish();
    await api.close();
    assert(!existsSync(join(root, 'control.sock')));
    assert.deepEqual(api.requests, []);
    assert.equal(guard.attempts(), 0);
    assert.equal(hash(readFileSync(seed)), savedHash);
    record(evidence, 'wire', session.wire);
    resources.stage = 'settled';
    resources.calls = calls;
    resources.httpArrivals = api.requests.length;
    resources.parentHTTPAttempts = guard.attempts();
    resources.controlPathAbsent = true;
    resources.stderr = session.stderr();
    resources.logicalEquality = true;
    if (!observed) assert.equal(session.stderr(), '');
    assert.equal(privateDirectory(root).ino, ownership.ino);
    rmSync(root, { recursive: true });
    assert(!existsSync(root));
    resources.ownedRootRemoved = true;
    record(evidence, 'receipt', {
      case: observed
        ? 'GRH-15-OBSERVED'
        : built
          ? 'GRH-15-BUILT'
          : 'GRH-15-SOURCE',
      result: 'passed',
      ...resources,
    });
    success = true;
  } finally {
    const cleanup = await Promise.allSettled(
      closers.reverse().map((close) => close()),
    );
    guard.restore();
    if (!success || cleanup.some((r) => r.status === 'rejected'))
      record(evidence, 'failure-resources', {
        ...resources,
        cleanup: cleanup.map((r) => r.status),
        preservedRoot: root ?? null,
      });
    assert(
      cleanup.every((r) => r.status === 'fulfilled'),
      'Owned SDK fixture cleanup failed.',
    );
  }
}
export async function verifyRetryHistorySourceSdk(
  entry: HistoryCLIEntry = 'src/cli.ts',
) {
  await journey(false, entry);
}
export async function verifyRetryHistoryObservedSdk() {
  await journey(true);
}

/** Independent byte-tail audit: the SDK's ReadBuffer can discard malformed JSON lines. */
class HistoryStdoutFrames {
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;
  private count = 0;
  private ended = false;
  constructor(private readonly validate: (value: unknown) => void) {}
  push(chunk: Uint8Array): unknown[] {
    assert(!this.ended && chunk instanceof Uint8Array);
    this.total += chunk.byteLength;
    assert(this.total <= 8 * 1024 * 1024);
    const bytes = Buffer.concat([this.tail, chunk]);
    const messages: unknown[] = [];
    let start = 0;
    for (
      let end = bytes.indexOf(10);
      end !== -1;
      end = bytes.indexOf(10, start)
    ) {
      assert(end - start <= 4 * 1024 * 1024);
      assert(++this.count <= 128);
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(start, end));
      const value: unknown = JSON.parse(text);
      this.validate(value);
      messages.push(value);
      start = end + 1;
    }
    this.tail = Buffer.from(bytes.subarray(start));
    assert(this.tail.length <= 4 * 1024 * 1024);
    return messages;
  }
  finish() {
    assert(!this.ended);
    assert.equal(
      this.tail.length,
      0,
      'Incomplete JSON-RPC stdout frame at EOF.',
    );
    this.ended = true;
    return { bytes: this.total, frames: this.count, tailBytes: 0 };
  }
}

export const retryHistoryFiniteCases = [
  'missing',
  'v1',
  'empty_v2',
  'stale_cursor',
] as const;
type FiniteCase = (typeof retryHistoryFiniteCases)[number];
const finiteStores = {
  missing: 'absent',
  v1: 'v1_ordinary',
  empty_v2: 'v2_empty',
  stale_cursor: 'v2_full',
} as const;
function finiteDescriptor(kind: FiniteCase) {
  return { version: 1, kind, store: finiteStores[kind] };
}
function savedPrivate(path: string, bound: number) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(realpathSync(path), path);
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o777, 0o600);
  assert(stat.size <= bound);
  const bytes = readFileSync(path);
  assert(bytes.length <= bound);
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  ) as unknown;
}
function readFinite(path: string): FiniteCase {
  const value = object(savedPrivate(path, 1_024));
  const kind = retryHistoryFiniteCases.find((kind) => kind === value.kind);
  assert(kind);
  assert.deepEqual(value, finiteDescriptor(kind));
  return kind;
}
async function s2Preparation(path: string) {
  const value = object(savedPrivate(path, 65_536));
  assert.deepEqual(Object.keys(value).sort(), [
    'controlChunks',
    'finite',
    'frames',
    'phaseChunks',
    'version',
  ]);
  assert.equal(value.version, 1);
  assert.deepEqual(value.finite, retryHistoryFiniteCases.map(finiteDescriptor));
  const { JSONRPCMessageSchema } = await import('@modelcontextprotocol/core');
  const { ReadBuffer } = await import('@modelcontextprotocol/client');
  function chunks(value: unknown) {
    assert(Array.isArray(value) && value.length >= 1 && value.length <= 64);
    return value.map((part: unknown) => {
      assert(typeof part === 'string' && part.length <= 21_848);
      const bytes = Buffer.from(part, 'base64');
      assert(bytes.length > 0 && bytes.toString('base64') === part);
      return bytes;
    });
  }
  assert(Array.isArray(value.frames) && value.frames.length === 8);
  const names = new Set<string>();
  for (const item of value.frames) {
    const frame = object(item);
    assert.deepEqual(Object.keys(frame).sort(), ['chunks', 'name', 'valid']);
    assert(
      typeof frame.name === 'string' && /^[a-z0-9_]{1,32}$/.test(frame.name),
    );
    assert(!names.has(frame.name));
    names.add(frame.name);
    assert.equal(typeof frame.valid, 'boolean');
    const input = chunks(frame.chunks);
    const audit = new HistoryStdoutFrames((v) => {
      JSONRPCMessageSchema.parse(v);
    });
    const decode = () => {
      const actual: unknown[] = [];
      const sdk = new ReadBuffer();
      for (const bytes of input) {
        const raw = audit.push(bytes);
        sdk.append(bytes);
        let message = sdk.readMessage();
        while (message !== null) {
          assert.deepEqual(message, raw.shift());
          actual.push(message);
          message = sdk.readMessage();
        }
        assert.equal(raw.length, 0);
      }
      const end = audit.finish();
      assert.equal(end.frames, actual.length);
      assert(actual.length > 0);
      return end;
    };
    if (frame.valid) decode();
    else assert.throws(decode);
  }
  assert.deepEqual([...names].sort(), [
    'bad_json',
    'bad_schema',
    'bad_utf8',
    'coalesced',
    'fragmented',
    'incomplete_json',
    'incomplete_utf8',
    'valid_then_tail',
  ]);
  const phase = new HistoryPhaseDecoder();
  for (const bytes of chunks(value.phaseChunks)) phase.push(bytes);
  phase.finish();
  assert.equal(phase.events.length, 7);
  const control = new HistoryControlDecoder();
  const commands = chunks(value.controlChunks).flatMap((bytes) =>
    control.push(bytes),
  );
  control.finish();
  assert.deepEqual(commands, [
    { event: 'BARRIER', sequence: 1 },
    { event: 'RELEASE_READ_IO', operation: 1 },
    { event: 'BARRIER', sequence: 2 },
  ]);
  console.log(
    JSON.stringify({
      event: 'HISTORY_S2_PREPARATION_OK',
      fixtureHash: hash(readFileSync(path)),
      finiteShapes: 4,
      frameStreams: 8,
      phaseEvents: 7,
      controlFrames: 3,
      sdkSchemaAndFramingOnly: true,
      sdkClients: 0,
      native: 0,
      sockets: 0,
      HTTP: 0,
    }),
  );
}

/** New-only native fixtures; no migration or reader substitution. */
async function finiteFixture(
  root: string,
  descriptor: string,
  seed: string,
): Promise<Fixture> {
  privateDirectory(root);
  const kind = readFinite(descriptor);
  if (kind === 'stale_cursor') return seedFixture(root, seed);
  const state = join(root, 'state'),
    policyPath = join(root, 'policy.json');
  for (const name of ['home', 'tmp'])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      enabled: true,
      mode: 'operator_policy',
      policyRevision: 'PRIVATE-GRH-POLICY',
      budgetScope: 'PRIVATE-GRH-SCOPE',
      credentialFingerprint: selected,
      period: { kind: 'utc_day' },
      caps: { tokens: 100_000, indexer: 100_000, checker: 100_000 },
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const f = {
    root,
    state,
    policyPath,
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
  };
  if (kind !== 'missing') {
    const api = await import('../src/submission-ledger');
    const writer =
      kind === 'v1'
        ? api.initializeLedger({ stateDirectory: state })
        : api.initializeLedgerV2({ stateDirectory: state });
    writer.close();
    if (kind === 'v1') await ordinaryFixtureWrite(f);
  }
  return f;
}
async function ordinaryFixtureWrite(f: Fixture) {
  const { openLedger } = await import('../src/submission-ledger');
  const { loadSubmissionConfiguration, createSubmissionContext } =
    await import('../src/submission-policy');
  const { buildCreateIndexingRequest } =
    await import('../src/create-indexing-task');
  const c = loadSubmissionConfiguration({
    apiKey: key,
    policyPath: f.policyPath,
    stateDirectory: f.state,
  });
  assert(c.state === 'configured');
  const built = buildCreateIndexingRequest({
    mode: 'preview',
    urls: ['https://private-history.test/s2-ordinary'],
    searchEngine: 'google',
  });
  const context = createSubmissionContext(
    c,
    built.quote.fingerprint,
    Date.UTC(2026, 9, 20),
  );
  const writer = openLedger({ stateDirectory: f.state });
  try {
    assert.equal(
      writer.prepareIntent({
        requestId: 'PRIVATE-GRH-REQ-s2-ordinary',
        budget: context.budget,
        taskFamily: 'google/indexer',
        providerRoute: built.request.providerRoute,
        payloadDigest: built.request.payloadDigest,
        submittedUrls: ['https://private-history.test/s2-ordinary'],
        quoteVersion: built.quote.version,
        quoteFingerprint: built.quote.fingerprint,
        reservation: built.quote.maximumExposure,
      }).kind,
      'created',
    );
  } finally {
    writer.close();
  }
}
async function storeView(f: Fixture) {
  if (!existsSync(f.state))
    return { kind: 'missing' as const, leafAbsent: true };
  const { Database, constants } = await import('bun:sqlite');
  const db = new Database(
    join(f.state, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    const rows = logical(db);
    const version = db
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version;
    assert(version === 1 || version === 2);
    const names = rows.schema
      .filter((s) => s.type === 'table')
      .map((s) => s.name);
    if (version === 1) {
      assert(
        !names.includes('retry_ledger_meta') &&
          !names.includes('intent_context'),
      );
      const ordinary = db
        .query<{ request_id: string; state: string; urls: number }, []>(
          'SELECT request_id,state,(SELECT COUNT(*) FROM intent_urls u WHERE u.credential_fp=i.credential_fp AND u.request_id=i.request_id) urls FROM intents i',
        )
        .all();
      assert.deepEqual(ordinary, [
        {
          request_id: 'PRIVATE-GRH-REQ-s2-ordinary',
          state: 'prepared',
          urls: 1,
        },
      ]);
    }
    return {
      kind: version === 1 ? ('v1' as const) : ('v2' as const),
      logical: rows,
    };
  } finally {
    db.close(true);
  }
}
async function emptyOracle(f: Fixture) {
  const { Database, constants } = await import('bun:sqlite');
  const db = new Database(
    join(f.state, 'ledger.sqlite'),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    assert.deepEqual(db.query('PRAGMA user_version').get(), {
      user_version: 2,
    });
    const ledger = db
      .query<{ ledger_id: string }, []>(
        'SELECT ledger_id FROM retry_ledger_meta',
      )
      .get()?.ledger_id;
    assert(ledger);
    const tuples = revisionTables.map(([table, columns, order]) => {
      assert.equal(
        db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()?.n,
        0,
      );
      return db
        .query(
          `SELECT ${columns
            .split(' ')
            .map((c) => `CAST(${c} AS TEXT)`)
            .join(',')} FROM ${table} WHERE credential_fp=? ORDER BY ${order}`,
        )
        .values(selected);
    });
    return {
      revision: domainHash('speedyindex-retry-ledger-snapshot-v2', [
        ledger,
        selected,
        ...tuples,
      ]),
      privateValues: [
        key,
        selected,
        ledger,
        f.root,
        'PRIVATE-GRH-REQ-',
        'PRIVATE-GRH-POLICY',
        'PRIVATE-GRH-SCOPE',
        'https://private-history.test/',
      ],
    };
  } finally {
    db.close(true);
  }
}
function checkEmpty(
  value: unknown,
  o: Awaited<ReturnType<typeof emptyOracle>>,
  before: number,
  after: number,
) {
  const capturedAt = object(
    object(object(value).structuredContent).snapshot,
  ).capturedAt;
  assert(
    typeof capturedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt),
  );
  assert(Date.parse(capturedAt) >= before && Date.parse(capturedAt) <= after);
  return checkEnvelope(
    value,
    {
      status: 'ok',
      snapshot: { revision: o.revision, capturedAt },
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
        localRetryAttempts: 0,
        matchingRetryAttempts: 0,
        legacyUnattributedLocalRecords: 0,
        ambiguousLocalProviderReferences: 0,
      },
      page: { limit: 25, returnedCount: 0, nextCursor: null },
      entries: [],
    },
    o.privateValues,
  );
}
function fixedHistory(
  value: unknown,
  status: 'blocked' | 'error',
  code: string,
  message: string,
  privacy: string[],
  maxBytes = 2_097_152,
) {
  const expected =
    status === 'blocked'
      ? { status, reason: { code, message } }
      : { status, error: { code, message } };
  const bytes = checkEnvelope(value, expected, privacy);
  assert(bytes <= maxBytes);
  assert.equal(object(object(value).structuredContent).entries, undefined);
  return bytes;
}
function accountOrdinaryCommit(
  before: Awaited<ReturnType<typeof logical>>,
  after: Awaited<ReturnType<typeof logical>>,
) {
  assert.deepEqual(before.version, after.version);
  assert.deepEqual(before.schema, after.schema);
  assert.equal(before.tables.length, after.tables.length);
  const append = new Set([
    'budget_periods',
    'intents',
    'intent_context',
    'intent_urls',
    'intent_events',
  ]);
  for (let i = 0; i < before.tables.length; i++) {
    const b = before.tables[i]!,
      a = after.tables[i]!;
    const name = b[0],
      oldRows = b[1],
      newRows = a[1];
    assert.equal(a[0], name);
    assert(
      typeof name === 'string' &&
        Array.isArray(oldRows) &&
        Array.isArray(newRows),
    );
    if (append.has(name)) {
      assert.equal(newRows.length, oldRows.length + 1);
      assert.deepEqual(newRows.slice(0, oldRows.length), oldRows);
    } else if (name === 'sqlite_sequence') {
      assert.deepEqual(
        newRows,
        oldRows.map((row: unknown) => {
          assert(Array.isArray(row) && row.length === 2);
          return row[0] === 'intent_events'
            ? [row[0], String(BigInt(String(row[1])) + 1n)]
            : row;
        }),
      );
    } else assert.deepEqual(newRows, oldRows);
  }
}

async function s2Journey(
  kind: FiniteCase | 'bounded' | 'cancel',
  entry: HistoryCLIEntry = 'src/cli.ts',
) {
  const cli = trustedHistoryEntry(entry);
  const built = cli === 'dist/cli.js';
  assert(!built || (kind !== 'bounded' && kind !== 'cancel'));
  const evidence = mkdtempSync(
    join(
      process.env.TMPDIR ?? realpathSync('/tmp'),
      'grh-s2-' + (built ? 'built-' : '') + kind + '-',
    ),
  );
  chmodSync(evidence, 0o700);
  const closers: (() => Promise<void>)[] = [];
  const register = (close: () => Promise<void>) => {
    closers.push(close);
  };
  const rootOwner: { path: string | undefined; ino: number | undefined } = {
    path: undefined,
    ino: undefined,
  };
  // Register path cleanup before allocation; invoke it only after all native/pipe/socket owners close.
  const removeOwnedRoot = () => {
    assert(rootOwner.path);
    assert.equal(privateDirectory(rootOwner.path).ino, rootOwner.ino);
    rmSync(rootOwner.path, { recursive: true });
    assert(!existsSync(rootOwner.path));
  };
  const resources: Record<string, unknown> = {
    case: kind,
    evidence,
    stage: 'fixture',
    ...(built ? { entry: cli } : {}),
  };
  const guard = denyHTTP();
  const controller = new AbortController();
  const timeline: string[] = [];
  let success = false;
  let session: Awaited<ReturnType<typeof openSDK>> | undefined;
  try {
    const seed = saveSeed(evidence);
    const fixtureKind =
      kind === 'bounded' || kind === 'cancel' ? 'stale_cursor' : kind;
    const descriptor = record(
      evidence,
      'finite-shape',
      finiteDescriptor(fixtureKind),
    );
    assert.equal(readFinite(descriptor.path), fixtureKind);
    const seedHash = hash(readFileSync(seed));
    const root = mkdtempSync(join(realpathSync('/tmp'), 'grh-sdk-'));
    rootOwner.path = root;
    chmodSync(root, 0o700);
    rootOwner.ino = privateDirectory(root).ino;
    assert(Buffer.byteLength(join(root, 'control.sock')) <= 103);
    resources.shortRoot = root;
    record(evidence, 'ownership-before-native', {
      root,
      ino: rootOwner.ino,
      uid: process.getuid?.(),
      socketBytes: Buffer.byteLength(join(root, 'control.sock')),
      seedHash,
      descriptorHash: descriptor.sha256,
    });
    const f = await finiteFixture(root, descriptor.path, seed);
    const initial = await storeView(f);
    record(evidence, 'logical-before', initial);
    const full = fixtureKind === 'stale_cursor' ? await oracle(f) : undefined;
    const empty = fixtureKind === 'empty_v2' ? await emptyOracle(f) : undefined;
    if (full) record(evidence, 'oracle-before', full);
    if (empty) record(evidence, 'empty-oracle', empty);
    const privacy = full?.privateValues ??
      empty?.privateValues ?? [
        key,
        selected,
        root,
        'PRIVATE-GRH-REQ-',
        'PRIVATE-GRH-POLICY',
        'PRIVATE-GRH-SCOPE',
      ];
    const api = await receiver(register);
    const phase =
      kind === 'bounded' || kind === 'cancel'
        ? new HistoryPhaseDecoder()
        : undefined;
    session = await openSDK(
      phase
        ? [
            'tests/fixtures/get-retry-history-sdk-child.ts',
            '--mode',
            kind,
            '--control-root',
            root,
          ]
        : [
            cli,
            '--submission-policy',
            f.policyPath,
            '--submission-state',
            f.state,
          ],
      {
        PATH: '/usr/bin:/bin',
        HOME: f.home,
        TMPDIR: f.tmp,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        NO_COLOR: '1',
        SPEEDYINDEX_API_KEY: key,
        TEST_ACCOUNT_ORIGIN: api.origin,
        ...(phase
          ? {
              TEST_SUBMISSION_POLICY: f.policyPath,
              TEST_SUBMISSION_STATE: f.state,
            }
          : {}),
      },
      phase,
      register,
    );
    const activeSession = session;
    resources.child = session.receipt;
    resources.stage = 'SDK';
    record(
      evidence,
      'tools',
      advertised((await within(session.client.listTools())).tools),
    );
    let calls = 0;
    const call = async (input: Record<string, unknown>) => {
      const before = Date.now();
      const value = await within(
        activeSession.client.callTool({
          name: 'get_retry_history',
          arguments: input,
        }),
      );
      const after = Date.now();
      record(evidence, 'call-' + ++calls, { input, value, before, after });
      return { value, before, after };
    };
    let finalExpected = initial;
    if (kind === 'missing') {
      const blocked = await call({});
      fixedHistory(
        blocked.value,
        'blocked',
        'StateMissing',
        'The configured local state does not exist.',
        privacy,
      );
      assert(!existsSync(f.state));
      assert.deepEqual(await storeView(f), initial);
      timeline.push('blocked_owner_reply_settled_leaf_absent');
      const { initializeLedgerV2 } = await import('../src/submission-ledger');
      const writer = initializeLedgerV2({ stateDirectory: f.state });
      writer.close();
      timeline.push('explicit_new_only_v2_init_closed');
      finalExpected = await storeView(f);
      record(evidence, 'explicit-init-logical', finalExpected);
      const expected = await emptyOracle(f);
      const good = await call({});
      checkEmpty(good.value, expected, good.before, good.after);
      timeline.push('same_host_empty_reply');
    } else if (kind === 'v1') {
      for (let i = 0; i < 2; i++) {
        const r = await call({});
        fixedHistory(
          r.value,
          'blocked',
          'V2Required',
          'Retry history requires existing V2 local state.',
          privacy,
        );
        assert.deepEqual(await storeView(f), initial);
      }
      advertised((await within(session.client.listTools())).tools);
    } else if (kind === 'empty_v2') {
      assert(empty);
      for (let i = 0; i < 2; i++) {
        const r = await call({});
        checkEmpty(r.value, empty, r.before, r.after);
        assert.deepEqual(await storeView(f), initial);
      }
    } else if (kind === 'stale_cursor') {
      assert(full);
      const r = await call({ limit: 2 });
      const first = checkOk(r.value, full, { limit: 2 }, 0, r.before, r.after);
      assert(first.nextCursor);
      assert.deepEqual(await storeView(f), initial);
      timeline.push('page1_owner_reply_settled_SQL_equal');
      await ordinaryFixtureWrite(f);
      timeline.push('ordinary_selected_key_writer_committed_closed');
      const changed = await oracle(f);
      assert(initial.kind === 'v2');
      accountOrdinaryCommit(initial.logical, changed.before);
      assert.notEqual(changed.revision, full.revision);
      assert.deepEqual(changed.entries, full.entries);
      record(evidence, 'ordinary-writer-oracle', changed);
      const mismatch = await call({
        limit: 2,
        searchEngine: 'google',
        cursor: first.nextCursor,
      });
      fixedHistory(
        mismatch.value,
        'error',
        'CursorMismatch',
        'The cursor does not match this history query.',
        privacy,
      );
      const stale = await call({ limit: 2, cursor: first.nextCursor });
      fixedHistory(
        stale.value,
        'error',
        'SnapshotChanged',
        'Local history changed. Start a new history query.',
        privacy,
      );
      const fresh = await call({ limit: 2 });
      checkOk(fresh.value, changed, { limit: 2 }, 0, fresh.before, fresh.after);
      finalExpected = { kind: 'v2', logical: changed.before };
      timeline.push(
        'query_mismatch_then_snapshot_changed_then_fresh_same_host',
      );
    } else {
      assert(phase && full);
      await phase.waitFor({ event: 'BOOT_READY' });
      const control = await controlSocket(root, phase, register);
      resources.control = control.receipt;
      const baseline = await control.barrier();
      assert.deepEqual(
        [
          baseline.handlerEntries,
          baseline.nativeReads,
          baseline.nativeCloses,
          baseline.budgetSettlements,
          baseline.httpAttempts,
        ],
        [0, 0, 0, 0, 0],
      );
      if (kind === 'bounded') {
        const r = await call({});
        resources.envelopeBytes = fixedHistory(
          r.value,
          'error',
          'ResourceLimitExceeded',
          'Retry history exceeded a resource limit.',
          privacy,
          1_024,
        );
        for (const event of ['NATIVE_CLOSED', 'BUDGET_CLOSED'] as const)
          await phase.waitFor({ event, operation: 1 });
        assert.deepEqual(
          await phase.waitFor({ event: 'OWNER_SETTLED', operation: 1 }),
          {
            event: 'OWNER_SETTLED',
            operation: 1,
            aborted: false,
            status: 'error',
            code: 'ResourceLimitExceeded',
          },
        );
      } else {
        const cancelled = session.client
          .callTool(
            { name: 'get_retry_history', arguments: {} },
            { signal: controller.signal },
          )
          .then(
            (value) => ({ state: 'resolved' as const, value }),
            () => ({ state: 'rejected' as const }),
          );
        calls++;
        await phase.waitFor({ event: 'NATIVE_CLOSED', operation: 1 });
        await phase.waitFor({ event: 'READ_IO_HELD', operation: 1 });
        timeline.push('native_closed1_and_real_IO_held1');
        const requests = session.sent.filter((r) => r.method === 'tools/call');
        assert.equal(requests.length, 1);
        const request = requests[0]!;
        assert(request.requestId !== null && request.flushed);
        resources.cancelledRequestId = request.requestId;
        controller.abort();
        timeline.push('SDK_signal_abort_requested');
        const flush = await session.cancellationFlushed(request.requestId);
        assert.equal(flush.method, 'notifications/cancelled');
        timeline.push('actual_cancellation_frame_flushed');
        await phase.waitFor({ event: 'SIGNAL_ABORTED', operation: 1 });
        timeline.push('actual_server_SIGNAL_ABORTED1');
        await control.releaseReadIO();
        timeline.push('finite_RELEASE_READ_IO1_flushed');
        await phase.waitFor({ event: 'BUDGET_CLOSED', operation: 1 });
        assert.deepEqual(
          await phase.waitFor({ event: 'OWNER_SETTLED', operation: 1 }),
          {
            event: 'OWNER_SETTLED',
            operation: 1,
            aborted: true,
            status: 'error',
            code: 'Cancelled',
          },
        );
        timeline.push('budget_closed1_and_post_super_Cancelled_owner1');
        const clientOutcome = await within(cancelled);
        if (clientOutcome.state === 'resolved')
          fixedHistory(
            clientOutcome.value,
            'error',
            'Cancelled',
            'Retry history was cancelled.',
            privacy,
          );
        record(evidence, 'cancelled-client', {
          requestId: request.requestId,
          outcome: clientOutcome,
          cancellationFrame: flush,
        });
        const noSuccess = () => {
          for (const raw of activeSession.wire) {
            const frame = object(raw);
            if (frame.id === request.requestId && frame.result !== undefined) {
              const result = object(frame.result);
              assert.equal(result.isError, true);
              if (result.structuredContent !== undefined)
                fixedHistory(
                  result,
                  'error',
                  'Cancelled',
                  'Retry history was cancelled.',
                  privacy,
                );
            }
          }
        };
        noSuccess();
        timeline.push('same_host_recovery_call2');
        const good = await call({});
        checkOk(good.value, full, {}, 0, good.before, good.after);
        for (const event of ['NATIVE_CLOSED', 'BUDGET_CLOSED'] as const)
          await phase.waitFor({ event, operation: 2 });
        assert.deepEqual(
          await phase.waitFor({ event: 'OWNER_SETTLED', operation: 2 }),
          {
            event: 'OWNER_SETTLED',
            operation: 2,
            aborted: false,
            status: 'ok',
            code: null,
          },
        );
        timeline.push('native_budget_post_super_ok_owner2');
        noSuccess();
      }
      const final = await control.barrier();
      const operations = kind === 'cancel' ? 2 : 1;
      assert.deepEqual(
        [
          final.handlerEntries,
          final.nativeReads,
          final.nativeCloses,
          final.budgetSettlements,
          final.httpAttempts,
        ],
        [operations, operations, operations, operations, 0],
      );
      record(evidence, 'observations', {
        baseline,
        final,
        phases: phase.events,
        timeline,
      });
      await control.close();
      assert(control.receipt.closed);
    }
    const after = await storeView(f);
    assert.deepEqual(after, finalExpected);
    record(evidence, 'logical-after', after);
    assert.deepEqual(api.requests, []);
    assert.equal(guard.attempts(), 0);
    await session.close();
    phase?.finish();
    if (!phase) assert.equal(session.stderr(), '');
    if (kind === 'cancel') {
      const id = resources.cancelledRequestId;
      const replies = session.wire.filter((v) => object(v).id === id);
      for (const value of replies) {
        const reply = object(value);
        if (reply.result !== undefined)
          fixedHistory(
            reply.result,
            'error',
            'Cancelled',
            'Retry history was cancelled.',
            privacy,
          );
      }
      resources.cancelledResponseFrames = replies.length;
    }
    await api.close();
    assert(!existsSync(join(root, 'control.sock')));
    assert.deepEqual(api.requests, []);
    assert.equal(guard.attempts(), 0);
    assert.equal(hash(readFileSync(seed)), seedHash);
    assert.equal(hash(readFileSync(descriptor.path)), descriptor.sha256);
    record(evidence, 'wire', { received: session.wire, sent: session.sent });
    resources.calls = calls;
    resources.logicalEquality = true;
    resources.historyHTTPArrivals = api.requests.length;
    resources.parentHTTPAttempts = guard.attempts();
    resources.controlPathAbsent = true;
    resources.stderr = session.stderr();
    resources.timeline = timeline;
    resources.stage = 'owners_closed';
    success = true;
  } finally {
    const cleanup = await Promise.allSettled(
      closers.reverse().map((close) => close()),
    );
    guard.restore();
    if (success && cleanup.every((r) => r.status === 'fulfilled')) {
      removeOwnedRoot();
      resources.ownedRootRemoved = true;
      resources.stage = 'settled';
      record(evidence, 'receipt', { result: 'passed', ...resources });
    } else {
      if (session)
        record(evidence, 'failed-wire', {
          received: session.wire,
          sent: session.sent,
          stderr: session.stderr(),
        });
      record(evidence, 'failure-resources', {
        ...resources,
        cleanup: cleanup.map((r) => r.status),
        preservedRoot: rootOwner.path ?? null,
      });
    }
    assert(
      cleanup.every((r) => r.status === 'fulfilled'),
      'Owned S2 fixture cleanup failed.',
    );
  }
}
export async function verifyRetryHistoryFiniteSdk(
  kind: FiniteCase,
  entry: HistoryCLIEntry = 'src/cli.ts',
) {
  await s2Journey(kind, entry);
}
export async function verifyRetryHistoryBoundedSdk() {
  await s2Journey('bounded');
}
export async function verifyRetryHistoryCancellationSdk() {
  await s2Journey('cancel');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--s2-preparation') {
    await s2Preparation(args[1]!);
  } else if (args.length === 5 && args[0] === '--prepare-finite-fixture') {
    const guard = denyHTTP();
    const root = args[3]!;
    const ownership = privateDirectory(root);
    try {
      const kind = readFinite(args[1]!);
      const f = await finiteFixture(root, args[1]!, args[2]!);
      const view = await storeView(f);
      const expected =
        kind === 'empty_v2'
          ? await emptyOracle(f)
          : kind === 'stale_cursor'
            ? await oracle(f)
            : null;
      record(args[4]!, 'finite-native-preparation', {
        kind,
        view,
        oracle: expected,
        HTTP: guard.attempts(),
        nativeHandlesClosed: true,
      });
      assert.equal(guard.attempts(), 0);
      assert.equal(privateDirectory(root).ino, ownership.ino);
      rmSync(root, { recursive: true });
      assert(!existsSync(root));
      console.log(
        JSON.stringify({
          event: 'HISTORY_FINITE_FIXTURE_OK',
          kind,
          nativeHandlesClosed: true,
          ownedRootRemoved: true,
          HTTP: 0,
        }),
      );
    } finally {
      guard.restore();
    }
  } else if (args.length === 2 && args[0] === '--fixture-sanity') {
    const rows = readSeed(args[1]!);
    console.log(
      JSON.stringify({
        event: 'HISTORY_SEED_SHAPE_OK',
        rows: rows.length,
        sha256: hash(readFileSync(args[1]!)),
        SDK: 0,
        native: 0,
        sockets: 0,
        HTTP: 0,
      }),
    );
  } else if (args.length === 4 && args[0] === '--prepare-fixture') {
    const guard = denyHTTP();
    try {
      const f = await seedFixture(args[2]!, args[1]!),
        o = await oracle(f);
      record(args[3]!, 'native-preparation', {
        event: 'HISTORY_GENUINE_SEED_OK',
        root: f.root,
        revision: o.revision,
        selectedRetries: o.entries.length,
        rows: o.rows,
        logical: o.before,
        parentHTTPAttempts: guard.attempts(),
      });
      assert.equal(guard.attempts(), 0);
      rmSync(f.root, { recursive: true });
      assert(!existsSync(f.root));
      console.log(
        JSON.stringify({
          event: 'HISTORY_GENUINE_SEED_OK',
          selectedRetries: 7,
          otherKeyRetries: 1,
          migratedLegacy: 1,
          nativeHandlesClosed: true,
          ownedRootRemoved: true,
          HTTP: 0,
        }),
      );
    } finally {
      guard.restore();
    }
  } else throw new Error('Invalid history helper preparation entry.');
}
