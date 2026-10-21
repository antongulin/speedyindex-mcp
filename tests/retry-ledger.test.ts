import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database, constants, SQLiteError } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  composeVerifiedRetryAdmission,
  computeRetryPlanFingerprint,
  type RetryProof,
  type RetrySelection,
  type RetryCollection,
  type RetryPlanFingerprintInput,
  initializeLedger,
  initializeLedgerV2,
  migrateLedgerV2,
  LedgerMigrationError,
  openLedger,
  openRetryLedgerV2,
  RetryLedgerError,
  readRetrySnapshot,
  readRetryPlanningState,
  readRetryReplay,
  type RetryPlanningInput,
  type RetryReplayIdentity,
  type IntentView,
  SubmissionLedgerError,
  type PrepareIntentInput,
  type SubmissionLedger,
  type PrepareRetryIntentInput,
  type RetryPrepareHooks,
  type RetrySubmissionLedger,
  type DispatchCapability,
  type DispatchOutcomeToken,
  type RetryLedgerPhase,
} from '../src/submission-ledger';
import {
  type AvailableRetrySnapshot,
  type SnapshotReadHooks,
} from '../src/retry-ledger-snapshot';

import {
  fixtureRetryConfiguration,
  fixtureRetryEvidence,
  fixtureRetryVerifier,
  retryFixtureUtc,
  retryFixtureBinding,
} from './fixtures/retry-verifier';
import type { SubmissionPolicy } from '../src/submission-policy';

const binding = 'a'.repeat(64);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function input(requestId = 'synthetic-request'): PrepareIntentInput {
  return {
    requestId,
    budget: {
      credentialFingerprint: binding,
      budgetScope: 'synthetic',
      periodId: 'one',
      periodStartMs: 1000,
      policyRevision: 'synthetic',
      policyDigest: hash('policy'),
      caps: { tokens: 100, indexer: 100, checker: 100 },
    },
    taskFamily: 'google/indexer',
    providerRoute: '/v2/task/google/indexer/create',
    payloadDigest: hash('payload'),
    quoteVersion: 'synthetic',
    quoteFingerprint: hash('quote'),
    submittedUrls: ['https://example.test/Case?q=1', 'https://example.test/é/'],
    reservation: { tokens: 3, indexer: 2, checker: 1 },
  };
}

function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'speedyindex-retry-ledger-'),
  );
  const handles: { close(): void }[] = [];
  // Register cleanup before any init/open/fixture write. Preserve the tree on close failure.
  const cleanup = (removeRoot = true) => {
    const failures: unknown[] = [];
    for (const handle of handles.reverse()) {
      try {
        handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Fixture close failed.');
    if (removeRoot) rmSync(root, { recursive: true });
  };
  const track = <T extends { close(): void }>(handle: T) => {
    handles.push(handle);
    return handle;
  };
  const raw = (directory: string) =>
    track(
      new Database(
        join(directory, 'ledger.sqlite'),
        constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
      ),
    );
  const init = (directory: string, version: 1 | 2 = 2) =>
    track(
      (version === 1 ? initializeLedger : initializeLedgerV2)({
        stateDirectory: directory,
      }),
    );
  const open = (directory: string) =>
    track(openLedger({ stateDirectory: directory }));
  return { root, cleanup, track, raw, init, open };
}
function expectUnavailable(operation: () => unknown) {
  expectLedgerError(operation, 'LedgerUnavailable');
}
function expectLedgerError(
  operation: () => unknown,
  code: SubmissionLedgerError['code'],
) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SubmissionLedgerError);
  expect((caught as SubmissionLedgerError).code).toBe(code);
  expect((caught as SubmissionLedgerError).message).toBe(
    new SubmissionLedgerError(code).message,
  );
}
function snapshot(database: Database) {
  // Independent logical projection, including private ownership fields and sequence.
  return {
    version: database.query('PRAGMA user_version').get(),
    schema: database
      .query(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
      )
      .all(),
    periods: database
      .query(
        'SELECT * FROM budget_periods ORDER BY credential_fp, budget_scope, period_id',
      )
      .all(),
    intents: database
      .query('SELECT * FROM intents ORDER BY credential_fp, request_id')
      .all(),
    urls: database
      .query(
        'SELECT * FROM intent_urls ORDER BY credential_fp, request_id, ordinal',
      )
      .all(),
    events: database
      .query('SELECT * FROM intent_events ORDER BY event_id')
      .all(),
    sequence: database
      .query('SELECT * FROM sqlite_sequence ORDER BY name')
      .all(),
    meta: database
      .query('SELECT * FROM retry_ledger_meta ORDER BY singleton')
      .all(),
    contexts: database
      .query('SELECT * FROM intent_context ORDER BY credential_fp, request_id')
      .all(),
  };
}
function newIntent(ledger: SubmissionLedger, value = input()) {
  const prepared = ledger.prepareIntent(value);
  expect(prepared.kind).toBe('created');
  if (prepared.kind !== 'created')
    throw new Error('Expected synthetic creator.');
  return prepared;
}
function makeRetryContext(database: Database, parent = ' Parent-é-🧪 ') {
  database
    .query(
      `UPDATE intent_context SET origin_kind = 'retry',
    parent_family = 'google/indexer', parent_task_id = ?, source_manifest_digest = ?, plan_fingerprint = ?`,
    )
    .run(parent, hash('manifest'), hash('plan'));
}

function replaceContextSchema(
  database: Database,
  transform: (sql: string) => string,
  origin = 'standalone',
) {
  const table = database
    .query("SELECT sql FROM sqlite_schema WHERE name = 'intent_context'")
    .get() as { sql: string };
  const index = database
    .query(
      "SELECT sql FROM sqlite_schema WHERE name = 'intent_context_parent_idx'",
    )
    .get() as { sql: string };
  database.run('DROP TABLE intent_context');
  database.run(transform(table.sql));
  database.run(index.sql);
  database
    .query(
      `INSERT INTO intent_context (credential_fp, request_id, origin_kind)
    SELECT credential_fp, request_id, ? FROM intents`,
    )
    .run(origin);
}

test('V2-01 init/open: additive exact schema, private new-only state, V1 unchanged', () => {
  const f = fixture();
  try {
    const v1 = join(f.root, 'v1');
    const v2 = join(f.root, 'v2');
    f.init(v1, 1).close();
    f.init(v2).close();
    const first = f.raw(v1);
    const second = f.raw(v2);
    expect(first.query('PRAGMA user_version').get()).toEqual({
      user_version: 1,
    });
    expect(second.query('PRAGMA user_version').get()).toEqual({
      user_version: 2,
    });
    const coreObjects = first
      .query<{ type: string; name: string; sql: string }, []>(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all();
    const v2Objects = second
      .query(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(
      v2Objects.filter(
        (row) =>
          ![
            'retry_ledger_meta',
            'intent_context',
            'intent_context_parent_idx',
            'intents_provider_ref_idx',
          ].includes(row.name),
      ),
    ).toEqual(coreObjects);
    expect(v2Objects).toHaveLength(coreObjects.length + 4);
    for (const [table, index] of [
      ['intents', 'intents_provider_ref_idx'],
      ['intent_context', 'intent_context_parent_idx'],
    ]) {
      const rows = second.query(`PRAGMA index_list(${table})`).all() as {
        name: string;
        unique: number;
      }[];
      expect(rows.find((row) => row.name === index)?.unique).toBe(0);
    }
    const meta = second.query('SELECT * FROM retry_ledger_meta').all() as {
      singleton: number;
      ledger_id: string;
    }[];
    expect(meta).toHaveLength(1);
    expect(meta[0]!.singleton).toBe(1);
    expect(meta[0]!.ledger_id).toMatch(/^[0-9a-f]{64}$/);
    expect(second.query('SELECT * FROM intent_context').all()).toEqual([]);
    expect(lstatSync(v2).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(v2, 'ledger.sqlite')).mode & 0o777).toBe(0o600);
    const before = snapshot(second);
    const inode = lstatSync(join(v2, 'ledger.sqlite')).ino;
    for (const init of [initializeLedger, initializeLedgerV2])
      expectUnavailable(() => init({ stateDirectory: v2 }));
    expect(snapshot(second)).toEqual(before);
    expect(lstatSync(join(v2, 'ledger.sqlite')).ino).toBe(inode);
    f.open(v1).close();
    f.open(v2).close();
    expect(snapshot(second)).toEqual(before);
    const other = join(f.root, 'other');
    f.init(other).close();
    expect(
      f.raw(other).query('SELECT ledger_id FROM retry_ledger_meta').get(),
    ).not.toEqual({ ledger_id: meta[0]!.ledger_id });
  } finally {
    f.cleanup();
  }
});

const corruptions: [string, (db: Database) => void][] = [
  ['version zero', (db) => db.run('PRAGMA user_version = 0')],
  ['future version three', (db) => db.run('PRAGMA user_version = 3')],
  ['V2 objects labelled V1', (db) => db.run('PRAGMA user_version = 1')],
  ['missing table', (db) => db.run('DROP TABLE intent_context')],
  [
    'missing parent index',
    (db) => db.run('DROP INDEX intent_context_parent_idx'),
  ],
  [
    'extra index',
    (db) => db.run('CREATE INDEX foreign_index ON intents (request_id)'),
  ],
  [
    'extra view',
    (db) =>
      db.run('CREATE VIEW foreign_view AS SELECT request_id FROM intents'),
  ],
  [
    'extra trigger',
    (db) =>
      db.run(
        'CREATE TRIGGER foreign_trigger AFTER INSERT ON intents BEGIN SELECT 1; END',
      ),
  ],
  [
    'wrong CHECK literal',
    (db) => {
      replaceContextSchema(
        db,
        (sql) => sql.replaceAll("'standalone'", "'Standalone'"),
        'Standalone',
      );
    },
  ],
  [
    'missing context foreign key',
    (db) =>
      replaceContextSchema(db, (sql) =>
        sql.replace(
          /FOREIGN KEY \(credential_fp, request_id\)\s+REFERENCES intents \(credential_fp, request_id\),/,
          '',
        ),
      ),
  ],
  ['missing meta', (db) => db.run('DELETE FROM retry_ledger_meta')],
  [
    'invalid meta identity',
    (db) => {
      db.run('PRAGMA ignore_check_constraints = ON');
      db.run("UPDATE retry_ledger_meta SET ledger_id = 'invalid'");
    },
  ],
  [
    'duplicate meta',
    (db) => {
      db.run('PRAGMA ignore_check_constraints = ON');
      db.query('INSERT INTO retry_ledger_meta VALUES (2, ?)').run(
        hash('second'),
      );
    },
  ],
  ['missing context', (db) => db.run('DELETE FROM intent_context')],
  [
    'orphan context',
    (db) =>
      db
        .query(
          "INSERT INTO intent_context (credential_fp, request_id, origin_kind) VALUES (?, 'orphan', 'standalone')",
        )
        .run(binding),
  ],
  [
    'nonretry metadata',
    (db) => {
      db.run('PRAGMA ignore_check_constraints = ON');
      db.run("UPDATE intent_context SET parent_task_id = 'unexpected'");
    },
  ],
  [
    'retry missing digest',
    (db) => {
      makeRetryContext(db);
      db.run('PRAGMA ignore_check_constraints = ON');
      db.run('UPDATE intent_context SET plan_fingerprint = NULL');
    },
  ],
  [
    'retry wrong child family',
    (db) => {
      makeRetryContext(db);
      db.run("UPDATE intent_context SET parent_family = 'yandex/indexer'");
    },
  ],
  ['retry blank Unicode parent', (db) => makeRetryContext(db, '\u2003')],
  ['retry unsafe parent', (db) => makeRetryContext(db, 'unsafe\nparent')],
  ['retry too large parent', (db) => makeRetryContext(db, 'é'.repeat(2049))],
  ['missing URL', (db) => db.run('DELETE FROM intent_urls')],
  [
    'gapped URL sequence',
    (db) => db.run('UPDATE intent_urls SET ordinal = ordinal + 10'),
  ],
  [
    'duplicate exact URL',
    (db) =>
      db.run(
        "UPDATE intent_urls SET url_text = 'https://example.test/duplicate'",
      ),
  ],
  ['missing prepared event', (db) => db.run('DELETE FROM intent_events')],
  [
    'duplicate prepared event',
    (db) =>
      db.run(`INSERT INTO intent_events (credential_fp, request_id, state_version, event_kind, occurred_at_ms)
    SELECT credential_fp, request_id, state_version, event_kind, occurred_at_ms FROM intent_events`),
  ],
  [
    'orphan event',
    (db) => db.run("UPDATE intent_events SET request_id = 'orphan'"),
  ],
  [
    'period mismatch',
    (db) => db.run('UPDATE intents SET period_start_ms = period_start_ms + 1'),
  ],
];
for (const [name, corrupt] of corruptions) {
  test(`V2-01 tamper: ${name} fails closed without repair`, () => {
    const f = fixture();
    try {
      const state = join(f.root, 'state');
      const ledger = f.init(state);
      newIntent(ledger);
      ledger.close();
      const db = f.raw(state);
      corrupt(db);
      // Capture after intentional corruption; normal open must not rewrite any logical data.
      const before = snapshotWithMissingTables(db);
      const inode = lstatSync(join(state, 'ledger.sqlite')).ino;
      expectUnavailable(() => f.open(state));
      // V2-05 reuses this real corruption matrix at the new aggregate boundary.
      expect(readRetrySnapshot({ stateDirectory: state }, binding)).toEqual({
        availability: 'unavailable',
        reason: 'InvalidState',
      });
      expect(snapshotWithMissingTables(db)).toEqual(before);
      expect(lstatSync(join(state, 'ledger.sqlite')).ino).toBe(inode);
    } finally {
      f.cleanup();
    }
  });
}
function snapshotWithMissingTables(database: Database) {
  const schema = database
    .query('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name')
    .all();
  const tables = database
    .query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return {
    version: database.query('PRAGMA user_version').get(),
    schema,
    // All names here come only from this fixture's known schema, never operator data.
    data: tables.map(({ name }) => [
      name,
      database.query(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  };
}

test('V2-01 paths: missing/partial state, aliases and unsafe modes preserve owned sentinels', () => {
  const f = fixture();
  try {
    const missing = join(f.root, 'missing');
    expectUnavailable(() => f.open(missing));
    expect(existsSync(missing)).toBe(false);
    const empty = join(f.root, 'empty');
    mkdirSync(empty, { mode: 0o700 });
    expectUnavailable(() => f.open(empty));
    expect(existsSync(join(empty, 'ledger.sqlite'))).toBe(false);
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('synthetic truncated file'),
    ]) {
      const state = join(f.root, `partial-${bytes.length}`);
      mkdirSync(state, { mode: 0o700 });
      const path = join(state, 'ledger.sqlite');
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      const inode = lstatSync(path).ino;
      expectUnavailable(() => f.open(state));
      expect(readFileSync(path)).toEqual(bytes);
      expect(lstatSync(path).ino).toBe(inode);
    }
    const state = join(f.root, 'valid');
    f.init(state).close();
    const path = join(state, 'ledger.sqlite');
    const before = readFileSync(path);
    const alias = join(f.root, 'alias');
    symlinkSync(state, alias);
    expectUnavailable(() => initializeLedgerV2({ stateDirectory: alias }));
    expectUnavailable(() => f.open(alias));
    const linkedState = join(f.root, 'hardlinked');
    mkdirSync(linkedState, { mode: 0o700 });
    const hardlink = join(linkedState, 'ledger.sqlite');
    linkSync(path, hardlink);
    expectUnavailable(() => f.open(linkedState));
    expectUnavailable(() =>
      initializeLedgerV2({ stateDirectory: linkedState }),
    );
    rmSync(hardlink);
    chmodSync(path, 0o644);
    expectUnavailable(() => f.open(state));
    chmodSync(path, 0o600);
    chmodSync(state, 0o755);
    expectUnavailable(() => f.open(state));
    chmodSync(state, 0o700);
    const unsafeParent = join(f.root, 'unsafe-parent');
    mkdirSync(unsafeParent, { mode: 0o777 });
    chmodSync(unsafeParent, 0o777);
    const unsafeLeaf = join(unsafeParent, 'new');
    expectUnavailable(() => initializeLedgerV2({ stateDirectory: unsafeLeaf }));
    expect(existsSync(unsafeLeaf)).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

test('V2-01/08 ordinary: atomic standalone, exact replay, immutable legacy and retry mode conflict', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const prepared = newIntent(ledger);
    const db = f.raw(state);
    expect(db.query('SELECT * FROM intent_context').all()).toEqual([
      {
        credential_fp: binding,
        request_id: input().requestId,
        origin_kind: 'standalone',
        parent_family: null,
        parent_task_id: null,
        source_manifest_digest: null,
        plan_fingerprint: null,
      },
    ]);
    expect(
      db.query('SELECT url_text FROM intent_urls ORDER BY ordinal').all(),
    ).toEqual(input().submittedUrls.map((url_text) => ({ url_text })));
    const standalone = snapshot(db);
    const replayInput = {
      ...input(),
      budget: { ...input().budget, periodId: 'later', periodStartMs: 2000 },
    };
    expect(ledger.prepareIntent(replayInput)).toEqual({
      kind: 'replay',
      intent: prepared.intent,
    });
    expect(snapshot(db)).toEqual(standalone);
    ledger.close();
    db.run("UPDATE intent_context SET origin_kind = 'legacy_unattributed'");
    const reopened = f.open(state);
    const legacy = snapshot(db);
    expect(reopened.prepareIntent(replayInput)).toEqual({
      kind: 'replay',
      intent: prepared.intent,
    });
    expect(snapshot(db)).toEqual(legacy);
    reopened.close();
    makeRetryContext(db);
    const retry = snapshot(db);
    const retryLedger = f.open(state);
    expectLedgerError(
      () => retryLedger.prepareIntent(input()),
      'RequestIdConflict',
    );
    expect(snapshot(db)).toEqual(retry);
    expect(db.query('SELECT parent_task_id FROM intent_context').get()).toEqual(
      { parent_task_id: ' Parent-é-🧪 ' },
    );
  } finally {
    f.cleanup();
  }
});

test('V2-08 ordinary: context insertion failure rolls back core, URLs, event, period and reservations', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    // Deliberate post-open SQL fault at the new relation insert, after the core/event inserts.
    db.run(`CREATE TRIGGER synthetic_context_failure BEFORE INSERT ON intent_context
      BEGIN SELECT RAISE(ABORT, 'synthetic context insertion failure'); END`);
    const before = snapshot(db);
    expectUnavailable(() => ledger.prepareIntent(input()));
    expect(snapshot(db)).toEqual(before);
    db.run('DROP TRIGGER synthetic_context_failure');
    const fullBudget = {
      ...input(),
      budget: { ...input().budget, caps: { ...input().reservation } },
    };
    newIntent(ledger, fullBudget);
    ledger.close();
    f.open(state).close();
    expect(db.query('SELECT origin_kind FROM intent_context').all()).toEqual([
      { origin_kind: 'standalone' },
    ]);
    expect(db.query('SELECT event_kind FROM intent_events').all()).toEqual([
      { event_kind: 'prepared' },
    ]);
    expect(db.query('SELECT * FROM intent_urls').all()).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});

for (const version of [1, 2] as const) {
  for (const method of ['prepare', 'claim', 'cancel', 'outcome'] as const) {
    test(`V2-08 version guard: opened V${version} ${method} cannot mutate changed version`, () => {
      const f = fixture();
      try {
        const state = join(f.root, 'state');
        const ledger = f.init(state, version);
        const prepared = newIntent(ledger);
        const claim =
          method === 'outcome'
            ? ledger.claimDispatch(prepared.dispatchCapability, 0)
            : null;
        if (claim && claim.kind !== 'claimed')
          throw new Error('Expected synthetic claim.');
        const operation = (target: SubmissionLedger) => {
          if (method === 'prepare')
            return target.prepareIntent(input('another'));
          if (method === 'claim')
            return target.claimDispatch(prepared.dispatchCapability, 0);
          if (method === 'cancel')
            return target.cancelPrepared(binding, input().requestId, 0);
          if (!claim || claim.kind !== 'claimed')
            throw new Error('Missing synthetic claim.');
          return target.recordDispatchOutcome({
            credentialFingerprint: binding,
            requestId: input().requestId,
            expectedStateVersion: 1,
            outcomeToken: claim.outcomeToken,
            outcome: { kind: 'unknown' },
          });
        };
        const db = f.raw(state);
        db.run(`PRAGMA user_version = ${version === 1 ? 2 : 3}`);
        const before =
          version === 2 ? snapshot(db) : snapshotWithMissingTables(db);
        expectUnavailable(() => operation(ledger));
        expect(
          version === 2 ? snapshot(db) : snapshotWithMissingTables(db),
        ).toEqual(before);
        db.run(`PRAGMA user_version = ${version}`);
        expectUnavailable(() => operation(ledger));
        ledger.close();
        const reopened = f.open(state);
        if (method === 'prepare') {
          expectLedgerError(() => operation(reopened), 'UrlOverlap');
        } else {
          const result = operation(reopened);
          expect(result).toMatchObject(
            method === 'claim'
              ? { kind: 'claimed' }
              : method === 'cancel'
                ? { kind: 'cancelled' }
                : { state: 'unknown' },
          );
        }
      } finally {
        f.cleanup();
      }
    });
  }
}

test('V2-08 version guard: changed V2 ledger identity rejects preparation before any write', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    db.query('UPDATE retry_ledger_meta SET ledger_id = ?').run(
      hash('changed-ledger'),
    );
    const before = snapshot(db);
    expectUnavailable(() => ledger.prepareIntent(input()));
    expect(snapshot(db)).toEqual(before);
    ledger.close();
    newIntent(f.open(state));
  } finally {
    f.cleanup();
  }
});

test('V2-01 history: every ordinary state reopens with unchanged context and ownership', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    for (const kind of [
      'prepared',
      'dispatching',
      'cancelled',
      'accepted',
      'rejected',
      'unknown',
    ] as const) {
      const value = {
        ...input(kind),
        submittedUrls: [`https://example.test/${kind}`],
      };
      const prepared = newIntent(ledger, value);
      if (kind === 'prepared') continue;
      if (kind === 'cancelled') {
        expect(ledger.cancelPrepared(binding, kind, 0)).toEqual({
          kind: 'cancelled',
          stateVersion: 1,
        });
        continue;
      }
      const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
      if (claim.kind !== 'claimed')
        throw new Error('Expected synthetic claim.');
      if (kind !== 'dispatching')
        ledger.recordDispatchOutcome({
          credentialFingerprint: binding,
          requestId: kind,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome:
            kind === 'accepted'
              ? {
                  kind,
                  providerType: 'google/indexer',
                  providerTaskId: 'synthetic-ack',
                }
              : { kind },
        });
    }
    ledger.close();
    const db = f.raw(state);
    const before = snapshot(db);
    const reopened = f.open(state);
    for (const kind of [
      'prepared',
      'dispatching',
      'cancelled',
      'accepted',
      'rejected',
      'unknown',
    ] as const) {
      expect(reopened.readIntent(binding, kind)?.state).toBe(kind);
    }
    expect(
      db.query('SELECT DISTINCT origin_kind FROM intent_context').all(),
    ).toEqual([{ origin_kind: 'standalone' }]);
    expect(snapshot(db)).toEqual(before);
    reopened.close();
    // A same-count terminal history missing its dispatch transition must fail,
    // even though the individual event rows still satisfy their SQL CHECKs.
    db.run(
      "DELETE FROM intent_events WHERE request_id = 'accepted' AND state_version = 1",
    );
    db.run(`INSERT INTO intent_events (credential_fp, request_id, state_version, event_kind, occurred_at_ms)
      SELECT credential_fp, request_id, 0, 'prepared', created_at_ms FROM intents WHERE request_id = 'accepted'`);
    const corrupt = snapshot(db);
    expectUnavailable(() => f.open(state));
    expect(snapshot(db)).toEqual(corrupt);
  } finally {
    f.cleanup();
  }
});

test('V2-01 history: event order and ACK association are checked without rewriting either', () => {
  for (const fault of ['order', 'ack', 'self-parent'] as const) {
    const f = fixture();
    try {
      const state = join(f.root, 'state');
      const ledger = f.init(state);
      const prepared = newIntent(ledger);
      const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
      if (claim.kind !== 'claimed')
        throw new Error('Expected synthetic claim.');
      ledger.recordDispatchOutcome({
        credentialFingerprint: binding,
        requestId: input().requestId,
        expectedStateVersion: 1,
        outcomeToken: claim.outcomeToken,
        outcome: {
          kind: 'accepted',
          providerType: 'google/indexer',
          providerTaskId: 'synthetic-ack',
        },
      });
      ledger.close();
      const db = f.raw(state);
      if (fault === 'order')
        db.run(
          'UPDATE intent_events SET event_id = 100 WHERE state_version = 0',
        );
      if (fault === 'ack')
        db.run(
          "UPDATE intent_events SET provider_task_id = 'changed-ack' WHERE state_version = 2",
        );
      if (fault === 'self-parent') makeRetryContext(db, 'synthetic-ack');
      const before = snapshot(db);
      expectUnavailable(() => f.open(state));
      expect(readRetrySnapshot({ stateDirectory: state }, binding)).toEqual({
        availability: 'unavailable',
        reason: 'InvalidState',
      });
      expect(snapshot(db)).toEqual(before);
    } finally {
      f.cleanup();
    }
  }
});

test('V2-01 paths: unsafe sidecars and nonempty rollback journals fail before SQLite open', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    f.init(state).close();
    const path = join(state, 'ledger.sqlite');
    const before = readFileSync(path);
    const sentinel = join(f.root, 'sentinel');
    writeFileSync(sentinel, 'synthetic private sentinel', {
      mode: 0o600,
      flag: 'wx',
    });
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${path}${suffix}`;
      // Closing SQLite may retain empty WAL/SHM; remove only these owned fixtures
      // after all their handles closed, before creating the negative sentinel.
      if (existsSync(sidecar)) rmSync(sidecar);
      symlinkSync(sentinel, sidecar);
      expectUnavailable(() => f.open(state));
      expect(readFileSync(sentinel, 'utf8')).toBe('synthetic private sentinel');
      rmSync(sidecar);
    }
    const journal = `${path}-journal`;
    writeFileSync(journal, 'synthetic nonempty journal', {
      mode: 0o600,
      flag: 'wx',
    });
    const journalBefore = readFileSync(journal);
    expectUnavailable(() => f.open(state));
    expect(readFileSync(journal)).toEqual(journalBefore);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

test('V2-01 open: V1 labelled V2 is incomplete, not an implicit migration', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'v1');
    f.init(state, 1).close();
    const db = f.raw(state);
    db.run('PRAGMA user_version = 2');
    const before = snapshotWithMissingTables(db);
    expectUnavailable(() => f.open(state));
    expect(snapshotWithMissingTables(db)).toEqual(before);
    expect(
      db
        .query("SELECT name FROM sqlite_schema WHERE name = 'intent_context'")
        .get(),
    ).toBeNull();
  } finally {
    f.cleanup();
  }
});

function exactCoreRows(database: Database) {
  const result: Record<string, unknown[]> = {};
  // Independent full-column oracle; no production projection/hash helper reused.
  for (const table of [
    'budget_periods',
    'intents',
    'intent_urls',
    'intent_events',
    'sqlite_sequence',
  ]) {
    const columns = database.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
    }[];
    const select = columns.map(({ name, type }) =>
      type === 'INTEGER' || (table === 'sqlite_sequence' && name === 'seq')
        ? `CAST("${name}" AS TEXT) AS "${name}"`
        : `"${name}"`,
    );
    result[table] = database
      .query(
        `SELECT CAST(rowid AS TEXT) AS _rowid, ${select.join(', ')} FROM ${table} ORDER BY rowid`,
      )
      .all();
  }
  return result;
}
function expectMigrationError(
  operation: () => unknown,
  code: LedgerMigrationError['code'],
) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerMigrationError);
  expect((caught as LedgerMigrationError).code).toBe(code);
  expect((caught as LedgerMigrationError).message).toBe(
    new LedgerMigrationError(code).message,
  );
}
function expectV1Unchanged(
  database: Database,
  before: ReturnType<typeof exactCoreRows>,
) {
  expect(database.query('PRAGMA user_version').get()).toEqual({
    user_version: 1,
  });
  expect(
    database
      .query(
        "SELECT name FROM sqlite_schema WHERE name IN ('intent_context', 'retry_ledger_meta')",
      )
      .all(),
  ).toEqual([]);
  expect(exactCoreRows(database)).toEqual(before);
}

test('V2-02 migration: exact all-family/state/column/sequence preservation and retained ownership', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'v1');
    const backup = join(f.root, 'backup');
    const ledger = f.init(state, 1);
    const retainedPrepared: ReturnType<typeof newIntent>[] = [];
    const retainedDispatch: {
      value: PrepareIntentInput;
      token: Extract<
        ReturnType<SubmissionLedger['claimDispatch']>,
        { kind: 'claimed' }
      >['outcomeToken'];
    }[] = [];
    const originals: PrepareIntentInput[] = [];
    const families = [
      'google/indexer',
      'google/checker',
      'yandex/indexer',
      'yandex/checker',
      'bing/checker',
      'backlink/checker',
    ] as const;
    const states = [
      'prepared',
      'dispatching',
      'accepted',
      'rejected',
      'unknown',
      'cancelled',
    ] as const;
    for (const [fi, family] of families.entries()) {
      for (const [si, kind] of states.entries()) {
        const value: PrepareIntentInput = {
          ...input(`preserve-${fi}-${kind}`),
          taskFamily: family,
          providerRoute: `/v2/task/${family}/create`,
          budget: {
            ...input().budget,
            credentialFingerprint: (fi % 2 ? 'b' : 'a').repeat(64),
            budgetScope: `scope-${si % 2}`,
            caps: { tokens: 100000, indexer: 100000, checker: 100000 },
          },
          submittedUrls: [`https://example.test/${fi}/${kind}?Case=1#Exact`],
        };
        originals.push(value);
        const prepared = newIntent(ledger, value);
        if (kind === 'prepared') {
          retainedPrepared.push(prepared);
          continue;
        }
        if (kind === 'cancelled') {
          ledger.cancelPrepared(
            value.budget.credentialFingerprint,
            value.requestId,
            0,
          );
          continue;
        }
        const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
        if (claim.kind !== 'claimed')
          throw new Error('Expected synthetic retained claim.');
        if (kind === 'dispatching') {
          retainedDispatch.push({ value, token: claim.outcomeToken });
          continue;
        }
        ledger.recordDispatchOutcome({
          credentialFingerprint: value.budget.credentialFingerprint,
          requestId: value.requestId,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome:
            kind === 'accepted'
              ? { kind, providerType: family, providerTaskId: ' Legacy-é-ID ' }
              : { kind },
        });
      }
    }
    // V1 permits a duplicated accepted provider reference; migration must retain it.
    const duplicate = {
      ...originals[2]!,
      requestId: 'legacy-duplicate-ack',
      submittedUrls: ['https://example.test/legacy-duplicate'],
    };
    const dp = newIntent(ledger, duplicate);
    const dc = ledger.claimDispatch(dp.dispatchCapability, 0);
    if (dc.kind !== 'claimed')
      throw new Error('Expected synthetic duplicate claim.');
    ledger.recordDispatchOutcome({
      credentialFingerprint: binding,
      requestId: duplicate.requestId,
      expectedStateVersion: 1,
      outcomeToken: dc.outcomeToken,
      outcome: {
        kind: 'accepted',
        providerType: 'google/indexer',
        providerTaskId: ' Legacy-é-ID ',
      },
    });
    const bulk: PrepareIntentInput = {
      ...input('preserve-10000'),
      budget: { ...input().budget, budgetScope: 'bulk' },
      submittedUrls: Array.from(
        { length: 10000 },
        (_, i) => `https://example.test/bulk/${i}`,
      ),
    };
    bulk.submittedUrls = [
      'HTTP://Example.test/Case?x=1#Frag',
      'http://example.test/Case?x=1#frag',
      'https://example.test/path/',
      'https://example.test/é',
      ...bulk.submittedUrls.slice(4),
    ];
    originals.push(bulk);
    newIntent(ledger, bulk);
    const large = {
      ...input('near-safe-units'),
      budget: {
        ...input().budget,
        budgetScope: 'large',
        caps: {
          tokens: Number.MAX_SAFE_INTEGER,
          indexer: Number.MAX_SAFE_INTEGER,
          checker: Number.MAX_SAFE_INTEGER,
        },
      },
      reservation: {
        tokens: Number.MAX_SAFE_INTEGER,
        indexer: Number.MAX_SAFE_INTEGER - 1,
        checker: Number.MAX_SAFE_INTEGER - 2,
      },
    };
    large.submittedUrls = ['https://example.test/' + 'x'.repeat(9000)];
    newIntent(ledger, large);
    ledger.cancelPrepared(binding, large.requestId, 0);
    const later = {
      ...input('later-period'),
      budget: {
        ...input().budget,
        budgetScope: 'scope-0',
        periodId: 'two',
        periodStartMs: 2000,
        caps: { tokens: 100000, indexer: 100000, checker: 100000 },
      },
      submittedUrls: ['https://example.test/later'],
    };
    newIntent(ledger, later);
    ledger.close();
    const db = f.raw(state);
    db.run('UPDATE intent_events SET event_id = event_id + 9007199254740992');
    db.run('UPDATE sqlite_sequence SET seq = 9007199254745999');
    const before = exactCoreRows(db);
    expect((before.intent_events![0] as { event_id: string }).event_id).toBe(
      '9007199254740993',
    );
    expect((before.sqlite_sequence![0] as { seq: string }).seq).toBe(
      '9007199254745999',
    );
    const inode = lstatSync(join(state, 'ledger.sqlite')).ino;
    expect(
      migrateLedgerV2({ stateDirectory: state, backupDirectory: backup }),
    ).toEqual({ migrated: true, schemaVersion: 2, backupVerified: true });
    expect(exactCoreRows(db)).toEqual(before);
    expect(lstatSync(join(state, 'ledger.sqlite')).ino).toBe(inode);
    expect(
      db
        .query(
          'SELECT DISTINCT origin_kind, parent_family, parent_task_id, source_manifest_digest, plan_fingerprint FROM intent_context',
        )
        .all(),
    ).toEqual([
      {
        origin_kind: 'legacy_unattributed',
        parent_family: null,
        parent_task_id: null,
        source_manifest_digest: null,
        plan_fingerprint: null,
      },
    ]);
    expect(
      db.query('SELECT COUNT(*) AS count FROM intent_context').get(),
    ).toEqual({ count: before.intents!.length });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS count FROM intents WHERE task_family = 'google/indexer' AND provider_task_id = ' Legacy-é-ID '",
        )
        .get(),
    ).toEqual({ count: 2 });
    const manifest = JSON.parse(
      readFileSync(join(backup, 'backup-manifest.json'), 'utf8'),
    ) as { files: Record<string, { size: string; sha256: string }> };
    for (const [name, file] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(backup, name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        file.sha256,
      );
      expect(String(bytes.length)).toBe(file.size);
      expect(lstatSync(join(backup, name)).mode & 0o777).toBe(0o600);
    }
    expect(lstatSync(backup).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(backup, 'backup-manifest.json')).mode & 0o777).toBe(
      0o600,
    );
    const backupDb = f.raw(backup);
    expect(exactCoreRows(backupDb)).toEqual(before);
    expect(backupDb.query('PRAGMA user_version').get()).toEqual({
      user_version: 1,
    });
    const reopened = f.open(state);
    for (const original of originals) {
      const replay = reopened.prepareIntent(original);
      expect(replay.kind).toBe('replay');
      expect(replay).not.toHaveProperty('dispatchCapability');
    }
    expect(exactCoreRows(db)).toEqual(before);
    const cap = retainedPrepared[0]!.dispatchCapability;
    expect(reopened.claimDispatch(cap, 0).kind).toBe('claimed');
    expect(reopened.claimDispatch(cap, 0)).toEqual({ kind: 'lost' });
    const owned = retainedDispatch[0]!;
    const wrong = retainedDispatch[1]!;
    const outcomeInput = {
      credentialFingerprint: owned.value.budget.credentialFingerprint,
      requestId: owned.value.requestId,
      expectedStateVersion: 1,
      outcomeToken: wrong.token,
      outcome: { kind: 'unknown' as const },
    };
    expectLedgerError(
      () => reopened.recordDispatchOutcome(outcomeInput),
      'DispatchOutcomeClaimLost',
    );
    expect(
      reopened.recordDispatchOutcome({
        ...outcomeInput,
        outcomeToken: owned.token,
      }).state,
    ).toBe('unknown');
    expectLedgerError(
      () =>
        reopened.recordDispatchOutcome({
          ...outcomeInput,
          outcomeToken: owned.token,
        }),
      'DispatchOutcomeClaimLost',
    );
    expectLedgerError(
      () =>
        reopened.prepareIntent({
          ...input('overlap-after-migration'),
          budget: { ...input().budget, budgetScope: 'other-scope' },
          submittedUrls: originals[0]!.submittedUrls,
        }),
      'UrlOverlap',
    );
    for (const unit of ['tokens', 'indexer', 'checker'] as const) {
      let error: unknown;
      try {
        reopened.prepareIntent({
          ...later,
          requestId: `cap-${unit}`,
          submittedUrls: [`https://example.test/cap/${unit}`],
          budget: {
            ...later.budget,
            periodId: 'three',
            periodStartMs: 3000,
            caps: {
              tokens: 100000,
              indexer: 100000,
              checker: 100000,
              [unit]: 0,
            },
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SubmissionLedgerError);
      expect((error as SubmissionLedgerError).code).toBe('BudgetExceeded');
      expect((error as SubmissionLedgerError).unit).toBe(unit);
    }
  } finally {
    f.cleanup();
  }
});

test('V2-02 migration: new binary V1 handles fail closed after actual migration; already V2 creates no backup', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'v1');
    const ledger = f.init(state, 1);
    const original = newIntent(ledger);
    expect(
      migrateLedgerV2({
        stateDirectory: state,
        backupDirectory: join(f.root, 'backup'),
      }).migrated,
    ).toBe(true);
    expectUnavailable(() =>
      ledger.claimDispatch(original.dispatchCapability, 0),
    );
    const newBackup = join(f.root, 'unused-backup');
    const db = f.raw(state);
    const before = snapshot(db);
    expect(
      migrateLedgerV2({ stateDirectory: state, backupDirectory: newBackup }),
    ).toEqual({ migrated: false, schemaVersion: 2, reason: 'AlreadyV2' });
    expect(existsSync(newBackup)).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(
      f.open(state).claimDispatch(original.dispatchCapability, 0).kind,
    ).toBe('claimed');
  } finally {
    f.cleanup();
  }
});

for (const kind of [
  'missing-event',
  'gapped-url',
  'partial-v2',
  'foreign-index',
  'not-wal',
] as const) {
  test(`V2-03 audit: ${kind} fails before backup or DDL`, () => {
    const f = fixture();
    try {
      const state = join(f.root, 'v1');
      const ledger = f.init(state, 1);
      newIntent(ledger);
      ledger.close();
      const db = f.raw(state);
      if (kind === 'missing-event') db.run('DELETE FROM intent_events');
      if (kind === 'gapped-url')
        db.run('UPDATE intent_urls SET ordinal = ordinal + 10');
      if (kind === 'partial-v2') db.run('PRAGMA user_version = 2');
      if (kind === 'foreign-index')
        db.run('CREATE INDEX foreign_extra ON intents (request_id)');
      if (kind === 'not-wal') db.run('PRAGMA journal_mode = DELETE');
      const before = exactCoreRows(db);
      const backup = join(f.root, 'backup');
      expectMigrationError(
        () =>
          migrateLedgerV2({ stateDirectory: state, backupDirectory: backup }),
        'InvalidState',
      );
      expect(exactCoreRows(db)).toEqual(before);
      expect(existsSync(backup)).toBe(false);
      expect(db.query('PRAGMA user_version').get()).toEqual({
        user_version: kind === 'partial-v2' ? 2 : 1,
      });
    } finally {
      f.cleanup();
    }
  });
}

for (const lock of ['reader', 'writer'] as const) {
  test(`V2-03 checkpoint: real ${lock} prevents truncation and preserves V1`, () => {
    const f = fixture();
    try {
      const state = join(f.root, 'v1');
      const ledger = f.init(state, 1);
      const db = f.raw(state);
      const blocker = f.raw(state);
      f.track({
        close() {
          if (blocker.inTransaction) blocker.run('ROLLBACK');
        },
      });
      newIntent(ledger);
      blocker.run(lock === 'reader' ? 'BEGIN' : 'BEGIN IMMEDIATE');
      blocker.query('SELECT * FROM intents').all();
      if (lock === 'reader')
        newIntent(ledger, {
          ...input('newer-than-reader'),
          submittedUrls: ['https://example.test/newer'],
        });
      const before = exactCoreRows(db);
      const backup = join(f.root, 'backup');
      expectMigrationError(
        () =>
          migrateLedgerV2({ stateDirectory: state, backupDirectory: backup }),
        'LedgerBusy',
      );
      expectV1Unchanged(db, before);
      expect(existsSync(backup)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
}

test('V2-03 checkpoint: a commit in the checkpoint-to-lock gap stops before backup/DDL', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'v1');
    const ledger = f.init(state, 1);
    newIntent(ledger);
    const db = f.raw(state);
    const backup = join(f.root, 'backup');
    let calls = 0;
    let afterWriter: ReturnType<typeof exactCoreRows> | undefined;
    expectMigrationError(
      () =>
        migrateLedgerV2(
          { stateDirectory: state, backupDirectory: backup },
          {
            afterCheckpoint() {
              calls++;
              newIntent(ledger, {
                ...input('gap-writer'),
                submittedUrls: ['https://example.test/gap-writer'],
              });
              expect(
                lstatSync(join(state, 'ledger.sqlite-wal')).size,
              ).toBeGreaterThan(0);
              afterWriter = exactCoreRows(db);
            },
          },
        ),
      'InvalidState',
    );
    expect(calls).toBe(1);
    expect(afterWriter).toBeDefined();
    expectV1Unchanged(db, afterWriter!);
    expect(existsSync(backup)).toBe(false);
  } finally {
    f.cleanup();
  }
});

for (const fault of [
  'copy',
  'zero-write',
  'fileSync',
  'directorySync',
  'parentSync',
] as const) {
  test(`V2-03 backup: ${fault} retains private unverified backup and exact V1`, () => {
    const f = fixture();
    try {
      const state = join(f.root, 'v1');
      const ledger = f.init(state, 1);
      newIntent(ledger);
      ledger.close();
      const db = f.raw(state);
      const before = exactCoreRows(db);
      const backup = join(f.root, 'backup');
      const hooks =
        fault === 'zero-write'
          ? { maxWriteBytes: 0 }
          : fault === 'copy'
            ? { fault, maxWriteBytes: 17 }
            : { fault };
      expectMigrationError(
        () =>
          migrateLedgerV2(
            { stateDirectory: state, backupDirectory: backup },
            hooks,
          ),
        'BackupFailed',
      );
      expectV1Unchanged(db, before);
      expect(existsSync(join(backup, 'ledger.sqlite'))).toBe(true);
      expect(lstatSync(backup).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(backup, 'ledger.sqlite')).mode & 0o777).toBe(0o600);
      expect(existsSync(join(backup, 'backup-manifest.json'))).toBe(false);
      if (fault === 'zero-write')
        expect(lstatSync(join(backup, 'ledger.sqlite')).size).toBe(0);
      if (fault === 'copy') {
        expect(lstatSync(join(backup, 'ledger.sqlite')).size).toBe(17);
        expect(lstatSync(join(state, 'ledger.sqlite')).size).toBeGreaterThan(
          17,
        );
      }
    } finally {
      f.cleanup();
    }
  });
}

test('V2-03 backup: bounded partial writes preserve committed WAL rows in verified recovery image', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'v1');
    const ledger = f.init(state, 1);
    const db = f.raw(state);
    db.run('PRAGMA wal_autocheckpoint = 0');
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const checkpointedEmptyMain = readFileSync(join(state, 'ledger.sqlite'));
    newIntent(ledger);
    expect(readFileSync(join(state, 'ledger.sqlite'))).toEqual(
      checkpointedEmptyMain,
    );
    expect(lstatSync(join(state, 'ledger.sqlite-wal')).size).toBeGreaterThan(0);
    const before = exactCoreRows(db);
    const backup = join(f.root, 'backup');
    expect(
      migrateLedgerV2(
        { stateDirectory: state, backupDirectory: backup },
        { maxWriteBytes: 17 },
      ).migrated,
    ).toBe(true);
    expect(exactCoreRows(f.raw(backup))).toEqual(before);
    expect(exactCoreRows(db)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

for (const shape of [
  'existing-directory',
  'existing-file',
  'symlink',
  'hardlink',
  'unsafe-parent',
  'unsafe-source',
  'unsafe-main-file',
  'source-symlink',
  'source-hardlink',
  'unsafe-journal',
] as const) {
  test(`V2-03 paths: ${shape} preserves sentinels/source and never overwrites`, () => {
    const f = fixture();
    try {
      const state = join(f.root, 'v1');
      const ledger = f.init(state, 1);
      newIntent(ledger);
      ledger.close();
      const db = f.raw(state);
      const before = exactCoreRows(db);
      const sentinel = join(f.root, 'sentinel');
      writeFileSync(sentinel, 'synthetic existing backup sentinel', {
        flag: 'wx',
        mode: 0o600,
      });
      let backup = join(f.root, 'backup');
      const sourceInode = lstatSync(join(state, 'ledger.sqlite')).ino;
      let selectedState = state;
      if (shape === 'existing-directory') {
        mkdirSync(backup, { mode: 0o700 });
        writeFileSync(join(backup, 'sentinel'), 'preexisting private backup', {
          mode: 0o600,
          flag: 'wx',
        });
      }
      if (shape === 'existing-file')
        writeFileSync(backup, 'existing file', { mode: 0o600, flag: 'wx' });
      if (shape === 'symlink') symlinkSync(sentinel, backup);
      if (shape === 'hardlink') linkSync(sentinel, backup);
      if (shape === 'unsafe-parent') {
        const parent = join(f.root, 'unsafe');
        mkdirSync(parent, { mode: 0o700 });
        chmodSync(parent, 0o777);
        backup = join(parent, 'new-backup');
      }
      if (shape === 'unsafe-source') chmodSync(state, 0o755);
      if (shape === 'unsafe-main-file')
        chmodSync(join(state, 'ledger.sqlite'), 0o644);
      if (shape === 'source-symlink') {
        selectedState = join(f.root, 'source-alias');
        symlinkSync(state, selectedState);
      }
      if (shape === 'source-hardlink') {
        db.close();
        linkSync(join(state, 'ledger.sqlite'), join(f.root, 'source-hardlink'));
      }
      if (shape === 'unsafe-journal')
        writeFileSync(
          join(state, 'ledger.sqlite-journal'),
          'owned nonempty journal',
          { flag: 'wx', mode: 0o600 },
        );
      const sourceBytes =
        shape === 'source-hardlink'
          ? readFileSync(join(state, 'ledger.sqlite'))
          : undefined;
      expectMigrationError(
        () =>
          migrateLedgerV2({
            stateDirectory: selectedState,
            backupDirectory: backup,
          }),
        [
          'unsafe-source',
          'unsafe-main-file',
          'source-symlink',
          'source-hardlink',
          'unsafe-journal',
        ].includes(shape)
          ? 'InvalidState'
          : 'BackupFailed',
      );
      if (shape === 'source-hardlink') {
        expect(lstatSync(join(state, 'ledger.sqlite')).nlink).toBe(2);
        expect(readFileSync(join(state, 'ledger.sqlite'))).toEqual(
          sourceBytes!,
        );
        rmSync(join(f.root, 'source-hardlink')); // Remove only the owned negative-fixture alias before SQLite inspection.
      }
      expectV1Unchanged(
        shape === 'source-hardlink' ? f.raw(state) : db,
        before,
      );
      expect(readFileSync(sentinel, 'utf8')).toBe(
        'synthetic existing backup sentinel',
      );
      if (shape === 'existing-file')
        expect(readFileSync(backup, 'utf8')).toBe('existing file');
      if (shape === 'existing-directory')
        expect(readFileSync(join(backup, 'sentinel'), 'utf8')).toBe(
          'preexisting private backup',
        );
      expect(lstatSync(join(state, 'ledger.sqlite')).ino).toBe(sourceInode);
      if (shape === 'unsafe-journal')
        expect(readFileSync(join(state, 'ledger.sqlite-journal'), 'utf8')).toBe(
          'owned nonempty journal',
        );
    } finally {
      f.cleanup();
    }
  });
}

async function migrationDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Migration child deadline exceeded.')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function spawnMigrationProcess(home: string) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      resolve('tests/fixtures/retry-ledger-child.ts'),
    ],
    {
      cwd: process.cwd(),
      env: { HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
interface MigrationChild {
  process: ReturnType<typeof spawnMigrationProcess>;
  pauseAt: 'before_commit' | 'after_commit';
  markers: string[];
  phaseReady: Promise<void>;
  stdoutDone?: Promise<void>;
  stderrDone?: Promise<string>;
  inputClosed: boolean;
  exitResult?: number;
}
async function startMigrationChild(
  config: {
    stateDirectory: string;
    backupDirectory: string;
    pauseAt: 'before_commit' | 'after_commit';
  },
  home: string,
  children: MigrationChild[],
) {
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const phaseReady = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  void phaseReady.catch(() => {});
  const process = spawnMigrationProcess(home);
  const child: MigrationChild = {
    process,
    pauseAt: config.pauseAt,
    markers: [],
    phaseReady,
    inputClosed: false,
  };
  children.push(child); // Cleanup registry owns the PID before stream startup or writes.
  child.stderrDone = new Response(process.stderr).text();
  void child.stderrDone.catch(() => {});
  child.stdoutDone = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 256)
          throw new Error('Unexpected migration child output.');
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const marker = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (
            ![
              'backup_verified',
              'before_commit',
              'after_commit',
              'receipt',
            ].includes(marker)
          )
            throw new Error('Unexpected migration child marker.');
          child.markers.push(marker);
          if (child.markers.length > 4)
            throw new Error('Excess migration child output.');
          if (marker === config.pauseAt) ready();
        }
      }
      buffer += decoder.decode();
      if (buffer !== '' || !child.markers.includes(config.pauseAt))
        throw new Error('Migration child exited before its phase.');
    } catch (error) {
      failed(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  void child.stdoutDone.catch(() => {});
  await migrationDeadline(
    Promise.resolve(process.stdin.write(JSON.stringify(config) + '\n')),
  );
  await migrationDeadline(Promise.resolve(process.stdin.flush()));
  await migrationDeadline(Promise.resolve(process.stdin.end()));
  child.inputClosed = true;
  return child;
}
async function killMigrationChild(child: MigrationChild) {
  if (child.process.exitCode === null && child.process.signalCode === null)
    child.process.kill('SIGKILL');
  child.exitResult = await migrationDeadline(child.process.exited);
}
async function closeMigrationFixture(
  f: ReturnType<typeof fixture>,
  children: MigrationChild[],
  verified: boolean,
) {
  const failures: unknown[] = [];
  const reaped = await Promise.allSettled(children.map(killMigrationChild));
  for (const result of reaped)
    if (result.status === 'rejected') failures.push(result.reason);
  const drained = await Promise.allSettled(
    children.map(async (child, index) => {
      const settled = await Promise.allSettled([
        migrationDeadline(
          (async () => {
            if (!child.inputClosed) {
              await child.process.stdin.end();
              child.inputClosed = true;
            }
          })(),
        ),
        migrationDeadline<void | string>(
          child.stdoutDone ?? new Response(child.process.stdout).text(),
        ),
        migrationDeadline(
          child.stderrDone ?? new Response(child.process.stderr).text(),
        ),
      ]);
      for (const result of settled)
        if (result.status === 'rejected') failures.push(result.reason);
      const stderr = settled[2];
      if (stderr?.status === 'fulfilled' && stderr.value !== '')
        failures.push(new Error('Migration child stderr was not empty.'));
      console.info(
        'V2-04_PROCESS ' +
          JSON.stringify({
            pauseAt: child.pauseAt,
            pid: child.process.pid,
            reaped: reaped[index]?.status === 'fulfilled',
            signal: child.process.signalCode,
            exitResult: child.exitResult,
            inputClosed: child.inputClosed,
            stdoutSettled: settled[1]?.status === 'fulfilled',
            stderrSettled: settled[2]?.status === 'fulfilled',
            markers: child.markers,
          }),
      );
    }),
  );
  for (const result of drained)
    if (result.status === 'rejected') failures.push(result.reason);
  try {
    f.cleanup(verified && failures.length === 0);
  } catch (error) {
    failures.push(error);
  }
  const removed = !existsSync(f.root);
  if (verified && failures.length === 0 && !removed)
    failures.push(new Error('Owned migration root was not removed.'));
  console.info(
    'V2-04_CLEANUP ' +
      JSON.stringify({
        ownedRoot: f.root,
        removed,
        children: children.length,
        failures: failures.length,
      }),
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Migration fixture cleanup failed; owned root preserved.',
    );
}

function seedCrashMigration(f: ReturnType<typeof fixture>, state: string) {
  const ledger = f.init(state, 1);
  for (const kind of ['prepared', 'dispatching', 'accepted'] as const) {
    const value = {
      ...input(`crash-${kind}`),
      submittedUrls: [
        `https://example.test/Crash/${kind}?Case=1`,
        `https://example.test/é/${kind}/`,
      ],
    };
    const prepared = newIntent(ledger, value);
    if (kind === 'prepared') continue;
    const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed')
      throw new Error('Expected synthetic crash-fixture claim.');
    if (kind === 'accepted')
      ledger.recordDispatchOutcome({
        credentialFingerprint: binding,
        requestId: value.requestId,
        expectedStateVersion: 1,
        outcomeToken: claim.outcomeToken,
        outcome: {
          kind: 'accepted',
          providerType: 'google/indexer',
          providerTaskId: ' Synthetic-é ',
        },
      });
  }
  ledger.close();
  const db = f.raw(state);
  db.run('UPDATE intent_events SET event_id = event_id + 9007199254740992');
  db.run('UPDATE sqlite_sequence SET seq = 9007199254745999');
  const before = exactCoreRows(db);
  db.close();
  return before;
}
function expectCrashBackup(
  f: ReturnType<typeof fixture>,
  backup: string,
  before: ReturnType<typeof exactCoreRows>,
) {
  const manifest = JSON.parse(
    readFileSync(join(backup, 'backup-manifest.json'), 'utf8'),
  ) as { files: Record<string, { size: string; sha256: string }> };
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(backup, name));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      expected.sha256,
    );
    expect(String(bytes.length)).toBe(expected.size);
  }
  const db = f.raw(backup);
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  expect(exactCoreRows(db)).toEqual(before);
}
for (const pauseAt of ['before_commit', 'after_commit'] as const) {
  test(`V2-04 ${pauseAt}: actual owned child death preserves the native transaction boundary`, async () => {
    const f = fixture();
    const children: MigrationChild[] = [];
    let verified = false;
    try {
      const state = join(f.root, 'state');
      const backup = join(f.root, 'backup');
      const home = join(f.root, 'child-home');
      mkdirSync(home, { mode: 0o700 });
      const before = seedCrashMigration(f, state);
      const inode = lstatSync(join(state, 'ledger.sqlite')).ino;
      const child = await startMigrationChild(
        { stateDirectory: state, backupDirectory: backup, pauseAt },
        home,
        children,
      );
      await migrationDeadline(child.phaseReady);
      await killMigrationChild(child);
      expect(child.process.signalCode).toBe('SIGKILL');
      expect(child.process.pid).toBeGreaterThan(0);
      await migrationDeadline(child.stdoutDone!);
      expect(await migrationDeadline(child.stderrDone!)).toBe('');
      expect(child.markers).toEqual(
        pauseAt === 'before_commit'
          ? ['backup_verified', 'before_commit']
          : ['backup_verified', 'before_commit', 'after_commit'],
      );
      expectCrashBackup(f, backup, before);
      // Normal open must validate the recovered exact schema, never repair or migrate it.
      f.open(state).close();
      const db = f.raw(state);
      expect(exactCoreRows(db)).toEqual(before);
      expect(lstatSync(join(state, 'ledger.sqlite')).ino).toBe(inode);
      if (pauseAt === 'before_commit') expectV1Unchanged(db, before);
      else {
        expect(db.query('PRAGMA user_version').get()).toEqual({
          user_version: 2,
        });
        expect(
          db.query('SELECT COUNT(*) AS count FROM intent_context').get(),
        ).toEqual({ count: before.intents!.length });
        expect(
          db
            .query(
              'SELECT DISTINCT origin_kind, parent_family, parent_task_id, source_manifest_digest, plan_fingerprint FROM intent_context',
            )
            .all(),
        ).toEqual([
          {
            origin_kind: 'legacy_unattributed',
            parent_family: null,
            parent_task_id: null,
            source_manifest_digest: null,
            plan_fingerprint: null,
          },
        ]);
        const completed = snapshot(db);
        const unused = join(f.root, 'must-not-create');
        expect(
          migrateLedgerV2({ stateDirectory: state, backupDirectory: unused }),
        ).toEqual({ migrated: false, schemaVersion: 2, reason: 'AlreadyV2' });
        expect(existsSync(unused)).toBe(false);
        expect(snapshot(db)).toEqual(completed);
        expect(exactCoreRows(db)).toEqual(before);
      }
      verified = true;
    } finally {
      await closeMigrationFixture(f, children, verified);
    }
  }, 30000);
}

test('V2-04 exception: injected synchronous precommit exception rolls back DDL and returns exact sanitized failure', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const backup = join(f.root, 'backup');
    const before = seedCrashMigration(f, state);
    const phases: string[] = [];
    expectMigrationError(
      () =>
        migrateLedgerV2(
          { stateDirectory: state, backupDirectory: backup },
          {
            onPhase(phase) {
              phases.push(phase);
              if (phase === 'before_commit')
                throw new Error(
                  'Synthetic private transaction failure details.',
                );
            },
          },
        ),
      'MigrationFailed',
    );
    expect(phases).toEqual(['backup_verified', 'before_commit']);
    f.open(state).close();
    expectV1Unchanged(f.raw(state), before);
    expectCrashBackup(f, backup, before);
  } finally {
    f.cleanup();
  }
});

test('V2-04 reactivation: repeated maintenance preserves new V2 unknown history, standalone context and held units', () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const backup = join(f.root, 'backup');
    seedCrashMigration(f, state);
    expect(
      migrateLedgerV2({ stateDirectory: state, backupDirectory: backup })
        .migrated,
    ).toBe(true);
    const ledger = f.open(state);
    const value = {
      ...input('post-reactivation'),
      submittedUrls: ['https://example.test/New/unknown'],
    };
    const prepared = newIntent(ledger, value);
    const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed')
      throw new Error('Expected synthetic reactivation claim.');
    ledger.recordDispatchOutcome({
      credentialFingerprint: binding,
      requestId: value.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome: { kind: 'unknown' },
    });
    const db = f.raw(state);
    const before = snapshot(db);
    const reactivatedCore = exactCoreRows(db);
    const unused = join(f.root, 'must-not-restore');
    expect(
      migrateLedgerV2({ stateDirectory: state, backupDirectory: unused }),
    ).toEqual({ migrated: false, schemaVersion: 2, reason: 'AlreadyV2' });
    expect(existsSync(unused)).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(exactCoreRows(db)).toEqual(reactivatedCore);
    expect(
      db
        .query('SELECT origin_kind FROM intent_context WHERE request_id = ?')
        .get(value.requestId),
    ).toEqual({ origin_kind: 'standalone' });
    expect(ledger.readIntent(binding, value.requestId)).toMatchObject({
      state: 'unknown',
      stateVersion: 2,
      reservation: value.reservation,
    });
    expect(
      db
        .query(
          'SELECT event_kind FROM intent_events WHERE request_id = ? ORDER BY event_id',
        )
        .all(value.requestId),
    ).toEqual([
      { event_kind: 'prepared' },
      { event_kind: 'dispatching' },
      { event_kind: 'unknown' },
    ]);
    expectLedgerError(
      () =>
        ledger.prepareIntent({
          ...value,
          requestId: 'must-still-overlap',
          budget: { ...value.budget, budgetScope: 'another-scope' },
        }),
      'UrlOverlap',
    );
  } finally {
    f.cleanup();
  }
});

function snapshotCase(body: (owned: ReturnType<typeof fixture>) => void) {
  const owned = fixture();
  let passed = false;
  try {
    body(owned);
    passed = true;
  } finally {
    // Close every registered handle first. A failed case or close preserves its
    // owned root; successful cases independently verify their cleanup.
    owned.cleanup(passed);
    if (passed) expect(existsSync(owned.root)).toBe(false);
  }
}

function availableSnapshot(
  state: string,
  hooks: SnapshotReadHooks = {},
  selected = binding,
): AvailableRetrySnapshot {
  const result = readRetrySnapshot({ stateDirectory: state }, selected, hooks);
  expect(result.availability).toBe('available');
  if (result.availability !== 'available')
    throw new Error('Expected available synthetic snapshot.');
  return result;
}
function seedSnapshotState(
  ledger: SubmissionLedger,
  value: PrepareIntentInput,
  state:
    | 'prepared'
    | 'dispatching'
    | 'accepted'
    | 'rejected'
    | 'unknown'
    | 'cancelled',
  providerTaskId = ' Local-é-ACK ',
) {
  const prepared = newIntent(ledger, value);
  if (state === 'prepared') return;
  if (state === 'cancelled') {
    expect(
      ledger.cancelPrepared(
        value.budget.credentialFingerprint,
        value.requestId,
        0,
      ).kind,
    ).toBe('cancelled');
    return;
  }
  const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('Expected synthetic claim.');
  if (state === 'dispatching') return;
  ledger.recordDispatchOutcome({
    credentialFingerprint: value.budget.credentialFingerprint,
    requestId: value.requestId,
    expectedStateVersion: 1,
    outcomeToken: claim.outcomeToken,
    outcome:
      state === 'accepted'
        ? { kind: state, providerTaskId, providerType: value.taskFamily }
        : { kind: state },
  });
}
function assertDeepFrozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  const before = JSON.stringify(value);
  for (const [key, child] of Object.entries(value)) {
    try {
      Reflect.set(value, key, 'MUTATION');
    } catch {
      /* Strict caller mutation may throw. */
    }
    expect(JSON.stringify(value)).toBe(before);
    assertDeepFrozen(child);
  }
  if (Array.isArray(value)) {
    expect(() => value.push('MUTATION')).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  }
}

// Independent oracle: explicit public storage contract columns, not production
// projection imports, table_info enumeration, or the production digest helper.
function snapshotRevisionOracle(db: Database, selected = binding) {
  const core = db
    .query(
      `SELECT credential_fp,request_id,budget_scope,period_id,CAST(period_start_ms AS TEXT),
    policy_revision,policy_digest,task_family,provider_route,payload_digest,quote_version,quote_fingerprint,
    CAST(reserved_tokens AS TEXT),CAST(reserved_indexer AS TEXT),CAST(reserved_checker AS TEXT),state,CAST(state_version AS TEXT),
    claim_token_digest,dispatch_outcome_token_digest,CAST(created_at_ms AS TEXT),provider_task_id,provider_type
    FROM intents WHERE credential_fp=? ORDER BY request_id COLLATE BINARY`,
    )
    .values(selected);
  const contexts = db
    .query(
      `SELECT credential_fp,request_id,origin_kind,parent_family,parent_task_id,source_manifest_digest,plan_fingerprint
    FROM intent_context WHERE credential_fp=? ORDER BY request_id COLLATE BINARY`,
    )
    .values(selected);
  const urls = db
    .query(
      `SELECT credential_fp,request_id,CAST(ordinal AS TEXT),url_text
    FROM intent_urls WHERE credential_fp=? ORDER BY request_id COLLATE BINARY,ordinal`,
    )
    .values(selected);
  const events = db
    .query(
      `SELECT CAST(event_id AS TEXT),credential_fp,request_id,CAST(state_version AS TEXT),event_kind,CAST(occurred_at_ms AS TEXT),provider_task_id,provider_type
    FROM intent_events WHERE credential_fp=? ORDER BY event_id`,
    )
    .values(selected);
  const ledgerId = (
    db
      .query('SELECT ledger_id FROM retry_ledger_meta WHERE singleton=1')
      .get() as { ledger_id: string }
  ).ledger_id;
  return createHash('sha256')
    .update('speedyindex-retry-ledger-snapshot-v2\0')
    .update(JSON.stringify([ledgerId, selected, core, contexts, urls, events]))
    .digest('hex');
}

test('V2-05 complete local DTO spans scopes, periods, six families, every state, legacy gaps and ambiguous ACK history without secrets', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state, 1);
    const families = [
      'google/indexer',
      'google/checker',
      'yandex/indexer',
      'yandex/checker',
      'bing/checker',
      'backlink/checker',
    ] as const;
    const states = [
      'prepared',
      'dispatching',
      'accepted',
      'rejected',
      'unknown',
      'cancelled',
    ] as const;
    for (const [fi, family] of families.entries()) {
      for (const [si, status] of states.entries()) {
        const value: PrepareIntentInput = {
          ...input(`matrix-${fi}-${status}`),
          taskFamily: family,
          providerRoute: `/v2/task/${family}/create`,
          budget: {
            ...input().budget,
            budgetScope: `scope-${si}`,
            periodId: `period-${si}`,
            periodStartMs: 1000 + si,
          },
          submittedUrls: [
            `HTTP://Example.test/${fi}/${si}?q=Case#É`,
            `http://example.test/${fi}/${si}?q=case#é/`,
          ],
        };
        seedSnapshotState(ledger, value, status);
      }
    }
    seedSnapshotState(
      ledger,
      {
        ...input('duplicate'),
        budget: { ...input().budget, budgetScope: 'duplicate' },
        submittedUrls: ['https://example.test/duplicate'],
      },
      'accepted',
    );
    seedSnapshotState(
      ledger,
      {
        ...input('other-binding'),
        budget: { ...input().budget, credentialFingerprint: 'b'.repeat(64) },
        submittedUrls: ['https://example.test/other'],
      },
      'unknown',
    );
    ledger.close();
    migrateLedgerV2({
      stateDirectory: state,
      backupDirectory: join(f.root, 'backup'),
    });
    const db = f.raw(state);
    // Explicit synthetic retry contexts exercise projection only, not admission.
    db.run(
      `UPDATE intent_context SET origin_kind='retry',parent_family='google/indexer',parent_task_id=' Parent ',source_manifest_digest='${hash('manifest')}',plan_fingerprint='${hash('plan')}' WHERE request_id LIKE 'matrix-0-%'`,
    );
    const before = snapshot(db);
    const result = availableSnapshot(state);
    expect(result.coverage).toEqual({
      localStore: true,
      keyBindingOnly: true,
      allBudgetScopes: true,
      allFamilies: true,
      globalProviderAccount: false,
      ancestry: 'cooperating_v2_retry_contexts_only',
    });
    expect(result.holds.length).toBe(18);
    expect(new Set(result.holds.map((row) => row.taskFamily)).size).toBe(6);
    expect(
      result.holds.every((row) =>
        ['prepared', 'dispatching', 'unknown'].includes(row.state),
      ),
    ).toBe(true);
    const first = result.holds.find(
      (row) => row.requestId === 'matrix-0-prepared',
    )!;
    expect(first.urls).toEqual([
      { ordinal: '0', url: 'HTTP://Example.test/0/0?q=Case#É' },
      { ordinal: '1', url: 'http://example.test/0/0?q=case#é/' },
    ]);
    expect(result.unresolvedHistory.length).toBe(18);
    const unknown = result.unresolvedHistory.find(
      (row) => row.requestId === 'matrix-0-unknown',
    )!;
    expect(unknown.events.map((row) => row.kind)).toEqual([
      'prepared',
      'dispatching',
      'unknown',
    ]);
    expect(unknown.reservation).toEqual({
      tokens: '3',
      indexer: '2',
      checker: '1',
    });
    expect(unknown.budgetScope).toBe('scope-4');
    expect(unknown.periodId).toBe('period-4');
    expect(result.retryChildren.map((row) => row.state).sort()).toEqual(
      [...states].sort(),
    );
    expect(
      result.retryChildren.filter((row) => row.providerTaskId === null).length,
    ).toBe(5);
    expect(
      result.retryChildren.every(
        (row) =>
          row.parentTaskId === ' Parent ' &&
          row.sourceManifestDigest === hash('manifest') &&
          row.planFingerprint === hash('plan'),
      ),
    ).toBe(true);
    expect(result.acceptedManifests.length).toBe(5);
    const backlink = result.acceptedManifests.find(
      (row) => row.taskFamily === 'backlink/checker',
    )!;
    expect(backlink.originKind).toBe('legacy_unattributed');
    expect(backlink.provenance).toBe('durable_local_intent_ack');
    expect(backlink.submittedUrls).toEqual([
      'HTTP://Example.test/5/2?q=Case#É',
      'http://example.test/5/2?q=case#é/',
    ]);
    expect(backlink.manifestDigest).toBe(
      hash(
        'speedyindex-intent-url-manifest-v1\0' +
          JSON.stringify(['backlink/checker', backlink.submittedUrls]),
      ),
    );
    expect(Object.keys(backlink).sort()).toEqual(
      [
        'manifestDigest',
        'originKind',
        'payloadDigest',
        'provenance',
        'providerTaskId',
        'requestId',
        'submittedUrls',
        'taskFamily',
      ].sort(),
    );
    expect(result.ambiguousProviderRefs.length).toBe(1);
    const ambiguous = result.ambiguousProviderRefs[0]!;
    expect(ambiguous.requestIds).toEqual(['duplicate', 'matrix-0-accepted']);
    expect(ambiguous.records.map((row) => row.requestId)).toEqual([
      ...ambiguous.requestIds,
    ]);
    expect(
      ambiguous.records.every(
        (row) =>
          row.state === 'accepted' &&
          row.events.length === 3 &&
          row.providerTaskId === ' Local-é-ACK ',
      ),
    ).toBe(true);
    expect(ambiguous.records[0]!.urls[0]!.url).toBe(
      'https://example.test/duplicate',
    );
    expect(result.attributionGaps.length).toBe(31);
    expect(
      result.attributionGaps.every(
        (row) => row.reason === 'legacy_unattributed',
      ),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('other-binding');
    expect(serialized).not.toContain(binding);
    expect(serialized).not.toContain(state);
    for (const row of db
      .query(
        'SELECT claim_token_digest,dispatch_outcome_token_digest FROM intents',
      )
      .all() as Record<string, string | null>[]) {
      for (const secret of Object.values(row))
        if (secret) expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('claim_token');
    expect(serialized).not.toContain('outcome_token');
    expect(result.revision).toBe(snapshotRevisionOracle(db));
    assertDeepFrozen(result);
    expect(snapshot(db)).toEqual(before);
  });
});

test('V2-05 one pinned read transaction stays coherent across a real second-connection commit; next call sees it', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const prepared = newIntent(ledger);
    const before = availableSnapshot(state);
    const phases: string[] = [];
    const old = availableSnapshot(state, {
      onPhase(phase) {
        phases.push(phase);
        if (phase === 'snapshot_fixed') {
          const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
          if (claim.kind !== 'claimed')
            throw new Error('Expected synthetic concurrent claim.');
          ledger.recordDispatchOutcome({
            credentialFingerprint: binding,
            requestId: input().requestId,
            expectedStateVersion: 1,
            outcomeToken: claim.outcomeToken,
            outcome: { kind: 'unknown' },
          });
        }
      },
    });
    expect(phases).toEqual([
      'snapshot_fixed',
      'before_projection',
      'before_close',
    ]);
    expect(old.revision).toBe(before.revision);
    expect(old.holds[0]!.state).toBe('prepared');
    expect(old.unresolvedHistory[0]!.events.map((row) => row.kind)).toEqual([
      'prepared',
    ]);
    const fresh = availableSnapshot(state);
    expect(fresh.revision).not.toBe(old.revision);
    expect(fresh.holds[0]!.state).toBe('unknown');
    expect(fresh.unresolvedHistory[0]!.events.map((row) => row.kind)).toEqual([
      'prepared',
      'dispatching',
      'unknown',
    ]);
  });
});

test('V2-05 valid empty and other-binding-only V2 are available-empty without logical mutation', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    const before = snapshot(db);
    const empty = availableSnapshot(state);
    expect(empty.holds).toEqual([]);
    expect(empty.acceptedManifests).toEqual([]);
    expect(empty.retryChildren).toEqual([]);
    expect(empty.unresolvedHistory).toEqual([]);
    expect(empty.attributionGaps).toEqual([]);
    expect(empty.ambiguousProviderRefs).toEqual([]);
    expect(snapshot(db)).toEqual(before);
    newIntent(ledger, {
      ...input(),
      budget: { ...input().budget, credentialFingerprint: 'b'.repeat(64) },
    });
    expect(availableSnapshot(state).revision).toBe(empty.revision);
  });
});

for (const variant of [
  'missing',
  'v1',
  'partial',
  'context',
  'event',
  'ack',
  'url',
  'period',
  'ownership',
  'journal',
  'symlink',
  'hardlink',
  'mode',
  'corrupt',
] as const) {
  test(`V2-05 strict sanitized unavailable: ${variant}`, () => {
    return snapshotCase((f) => {
      const state = join(f.root, 'state');
      if (variant === 'missing') {
        expect(readRetrySnapshot({ stateDirectory: state }, binding)).toEqual({
          availability: 'unavailable',
          reason: 'MissingState',
        });
        expect(existsSync(state)).toBe(false);
        return;
      }
      const ledger = f.init(state, variant === 'v1' ? 1 : 2);
      seedSnapshotState(ledger, input(), 'accepted');
      ledger.close();
      let requested = state;
      if (variant === 'journal') {
        writeFileSync(
          join(state, 'ledger.sqlite-journal'),
          'nonempty owned journal',
          { mode: 0o600 },
        );
      } else if (variant === 'symlink') {
        requested = join(f.root, 'alias');
        symlinkSync(state, requested);
      } else if (variant === 'hardlink') {
        linkSync(join(state, 'ledger.sqlite'), join(f.root, 'linked'));
      } else if (variant === 'mode')
        chmodSync(join(state, 'ledger.sqlite'), 0o644);
      else if (variant === 'corrupt')
        writeFileSync(join(state, 'ledger.sqlite'), 'not SQLite');
      else if (variant !== 'v1') {
        const db = f.raw(state);
        switch (variant) {
          case 'partial':
            db.run('DROP TABLE intent_context');
            break;
          case 'context':
            db.run('DELETE FROM intent_context');
            break;
          case 'event':
            db.run('DELETE FROM intent_events WHERE state_version=1');
            break;
          case 'ack':
            db.run(
              "UPDATE intent_events SET provider_task_id='different' WHERE state_version=2",
            );
            break;
          case 'url':
            db.run('DELETE FROM intent_urls WHERE ordinal=0');
            break;
          case 'period':
            db.run('UPDATE intents SET period_start_ms=1234');
            break;
          case 'ownership':
            db.run('PRAGMA ignore_check_constraints=ON');
            db.run("UPDATE intents SET claim_token_digest='bad'");
            break;
        }
        db.close(true);
      }
      expect(readRetrySnapshot({ stateDirectory: requested }, binding)).toEqual(
        {
          availability: 'unavailable',
          reason: variant === 'v1' ? 'UpgradeRequired' : 'InvalidState',
        },
      );
    });
  });
}

for (const reason of ['ReadFailure', 'Busy'] as const) {
  test(`V2-05 injected synchronous read boundary ${reason} is sanitized and leaves no read lock`, () => {
    return snapshotCase((f) => {
      const state = join(f.root, 'state');
      const ledger = f.init(state);
      newIntent(ledger);
      const db = f.raw(state);
      const before = snapshot(db);
      let injected: SQLiteError | undefined;
      const lock = reason === 'Busy' ? f.raw(state) : undefined;
      try {
        lock?.run('BEGIN IMMEDIATE');
        db.run('PRAGMA busy_timeout=0');
        try {
          db.run(
            reason === 'Busy'
              ? 'BEGIN IMMEDIATE'
              : 'SELECT * FROM owned_missing_read_fixture',
          );
        } catch (error) {
          expect(error).toBeInstanceOf(SQLiteError);
          injected = error as SQLiteError;
        }
      } finally {
        lock?.run('ROLLBACK');
      }
      if (!injected) throw new Error('Expected owned SQL read error.');
      // A real owned SQLite error is rethrown at the trusted read seam. The Busy
      // case proves classification, not that this WAL read transaction was locked.
      expect(injected.code).toBe(
        reason === 'Busy' ? 'SQLITE_BUSY' : 'SQLITE_ERROR',
      );
      const result = readRetrySnapshot({ stateDirectory: state }, binding, {
        onPhase(phase) {
          if (phase === 'before_projection') throw injected;
        },
      });
      expect(result).toEqual({ availability: 'unavailable', reason });
      expect(Object.isFrozen(result)).toBe(true);
      expect(snapshot(db)).toEqual(before);
      expect(ledger.cancelPrepared(binding, input().requestId, 0).kind).toBe(
        'cancelled',
      );
      expect(availableSnapshot(state).holds).toEqual([]);
    });
  });
}

test('V2-05 before-close exception and asynchronous phase result never yield an available DTO', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    f.init(state);
    expect(
      readRetrySnapshot({ stateDirectory: state }, binding, {
        onPhase(phase) {
          if (phase === 'before_close')
            throw new Error('private source path/provider body');
        },
      }),
    ).toEqual({ availability: 'unavailable', reason: 'ReadFailure' });
    // Deliberately violates the synchronous trusted seam; no transaction crosses await.
    expect(
      readRetrySnapshot({ stateDirectory: state }, binding, {
        onPhase: () => Promise.resolve(),
      }),
    ).toEqual({ availability: 'unavailable', reason: 'ReadFailure' });
    expect(availableSnapshot(state).holds).toEqual([]);
  });
});

test('V2-06 independent complete-column tuple oracle, BINARY order, exact unsafe event integers and private ownership revisions', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    for (const [id, status] of [
      ['z', 'prepared'],
      ['legacy', 'dispatching'],
      ['A', 'unknown'],
    ] as const) {
      seedSnapshotState(
        ledger,
        { ...input(id), submittedUrls: [`https://example.test/${id}`] },
        status,
      );
    }
    // Legacy SQL allows Unicode request identities that the ordinary API doesn't create.
    db.transaction(() => {
      for (const table of [
        'intents',
        'intent_context',
        'intent_urls',
        'intent_events',
      ])
        db.run(`UPDATE ${table} SET request_id='É' WHERE request_id='legacy'`);
    }).immediate();
    db.run('UPDATE intent_events SET event_id=event_id+9007199254740992');
    db.run(
      "UPDATE intents SET reserved_tokens=9007199254740993 WHERE request_id='z'",
    );
    const first = availableSnapshot(state);
    expect(first.revision).toBe(snapshotRevisionOracle(db));
    expect(first.holds.map((row) => row.requestId)).toEqual(['A', 'z', 'É']);
    expect(
      first.unresolvedHistory.find((row) => row.requestId === 'z')!.reservation
        .tokens,
    ).toBe('9007199254740993');
    const ids = first.unresolvedHistory.flatMap((row) =>
      row.events.map((event) => event.eventId),
    );
    expect(new Set(ids).size).toBe(6);
    expect(ids).toContain('9007199254740993');
    expect(ids).toContain('9007199254740994');
    db.run(
      "UPDATE intents SET claim_token_digest='" +
        hash('changed-private-claim') +
        "' WHERE request_id='z'",
    );
    const changed = availableSnapshot(state);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.revision).toBe(snapshotRevisionOracle(db));
    db.run(
      "UPDATE intents SET dispatch_outcome_token_digest='" +
        hash('changed-private-outcome') +
        "' WHERE request_id='É'",
    );
    const again = availableSnapshot(state);
    expect(again.revision).not.toBe(changed.revision);
    expect(again.revision).toBe(snapshotRevisionOracle(db));
    expect(JSON.stringify(again)).not.toContain(hash('changed-private-claim'));
    expect(JSON.stringify(again)).not.toContain(
      hash('changed-private-outcome'),
    );
    // Captured time changes independently; unrelated committed history is excluded.
    const NativeDate = globalThis.Date;
    try {
      globalThis.Date = class extends NativeDate {
        constructor() {
          super('2031-01-01T00:00:00Z');
        }
      } as DateConstructor;
      const later = availableSnapshot(state);
      expect(later.capturedAt).not.toBe(again.capturedAt);
      expect(later.revision).toBe(again.revision);
    } finally {
      globalThis.Date = NativeDate;
    }
    seedSnapshotState(
      ledger,
      {
        ...input('other'),
        budget: { ...input().budget, credentialFingerprint: 'b'.repeat(64) },
      },
      'unknown',
    );
    expect(availableSnapshot(state).revision).toBe(again.revision);
  });
});

test('V2-06 valid selected identity, units, lineage, URL order/case, event and ACK changes each bind revision', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    seedSnapshotState(ledger, input(), 'accepted', 'ACK');
    let previous = availableSnapshot(state);
    const changes = [
      "UPDATE intents SET policy_revision='revision-two'",
      `UPDATE intents SET policy_digest='${hash('policy-two')}'`,
      `UPDATE intents SET payload_digest='${hash('payload-two')}'`,
      "UPDATE intents SET quote_version='quote-two'",
      `UPDATE intents SET quote_fingerprint='${hash('quote-two')}'`,
      'UPDATE intents SET reserved_tokens=4,reserved_indexer=5,reserved_checker=6',
      'UPDATE intents SET created_at_ms=created_at_ms+1',
      "UPDATE budget_periods SET budget_scope='other-scope'; UPDATE intents SET budget_scope='other-scope'",
      "UPDATE budget_periods SET period_id='other-period',period_start_ms=2000; UPDATE intents SET period_id='other-period',period_start_ms=2000",
      "UPDATE intent_context SET origin_kind='legacy_unattributed'",
      `UPDATE intent_context SET origin_kind='retry',parent_family='google/indexer',parent_task_id='Parent',source_manifest_digest='${hash('source')}',plan_fingerprint='${hash('plan')}'`,
      "UPDATE intent_context SET parent_task_id='ParentCase'",
      `UPDATE intent_context SET source_manifest_digest='${hash('source-two')}'`,
      `UPDATE intent_context SET plan_fingerprint='${hash('plan-two')}'`,
      "UPDATE intent_urls SET url_text=replace(url_text,'example.test','Example.test')",
      'UPDATE intent_urls SET ordinal=ordinal+2; UPDATE intent_urls SET ordinal=3-ordinal',
      'UPDATE intent_events SET event_id=event_id+100',
      'UPDATE intent_events SET occurred_at_ms=-state_version',
      "UPDATE intents SET provider_task_id='AckCase'; UPDATE intent_events SET provider_task_id='AckCase' WHERE state_version=2",
      "UPDATE intents SET task_family='yandex/indexer',provider_route='/v2/task/yandex/indexer/create',provider_type='yandex/indexer'; UPDATE intent_context SET parent_family='yandex/indexer'; UPDATE intent_events SET provider_type='yandex/indexer' WHERE state_version=2",
      "UPDATE intents SET request_id='renamed'; UPDATE intent_context SET request_id='renamed'; UPDATE intent_urls SET request_id='renamed'; UPDATE intent_events SET request_id='renamed'",
    ];
    for (const sql of changes) {
      db.transaction(() => db.run(sql)).immediate();
      const current = availableSnapshot(state);
      expect(current.revision).not.toBe(previous.revision);
      expect(current.revision).toBe(snapshotRevisionOracle(db));
      previous = current;
    }
    expect(previous.acceptedManifests[0]!.submittedUrls).toEqual([
      'https://Example.test/é/',
      'https://Example.test/Case?q=1',
    ]);
    const manifest = previous.acceptedManifests[0]!;
    expect(manifest.manifestDigest).toBe(
      hash(
        'speedyindex-intent-url-manifest-v1\0' +
          JSON.stringify(['yandex/indexer', manifest.submittedUrls]),
      ),
    );
  });
});

test('V2-06 preparation, claim, outcome and cancel advance selected revision with valid histories', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    let previous = availableSnapshot(state).revision;
    const step = () => {
      const current = availableSnapshot(state);
      expect(current.revision).not.toBe(previous);
      previous = current.revision;
      return current;
    };
    const prepared = newIntent(ledger);
    step();
    const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed') throw new Error('Expected claim');
    step();
    ledger.recordDispatchOutcome({
      credentialFingerprint: binding,
      requestId: input().requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome: { kind: 'unknown' },
    });
    expect(step().holds[0]!.state).toBe('unknown');
    newIntent(ledger, {
      ...input('cancel'),
      submittedUrls: ['https://example.test/cancel'],
    });
    step();
    ledger.cancelPrepared(binding, 'cancel', 0);
    expect(step().holds.map((row) => row.requestId)).toEqual([
      input().requestId,
    ]);
  });
});

for (const cap of ['intents', 'events', 'urls'] as const) {
  test(`V2-06 exact and over ${cap} limits use actual selected queries without partial projections`, () => {
    return snapshotCase((f) => {
      const state = join(f.root, 'state');
      const ledger = f.init(state);
      seedSnapshotState(ledger, input(), 'unknown');
      const exact = cap === 'intents' ? 1 : cap === 'events' ? 3 : 2;
      expect(
        availableSnapshot(state, { limits: { [cap]: exact } }).holds.length,
      ).toBe(1);
      const phases: string[] = [];
      expect(
        readRetrySnapshot({ stateDirectory: state }, binding, {
          limits: { [cap]: exact - 1 },
          onPhase(phase) {
            phases.push(phase);
          },
        }),
      ).toEqual({ availability: 'unavailable', reason: 'LimitExceeded' });
      expect(phases).toEqual(['snapshot_fixed']);
      expect(availableSnapshot(state).holds.length).toBe(1);
    });
  });
}

test('V2-06 exact retained UTF8 DTO bytes and overlarge legacy TEXT are bounded before projection; seams cannot raise ceilings', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    newIntent(ledger);
    const db = f.raw(state);
    const original = availableSnapshot(state);
    const bytes = Buffer.byteLength(JSON.stringify(original), 'utf8');
    expect(availableSnapshot(state, { limits: { bytes } }).revision).toBe(
      original.revision,
    );
    expect(
      readRetrySnapshot({ stateDirectory: state }, binding, {
        limits: { bytes: bytes - 1 },
      }),
    ).toEqual({ availability: 'unavailable', reason: 'LimitExceeded' });
    db.query('UPDATE intent_urls SET url_text=? WHERE ordinal=0').run(
      'https://example.test/' + 'é🧪'.repeat(10000),
    );
    const before = exactCoreRows(db);
    const phases: string[] = [];
    expect(
      readRetrySnapshot({ stateDirectory: state }, binding, {
        limits: { bytes: 4096 },
        onPhase(phase) {
          phases.push(phase);
        },
      }),
    ).toEqual({ availability: 'unavailable', reason: 'LimitExceeded' });
    expect(phases).toEqual(['snapshot_fixed']);
    expect(exactCoreRows(db)).toEqual(before);
    // Larger valid legacy values remain valid for the ordinary API and default reader.
    expect(f.open(state).readIntent(binding, input().requestId)?.state).toBe(
      'prepared',
    );
    expect(availableSnapshot(state).holds[0]!.urls[0]!.url).toBe(
      'https://example.test/' + 'é🧪'.repeat(10000),
    );
    for (const limits of [
      { intents: 2001 },
      { events: 6001 },
      { urls: 20001 },
      { bytes: 16 * 1024 * 1024 + 1 },
      { intents: -1 },
      { urls: 0.5 },
    ])
      expect(
        readRetrySnapshot({ stateDirectory: state }, binding, { limits }),
      ).toEqual({ availability: 'unavailable', reason: 'InvalidState' });
  });
});

test('V2-06 URL ordinals above nine retain numeric order and the independently hashed exact manifest', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const submittedUrls = Array.from(
      { length: 12 },
      (_, n) => `https://example.test/Exact/${n}?q=É#Frag`,
    );
    seedSnapshotState(ledger, { ...input(), submittedUrls }, 'accepted');
    const result = availableSnapshot(state);
    expect(result.acceptedManifests[0]!.submittedUrls).toEqual(submittedUrls);
    expect(result.acceptedManifests[0]!.manifestDigest).toBe(
      hash(
        'speedyindex-intent-url-manifest-v1\0' +
          JSON.stringify(['google/indexer', submittedUrls]),
      ),
    );
    expect(result.revision).toBe(snapshotRevisionOracle(f.raw(state)));
  });
});

test('V2-05 post-read identity validation rejects a changed private file mode without returning partial data', () => {
  return snapshotCase((f) => {
    const state = join(f.root, 'state');
    f.init(state);
    const result = readRetrySnapshot({ stateDirectory: state }, binding, {
      onPhase(phase) {
        if (phase === 'before_close')
          chmodSync(join(state, 'ledger.sqlite'), 0o640);
      },
    });
    expect(result).toEqual({
      availability: 'unavailable',
      reason: 'InvalidState',
    });
  });
});

const parentUrls = [
  'HTTP://Example.test/Case?q=1#F',
  'http://example.test/Case?q=1#f/',
  'https://example.test/é/',
  'https://example.test/second',
];
function retryFixture(
  f: ReturnType<typeof fixture>,
  hooks: RetryPrepareHooks = {},
) {
  const state = join(f.root, 'state');
  const ordinary = f.init(state);
  seedRetryParent(ordinary);
  const writer = f.track(openRetryLedgerV2({ stateDirectory: state }, hooks));
  return { state, ordinary, writer, db: f.raw(state) };
}
function seedRetryParent(
  ledger: SubmissionLedger,
  id = 'parent',
  providerTaskId = ' Parent-é ',
  urls: readonly string[] = parentUrls,
  family: 'google/indexer' | 'yandex/indexer' = 'google/indexer',
  selected = binding,
) {
  seedSnapshotState(
    ledger,
    {
      ...input(id),
      taskFamily: family,
      providerRoute: `/v2/task/${family}/create`,
      budget: {
        ...input().budget,
        credentialFingerprint: selected,
        budgetScope: `parent-${id}`,
      },
      submittedUrls: urls,
    },
    'accepted',
    providerTaskId,
  );
}
function retryInput(
  state: string,
  requestId = 'retry-one',
  taskId = ' Parent-é ',
  family: 'google/indexer' | 'yandex/indexer' = 'google/indexer',
): PrepareRetryIntentInput {
  const snap = availableSnapshot(state);
  const parent = snap.acceptedManifests.find(
    (row) => row.taskFamily === family && row.providerTaskId === taskId,
  );
  if (!parent) throw new Error('Expected synthetic parent manifest.');
  return {
    intent: {
      ...input(requestId),
      taskFamily: family,
      providerRoute: `/v2/task/${family}/create`,
      budget: { ...input().budget, budgetScope: 'retry-scope' },
      submittedUrls: parent.submittedUrls.slice(0, 2),
    },
    parent: { family, taskId },
    sourceManifestDigest: parent.manifestDigest,
    planFingerprint: hash('retry-plan'),
    expectedRevision: snap.revision,
  };
}
function createRetry(
  writer: RetrySubmissionLedger,
  value: PrepareRetryIntentInput,
) {
  const result = writer.prepareRetryIntent(value);
  expect(result.kind).toBe('created');
  if (result.kind !== 'created')
    throw new Error('Expected synthetic retry creator.');
  return result;
}
function claimRetry(
  writer: SubmissionLedger,
  prepared: ReturnType<typeof createRetry>,
) {
  const result = writer.claimDispatch(prepared.dispatchCapability, 0);
  expect(result.kind).toBe('claimed');
  if (result.kind !== 'claimed')
    throw new Error('Expected synthetic retry claim.');
  return result;
}
function expectRetryError(
  operation: () => unknown,
  code: RetryLedgerError['code'],
  reason?: RetryLedgerError['reason'],
) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RetryLedgerError);
  const error = caught as RetryLedgerError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(new RetryLedgerError(code).message);
  expect(error.reason).toBe(reason);
}
function assertNoRetryWrite(db: Database, operation: () => void) {
  const before = snapshot(db);
  const exactBefore = exactCoreRows(db);
  operation();
  expect(snapshot(db)).toEqual(before);
  expect(exactCoreRows(db)).toEqual(exactBefore);
}

test('V2-07 factory rejects valid V1 as UpgradeRequired without migration, and ordinary legacy replay remains unchanged', () =>
  snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state, 1);
    const manual = input('manual');
    newIntent(ledger, manual);
    const db = f.raw(state);
    const before = snapshotWithMissingTables(db);
    const exact = exactCoreRows(db);
    expectRetryError(
      () => openRetryLedgerV2({ stateDirectory: state }),
      'UpgradeRequired',
    );
    expect(snapshotWithMissingTables(db)).toEqual(before);
    expect(exactCoreRows(db)).toEqual(exact);
    expect(ledger.prepareIntent(manual).kind).toBe('replay');
  }));

for (const status of [
  'prepared',
  'dispatching',
  'accepted',
  'rejected',
  'unknown',
  'cancelled',
] as const) {
  test(`V2-07 P0-05 exact retry replay in ${status} survives stale revision and reopen without minting ownership or rows`, () =>
    snapshotCase((f) => {
      const { state, writer, db } = retryFixture(f);
      const value = retryInput(state);
      const prepared = createRetry(writer, value);
      const stale = value.expectedRevision;
      if (status === 'cancelled') {
        expect(
          writer.cancelPrepared(binding, value.intent.requestId, 0),
        ).toEqual({ kind: 'cancelled', stateVersion: 1 });
        expect(writer.claimDispatch(prepared.dispatchCapability, 0)).toEqual({
          kind: 'lost',
        });
      } else if (status !== 'prepared') {
        const claim = claimRetry(writer, prepared);
        expect(
          writer.cancelPrepared(binding, value.intent.requestId, 0),
        ).toEqual({ kind: 'lost' });
        if (status !== 'dispatching') {
          const outcome = {
            credentialFingerprint: binding,
            requestId: value.intent.requestId,
            expectedStateVersion: 1,
            outcomeToken: claim.outcomeToken,
            outcome:
              status === 'accepted'
                ? {
                    kind: status,
                    providerTaskId: ' Child-é ',
                    providerType: value.intent.taskFamily,
                  }
                : { kind: status },
          };
          expect(writer.recordDispatchOutcome(outcome).state).toBe(status);
          expectLedgerError(
            () => writer.recordDispatchOutcome(outcome),
            'DispatchOutcomeClaimLost',
          );
        }
      }
      const current = availableSnapshot(state);
      expect(current.revision).not.toBe(stale);
      const contextBefore = db
        .query('SELECT * FROM intent_context WHERE request_id=?')
        .get(value.intent.requestId);
      for (const revision of [stale, current.revision]) {
        const replayInput = {
          ...value,
          expectedRevision: revision,
          intent: {
            ...value.intent,
            budget: {
              ...value.intent.budget,
              periodId: 'later-context',
              periodStartMs: 9999,
              caps: { tokens: 0, indexer: 0, checker: 0 },
            },
          },
        };
        assertNoRetryWrite(db, () => {
          const replay = writer.prepareRetryIntent(replayInput);
          expect(replay).toEqual({
            kind: 'replay',
            intent: writer.readIntent(binding, value.intent.requestId)!,
          });
          expect('dispatchCapability' in replay).toBe(false);
        });
      }
      assertNoRetryWrite(db, () => {
        // Historical policy and budget are comparison data, independent of today's
        // selected policy, period, caps, lifetime allowance and complete projection.
        const identity = replayIdentity(value);
        expect(
          readRetryPlanningState(
            { stateDirectory: state },
            binding,
            planningInput(),
            { limits: { intents: 0 }, now: () => planningNow },
          ),
        ).toEqual({ availability: 'unavailable', reason: 'LimitExceeded' });
        const replay = readRetryReplay(
          { stateDirectory: state },
          binding,
          identity,
          {
            limits: { intents: 0 },
          },
        );
        expect(replay).toEqual({
          availability: 'available',
          kind: 'replay',
          intent: replayView(
            writer.readIntent(binding, value.intent.requestId)!,
          ),
        });
        const historicalBudget = structuredClone(identity);
        historicalBudget.intent.budget.caps = {
          tokens: 0,
          indexer: 0,
          checker: 0,
        };
        historicalBudget.intent.budget.periodId = 'expired-comparison-only';
        historicalBudget.intent.budget.periodStartMs = 0;
        expect(
          readRetryReplay({ stateDirectory: state }, binding, historicalBudget),
        ).toEqual(replay);
        assertDeepFrozen(replay);
        expect('dispatchCapability' in replay).toBe(false);
        expect('outcomeToken' in replay).toBe(false);
        const changedPolicy = structuredClone(identity);
        changedPolicy.intent.budget.policyDigest = hash('today-policy');
        changedPolicy.intent.budget.policyRevision = 'today';
        expect(
          readRetryReplay({ stateDirectory: state }, binding, changedPolicy),
        ).toEqual({
          availability: 'available',
          kind: 'conflict',
        });
      });
      writer.close();
      const reopened = f.track(openRetryLedgerV2({ stateDirectory: state }));
      assertNoRetryWrite(db, () => {
        const identity = replayIdentity(value);
        const historical = readRetryReplay(
          { stateDirectory: state },
          binding,
          identity,
        );
        expect(historical.availability).toBe('available');
        if (
          historical.availability !== 'available' ||
          historical.kind !== 'replay'
        )
          throw new Error('Expected reopened historical replay.');
        expect(historical.intent.state).toBe(status);
        expect(reopened.prepareRetryIntent(value).kind).toBe('replay');
        expectLedgerError(
          () => reopened.prepareIntent(value.intent),
          'RequestIdConflict',
        );
      });
      expect(
        db
          .query('SELECT * FROM intent_context WHERE request_id=?')
          .get(value.intent.requestId),
      ).toEqual(contextBefore);
      const relation = availableSnapshot(state).retryChildren[0]!;
      expect(relation.requestId).toBe(value.intent.requestId);
      expect(relation.state).toBe(status);
      expect(relation.parentTaskId).toBe(value.parent.taskId);
      expect(relation.sourceManifestDigest).toBe(value.sourceManifestDigest);
      expect(relation.providerTaskId).toBe(
        status === 'accepted' ? ' Child-é ' : null,
      );
      if (status === 'accepted') {
        const ownManifest = availableSnapshot(state).acceptedManifests.find(
          (row) => row.requestId === value.intent.requestId,
        )!;
        expect(ownManifest.originKind).toBe('retry');
        expect(ownManifest.submittedUrls).toEqual([
          ...value.intent.submittedUrls,
        ]);
      }
    }));
}

const retryIdentityChanges: [
  string,
  (value: PrepareRetryIntentInput) => void,
][] = [
  [
    'parent family',
    (v) => {
      v.parent.family = 'yandex/indexer';
    },
  ],
  [
    'parent exact ID',
    (v) => {
      v.parent.taskId = ' Parent-É ';
    },
  ],
  [
    'source digest',
    (v) => {
      v.sourceManifestDigest = hash('other-source');
    },
  ],
  [
    'plan',
    (v) => {
      v.planFingerprint = hash('other-plan');
    },
  ],
  [
    'scope',
    (v) => {
      v.intent.budget.budgetScope = 'other-scope';
    },
  ],
  [
    'policy revision',
    (v) => {
      v.intent.budget.policyRevision = 'other-revision';
    },
  ],
  [
    'policy digest',
    (v) => {
      v.intent.budget.policyDigest = hash('other-policy');
    },
  ],
  [
    'family and route',
    (v) => {
      v.intent.taskFamily = 'yandex/indexer';
      v.intent.providerRoute = '/v2/task/yandex/indexer/create';
      v.parent.family = 'yandex/indexer';
    },
  ],
  [
    'payload',
    (v) => {
      v.intent.payloadDigest = hash('other-payload');
    },
  ],
  [
    'quote version',
    (v) => {
      v.intent.quoteVersion = 'other-quote';
    },
  ],
  [
    'quote digest',
    (v) => {
      v.intent.quoteFingerprint = hash('other-quote');
    },
  ],
  [
    'tokens',
    (v) => {
      v.intent.reservation = {
        ...v.intent.reservation,
        tokens: v.intent.reservation.tokens + 1,
      };
    },
  ],
  [
    'indexer',
    (v) => {
      v.intent.reservation = {
        ...v.intent.reservation,
        indexer: v.intent.reservation.indexer + 1,
      };
    },
  ],
  [
    'checker',
    (v) => {
      v.intent.reservation = {
        ...v.intent.reservation,
        checker: v.intent.reservation.checker + 1,
      };
    },
  ],
  [
    'URL order',
    (v) => {
      v.intent.submittedUrls = [...v.intent.submittedUrls].reverse();
    },
  ],
  [
    'URL exact case',
    (v) => {
      v.intent.submittedUrls = [
        v.intent.submittedUrls[0]!.replace('Example', 'example'),
        v.intent.submittedUrls[1]!,
      ];
    },
  ],
  [
    'URL membership',
    (v) => {
      v.intent.submittedUrls = [v.intent.submittedUrls[0]!];
    },
  ],
];
for (const [name, change] of retryIdentityChanges) {
  test(`V2-07 P0-05 stored retry ${name} mutation is RequestIdConflict before revision or admission`, () =>
    snapshotCase((f) => {
      const { state, writer, db } = retryFixture(f);
      const value = retryInput(state);
      createRetry(writer, value);
      const changed = structuredClone(value);
      change(changed);
      assertNoRetryWrite(db, () => {
        expectLedgerError(
          () => writer.prepareRetryIntent(changed),
          'RequestIdConflict',
        );
        const identity = replayIdentity(changed);
        expect(
          readRetryReplay({ stateDirectory: state }, binding, identity),
        ).toEqual({
          availability: 'available',
          kind: 'conflict',
        });
      });
    }));
}

for (const origin of ['standalone', 'legacy_unattributed'] as const) {
  test(`V2-07 P0-05 ${origin} request cannot acquire lineage; exact ordinary replay leaves attribution intact`, () =>
    snapshotCase((f) => {
      const state = join(f.root, 'state');
      const ordinary = f.init(state, origin === 'standalone' ? 2 : 1);
      seedRetryParent(ordinary);
      const manual = {
        ...input('manual'),
        budget: { ...input().budget, budgetScope: 'manual' },
        submittedUrls: parentUrls.slice(0, 2),
      };
      newIntent(ordinary, manual);
      ordinary.close();
      if (origin === 'legacy_unattributed')
        migrateLedgerV2({
          stateDirectory: state,
          backupDirectory: join(f.root, 'backup'),
        });
      const writer = f.track(openRetryLedgerV2({ stateDirectory: state }));
      const db = f.raw(state);
      const retry = { ...retryInput(state, 'manual'), intent: manual };
      assertNoRetryWrite(db, () => {
        expectLedgerError(
          () => writer.prepareRetryIntent(retry),
          'RequestIdConflict',
        );
        const identity = replayIdentity(retry);
        expect(
          readRetryReplay({ stateDirectory: state }, binding, identity),
        ).toEqual({ availability: 'available', kind: 'conflict' });
        expect(writer.prepareIntent(manual).kind).toBe('replay');
      });
      expect(
        (
          db
            .query('SELECT origin_kind FROM intent_context WHERE request_id=?')
            .get('manual') as { origin_kind: string }
        ).origin_kind,
      ).toBe(origin);
    }));
}

for (const fault of [
  'checker child',
  'checker parent',
  'bad route',
  'extra approval',
  'extra parent field',
  'bad revision',
  'bad plan',
  'bad manifest',
  'unsafe parent',
  'blank parent',
  'oversized parent',
  'invalid unit',
] as const) {
  test(`V2-07 strict trusted DTO rejects ${fault} before writes`, () =>
    snapshotCase((f) => {
      const { state, writer, db } = retryFixture(f);
      const value = retryInput(state);
      let invalid: unknown = value;
      switch (fault) {
        case 'checker child':
          value.intent.taskFamily = 'google/checker';
          value.intent.providerRoute = '/v2/task/google/checker/create';
          break;
        case 'checker parent':
          invalid = {
            ...value,
            parent: { ...value.parent, family: 'google/checker' },
          };
          break;
        case 'bad route':
          value.intent.providerRoute = '/v2/task/yandex/indexer/create';
          break;
        case 'extra approval':
          invalid = { ...value, approved: true };
          break;
        case 'extra parent field':
          invalid = { ...value, parent: { ...value.parent, approved: true } };
          break;
        case 'bad revision':
          value.expectedRevision = 'not-a-digest';
          break;
        case 'bad plan':
          value.planFingerprint = 'A'.repeat(64);
          break;
        case 'bad manifest':
          value.sourceManifestDigest = 'missing';
          break;
        case 'unsafe parent':
          value.parent.taskId = 'unsafe\nID';
          break;
        case 'blank parent':
          value.parent.taskId = '\u2003';
          break;
        case 'oversized parent':
          value.parent.taskId = 'é'.repeat(2049);
          break;
        case 'invalid unit':
          value.intent.reservation = {
            ...value.intent.reservation,
            checker: -1,
          };
          break;
      }
      assertNoRetryWrite(db, () =>
        expectLedgerError(
          () => writer.prepareRetryIntent(invalid as PrepareRetryIntentInput),
          'InvalidLedgerInput',
        ),
      );
    }));
}

for (const fault of [
  'missing',
  'cross-engine',
  'digest',
  'exact subset',
  'other binding',
  'unaccepted',
  'ambiguous',
  'accepted own retry child',
] as const) {
  test(`V2-07 fresh current revision reaches local-parent ${fault} barrier`, () =>
    snapshotCase((f) => {
      const { state, ordinary, writer, db } = retryFixture(f);
      let value = retryInput(state);
      switch (fault) {
        case 'missing':
          value.parent.taskId = ' External-only ';
          break;
        case 'cross-engine': {
          const parentId = ' Opposite-engine-é ';
          seedRetryParent(
            ordinary,
            'opposite-engine-parent',
            parentId,
            parentUrls,
            'yandex/indexer',
          );
          expect(
            ordinary.readIntent(binding, 'opposite-engine-parent'),
          ).toMatchObject({
            state: 'accepted',
            taskFamily: 'yandex/indexer',
            providerType: 'yandex/indexer',
            providerTaskId: parentId,
          });
          const current = availableSnapshot(state);
          const parent = current.acceptedManifests.find(
            (row) =>
              row.taskFamily === 'yandex/indexer' &&
              row.providerTaskId === parentId,
          );
          expect(parent).toBeDefined();
          if (!parent)
            throw new Error('Expected accepted opposite-engine parent.');
          expect(parent.requestId).toBe('opposite-engine-parent');
          expect(parent.provenance).toBe('durable_local_intent_ack');
          expect(parent.originKind).toBe('standalone');
          expect(parent.submittedUrls).toEqual(parentUrls);
          expect(parent.manifestDigest).toBe(
            hash(
              'speedyindex-intent-url-manifest-v1\0' +
                JSON.stringify(['yandex/indexer', parentUrls]),
            ),
          );
          expect(current.ambiguousProviderRefs).toEqual([]);
          expect(current.retryChildren).toEqual([]);
          expect(current.holds).toEqual([]);
          value.parent = { family: 'yandex/indexer', taskId: parentId };
          value.sourceManifestDigest = parent.manifestDigest;
          value.intent.submittedUrls = parent.submittedUrls.slice(0, 2);
          expect(value.intent.submittedUrls).toEqual(parentUrls.slice(0, 2));
          expect(
            value.intent.submittedUrls.every((url) =>
              parent.submittedUrls.includes(url),
            ),
          ).toBe(true);
          expect(value.intent.taskFamily).toBe('google/indexer');
          expect(value.intent.providerRoute).toBe(
            '/v2/task/google/indexer/create',
          );
          value.expectedRevision = current.revision;
          break;
        }
        case 'digest':
          value.sourceManifestDigest = hash('supplied-external-digest');
          break;
        case 'exact subset':
          value.intent.submittedUrls = [
            parentUrls[0]!.replace('Example', 'example'),
          ];
          break;
        case 'other binding':
          seedRetryParent(
            ordinary,
            'foreign',
            ' Foreign ',
            ['https://example.test/foreign'],
            'google/indexer',
            'b'.repeat(64),
          );
          value.parent.taskId = ' Foreign ';
          break;
        case 'unaccepted':
          newIntent(ordinary, {
            ...input('not-acked'),
            submittedUrls: ['https://example.test/not-acked'],
          });
          value.parent.taskId = 'not-acked';
          break;
        case 'ambiguous': {
          // Existing V1 duplicates remain legal after migration; a raw valid fixture
          // produces the same ambiguity without weakening the new V2 ACK guard.
          seedRetryParent(
            ordinary,
            'duplicate',
            ' Unique-before-legacy-rewrite ',
            ['https://example.test/duplicate'],
          );
          db.run(
            "UPDATE intents SET provider_task_id=' Parent-é ' WHERE request_id='duplicate'; UPDATE intent_events SET provider_task_id=' Parent-é ' WHERE request_id='duplicate' AND state_version=2",
          );
          break;
        }
        case 'accepted own retry child': {
          const child = createRetry(writer, value);
          const claim = claimRetry(writer, child);
          writer.recordDispatchOutcome({
            credentialFingerprint: binding,
            requestId: value.intent.requestId,
            expectedStateVersion: 1,
            outcomeToken: claim.outcomeToken,
            outcome: {
              kind: 'accepted',
              providerTaskId: ' Own-child ',
              providerType: 'google/indexer',
            },
          });
          value = retryInput(state, 'grandchild', ' Own-child ');
          break;
        }
      }
      value.expectedRevision = availableSnapshot(state).revision;
      assertNoRetryWrite(db, () =>
        expectRetryError(
          () => writer.prepareRetryIntent(value),
          'RetryLineageConflict',
        ),
      );
    }));
}

test('V2-08 deterministic admission separates stale revision, fresh cross-scope/family URL overlap and period gates', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer, db } = retryFixture(f);
    const stale = retryInput(state);
    newIntent(ordinary, {
      ...input('other-family-hold'),
      budget: {
        ...input().budget,
        budgetScope: 'elsewhere',
        periodId: 'other',
        periodStartMs: 2000,
      },
      taskFamily: 'backlink/checker',
      providerRoute: '/v2/task/backlink/checker/create',
      submittedUrls: [parentUrls[0]!],
    });
    assertNoRetryWrite(db, () =>
      expectRetryError(
        () => writer.prepareRetryIntent(stale),
        'SnapshotConflict',
      ),
    );
    const fresh = {
      ...stale,
      expectedRevision: availableSnapshot(state).revision,
    };
    assertNoRetryWrite(db, () =>
      expectLedgerError(() => writer.prepareRetryIntent(fresh), 'UrlOverlap'),
    );
    expect(ordinary.cancelPrepared(binding, 'other-family-hold', 0).kind).toBe(
      'cancelled',
    );
    newIntent(ordinary, {
      ...input('period-control'),
      budget: { ...input().budget, budgetScope: 'retry-scope' },
      submittedUrls: ['https://example.test/period-control'],
    });
    const badPeriod = retryInput(state, 'bad-period');
    badPeriod.intent.budget.periodId = 'old';
    badPeriod.intent.budget.periodStartMs = 0;
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () => writer.prepareRetryIntent(badPeriod),
        'StalePeriodContext',
      ),
    );
  }));

for (const unit of ['tokens', 'indexer', 'checker'] as const) {
  test(`V2-08 fresh revision reaches independent ${unit} cap without partial reservations`, () =>
    snapshotCase((f) => {
      const { state, ordinary, writer, db } = retryFixture(f);
      const held = {
        ...input('cap-hold'),
        budget: { ...input().budget, budgetScope: 'retry-scope' },
        submittedUrls: ['https://example.test/cap-hold'],
      };
      newIntent(ordinary, held);
      const value = retryInput(state);
      value.intent.budget.caps = {
        ...value.intent.budget.caps,
        [unit]: held.reservation[unit] + value.intent.reservation[unit] - 1,
      };
      assertNoRetryWrite(db, () => {
        let caught: unknown;
        try {
          writer.prepareRetryIntent(value);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SubmissionLedgerError);
        expect((caught as SubmissionLedgerError).code).toBe('BudgetExceeded');
        expect((caught as SubmissionLedgerError).unit).toBe(unit);
        expect((caught as SubmissionLedgerError).message).toBe(
          new SubmissionLedgerError('BudgetExceeded', unit).message,
        );
      });
    }));
}

test('V2-08 injected synchronous before-context exception rolls back actual core, URLs, event, period and reservation', () =>
  snapshotCase((f) => {
    const phases: string[] = [];
    const { state, writer, db } = retryFixture(f, {
      onPhase(phase) {
        phases.push(phase);
        throw new Error('owned private fault detail');
      },
    });
    const value = retryInput(state);
    value.intent.budget.budgetScope = 'new-rollback-scope';
    value.intent.budget.periodId = 'new-rollback-period';
    value.intent.budget.periodStartMs = 3000;
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () => writer.prepareRetryIntent(value),
        'LedgerUnavailable',
      ),
    );
    expect(phases).toEqual(['before_context']);
    expect(
      db
        .query('SELECT 1 FROM intents WHERE request_id=?')
        .get(value.intent.requestId),
    ).toBeNull();
    expect(
      db
        .query('SELECT 1 FROM intent_context WHERE request_id=?')
        .get(value.intent.requestId),
    ).toBeNull();
    expect(
      db
        .query('SELECT 1 FROM budget_periods WHERE budget_scope=?')
        .get('new-rollback-scope'),
    ).toBeNull();
    expect(availableSnapshot(state).acceptedManifests.length).toBe(1);
    expect(availableSnapshot(state).retryChildren).toEqual([]);
  }));

for (const status of ['dispatching', 'unknown'] as const) {
  test(`V2-09 fresh valid different parent reaches ${status} no-ID retry barrier while exact replay and ordinary creates survive`, () =>
    snapshotCase((f) => {
      const { state, ordinary, writer, db } = retryFixture(f);
      seedRetryParent(ordinary, 'other-parent', ' Other-parent ', [
        'https://example.test/other/1',
        'https://example.test/other/2',
      ]);
      const value = retryInput(state);
      const child = createRetry(writer, value);
      const claim = claimRetry(writer, child);
      if (status === 'unknown')
        writer.recordDispatchOutcome({
          credentialFingerprint: binding,
          requestId: value.intent.requestId,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome: { kind: 'unknown' },
        });
      const fresh = retryInput(state, 'different-parent', ' Other-parent ');
      assertNoRetryWrite(db, () =>
        expectRetryError(
          () => writer.prepareRetryIntent(fresh),
          'UnknownRetryDispatch',
        ),
      );
      assertNoRetryWrite(db, () =>
        expect(writer.prepareRetryIntent(value).kind).toBe('replay'),
      );
      const snap = availableSnapshot(state);
      expect(snap.retryChildren[0]!.state).toBe(status);
      expect(snap.retryChildren[0]!.providerTaskId).toBeNull();
      expect(
        snap.unresolvedHistory.find(
          (row) => row.requestId === value.intent.requestId,
        )!.reservation,
      ).toEqual({ tokens: '3', indexer: '2', checker: '1' });
      newIntent(ordinary, {
        ...input('ordinary-still-allowed'),
        submittedUrls: ['https://example.test/ordinary-unique'],
      });
      expectLedgerError(
        () =>
          ordinary.prepareIntent({
            ...input('ordinary-overlap'),
            budget: { ...input().budget, budgetScope: 'elsewhere' },
            submittedUrls: [value.intent.submittedUrls[0]!],
          }),
        'UrlOverlap',
      );
    }));
}

for (const status of ['prepared', 'rejected', 'cancelled'] as const) {
  test(`V2-09 ${status} retry context is retained without inventing a dispatched-unknown barrier`, () =>
    snapshotCase((f) => {
      const { state, writer } = retryFixture(f);
      const value = retryInput(state);
      value.intent.submittedUrls = parentUrls.slice(0, 1);
      const child = createRetry(writer, value);
      if (status === 'cancelled')
        writer.cancelPrepared(binding, value.intent.requestId, 0);
      if (status === 'rejected') {
        const claim = claimRetry(writer, child);
        writer.recordDispatchOutcome({
          credentialFingerprint: binding,
          requestId: value.intent.requestId,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome: { kind: 'rejected' },
        });
      }
      const next = retryInput(state, 'next');
      next.intent.submittedUrls =
        status === 'prepared'
          ? parentUrls.slice(2, 3)
          : value.intent.submittedUrls;
      createRetry(writer, next);
      const snap = availableSnapshot(state);
      expect(snap.retryChildren.length).toBe(2);
      expect(
        snap.retryChildren.find(
          (row) => row.requestId === value.intent.requestId,
        )!.state,
      ).toBe(status);
      expect(
        snap.holds.some((row) => row.requestId === value.intent.requestId),
      ).toBe(status === 'prepared');
    }));
}

test('V2-09 owner-token, family and duplicate ACK guards leave retry dispatch/context/events/three-unit holds intact until one legitimate result', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer, db } = retryFixture(f);
    seedRetryParent(ordinary, 'another-ack', ' Another-ACK ', [
      'https://example.test/another-ack',
    ]);
    const value = retryInput(state);
    const child = createRetry(writer, value);
    const secondValue = retryInput(state, 'second-owner');
    secondValue.intent.submittedUrls = parentUrls.slice(2, 3);
    const second = createRetry(writer, secondValue);
    const claim = claimRetry(writer, child);
    const otherClaim = claimRetry(writer, second);
    const outcome = {
      credentialFingerprint: binding,
      requestId: value.intent.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome: {
        kind: 'accepted' as const,
        providerType: value.intent.taskFamily,
        providerTaskId: ' Another-ACK ',
      },
    };
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () =>
          writer.recordDispatchOutcome({
            ...outcome,
            outcomeToken: otherClaim.outcomeToken,
          }),
        'DispatchOutcomeClaimLost',
      ),
    );
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () =>
          writer.recordDispatchOutcome({
            ...outcome,
            outcome: { ...outcome.outcome, providerType: 'yandex/indexer' },
          }),
        'ProviderTypeMismatch',
      ),
    );
    assertNoRetryWrite(db, () =>
      expectRetryError(
        () => writer.recordDispatchOutcome(outcome),
        'RetryLineageConflict',
      ),
    );
    const unresolved = availableSnapshot(state);
    const history = unresolved.unresolvedHistory.find(
      (row) => row.requestId === value.intent.requestId,
    )!;
    expect(history.state).toBe('dispatching');
    expect(history.reservation).toEqual({
      tokens: '3',
      indexer: '2',
      checker: '1',
    });
    expect(history.events.map((row) => row.kind)).toEqual([
      'prepared',
      'dispatching',
    ]);
    expect(history.urls.map((row) => row.url)).toEqual([
      ...value.intent.submittedUrls,
    ]);
    expect(
      unresolved.retryChildren.find(
        (row) => row.requestId === value.intent.requestId,
      )!.providerTaskId,
    ).toBeNull();
    const accepted = {
      ...outcome,
      outcome: { ...outcome.outcome, providerTaskId: ' Child-é-accepted ' },
    };
    expect(writer.recordDispatchOutcome(accepted).state).toBe('accepted');
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () => writer.recordDispatchOutcome(accepted),
        'DispatchOutcomeClaimLost',
      ),
    );
    const joined = availableSnapshot(state);
    const relation = joined.retryChildren.find(
      (row) => row.requestId === value.intent.requestId,
    )!;
    expect(relation.state).toBe('accepted');
    expect(relation.providerTaskId).toBe(' Child-é-accepted ');
    expect(relation.parentTaskId).toBe(' Parent-é ');
    expect(
      joined.acceptedManifests.find(
        (row) => row.providerTaskId === ' Child-é-accepted ',
      )!.originKind,
    ).toBe('retry');
  }));

test('V2-09 self-parent ACK is rejected even without any other accepted local provider row; exact opaque identity is preserved', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer, db } = retryFixture(f);
    const value = {
      ...input('external-looking-context'),
      submittedUrls: ['https://example.test/external-looking'],
    };
    const prepared = newIntent(ordinary, value);
    // Controlled complete valid context, not an external-admission API. No local
    // accepted parent row exists, so this isolates self-parent from duplicate guard.
    db.query(
      `UPDATE intent_context SET origin_kind='retry',parent_family='google/indexer',parent_task_id=?,source_manifest_digest=?,plan_fingerprint=? WHERE request_id=?`,
    ).run(
      ' External-é ',
      hash('external-manifest'),
      hash('external-plan'),
      value.requestId,
    );
    expect(
      db
        .query(
          "SELECT 1 FROM intents WHERE state='accepted' AND provider_task_id=' External-é '",
        )
        .get(),
    ).toBeNull();
    const claim = claimRetry(writer, prepared);
    const outcome = {
      credentialFingerprint: binding,
      requestId: value.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome: {
        kind: 'accepted' as const,
        providerType: value.taskFamily,
        providerTaskId: ' External-é ',
      },
    };
    assertNoRetryWrite(db, () =>
      expectRetryError(
        () => writer.recordDispatchOutcome(outcome),
        'RetryLineageConflict',
      ),
    );
    const snap = availableSnapshot(state);
    expect(snap.retryChildren[0]!.state).toBe('dispatching');
    expect(snap.retryChildren[0]!.parentTaskId).toBe(' External-é ');
    expect(
      snap.holds.find((row) => row.requestId === value.requestId)!.urls[0]!.url,
    ).toBe(value.submittedUrls[0]!);
    // Distinct surrounding whitespace remains distinct; no ID trimming/casefolding.
    expect(
      writer.recordDispatchOutcome({
        ...outcome,
        outcome: { ...outcome.outcome, providerTaskId: 'External-é' },
      }).state,
    ).toBe('accepted');
    expect(availableSnapshot(state).retryChildren[0]!.providerTaskId).toBe(
      'External-é',
    );
  }));

for (const version of [1, 2] as const) {
  test(`V2-09 ordinary V${version} duplicate ACK behavior preserves V1 compatibility and V2 held-state guard`, () =>
    snapshotCase((f) => {
      const state = join(f.root, 'state');
      const ledger = f.init(state, version);
      seedRetryParent(ledger);
      const value = {
        ...input('ordinary-duplicate'),
        submittedUrls: ['https://example.test/ordinary-duplicate'],
      };
      const prepared = newIntent(ledger, value);
      const claim = claimRetry(ledger, prepared);
      const db = f.raw(state);
      const outcome = {
        credentialFingerprint: binding,
        requestId: value.requestId,
        expectedStateVersion: 1,
        outcomeToken: claim.outcomeToken,
        outcome: {
          kind: 'accepted' as const,
          providerType: value.taskFamily,
          providerTaskId: ' Parent-é ',
        },
      };
      if (version === 1) {
        expect(ledger.recordDispatchOutcome(outcome).state).toBe('accepted');
        expect(
          (
            db
              .query(
                "SELECT COUNT(*) AS n FROM intents WHERE state='accepted' AND provider_task_id=' Parent-é '",
              )
              .get() as { n: number }
          ).n,
        ).toBe(2);
      } else {
        assertNoRetryWrite(db, () =>
          expectRetryError(
            () => ledger.recordDispatchOutcome(outcome),
            'RetryLineageConflict',
          ),
        );
        expect(ledger.readIntent(binding, value.requestId)!.state).toBe(
          'dispatching',
        );
        expect(
          availableSnapshot(state).holds.find(
            (row) => row.requestId === value.requestId,
          )!.urls[0]!.url,
        ).toBe(value.submittedUrls[0]!);
        expectLedgerError(
          () =>
            ledger.prepareIntent({
              ...input('overlap-after-conflict'),
              budget: { ...input().budget, budgetScope: 'other' },
              submittedUrls: value.submittedUrls,
            }),
          'UrlOverlap',
        );
        expect(
          ledger.recordDispatchOutcome({
            ...outcome,
            outcome: { ...outcome.outcome, providerTaskId: ' Parent-É ' },
          }).state,
        ).toBe('accepted');
      }
    }));
}

test('V2-09 V2 ACK association is scoped to exact binding and family, with no global provider-ID uniqueness', () =>
  snapshotCase((f) => {
    const { state, ordinary } = retryFixture(f);
    seedRetryParent(
      ordinary,
      'same-id-other-family',
      ' Parent-é ',
      ['https://example.test/other-family'],
      'yandex/indexer',
    );
    seedRetryParent(
      ordinary,
      'same-id-other-binding',
      ' Parent-é ',
      ['https://example.test/other-binding'],
      'google/indexer',
      'b'.repeat(64),
    );
    const snap = availableSnapshot(state);
    expect(
      snap.acceptedManifests.filter(
        (row) => row.providerTaskId === ' Parent-é ',
      ).length,
    ).toBe(2);
    expect(snap.ambiguousProviderRefs).toEqual([]);
    expect(
      availableSnapshot(state, {}, 'b'.repeat(64)).acceptedManifests[0]!
        .providerTaskId,
    ).toBe(' Parent-é ');
  }));

test('V2-09 an ordinary unknown remains visible but does not become the retry-only unknown dispatch barrier', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer } = retryFixture(f);
    seedSnapshotState(
      ordinary,
      {
        ...input('ordinary-unknown'),
        submittedUrls: ['https://example.test/ordinary-unknown'],
      },
      'unknown',
    );
    createRetry(writer, retryInput(state));
    const snap = availableSnapshot(state);
    expect(
      snap.unresolvedHistory.find(
        (row) => row.requestId === 'ordinary-unknown',
      )!.context.originKind,
    ).toBe('standalone');
    expect(snap.retryChildren.length).toBe(1);
  }));

test('V2-07 exact replay bypasses snapshot resource limits while new retry fails SnapshotLimitExceeded with no new rows', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer, db } = retryFixture(f);
    const value = retryInput(state);
    createRetry(writer, value);
    const large = {
      ...input('large-legacy-value'),
      submittedUrls: ['https://example.test/large-legacy-value'],
    };
    newIntent(ordinary, large);
    ordinary.cancelPrepared(binding, large.requestId, 0);
    db.query('UPDATE intents SET quote_version=? WHERE request_id=?').run(
      'x'.repeat(16 * 1024 * 1024 + 1),
      large.requestId,
    );
    expect(readRetrySnapshot({ stateDirectory: state }, binding)).toEqual({
      availability: 'unavailable',
      reason: 'LimitExceeded',
    });
    const replay = writer.prepareRetryIntent({
      ...value,
      expectedRevision: hash('valid-stale-revision'),
    });
    expect(replay.kind).toBe('replay');
    expect('dispatchCapability' in replay).toBe(false);
    const before = db.query('SELECT COUNT(*) AS n FROM intents').get();
    const seq = db.query('SELECT * FROM sqlite_sequence').all();
    const freshId = {
      ...value,
      intent: {
        ...value.intent,
        requestId: 'resource-blocked',
        submittedUrls: parentUrls.slice(2, 3),
      },
    };
    expectRetryError(
      () => writer.prepareRetryIntent(freshId),
      'SnapshotLimitExceeded',
      'LimitExceeded',
    );
    expect(db.query('SELECT COUNT(*) AS n FROM intents').get()).toEqual(before);
    expect(db.query('SELECT * FROM sqlite_sequence').all()).toEqual(seq);
    expect(
      db
        .query(
          "SELECT 1 FROM intent_context WHERE request_id='resource-blocked'",
        )
        .get(),
    ).toBeNull();
    expect(
      (
        db
          .query(
            'SELECT length(quote_version) AS n FROM intents WHERE request_id=?',
          )
          .get(large.requestId) as { n: number }
      ).n,
    ).toBe(16 * 1024 * 1024 + 1);
    writer.close();
    const reopened = f.track(openRetryLedgerV2({ stateDirectory: state }));
    const replayAfterReopen = reopened.prepareRetryIntent(value);
    expect(replayAfterReopen.kind).toBe('replay');
    expect('dispatchCapability' in replayAfterReopen).toBe(false);
  }));

test('V2-08 selected malformed scalar maps to fixed SnapshotUnavailable; replay still rejects corrupted context', () =>
  snapshotCase((f) => {
    const { state, ordinary, writer, db } = retryFixture(f);
    const value = retryInput(state);
    createRetry(writer, value);
    newIntent(ordinary, {
      ...input('malformed-scalar'),
      submittedUrls: ['https://example.test/malformed'],
    });
    db.run(
      "UPDATE intents SET quote_version=X'' WHERE request_id='malformed-scalar'",
    );
    const freshId = {
      ...value,
      intent: {
        ...value.intent,
        requestId: 'malformed-blocked',
        submittedUrls: parentUrls.slice(2, 3),
      },
    };
    assertNoRetryWrite(db, () =>
      expectRetryError(
        () => writer.prepareRetryIntent(freshId),
        'SnapshotUnavailable',
        'InvalidState',
      ),
    );
    db.run(
      "UPDATE intents SET quote_version='restored' WHERE request_id='malformed-scalar'",
    );
    db.query('DELETE FROM intent_context WHERE request_id=?').run(
      value.intent.requestId,
    );
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () => writer.prepareRetryIntent(value),
        'LedgerUnavailable',
      ),
    );
  }));

test('V2-08 asynchronous trusted phase result is rejected and rolled back without crossing await', () =>
  snapshotCase((f) => {
    const { state, writer, db } = retryFixture(f, {
      onPhase: () => Promise.resolve(),
    });
    const value = retryInput(state);
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () => writer.prepareRetryIntent(value),
        'LedgerUnavailable',
      ),
    );
  }));

interface RetryProcessSetup {
  role:
    | 'verified'
    | 'verified_lock_wait'
    | 'retry'
    | 'ordinary'
    | 'claim'
    | 'cancel'
    | 'claim_pause'
    | 'outcome'
    | 'lock';
  stateDirectory: string;
  input: PrepareRetryIntentInput;
  ordinaryIntent?: PrepareIntentInput;
  capability?: DispatchCapability;
  pauseAt?: RetryLedgerPhase;
  verifiedUrls?: string[];
  clockAfterWait?: 'expiry' | 'utc';
}
interface RetryProcessMessage {
  event: 'ready' | 'phase' | 'result';
  phase?:
    | RetryLedgerPhase
    | 'claim_committed'
    | 'locked'
    | 'lock_waited'
    | 'prepare_attempt';
  kind?:
    | 'created'
    | 'replay'
    | 'claimed'
    | 'cancelled'
    | 'lost'
    | 'accepted'
    | 'error';
  code?: string;
  unit?: 'tokens' | 'indexer' | 'checker';
  capability?: boolean;
}
function spawnRetryProcess(home: string) {
  return Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      resolve('tests/fixtures/retry-admission-child.ts'),
    ],
    {
      cwd: process.cwd(),
      env: { HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
interface OwnedRetryProcess {
  process: ReturnType<typeof spawnRetryProcess>;
  role: RetryProcessSetup['role'];
  pauseAt: RetryLedgerPhase | null;
  messages: RetryProcessMessage[];
  waiters: {
    match: (m: RetryProcessMessage) => boolean;
    resolve: (m: RetryProcessMessage) => void;
    reject: (e: Error) => void;
  }[];
  stdoutDone?: Promise<void>;
  stderrDone?: Promise<string>;
  inputClosed: boolean;
  exitResult?: number;
  outputEnded: boolean;
}
async function retryProcessDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned retry process deadline exceeded.')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function retryControl(
  child: OwnedRetryProcess,
  command: 'GO' | 'RECORD' | 'RETRY',
  end = true,
) {
  await retryProcessDeadline(
    Promise.resolve(child.process.stdin.write(command + '\n')),
  );
  await retryProcessDeadline(Promise.resolve(child.process.stdin.flush()));
  if (end) {
    await retryProcessDeadline(Promise.resolve(child.process.stdin.end()));
    child.inputClosed = true;
  }
}
function waitRetryMessage(
  child: OwnedRetryProcess,
  match: (m: RetryProcessMessage) => boolean,
) {
  const found = child.messages.find(match);
  if (found) return Promise.resolve(found);
  if (child.outputEnded)
    return Promise.reject(
      new Error('Retry child ended before expected marker.'),
    );
  const pending = new Promise<RetryProcessMessage>((resolve, reject) => {
    child.waiters.push({ match, resolve, reject });
  });
  void pending.catch(() => {});
  return retryProcessDeadline(pending);
}
async function startRetryProcess(
  f: ReturnType<typeof fixture>,
  children: OwnedRetryProcess[],
  setup: RetryProcessSetup,
) {
  const home = join(f.root, `retry-child-home-${children.length}`);
  mkdirSync(home, { mode: 0o700 });
  const process = spawnRetryProcess(home);
  const child: OwnedRetryProcess = {
    process,
    role: setup.role,
    pauseAt: setup.pauseAt ?? null,
    messages: [],
    waiters: [],
    inputClosed: false,
    outputEnded: false,
  };
  children.push(child); // Registry owns PID before starting stream tasks or setup writes.
  child.stderrDone = new Response(process.stderr).text();
  void child.stderrDone.catch(() => {});
  child.stdoutDone = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 4096)
          throw new Error('Unexpected retry child output.');
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const message = JSON.parse(line) as RetryProcessMessage;
          if (
            Object.keys(message).some(
              (key) =>
                ![
                  'event',
                  'phase',
                  'kind',
                  'code',
                  'unit',
                  'capability',
                ].includes(key),
            ) ||
            !['ready', 'phase', 'result'].includes(message.event) ||
            (message.phase !== undefined &&
              ![
                'before_context',
                'after_prepare_commit',
                'before_accepted_commit',
                'after_accepted_commit',
                'claim_committed',
                'locked',
                'lock_waited',
                'prepare_attempt',
              ].includes(message.phase)) ||
            (message.kind !== undefined &&
              ![
                'created',
                'replay',
                'claimed',
                'cancelled',
                'lost',
                'accepted',
                'error',
              ].includes(message.kind)) ||
            (message.code !== undefined &&
              ![
                'RetryProofInvalid',
                'RetryProofExpired',
                'RetryPermissionDenied',
                'RetryObservationInvalid',
                'RetryCancelled',
                'SnapshotConflict',
                'SnapshotUnavailable',
                'SnapshotLimitExceeded',
                'RetryLineageConflict',
                'UnknownRetryDispatch',
                'LedgerBusy',
                'BudgetExceeded',
                'UrlOverlap',
                'StalePeriodContext',
                'LedgerUnavailable',
                'DispatchOutcomeClaimLost',
                'ProviderTypeMismatch',
                'InvalidLedgerInput',
                'OutcomePersistenceFailed',
                'UpgradeRequired',
                'RequestIdConflict',
              ].includes(message.code)) ||
            (message.unit !== undefined &&
              !['tokens', 'indexer', 'checker'].includes(message.unit)) ||
            (message.capability !== undefined &&
              typeof message.capability !== 'boolean')
          )
            throw new Error('Unexpected retry child protocol.');
          child.messages.push(message);
          if (child.messages.length > 16)
            throw new Error('Excess retry child output.');
          for (const waiter of [...child.waiters])
            if (waiter.match(message)) {
              child.waiters.splice(child.waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            }
        }
      }
      buffer += decoder.decode();
      if (buffer !== '') throw new Error('Unterminated retry child output.');
    } finally {
      child.outputEnded = true;
      for (const waiter of child.waiters.splice(0))
        waiter.reject(new Error('Retry child ended before expected marker.'));
      reader.releaseLock();
    }
  })();
  void child.stdoutDone.catch(() => {});
  await retryProcessDeadline(
    Promise.resolve(process.stdin.write(JSON.stringify(setup) + '\n')),
  );
  await retryProcessDeadline(Promise.resolve(process.stdin.flush()));
  await waitRetryMessage(child, (m) => m.event === 'ready');
  return child;
}
async function reapRetryProcess(child: OwnedRetryProcess) {
  if (child.process.exitCode === null && child.process.signalCode === null)
    child.process.kill('SIGKILL');
  child.exitResult = await retryProcessDeadline(child.process.exited);
}
async function finishRetryProcess(child: OwnedRetryProcess, killed = false) {
  if (killed) await reapRetryProcess(child);
  else child.exitResult = await retryProcessDeadline(child.process.exited);
  await retryProcessDeadline(child.stdoutDone!);
  expect(await retryProcessDeadline(child.stderrDone!)).toBe('');
  expect(child.exitResult).toBe(killed ? 137 : 0);
  expect(child.process.signalCode).toBe(killed ? 'SIGKILL' : null);
}
async function retryProcessResult(child: OwnedRetryProcess) {
  const result = await waitRetryMessage(child, (m) => m.event === 'result');
  await finishRetryProcess(child);
  return result;
}
async function retryProcessCase(
  body: (
    f: ReturnType<typeof fixture>,
    children: OwnedRetryProcess[],
  ) => Promise<void>,
) {
  const f = fixture();
  const children: OwnedRetryProcess[] = [];
  let verified = false;
  const failures: unknown[] = [];
  try {
    await body(f, children);
    verified = true;
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await closeRetryProcessFixture(f, children, verified);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Retry case and cleanup failed; owned root preserved.',
    );
}
async function closeRetryProcessFixture(
  f: ReturnType<typeof fixture>,
  children: OwnedRetryProcess[],
  verified: boolean,
) {
  const failures: unknown[] = [];
  const reaped = await Promise.allSettled(children.map(reapRetryProcess));
  for (const result of reaped)
    if (result.status === 'rejected') failures.push(result.reason);
  const settled = await Promise.allSettled(
    children.map(async (child, index) => {
      const streams = await Promise.allSettled([
        retryProcessDeadline(
          (async () => {
            if (!child.inputClosed) {
              await child.process.stdin.end();
              child.inputClosed = true;
            }
          })(),
        ),
        retryProcessDeadline<void | string>(
          child.stdoutDone ?? new Response(child.process.stdout).text(),
        ),
        retryProcessDeadline(
          child.stderrDone ?? new Response(child.process.stderr).text(),
        ),
      ]);
      for (const result of streams)
        if (result.status === 'rejected') failures.push(result.reason);
      if (streams[2]?.status === 'fulfilled' && streams[2].value !== '')
        failures.push(new Error('Retry child stderr was not empty.'));
      console.info(
        'V2-RETRY_PROCESS ' +
          JSON.stringify({
            pid: child.process.pid,
            role: child.role,
            pauseAt: child.pauseAt,
            signal: child.process.signalCode,
            exitResult: child.exitResult,
            reaped: reaped[index]?.status === 'fulfilled',
            inputClosed: child.inputClosed,
            stdoutSettled: streams[1]?.status === 'fulfilled',
            stderrSettled: streams[2]?.status === 'fulfilled',
            messages: child.messages,
          }),
      );
    }),
  );
  for (const result of settled)
    if (result.status === 'rejected') failures.push(result.reason);
  try {
    f.cleanup(verified && failures.length === 0);
  } catch (error) {
    failures.push(error);
  }
  const removed = !existsSync(f.root);
  if (verified && failures.length === 0 && !removed)
    failures.push(new Error('Owned retry root was not removed.'));
  console.info(
    'V2-RETRY_CLEANUP ' +
      JSON.stringify({
        ownedRoot: f.root,
        removed,
        children: children.length,
        failures: failures.length,
      }),
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Retry process cleanup failed; owned root preserved.',
    );
}
function retryProcessProjection(db: Database) {
  return {
    core: exactCoreRows(db),
    contexts: db
      .query('SELECT * FROM intent_context ORDER BY credential_fp,request_id')
      .all(),
    meta: db.query('SELECT * FROM retry_ledger_meta').all(),
    schema: db
      .query(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name',
      )
      .all(),
    version: db.query('PRAGMA user_version').get(),
  };
}
function expectProcessOriginalsPreserved(
  before: ReturnType<typeof retryProcessProjection>,
  after: ReturnType<typeof retryProcessProjection>,
  value: PrepareRetryIntentInput,
) {
  expect(after.meta).toEqual(before.meta);
  expect(after.schema).toEqual(before.schema);
  expect(after.version).toEqual(before.version);
  expect(
    after.contexts.filter(
      (row) =>
        (row as { request_id: string }).request_id !== value.intent.requestId,
    ),
  ).toEqual(before.contexts);
  expect(
    after.contexts.find(
      (row) =>
        (row as { request_id: string }).request_id === value.intent.requestId,
    ),
  ).toEqual({
    credential_fp: binding,
    request_id: value.intent.requestId,
    origin_kind: 'retry',
    parent_family: value.parent.family,
    parent_task_id: value.parent.taskId,
    source_manifest_digest: value.sourceManifestDigest,
    plan_fingerprint: value.planFingerprint,
  });
  for (const table of ['intents', 'intent_urls', 'intent_events'])
    expect(
      (after.core[table] as Record<string, unknown>[]).filter(
        (row) => row.request_id !== value.intent.requestId,
      ),
    ).toEqual(before.core[table] as Record<string, unknown>[]);
  expect(
    (after.core.budget_periods as Record<string, unknown>[]).filter(
      (row) => row.budget_scope !== value.intent.budget.budgetScope,
    ),
  ).toEqual(before.core.budget_periods as Record<string, unknown>[]);
}
function strictRetryReopen(f: ReturnType<typeof fixture>, state: string) {
  const reopened = f.track(openRetryLedgerV2({ stateDirectory: state }));
  expect(availableSnapshot(state).schemaVersion).toBe(2);
  return reopened;
}
function prepareProcessCrashFixture(f: ReturnType<typeof fixture>) {
  const setup = retryFixture(f);
  seedRetryParent(setup.ordinary, 'other-parent', ' Other-parent ', [
    'https://example.test/other-process/1',
    'https://example.test/other-process/2',
  ]);
  setup.ordinary.close();
  setup.writer.close();
  setup.db.run('UPDATE intent_events SET event_id=event_id+9007199254740992');
  setup.db.run('UPDATE sqlite_sequence SET seq=9007199254745999');
  const value = retryInput(setup.state);
  value.intent.budget = {
    ...value.intent.budget,
    budgetScope: 'process-retry-scope',
    periodId: 'process-period',
    periodStartMs: 3000,
  };
  return { ...setup, value };
}

test('V2-08 process same-ID READY/GO race creates one retry and returns one exact replay without a second capability', () =>
  retryProcessCase(async (f, children) => {
    const { state, db } = retryFixture(f);
    const value = retryInput(state);
    const a = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: value,
    });
    const b = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: value,
    });
    await Promise.all([retryControl(a, 'GO'), retryControl(b, 'GO')]);
    const results = await Promise.all([
      retryProcessResult(a),
      retryProcessResult(b),
    ]);
    expect(results.map((row) => row.kind).sort()).toEqual([
      'created',
      'replay',
    ]);
    expect(results.map((row) => row.capability).sort()).toEqual([false, true]);
    const writer = strictRetryReopen(f, state);
    const snap = availableSnapshot(state);
    expect(snap.retryChildren.length).toBe(1);
    expect(snap.holds.length).toBe(1);
    expect(snap.holds[0]!.urls.map((row) => row.url)).toEqual([
      ...value.intent.submittedUrls,
    ]);
    expect(snap.unresolvedHistory[0]!.reservation).toEqual({
      tokens: '3',
      indexer: '2',
      checker: '1',
    });
    expect(
      (
        db
          .query('SELECT COUNT(*) AS n FROM intents WHERE request_id=?')
          .get(value.intent.requestId) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        db
          .query('SELECT COUNT(*) AS n FROM intent_events WHERE request_id=?')
          .get(value.intent.requestId) as { n: number }
      ).n,
    ).toBe(1);
    assertNoRetryWrite(db, () => {
      const replay = writer.prepareRetryIntent(value);
      expect(replay.kind).toBe('replay');
      expect('dispatchCapability' in replay).toBe(false);
    });
  }));

test('V2-08 process different-ID shared revision reaches exact SnapshotConflict after first commit and lock settlement', () =>
  retryProcessCase(async (f, children) => {
    const { state, db } = retryFixture(f);
    const first = retryInput(state);
    const second = {
      ...first,
      intent: { ...first.intent, requestId: 'second-id' },
    };
    const a = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: first,
    });
    const b = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: second,
    });
    await retryControl(a, 'GO');
    expect((await retryProcessResult(a)).kind).toBe('created');
    const before = retryProcessProjection(db);
    await retryControl(b, 'GO');
    expect(await retryProcessResult(b)).toEqual({
      event: 'result',
      kind: 'error',
      code: 'SnapshotConflict',
    });
    strictRetryReopen(f, state);
    expect(retryProcessProjection(db)).toEqual(before);
  }));

test(
  'V2-08 process retained writer lock reaches exact LedgerBusy separately from stale revision and overlap',
  () =>
    retryProcessCase(async (f, children) => {
      const { state, db } = retryFixture(f);
      const value = retryInput(state);
      const before = retryProcessProjection(db);
      const writer = await startRetryProcess(f, children, {
        role: 'retry',
        stateDirectory: state,
        input: value,
      });
      const lock = await startRetryProcess(f, children, {
        role: 'lock',
        stateDirectory: state,
        input: value,
      });
      await retryControl(lock, 'GO');
      await waitRetryMessage(lock, (m) => m.phase === 'locked');
      await retryControl(writer, 'GO');
      expect(await retryProcessResult(writer)).toEqual({
        event: 'result',
        kind: 'error',
        code: 'LedgerBusy',
      });
      await finishRetryProcess(lock, true);
      strictRetryReopen(f, state);
      expect(retryProcessProjection(db)).toEqual(before);
    }),
  15000,
);

for (const unit of ['tokens', 'indexer', 'checker'] as const) {
  test(`V2-08 process fresh revision and disjoint URLs reach exact ${unit} BudgetExceeded`, () =>
    retryProcessCase(async (f, children) => {
      const { state, db } = retryFixture(f);
      const first = retryInput(state);
      first.intent.submittedUrls = parentUrls.slice(0, 1);
      first.intent.budget.caps = {
        ...first.intent.budget.caps,
        [unit]: first.intent.reservation[unit] * 2 - 1,
      };
      const a = await startRetryProcess(f, children, {
        role: 'retry',
        stateDirectory: state,
        input: first,
      });
      await retryControl(a, 'GO');
      expect((await retryProcessResult(a)).kind).toBe('created');
      const second = retryInput(state, 'cap-second');
      second.intent.submittedUrls = parentUrls.slice(1, 2);
      second.intent.budget.caps = first.intent.budget.caps;
      const before = retryProcessProjection(db);
      const b = await startRetryProcess(f, children, {
        role: 'retry',
        stateDirectory: state,
        input: second,
      });
      await retryControl(b, 'GO');
      expect(await retryProcessResult(b)).toEqual({
        event: 'result',
        kind: 'error',
        code: 'BudgetExceeded',
        unit,
      });
      strictRetryReopen(f, state);
      expect(retryProcessProjection(db)).toEqual(before);
    }));
}

test('V2-08 process ordinary V2 commit between snapshot and retry invalidates revision and preserves atomic standalone history', () =>
  retryProcessCase(async (f, children) => {
    const { state, db } = retryFixture(f);
    const stale = retryInput(state);
    const retry = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: stale,
    });
    const ordinary = await startRetryProcess(f, children, {
      role: 'ordinary',
      stateDirectory: state,
      input: stale,
      ordinaryIntent: {
        ...input('ordinary-between'),
        submittedUrls: ['https://example.test/ordinary-between'],
      },
    });
    await retryControl(ordinary, 'GO');
    expect(await retryProcessResult(ordinary)).toEqual({
      event: 'result',
      kind: 'created',
      capability: true,
    });
    const before = retryProcessProjection(db);
    await retryControl(retry, 'GO');
    expect(await retryProcessResult(retry)).toEqual({
      event: 'result',
      kind: 'error',
      code: 'SnapshotConflict',
    });
    expect(retryProcessProjection(db)).toEqual(before);
    const snap = availableSnapshot(state);
    expect(snap.revision).not.toBe(stale.expectedRevision);
    expect(
      snap.unresolvedHistory.find(
        (row) => row.requestId === 'ordinary-between',
      )!.context.originKind,
    ).toBe('standalone');
    expect(
      snap.unresolvedHistory
        .find((row) => row.requestId === 'ordinary-between')!
        .events.map((row) => row.kind),
    ).toEqual(['prepared']);
    const fresh = await startRetryProcess(f, children, {
      role: 'retry',
      stateDirectory: state,
      input: retryInput(state),
    });
    await retryControl(fresh, 'GO');
    expect((await retryProcessResult(fresh)).kind).toBe('created');
    strictRetryReopen(f, state);
  }));

for (const pauseAt of ['before_context', 'after_prepare_commit'] as const) {
  test(`V2-08 process kill ${pauseAt} proves native prepare atomicity and lost-capability retention`, () =>
    retryProcessCase(async (f, children) => {
      const { state, db, value } = prepareProcessCrashFixture(f);
      const before = retryProcessProjection(db);
      const child = await startRetryProcess(f, children, {
        role: 'retry',
        stateDirectory: state,
        input: value,
        pauseAt,
      });
      await retryControl(child, 'GO');
      await waitRetryMessage(child, (m) => m.phase === pauseAt);
      await finishRetryProcess(child, true);
      expect(child.messages.some((row) => row.event === 'result')).toBe(false);
      const reopened = strictRetryReopen(f, state);
      if (pauseAt === 'before_context') {
        expect(retryProcessProjection(db)).toEqual(before);
        expect(reopened.readIntent(binding, value.intent.requestId)).toBeNull();
        expect(availableSnapshot(state).retryChildren).toEqual([]);
      } else {
        const snap = availableSnapshot(state);
        expect(snap.retryChildren).toHaveLength(1);
        expect(snap.retryChildren[0]!.state).toBe('prepared');
        expect(snap.retryChildren[0]!.parentTaskId).toBe(value.parent.taskId);
        expect(snap.holds[0]!.urls.map((row) => row.url)).toEqual([
          ...value.intent.submittedUrls,
        ]);
        expect(
          snap.unresolvedHistory[0]!.events.map((row) => row.kind),
        ).toEqual(['prepared']);
        expect(snap.unresolvedHistory[0]!.reservation).toEqual({
          tokens: '3',
          indexer: '2',
          checker: '1',
        });
        const after = retryProcessProjection(db);
        expectProcessOriginalsPreserved(before, after, value);
        expect(after.contexts.length).toBe(before.contexts.length + 1);
        expect(after.core.budget_periods!.length).toBe(
          before.core.budget_periods!.length + 1,
        );
        const row = (after.core.intents as Record<string, unknown>[]).find(
          (row) => row.request_id === value.intent.requestId,
        )!;
        expect(row.created_at_ms).toMatch(/^-?\d+$/);
        expect(row.claim_token_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(row).toEqual({
          _rowid: row._rowid,
          credential_fp: binding,
          request_id: value.intent.requestId,
          budget_scope: value.intent.budget.budgetScope,
          period_id: value.intent.budget.periodId,
          period_start_ms: String(value.intent.budget.periodStartMs),
          policy_revision: value.intent.budget.policyRevision,
          policy_digest: value.intent.budget.policyDigest,
          task_family: value.intent.taskFamily,
          provider_route: value.intent.providerRoute,
          payload_digest: value.intent.payloadDigest,
          quote_version: value.intent.quoteVersion,
          quote_fingerprint: value.intent.quoteFingerprint,
          reserved_tokens: '3',
          reserved_indexer: '2',
          reserved_checker: '1',
          state: 'prepared',
          state_version: '0',
          claim_token_digest: row.claim_token_digest,
          dispatch_outcome_token_digest: null,
          created_at_ms: row.created_at_ms,
          provider_task_id: null,
          provider_type: null,
        });
        const oldSeq = (before.core.sqlite_sequence as { seq: string }[])[0]!
          .seq;
        const nextId = (BigInt(oldSeq) + 1n).toString();
        const newEvents = (
          after.core.intent_events as Record<string, unknown>[]
        ).filter((row) => row.request_id === value.intent.requestId);
        expect(newEvents.length).toBe(1);
        expect(newEvents[0]).toMatchObject({
          _rowid: nextId,
          event_id: nextId,
          credential_fp: binding,
          request_id: value.intent.requestId,
          state_version: '0',
          event_kind: 'prepared',
          provider_task_id: null,
          provider_type: null,
        });
        expect(newEvents[0]!.occurred_at_ms).toMatch(/^-?\d+$/);
        expect((after.core.sqlite_sequence as { seq: string }[])[0]!.seq).toBe(
          nextId,
        );
        assertNoRetryWrite(db, () => {
          const replay = reopened.prepareRetryIntent(value);
          expect(replay.kind).toBe('replay');
          expect('dispatchCapability' in replay).toBe(false);
        });
      }
    }));
}

test('V2-09 process death immediately after durable retry claim retains unknown dispatch barrier, units and ownership', () =>
  retryProcessCase(async (f, children) => {
    const { state, db, value } = prepareProcessCrashFixture(f);
    const originals = retryProcessProjection(db);
    const child = await startRetryProcess(f, children, {
      role: 'claim_pause',
      stateDirectory: state,
      input: value,
    });
    await retryControl(child, 'GO');
    await waitRetryMessage(child, (m) => m.phase === 'claim_committed');
    await finishRetryProcess(child, true);
    const reopened = strictRetryReopen(f, state);
    expectProcessOriginalsPreserved(
      originals,
      retryProcessProjection(db),
      value,
    );
    expect(
      (retryProcessProjection(db).core.sqlite_sequence as { seq: string }[])[0]!
        .seq,
    ).toBe(
      (
        BigInt((originals.core.sqlite_sequence as { seq: string }[])[0]!.seq) +
        2n
      ).toString(),
    );
    const snap = availableSnapshot(state);
    expect(snap.retryChildren[0]!.state).toBe('dispatching');
    expect(snap.retryChildren[0]!.providerTaskId).toBeNull();
    expect(snap.unresolvedHistory[0]!.events.map((row) => row.kind)).toEqual([
      'prepared',
      'dispatching',
    ]);
    expect(snap.unresolvedHistory[0]!.reservation).toEqual({
      tokens: '3',
      indexer: '2',
      checker: '1',
    });
    expect(snap.holds[0]!.urls.map((row) => row.url)).toEqual([
      ...value.intent.submittedUrls,
    ]);
    const fresh = retryInput(state, 'different-parent', ' Other-parent ');
    assertNoRetryWrite(db, () =>
      expectRetryError(
        () => reopened.prepareRetryIntent(fresh),
        'UnknownRetryDispatch',
      ),
    );
    assertNoRetryWrite(db, () => {
      const replay = reopened.prepareRetryIntent(value);
      expect(replay.kind).toBe('replay');
      expect('dispatchCapability' in replay).toBe(false);
      expect(
        reopened.cancelPrepared(binding, value.intent.requestId, 0),
      ).toEqual({ kind: 'lost' });
    });
    const wrong = newIntent(reopened, {
      ...input('wrong-owner'),
      submittedUrls: ['https://example.test/wrong-process-owner'],
    });
    const wrongClaim = claimRetry(reopened, wrong);
    assertNoRetryWrite(db, () =>
      expectLedgerError(
        () =>
          reopened.recordDispatchOutcome({
            credentialFingerprint: binding,
            requestId: value.intent.requestId,
            expectedStateVersion: 1,
            outcomeToken: wrongClaim.outcomeToken,
            outcome: { kind: 'unknown' },
          }),
        'DispatchOutcomeClaimLost',
      ),
    );
  }));

for (const pauseAt of [
  'before_accepted_commit',
  'after_accepted_commit',
] as const) {
  test(`V2-09 process kill ${pauseAt} preserves exact joined outcome at the native transaction boundary`, () =>
    retryProcessCase(async (f, children) => {
      const { state, db, value } = prepareProcessCrashFixture(f);
      const originals = retryProcessProjection(db);
      const child = await startRetryProcess(f, children, {
        role: 'outcome',
        stateDirectory: state,
        input: value,
        pauseAt,
      });
      await retryControl(child, 'GO', false);
      await waitRetryMessage(child, (m) => m.phase === 'claim_committed');
      const before = retryProcessProjection(db);
      expect(
        strictRetryReopen(f, state).readIntent(binding, value.intent.requestId)!
          .state,
      ).toBe('dispatching');
      await retryControl(child, 'RECORD');
      await waitRetryMessage(child, (m) => m.phase === pauseAt);
      await finishRetryProcess(child, true);
      expect(child.messages.some((row) => row.event === 'result')).toBe(false);
      const reopened = strictRetryReopen(f, state);
      expectProcessOriginalsPreserved(
        originals,
        retryProcessProjection(db),
        value,
      );
      const snap = availableSnapshot(state);
      if (pauseAt === 'before_accepted_commit') {
        expect(retryProcessProjection(db)).toEqual(before);
        expect(snap.retryChildren[0]!.state).toBe('dispatching');
        expect(snap.retryChildren[0]!.providerTaskId).toBeNull();
        expect(snap.holds[0]!.urls.map((row) => row.url)).toEqual([
          ...value.intent.submittedUrls,
        ]);
        expect(snap.unresolvedHistory[0]!.reservation).toEqual({
          tokens: '3',
          indexer: '2',
          checker: '1',
        });
      } else {
        const after = retryProcessProjection(db);
        expect(after.contexts).toEqual(before.contexts);
        expect(after.meta).toEqual(before.meta);
        expect(after.schema).toEqual(before.schema);
        expect(after.core.budget_periods).toEqual(before.core.budget_periods);
        expect(after.core.intent_urls).toEqual(before.core.intent_urls);
        const oldRows = before.core.intents as Record<string, unknown>[];
        const newRows = after.core.intents as Record<string, unknown>[];
        expect(newRows).toEqual(
          oldRows.map((row) =>
            row.request_id === value.intent.requestId
              ? {
                  ...row,
                  state: 'accepted',
                  state_version: '2',
                  dispatch_outcome_token_digest: null,
                  provider_task_id: ' Process-child-é ',
                  provider_type: 'google/indexer',
                }
              : row,
          ),
        );
        const oldEvents = before.core.intent_events as Record<
          string,
          unknown
        >[];
        const newEvents = after.core.intent_events as Record<string, unknown>[];
        expect(newEvents.slice(0, -1)).toEqual(oldEvents);
        expect(newEvents.length).toBe(oldEvents.length + 1);
        const oldSeq = (before.core.sqlite_sequence as { seq: string }[])[0]!
          .seq;
        const nextId = (BigInt(oldSeq) + 1n).toString();
        expect(newEvents.at(-1)).toMatchObject({
          _rowid: nextId,
          event_id: nextId,
          credential_fp: binding,
          request_id: value.intent.requestId,
          state_version: '2',
          event_kind: 'accepted',
          provider_task_id: ' Process-child-é ',
          provider_type: 'google/indexer',
        });
        expect(newEvents.at(-1)!.occurred_at_ms).toMatch(/^-?\d+$/);
        expect((after.core.sqlite_sequence as { seq: string }[])[0]!.seq).toBe(
          nextId,
        );
        expect(snap.retryChildren[0]!.providerTaskId).toBe(' Process-child-é ');
        expect(snap.retryChildren[0]!.state).toBe('accepted');
        expect(snap.holds).toEqual([]);
        expect(
          snap.acceptedManifests.find(
            (row) => row.requestId === value.intent.requestId,
          )!.originKind,
        ).toBe('retry');
        const grandchild = retryInput(state, 'grandchild', ' Process-child-é ');
        assertNoRetryWrite(db, () =>
          expectRetryError(
            () => reopened.prepareRetryIntent(grandchild),
            'RetryLineageConflict',
          ),
        );
      }
      assertNoRetryWrite(db, () => {
        const replay = reopened.prepareRetryIntent(value);
        expect(replay.kind).toBe('replay');
        expect('dispatchCapability' in replay).toBe(false);
      });
    }));
}

test('V2-09 process prepared cancel versus claim race has one durable winner and truthful held units/context', () =>
  retryProcessCase(async (f, children) => {
    const { state, writer, db } = retryFixture(f);
    const value = retryInput(state);
    const prepared = createRetry(writer, value);
    const claim = await startRetryProcess(f, children, {
      role: 'claim',
      stateDirectory: state,
      input: value,
      capability: prepared.dispatchCapability,
    });
    const cancel = await startRetryProcess(f, children, {
      role: 'cancel',
      stateDirectory: state,
      input: value,
    });
    await Promise.all([retryControl(claim, 'GO'), retryControl(cancel, 'GO')]);
    const [claimed, cancelled] = await Promise.all([
      retryProcessResult(claim),
      retryProcessResult(cancel),
    ]);
    const reopened = strictRetryReopen(f, state);
    const snap = availableSnapshot(state);
    const relation = snap.retryChildren[0]!;
    if (cancelled.kind === 'cancelled') {
      expect(claimed.kind).toBe('lost');
      expect(relation.state).toBe('cancelled');
      expect(snap.holds).toEqual([]);
      expect(reopened.claimDispatch(prepared.dispatchCapability, 0)).toEqual({
        kind: 'lost',
      });
    } else {
      expect(cancelled.kind).toBe('lost');
      expect(claimed.kind).toBe('claimed');
      expect(relation.state).toBe('dispatching');
      expect(relation.providerTaskId).toBeNull();
      expect(snap.holds[0]!.urls.map((row) => row.url)).toEqual([
        ...value.intent.submittedUrls,
      ]);
      expect(snap.unresolvedHistory[0]!.reservation).toEqual({
        tokens: '3',
        indexer: '2',
        checker: '1',
      });
      expect(
        reopened.cancelPrepared(binding, value.intent.requestId, 0),
      ).toEqual({ kind: 'lost' });
      assertNoRetryWrite(db, () =>
        expectLedgerError(
          () =>
            reopened.recordDispatchOutcome({
              credentialFingerprint: binding,
              requestId: value.intent.requestId,
              expectedStateVersion: 1,
              outcomeToken:
                prepared.dispatchCapability as unknown as DispatchOutcomeToken,
              outcome: { kind: 'unknown' },
            }),
          'DispatchOutcomeClaimLost',
        ),
      );
    }
    expect(relation.parentTaskId).toBe(value.parent.taskId);
    expect(
      (
        db
          .query('SELECT COUNT(*) AS n FROM intent_context WHERE request_id=?')
          .get(value.intent.requestId) as { n: number }
      ).n,
    ).toBe(1);
    const held = db
      .query(
        `SELECT CAST(COALESCE(SUM(reserved_tokens),0) AS TEXT) AS tokens,CAST(COALESCE(SUM(reserved_indexer),0) AS TEXT) AS indexer,CAST(COALESCE(SUM(reserved_checker),0) AS TEXT) AS checker FROM intents WHERE request_id=? AND state IN ('prepared','dispatching','unknown')`,
      )
      .get(value.intent.requestId);
    expect(held).toEqual(
      cancelled.kind === 'cancelled'
        ? { tokens: '0', indexer: '0', checker: '0' }
        : { tokens: '3', indexer: '2', checker: '1' },
    );
    const events = db
      .query(
        'SELECT event_kind FROM intent_events WHERE request_id=? ORDER BY event_id',
      )
      .all(value.intent.requestId) as { event_kind: string }[];
    expect(events.map((row) => row.event_kind)).toEqual([
      'prepared',
      cancelled.kind === 'cancelled' ? 'cancelled' : 'dispatching',
    ]);
    console.info(
      'V2-RETRY_RACE ' +
        JSON.stringify({
          claim: claimed.kind,
          cancel: cancelled.kind,
          durableState: relation.state,
        }),
    );
  }));

function replayIdentity(value: PrepareRetryIntentInput): RetryReplayIdentity {
  return {
    intent: value.intent,
    parent: value.parent,
    sourceManifestDigest: value.sourceManifestDigest,
    planFingerprint: value.planFingerprint,
  };
}
function replayView(value: IntentView) {
  const { credentialFingerprint, ...view } = value;
  expect(credentialFingerprint).toBe(binding);
  return view;
}

const planningNow = Date.UTC(2026, 9, 21, 12);
function planningInput(requestId = 'planning'): RetryPlanningInput {
  const intent = input(requestId);
  intent.budget = {
    ...intent.budget,
    periodId: 'utc-day:2026-10-21',
    periodStartMs: Date.UTC(2026, 9, 21),
  };
  return {
    intent,
    parent: { family: 'google/indexer', taskId: ' Parent-é ' },
    maxAttemptsPerSource: 6,
  };
}
function planningRead(state: string, value = planningInput(), hooks = {}) {
  const result = readRetryPlanningState(
    { stateDirectory: state },
    binding,
    value,
    {
      now: () => planningNow,
      ...hooks,
    },
  );
  expect(result.availability).toBe('available');
  if (result.availability !== 'available')
    throw new Error('Expected planning inspection.');
  return result;
}

test('P0-03 coherent all-state lifetime counts ignore scope/policy/period but separate binding and exact parent family/ID', () =>
  snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ordinary = f.init(state);
    const urls = Array.from(
      { length: 8 },
      (_, i) => `https://example.test/read-parent/${i}`,
    );
    seedRetryParent(ordinary, 'read-parent', ' Parent-é ', urls);
    const writer = f.track(openRetryLedgerV2({ stateDirectory: state }));
    const states = [
      'prepared',
      'cancelled',
      'accepted',
      'rejected',
      'dispatching',
      'unknown',
    ] as const;
    const prepared = states.map((status, i) => {
      const value = retryInput(state, `read-${status}`);
      value.intent.submittedUrls = [urls[i]!];
      value.intent.budget = {
        ...value.intent.budget,
        budgetScope: `scope-${i}`,
        policyRevision: `policy-${i}`,
        periodId: `period-${i}`,
        periodStartMs: i,
      };
      return { status, value, result: createRetry(writer, value) };
    });
    for (const { status, value, result } of prepared) {
      if (status === 'prepared') continue;
      if (status === 'cancelled') {
        writer.cancelPrepared(binding, value.intent.requestId, 0);
        continue;
      }
      const claim = claimRetry(writer, result);
      if (status !== 'dispatching')
        writer.recordDispatchOutcome({
          credentialFingerprint: binding,
          requestId: value.intent.requestId,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome:
            status === 'accepted'
              ? {
                  kind: status,
                  providerTaskId: 'read-child',
                  providerType: value.intent.taskFamily,
                }
              : { kind: status },
        });
    }
    // Controls use real independent local-parent preparation before changing
    // their state; no fabricated external parent or provenance is introduced.
    const db = f.raw(state);
    // Existing unknown retry dispatch intentionally blocks fresh local preparation.
    // Count controls therefore use distinct bindings, where that barrier is absent.
    const otherBinding = 'b'.repeat(64);
    seedRetryParent(
      ordinary,
      'other-binding-parent',
      ' Parent-é ',
      ['https://example.test/other-binding'],
      'google/indexer',
      otherBinding,
    );
    const otherSnapshot = availableSnapshot(state, {}, otherBinding);
    const other = {
      ...retryInput(state, 'other-binding-retry'),
      expectedRevision: otherSnapshot.revision,
      sourceManifestDigest: otherSnapshot.acceptedManifests[0]!.manifestDigest,
    };
    other.intent = {
      ...other.intent,
      submittedUrls: ['https://example.test/other-binding'],
      budget: { ...other.intent.budget, credentialFingerprint: otherBinding },
    };
    createRetry(writer, other);
    const before = snapshot(db);
    const result = planningRead(state);
    expect(result.snapshot.retryChildren).toHaveLength(6);
    expect(result.decision.attempts).toEqual({
      count: 6,
      limit: 6,
      canCreate: false,
    });
    expect(result.snapshot.holds.map((row) => row.requestId).sort()).toEqual([
      'read-dispatching',
      'read-prepared',
      'read-unknown',
    ]);
    for (const parent of [
      { family: 'google/indexer' as const, taskId: 'Parent-é' },
      { family: 'yandex/indexer' as const, taskId: ' Parent-é ' },
    ]) {
      const value = planningInput();
      value.parent = parent;
      value.intent.taskFamily = parent.family;
      value.intent.providerRoute = `/v2/task/${parent.family}/create`;
      expect(planningRead(state, value).decision.attempts.count).toBe(0);
    }
    const lower = planningInput();
    lower.maxAttemptsPerSource = 5;
    expect(planningRead(state, lower).decision.attempts.canCreate).toBe(false);
    const greater = planningInput();
    greater.maxAttemptsPerSource = 7;
    expect(planningRead(state, greater).decision.attempts.canCreate).toBe(true);
    assertDeepFrozen(result);
    expect(JSON.stringify(result)).not.toContain(binding);
    expect(snapshot(db)).toEqual(before);
  }));

test('P0-03 exact three-unit usage includes current accepted and all-period unresolved in selected scope only', () =>
  snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    for (const [id, status, current, scope, selected] of [
      ['old-hold', 'unknown', false, 'synthetic', binding],
      ['old-accepted', 'accepted', false, 'synthetic', binding],
      ['current-accepted', 'accepted', true, 'synthetic', binding],
      ['released', 'rejected', true, 'synthetic', binding],
      ['other-scope', 'prepared', true, 'other', binding],
      ['other-key', 'prepared', true, 'synthetic', 'b'.repeat(64)],
    ] as const) {
      const value = planningInput(id).intent;
      value.submittedUrls = [`https://example.test/${id}`];
      value.budget.budgetScope = scope;
      value.budget.credentialFingerprint = selected;
      if (!current) {
        value.budget.periodId = 'old';
        value.budget.periodStartMs = 1000;
      }
      // Seed old rows before current ones, preserving monotonic stored periods.
      seedSnapshotState(ledger, value, status, `ack-${id}`);
    }
    const before = snapshot(db);
    const value = planningInput();
    value.intent.budget.caps = { tokens: 9, indexer: 6, checker: 3 };
    const result = planningRead(state, value);
    expect(result.decision.usage).toEqual({
      tokens: '6',
      indexer: '4',
      checker: '2',
    });
    expect(result.decision.withinCaps).toEqual({
      tokens: true,
      indexer: true,
      checker: true,
    });
    for (const unit of ['tokens', 'indexer', 'checker'] as const) {
      const lower = structuredClone(value);
      lower.intent.budget.caps = {
        ...value.intent.budget.caps,
        [unit]: value.intent.budget.caps[unit] - 1,
      };
      expect(planningRead(state, lower).decision.withinCaps[unit]).toBe(false);
    }
    expect(snapshot(db)).toEqual(before);
    // 1,025 individually safe rows exceed even SQLite's signed INTEGER SUM.
    // Initial zero holds are legitimate local intents, never HTTP/provider calls.
    for (let i = 0; i < 1023; i++) {
      const extra = planningInput(`aggregate-${i}`).intent;
      extra.submittedUrls = [`https://example.test/aggregate/${i}`];
      extra.reservation = { tokens: 0, indexer: 0, checker: 0 };
      extra.budget.caps = {
        tokens: Number.MAX_SAFE_INTEGER,
        indexer: Number.MAX_SAFE_INTEGER,
        checker: Number.MAX_SAFE_INTEGER,
      };
      seedSnapshotState(ledger, extra, 'prepared');
    }
    db.query(
      "UPDATE intents SET reserved_tokens=9007199254740991, reserved_indexer=9007199254740991, reserved_checker=9007199254740991 WHERE request_id IN ('old-hold','current-accepted') OR request_id LIKE 'aggregate-%'",
    ).run();
    const exactBefore = exactCoreRows(db);
    expect(planningRead(state).decision.usage).toEqual({
      tokens: '9232379236109515775',
      indexer: '9232379236109515775',
      checker: '9232379236109515775',
    });
    expect(planningRead(state).decision.withinCaps).toEqual({
      tokens: false,
      indexer: false,
      checker: false,
    });
    expect(exactCoreRows(db)).toEqual(exactBefore);
  }));

test('P0-03 snapshot barrier commits cannot tear revision, caps or lifetime; next read sees new data', () =>
  snapshotCase((f) => {
    const { state, writer, db } = retryFixture(f);
    const child = retryInput(state);
    child.intent.budget = { ...planningInput().intent.budget };
    const before = planningRead(state);
    let committed = false;
    const pinned = planningRead(state, planningInput(), {
      onPhase(phase: string) {
        if (phase === 'snapshot_fixed') {
          createRetry(writer, child);
          committed = true;
        }
      },
    });
    expect(committed).toBe(true);
    expect(pinned.decision).toEqual(before.decision);
    expect({
      ...pinned.snapshot,
      capturedAt: before.snapshot.capturedAt,
    }).toEqual(before.snapshot);
    const afterCommit = snapshot(db);
    const fresh = planningRead(state);
    expect(fresh.snapshot.revision).not.toBe(before.snapshot.revision);
    expect(fresh.decision.attempts.count).toBe(1);
    expect(fresh.decision.usage).toEqual({
      tokens: '3',
      indexer: '2',
      checker: '1',
    });
    expect(snapshot(db)).toEqual(afterCommit);
  }));

test('P0-03 current UTC and stored period checks are nonmutating, including rollover before return', () =>
  snapshotCase((f) => {
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    const value = planningInput();
    const empty = snapshot(db);
    expect(planningRead(state, value).decision.periodCompatible).toBe(true);
    expect(snapshot(db)).toEqual(empty); // No INSERT of an unseen period.
    const row = planningInput('stored').intent;
    row.budget.periodId = 'wrong-stored-id';
    seedSnapshotState(ledger, row, 'cancelled');
    assertNoRetryWrite(db, () => {
      expect(planningRead(state, value).decision.periodCompatible).toBe(false);
    });
    const clean = join(f.root, 'clean');
    f.init(clean);
    let now = planningNow;
    const rollover = planningRead(clean, value, {
      now: () => now,
      onPhase(phase: string) {
        if (phase === 'before_close') now += 86400000;
      },
    });
    expect(rollover.decision.periodCompatible).toBe(false);
    const stale = planningInput();
    stale.intent.budget.periodStartMs -= 86400000;
    stale.intent.budget.periodId = 'utc-day:2026-10-20';
    expect(planningRead(clean, stale).decision.periodCompatible).toBe(false);
    const future = planningInput('future').intent;
    future.budget.periodId = 'utc-day:2026-10-22';
    future.budget.periodStartMs += 86400000;
    seedSnapshotState(f.open(clean), future, 'cancelled');
    assertNoRetryWrite(f.raw(clean), () => {
      expect(planningRead(clean).decision.periodCompatible).toBe(false);
    });
  }));

test('P0-03/P0-05 guarded readers reject missing/V1/tampered/limited state without partial results or initialization', () =>
  snapshotCase((f) => {
    const missing = join(f.root, 'missing');
    const identity = {
      ...planningInput(),
      sourceManifestDigest: hash('manifest'),
      planFingerprint: hash('plan'),
    };
    // Replay accepts only its narrow identity, never an attempt allowance.
    const replayIdentity = {
      intent: identity.intent,
      parent: identity.parent,
      sourceManifestDigest: identity.sourceManifestDigest,
      planFingerprint: identity.planFingerprint,
    };
    for (const read of [
      (state: string) =>
        readRetryPlanningState(
          { stateDirectory: state },
          binding,
          planningInput(),
          { now: () => planningNow },
        ),
      (state: string) =>
        readRetryReplay({ stateDirectory: state }, binding, replayIdentity),
    ]) {
      expect(read(missing)).toEqual({
        availability: 'unavailable',
        reason: 'MissingState',
      });
      expect(existsSync(missing)).toBe(false);
    }
    const v1 = join(f.root, 'v1');
    f.init(v1, 1);
    expect(
      readRetryPlanningState({ stateDirectory: v1 }, binding, planningInput()),
    ).toEqual({ availability: 'unavailable', reason: 'UpgradeRequired' });
    expect(
      readRetryReplay({ stateDirectory: v1 }, binding, replayIdentity),
    ).toEqual({ availability: 'unavailable', reason: 'UpgradeRequired' });
    const state = join(f.root, 'state');
    const ledger = f.init(state);
    const db = f.raw(state);
    newIntent(ledger);
    expect(
      readRetryPlanningState(
        { stateDirectory: state },
        binding,
        planningInput(),
        { limits: { intents: 0 } },
      ),
    ).toEqual({ availability: 'unavailable', reason: 'LimitExceeded' });
    expect(
      readRetryReplay({ stateDirectory: state }, binding, replayIdentity, {
        limits: { intents: 0 },
      }),
    ).toEqual({ availability: 'available', kind: 'missing' });
    db.run('CREATE TABLE unexpected (id INTEGER)');
    expect(
      readRetryPlanningState(
        { stateDirectory: state },
        binding,
        planningInput(),
      ),
    ).toEqual({ availability: 'unavailable', reason: 'InvalidState' });
    expect(
      readRetryReplay({ stateDirectory: state }, binding, replayIdentity),
    ).toEqual({ availability: 'unavailable', reason: 'InvalidState' });
  }));

test('P0-03 trusted inspection rejects mismatched binding, invalid attempt allowance and unsafe parent without writes', () =>
  snapshotCase((f) => {
    const state = join(f.root, 'state');
    f.init(state);
    const db = f.raw(state);
    for (const change of [
      (v: RetryPlanningInput) => {
        v.intent.budget.credentialFingerprint = 'b'.repeat(64);
      },
      (v: RetryPlanningInput) => {
        v.maxAttemptsPerSource = 0;
      },
      (v: RetryPlanningInput) => {
        v.maxAttemptsPerSource = Number.MAX_SAFE_INTEGER + 1;
      },
      (v: RetryPlanningInput) => {
        v.parent.family = 'yandex/indexer';
      },
      (v: RetryPlanningInput) => {
        v.parent.taskId = 'bad\nparent';
      },
    ]) {
      const value = planningInput();
      change(value);
      assertNoRetryWrite(db, () => {
        expect(
          readRetryPlanningState({ stateDirectory: state }, binding, value, {
            now: () => planningNow,
          }),
        ).toEqual({ availability: 'unavailable', reason: 'InvalidState' });
      });
    }
    assertNoRetryWrite(db, () => {
      expect(
        readRetryPlanningState(
          { stateDirectory: state },
          binding,
          planningInput(),
          { now: () => NaN },
        ),
      ).toEqual({ availability: 'unavailable', reason: 'ReadFailure' });
    });
    const otherBinding = 'b'.repeat(64);
    const identity = {
      intent: planningInput().intent,
      parent: planningInput().parent,
      sourceManifestDigest: hash('manifest'),
      planFingerprint: hash('plan'),
    };
    assertNoRetryWrite(db, () => {
      expect(
        readRetryReplay({ stateDirectory: state }, otherBinding, identity),
      ).toEqual({ availability: 'unavailable', reason: 'InvalidState' });
    });
  }));

// P0-B2 fixtures exercise the same enclosed boundary required of the future P1 verifier.
const externalParent = {
  family: 'google/indexer' as const,
  taskId: ' External-é ',
};
function verifiedFixture(
  f: ReturnType<typeof fixture>,
  policy: Partial<SubmissionPolicy> = {},
  evidence = fixtureRetryEvidence(),
  hooks: RetryPrepareHooks = {},
) {
  const state = join(f.root, 'verified-state');
  const ordinary = f.init(state);
  const configuration = fixtureRetryConfiguration(
    join(f.root, 'verified-policy.json'),
    state,
    policy,
  );
  const clock = {
    utc: retryFixtureUtc,
    mono: 100,
    utcMs() {
      return this.utc;
    },
    monotonicMs() {
      return this.mono;
    },
  };
  const verifier = fixtureRetryVerifier(evidence);
  const composition = composeVerifiedRetryAdmission({
    configuration,
    verifier,
    clock,
    hooks,
  });
  const selection: RetrySelection = {
    requestId: 'verified-child',
    parent: externalParent,
  };
  return {
    state,
    ordinary,
    configuration,
    clock,
    verifier,
    composition,
    selection,
    evidence,
    db: f.raw(state),
  };
}
function candidate(result: RetryCollection) {
  expect(result.kind).toBe('candidate');
  if (result.kind !== 'candidate')
    throw new Error('Expected synthetic retry candidate: ' + result.code);
  return result;
}
function seedVerifiedParent(
  ledger: SubmissionLedger,
  state = 'accepted' as const,
  providerId = externalParent.taskId,
  urls: readonly string[] = fixtureRetryEvidence().reports[0].indexedUrls.concat(
    fixtureRetryEvidence().reports[0].unindexedUrls,
  ),
  id = 'local-parent',
) {
  seedSnapshotState(
    ledger,
    {
      ...input(id),
      budget: {
        ...input(id).budget,
        credentialFingerprint: retryFixtureBinding,
        budgetScope: 'parent-scope',
      },
      submittedUrls: urls,
    },
    state,
    providerId,
  );
}
function verifiedWriter(
  f: ReturnType<typeof fixture>,
  h: ReturnType<typeof verifiedFixture>,
) {
  return f.track(h.composition.open());
}
function verifiedLogical(db: Database) {
  return snapshot(db);
}

test('P0-02 genuine external admission inserts only actual child/core/URLs/event/reservation and provider-domain manifest', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const before = verifiedLogical(h.db);
    const c = candidate(await h.composition.collect(h.selection));
    const urls = [
      ...h.evidence.reports[1].indexedUrls,
      ...h.evidence.reports[1].unindexedUrls,
    ];
    expect(c.input.sourceManifestDigest).toBe(
      hash(
        'speedyindex-provider-report-url-manifest-v1\0' +
          JSON.stringify([externalParent.family, externalParent.taskId, urls]),
      ),
    );
    expect(c.request.body).toBe(
      JSON.stringify({
        urls: h.evidence.eligibleUrls,
        pay_per_indexed: true,
        drip_feed: false,
      }),
    );
    expect(c.request.request.payloadDigest).toBe(hash(c.request.body));
    expect(c.input.intent.reservation).toEqual({
      tokens: 200,
      indexer: 0,
      checker: 0,
    });
    expect(verifiedLogical(h.db)).toEqual(before);
    const writer = verifiedWriter(f, h);
    const created = writer.prepareVerifiedRetryIntent(c.input, c.proof);
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('Missing creator.');
    const after = verifiedLogical(h.db);
    expect(after.schema).toEqual(before.schema);
    expect(after.meta).toEqual(before.meta);
    expect(after.intents).toHaveLength(1);
    expect(after.contexts).toEqual([
      {
        credential_fp: retryFixtureBinding,
        request_id: 'verified-child',
        origin_kind: 'retry',
        parent_family: externalParent.family,
        parent_task_id: externalParent.taskId,
        source_manifest_digest: c.input.sourceManifestDigest,
        plan_fingerprint: c.input.planFingerprint,
      },
    ]);
    const row = after.intents[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      credential_fp: retryFixtureBinding,
      request_id: 'verified-child',
      budget_scope: 'fixture-retry',
      period_id: 'utc-day:2026-10-21',
      policy_revision: 'fixture-retry',
      policy_digest: h.configuration.snapshot.digest,
      task_family: 'google/indexer',
      provider_route: '/v2/task/google/indexer/create',
      payload_digest: hash(c.request.body),
      quote_version: c.request.quote.version,
      quote_fingerprint: c.request.quote.fingerprint,
      reserved_tokens: 200,
      reserved_indexer: 0,
      reserved_checker: 0,
      state: 'prepared',
      state_version: 0,
      dispatch_outcome_token_digest: null,
      created_at_ms: retryFixtureUtc,
      provider_task_id: null,
      provider_type: null,
    });
    expect(row.claim_token_digest).toBe(hash(created.dispatchCapability));
    expect(after.urls).toEqual(
      h.evidence.eligibleUrls.map((url, ordinal) => ({
        credential_fp: retryFixtureBinding,
        request_id: 'verified-child',
        ordinal,
        url_text: url,
      })),
    );
    expect(after.events).toEqual([
      {
        event_id: 1,
        credential_fp: retryFixtureBinding,
        request_id: 'verified-child',
        state_version: 0,
        event_kind: 'prepared',
        occurred_at_ms: retryFixtureUtc,
        provider_task_id: null,
        provider_type: null,
      },
    ]);
    expect(after.periods).toEqual([
      {
        credential_fp: retryFixtureBinding,
        budget_scope: 'fixture-retry',
        period_id: 'utc-day:2026-10-21',
        period_start_ms: Date.parse('2026-10-21T00:00:00Z'),
        first_seen_at_ms: retryFixtureUtc,
      },
    ]);
    expect(after.sequence).toEqual([{ name: 'intent_events', seq: 1 }]);
    const replay = writer.prepareVerifiedRetryIntent(c.input);
    expect(replay.kind).toBe('replay');
    expect('dispatchCapability' in replay).toBe(false);
    expect(verifiedLogical(h.db)).toEqual(after);
  }));

for (const variant of ['absent', 'disabled', 'adoption-false'] as const)
  test(
    'P0-02 permission ' + variant + ' blocks new external work without writes',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f, {
          retry:
            variant === 'absent'
              ? undefined
              : {
                  enabled: variant !== 'disabled',
                  allowUnattributedParents: variant !== 'adoption-false',
                  maxAttemptsPerSource: 3,
                },
        });
        const before = verifiedLogical(h.db);
        expect(await h.composition.collect(h.selection)).toEqual({
          kind: 'blocked',
          code: 'RetryPermissionDenied',
        });
        const writer = verifiedWriter(f, h);
        const value: PrepareRetryIntentInput = {
          intent: {
            ...input(),
            budget: {
              ...input().budget,
              credentialFingerprint: retryFixtureBinding,
            },
          },
          parent: externalParent,
          sourceManifestDigest: hash('source'),
          planFingerprint: hash('plan'),
          expectedRevision: hash('revision'),
        };
        expectRetryError(
          () => writer.prepareVerifiedRetryIntent(value),
          'RetryProofInvalid',
        );
        expect(verifiedLogical(h.db)).toEqual(before);
      }),
  );

for (const legacy of [false, true])
  test(
    'P0-02 ' +
      (legacy ? 'legacy' : 'standalone') +
      ' exact local manifest succeeds; source omissions and own children cannot become external',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f);
        seedVerifiedParent(h.ordinary);
        if (legacy)
          h.db.run(
            "UPDATE intent_context SET origin_kind='legacy_unattributed'",
          );
        const c = candidate(await h.composition.collect(h.selection));
        expect(c.input.sourceManifestDigest).toBe(
          hash(
            'speedyindex-intent-url-manifest-v1\0' +
              JSON.stringify([
                externalParent.family,
                [
                  ...h.evidence.reports[0].indexedUrls,
                  ...h.evidence.reports[0].unindexedUrls,
                ],
              ]),
          ),
        );
        const writer = verifiedWriter(f, h);
        const created = writer.prepareVerifiedRetryIntent(c.input, c.proof);
        expect(created.kind).toBe('created');
        if (created.kind !== 'created') throw new Error('Missing creator.');
        const claim = writer.claimDispatch(created.dispatchCapability, 0);
        if (claim.kind !== 'claimed') throw new Error('Missing claim.');
        writer.recordDispatchOutcome({
          credentialFingerprint: retryFixtureBinding,
          requestId: c.input.intent.requestId,
          expectedStateVersion: 1,
          outcomeToken: claim.outcomeToken,
          outcome: {
            kind: 'accepted',
            providerType: externalParent.family,
            providerTaskId: 'own-child',
          },
        });
        writer.close();
        expect(
          await h.composition.collect({
            ...h.selection,
            requestId: 'own-as-parent',
            parent: { ...externalParent, taskId: 'own-child' },
          }),
        ).toEqual({ kind: 'blocked', code: 'RetryLineageConflict' });
      }),
  );

test('P0-02 ambiguity, legacy permission and omitted local source fail closed without external fallback', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    seedVerifiedParent(h.ordinary);
    seedVerifiedParent(
      h.ordinary,
      'accepted',
      'other-ref',
      undefined,
      'second-parent',
    );
    h.db
      .query('UPDATE intents SET provider_task_id=? WHERE request_id=?')
      .run(externalParent.taskId, 'second-parent');
    h.db
      .query(
        "UPDATE intent_events SET provider_task_id=? WHERE request_id=? AND event_kind='accepted'",
      )
      .run(externalParent.taskId, 'second-parent');
    expect(await h.composition.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'RetryLineageConflict',
    });
    h.db
      .query('UPDATE intents SET provider_task_id=? WHERE request_id=?')
      .run('other-ref', 'second-parent');
    h.db
      .query(
        "UPDATE intent_events SET provider_task_id=? WHERE request_id=? AND event_kind='accepted'",
      )
      .run('other-ref', 'second-parent');
    h.evidence.reports[0].unindexedUrls.pop();
    h.evidence.reports[1].unindexedUrls.pop();
    h.evidence.reports[0].size--;
    h.evidence.reports[1].size--;
    h.evidence.reports[0].processedCount--;
    h.evidence.reports[1].processedCount--;
    h.evidence.eligibleUrls.pop();
    expect(await h.composition.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'RetryLineageConflict',
    });
    h.db.run("UPDATE intent_context SET origin_kind='legacy_unattributed'");
    const deny = composeVerifiedRetryAdmission({
      configuration: fixtureRetryConfiguration(
        join(f.root, 'deny.json'),
        h.state,
        {
          retry: {
            enabled: true,
            allowUnattributedParents: false,
            maxAttemptsPerSource: 3,
          },
        },
      ),
      verifier: fixtureRetryVerifier(fixtureRetryEvidence()),
      clock: h.clock,
    });
    expect(await deny.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'RetryPermissionDenied',
    });
  }));

for (const variant of [
  'forged',
  'clone',
  'serialized',
  'foreign-composition',
  'input-request',
  'input-parent',
  'input-family',
  'input-manifest',
  'input-plan',
  'input-revision',
  'input-binding',
  'input-policy',
  'input-scope',
  'input-caps',
  'input-payload',
  'input-quote',
  'input-reservation',
  'input-subset',
  'input-order',
  'input-period',
  'expired',
  'regressed',
] as const)
  test('P0-02 proof ' + variant + ' is rejected and never restored', () =>
    retryProcessCase(async (f) => {
      const h = verifiedFixture(f);
      const c = candidate(await h.composition.collect(h.selection));
      let proof = c.proof;
      const value = structuredClone(c.input);
      if (variant === 'forged') proof = Object.freeze({}) as RetryProof;
      if (variant === 'clone') proof = structuredClone(c.proof);
      if (variant === 'serialized')
        proof = JSON.parse(JSON.stringify(c.proof)) as RetryProof;
      if (variant === 'foreign-composition') {
        const other = composeVerifiedRetryAdmission({
          configuration: h.configuration,
          verifier: h.verifier,
          clock: h.clock,
        });
        proof = candidate(await other.collect(h.selection)).proof;
      }
      if (variant === 'input-request') value.intent.requestId = 'changed';
      if (variant === 'input-parent') value.parent.taskId = 'changed';
      if (variant === 'input-family') {
        value.parent.family = 'yandex/indexer';
        value.intent.taskFamily = 'yandex/indexer';
        value.intent.providerRoute = '/v2/task/yandex/indexer/create';
      }
      if (variant === 'input-manifest')
        value.sourceManifestDigest = hash('changed');
      if (variant === 'input-plan') value.planFingerprint = hash('changed');
      if (variant === 'input-revision')
        value.expectedRevision = hash('changed');
      if (variant === 'input-binding')
        value.intent.budget.credentialFingerprint = 'b'.repeat(64);
      if (variant === 'input-policy')
        value.intent.budget.policyDigest = hash('changed');
      if (variant === 'input-scope')
        value.intent.budget.budgetScope = 'changed';
      if (variant === 'input-caps')
        value.intent.budget.caps = { tokens: 1, indexer: 0, checker: 0 };
      if (variant === 'input-payload')
        value.intent.payloadDigest = hash('changed');
      if (variant === 'input-quote')
        value.intent.quoteFingerprint = hash('changed');
      if (variant === 'input-reservation')
        value.intent.reservation = { tokens: 1, indexer: 0, checker: 0 };
      if (variant === 'input-subset')
        value.intent.submittedUrls = ['https://example.test/outside'];
      if (variant === 'input-order')
        value.intent.submittedUrls = [...value.intent.submittedUrls].reverse();
      if (variant === 'input-period') value.intent.budget.periodId = 'changed';
      if (variant === 'expired') h.clock.mono += 60000;
      if (variant === 'regressed') h.clock.mono--;
      const writer = verifiedWriter(f, h);
      const before = verifiedLogical(h.db);
      if (variant === 'input-binding')
        expectLedgerError(
          () => writer.prepareVerifiedRetryIntent(value, proof),
          'InvalidLedgerInput',
        );
      else
        expectRetryError(
          () => writer.prepareVerifiedRetryIntent(value, proof),
          variant === 'expired' || variant === 'regressed'
            ? 'RetryProofExpired'
            : 'RetryProofInvalid',
        );
      expect(verifiedLogical(h.db)).toEqual(before);
      if (variant.startsWith('input-') && variant !== 'input-binding')
        expectRetryError(
          () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
          'RetryProofInvalid',
        );
    }),
  );

test('P0-02 captured configuration/verifier/clocks and copied frozen observations resist later mutation; consumed proof grants no second ownership', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const c = candidate(await h.composition.collect(h.selection));
    const inputBefore = structuredClone(c.input);
    const body = c.request.body;
    h.evidence.eligibleUrls[0] = 'https://example.test/changed';
    h.evidence.reports[1].unindexedUrls.splice(0);
    h.evidence.safetyEvidenceDigests[0] = hash('changed');
    h.verifier.collectAndVerify = async () => {
      throw new Error('SENTINEL-key-path');
    };
    h.clock.utcMs = () => {
      throw new Error('SENTINEL-clock');
    };
    h.clock.monotonicMs = () => 0;
    expect(Object.isFrozen(c.input.intent.budget.caps)).toBe(true);
    expect(Object.isFrozen(c.input.intent.submittedUrls)).toBe(true);
    expect(c.input).toEqual(inputBefore);
    expect(c.request.body).toBe(body);
    const writer = verifiedWriter(f, h);
    expect(writer.prepareVerifiedRetryIntent(c.input, c.proof).kind).toBe(
      'created',
    );
    const after = verifiedLogical(h.db);
    const replay = writer.prepareVerifiedRetryIntent(c.input, c.proof);
    expect(replay.kind).toBe('replay');
    expect('dispatchCapability' in replay).toBe(false);
    expect(verifiedLogical(h.db)).toEqual(after);
  }));

for (const variant of [
  'absent',
  'disabled',
  'adoption-false',
  'reduced',
] as const)
  test(
    'P0-02 R1 replay precedes current ' +
      variant +
      ' policy, missing/expired proof and clocks',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f);
        const c = candidate(await h.composition.collect(h.selection));
        const writer = verifiedWriter(f, h);
        expect(writer.prepareVerifiedRetryIntent(c.input, c.proof).kind).toBe(
          'created',
        );
        writer.close();
        h.clock.mono += 60000;
        const configuration = fixtureRetryConfiguration(
          join(f.root, 'changed.json'),
          h.state,
          {
            policyRevision: 'current-different',
            retry:
              variant === 'absent'
                ? undefined
                : {
                    enabled: variant !== 'disabled',
                    allowUnattributedParents: variant !== 'adoption-false',
                    maxAttemptsPerSource: 1,
                  },
          },
        );
        const clock = {
          utcMs() {
            throw new Error('Replay must not use clock.');
          },
          monotonicMs() {
            throw new Error('Replay must not use clock.');
          },
        };
        const composition = composeVerifiedRetryAdmission({
          configuration,
          verifier: h.verifier,
          clock,
        });
        const current = f.track(composition.open());
        const before = verifiedLogical(h.db);
        for (const proof of [undefined, c.proof]) {
          const replay = current.prepareVerifiedRetryIntent(c.input, proof);
          expect(replay.kind).toBe('replay');
          expect('dispatchCapability' in replay).toBe(false);
          expect(verifiedLogical(h.db)).toEqual(before);
        }
      }),
  );

test('P0-02 R2 collect/writer mutually exclude in both directions at arrival/release barrier; recover throw/cancel/open error', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    let release!: () => void;
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    const released = new Promise<void>((r) => (release = r));
    let mode: 'hold' | 'throw' | 'ok' = 'hold';
    const verifier = {
      async collectAndVerify() {
        if (mode === 'throw') throw new Error('SENTINEL-key-path-reflected');
        if (mode === 'hold') {
          arrive();
          await released;
        }
        return h.evidence;
      },
    };
    const composition = composeVerifiedRetryAdmission({
      configuration: h.configuration,
      verifier,
      clock: h.clock,
    });
    const abort = new AbortController();
    const pending = composition.collect(h.selection, abort.signal);
    void pending.catch(() => {});
    try {
      await retryProcessDeadline(arrived);
      expectLedgerError(() => composition.open(), 'LedgerBusy');
      expect(await composition.collect(h.selection)).toEqual({
        kind: 'blocked',
        code: 'LedgerBusy',
      });
      abort.abort();
    } finally {
      release();
    }
    expect(await pending).toEqual({ kind: 'blocked', code: 'RetryCancelled' });
    mode = 'throw';
    expect(await composition.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'RetryObservationInvalid',
    });
    mode = 'ok';
    const c = candidate(await composition.collect(h.selection));
    const writer = f.track(composition.open());
    expectLedgerError(() => composition.open(), 'LedgerBusy');
    expect(await composition.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'LedgerBusy',
    });
    writer.close();
    candidate(await composition.collect(h.selection));
    const pre = new AbortController();
    pre.abort();
    expect(await composition.collect(h.selection, pre.signal)).toEqual({
      kind: 'blocked',
      code: 'RetryCancelled',
    });
    candidate(await composition.collect(h.selection));
    expect(c.request.input.dripFeedDays).toBeUndefined();
    const missing = join(f.root, 'missing');
    const config = fixtureRetryConfiguration(
      join(f.root, 'missing.json'),
      missing,
    );
    const recover = composeVerifiedRetryAdmission({
      configuration: config,
      verifier,
      clock: h.clock,
    });
    expectUnavailable(() => recover.open());
    f.init(missing);
    const recovered = f.track(recover.open());
    recovered.close();
  }));

const reportInvalidVariants = [
  'category-order',
  'membership',
  'conflict',
  'size',
  'processed',
  'omission',
  'unsafe-url',
  'eligible-indexed',
  'eligible-order',
  'duplicate-proposal',
  'raw-limit',
  'proposal-limit',
  'empty-digests',
  'digest-limit',
  'digest-prefix',
  'partition-prefix',
  'body-limit',
  'semantic-limit',
] as const;
for (const variant of reportInvalidVariants)
  test(
    'P0-02 report ' +
      variant +
      ' is bounded and rejected without authority or writes',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f);
        const e = h.evidence;
        if (variant === 'category-order') e.reports[1].unindexedUrls.reverse();
        if (variant === 'membership')
          e.reports[1].unindexedUrls[0] = 'https://example.test/other';
        if (variant === 'conflict')
          for (const r of e.reports) r.unindexedUrls[0] = r.indexedUrls[0]!;
        if (variant === 'size') for (const r of e.reports) r.size++;
        if (variant === 'processed')
          for (const r of e.reports) r.processedCount--;
        if (variant === 'omission')
          for (const r of e.reports) r.unindexedUrls.pop();
        if (variant === 'unsafe-url')
          for (const r of e.reports)
            r.unindexedUrls[0] = 'https://user:pass@example.test/';
        if (variant === 'eligible-indexed')
          e.eligibleUrls = [e.reports[0].indexedUrls[0]!];
        if (variant === 'eligible-order') e.eligibleUrls.reverse();
        if (variant === 'duplicate-proposal')
          e.eligibleUrls.push(e.eligibleUrls[0]!);
        if (variant === 'raw-limit')
          for (const r of e.reports)
            r.indexedUrls = Array(10001).fill(r.indexedUrls[0]);
        if (variant === 'proposal-limit')
          e.eligibleUrls = Array(10001).fill('https://example.test/proposal');
        if (variant === 'empty-digests') e.safetyEvidenceDigests = [];
        if (variant === 'digest-limit')
          e.safetyEvidenceDigests = Array(65).fill(hash('one'));
        if (variant === 'digest-prefix')
          e.safetyEvidenceDigests = [hash('one') + 'extra'];
        if (variant === 'partition-prefix')
          e.partitionDigest = hash('one') + 'extra';
        if (variant === 'body-limit' || variant === 'semantic-limit') {
          const length = variant === 'body-limit' ? 2150 : 3000;
          const width = variant === 'body-limit' ? 1000 : 1500;
          const urls = Array.from(
            { length },
            (_, i) => 'https://example.test/' + i + 'x'.repeat(width),
          );
          for (const r of e.reports) {
            r.indexedUrls = variant === 'semantic-limit' ? urls : [];
            r.unindexedUrls =
              variant === 'semantic-limit'
                ? ['https://example.test/proposal']
                : urls;
            r.size = r.indexedUrls.length + r.unindexedUrls.length;
            r.processedCount = r.size;
          }
          e.eligibleUrls =
            variant === 'semantic-limit'
              ? ['https://example.test/proposal']
              : urls;
        }
        const before = verifiedLogical(h.db);
        const result = await h.composition.collect(h.selection);
        expect(result.kind).toBe('blocked');
        expect(JSON.stringify(result)).not.toContain('SENTINEL');
        expect(verifiedLogical(h.db)).toEqual(before);
      }),
  );

test('P0-02 matching first-unique reports retain exact category order and proposal; constructor captures mutable trusted config', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    h.evidence.reports[0].indexedUrls.push(
      h.evidence.reports[0].indexedUrls[0]!,
    );
    h.evidence.reports[1].unindexedUrls.push(
      h.evidence.reports[1].unindexedUrls[0]!,
    );
    const configuration = structuredClone(h.configuration);
    const composition = composeVerifiedRetryAdmission({
      configuration,
      verifier: h.verifier,
      clock: h.clock,
    });
    (configuration.snapshot.policy.caps as { tokens: number }).tokens = 0;
    (configuration.snapshot.policy.retry as { enabled: boolean }).enabled =
      false;
    const c = candidate(await composition.collect(h.selection));
    expect(c.request.input.urls).toEqual(fixtureRetryEvidence().eligibleUrls);
    const writer = f.track(composition.open());
    expect(writer.prepareVerifiedRetryIntent(c.input, c.proof).kind).toBe(
      'created',
    );
  }));

test('P0-02 R3 FP-INVALID-TUPLE-1 pure public tuple has a canonical oracle and rejects semantic boundary mutations', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const a = candidate(await h.composition.collect(h.selection));
    h.clock.mono += 100;
    h.clock.utc += 100;
    const b = candidate(
      await h.composition.collect({
        ...h.selection,
        requestId: 'different-request',
      }),
    );
    expect(a.input.planFingerprint).toBe(b.input.planFingerprint);
    const value: RetryPlanFingerprintInput = {
      parent: externalParent,
      provenance: 'external_unattributed',
      originalManifestKnown: false,
      manifestProvenance: 'provider_report_observed_corpus',
      sourceManifestDigest: a.input.sourceManifestDigest,
      safetyEvidenceDigests: h.evidence.safetyEvidenceDigests,
      partitionDigest: h.evidence.partitionDigest,
      revision: a.input.expectedRevision,
      policyDigest: a.input.intent.budget.policyDigest,
      authorizationFingerprint: hash('public-authorization'),
      payloadDigest: a.input.intent.payloadDigest,
      quoteVersion: a.input.intent.quoteVersion,
      quoteFingerprint: a.input.intent.quoteFingerprint,
      period: {
        id: a.input.intent.budget.periodId,
        startMs: a.input.intent.budget.periodStartMs,
        endMs: a.input.intent.budget.periodStartMs + 86400000,
      },
      providerRoute: a.input.intent.providerRoute,
      urlCount: 2,
      providerBodyBytes: a.request.request.providerBodyBytes,
      reservation: a.input.intent.reservation,
    };
    const expected = hash(
      'speedyindex-retry-plan-v1\0' +
        JSON.stringify([
          externalParent.family,
          externalParent.taskId,
          'external_unattributed',
          false,
          'provider_report_observed_corpus',
          value.sourceManifestDigest,
          value.safetyEvidenceDigests,
          value.partitionDigest,
          value.revision,
          value.policyDigest,
          value.authorizationFingerprint,
          value.payloadDigest,
          value.quoteVersion,
          value.quoteFingerprint,
          [value.period.id, value.period.startMs, value.period.endMs],
          value.providerRoute,
          value.urlCount,
          value.providerBodyBytes,
          [200, 0, 0],
        ]),
    );
    expect(computeRetryPlanFingerprint(value)).toBe(expected);
    const incidental = {
      ...value,
      requestId: 'unrelated',
      observationTime: 999,
      credentialFingerprint: 'private',
      ledgerId: 'private',
      stateDirectory: 'private',
      owner: 'private',
    };
    expect(computeRetryPlanFingerprint(incidental)).toBe(expected);
    for (const key of [
      'sourceManifestDigest',
      'partitionDigest',
      'revision',
      'policyDigest',
      'authorizationFingerprint',
      'payloadDigest',
      'quoteFingerprint',
    ] as const)
      expect(
        computeRetryPlanFingerprint({ ...value, [key]: hash(key) }),
      ).not.toBe(expected);
    expect(
      computeRetryPlanFingerprint({
        ...value,
        safetyEvidenceDigests: [hash('changed')],
      }),
    ).not.toBe(expected);
    expect(
      computeRetryPlanFingerprint({
        ...value,
        provenance: 'legacy_unattributed',
      }),
    ).not.toBe(expected);
    const invalidTuples: RetryPlanFingerprintInput[] = [
      { ...value, providerRoute: '/v2/task/yandex/indexer/create' },
      {
        ...value,
        period: { ...value.period, endMs: value.period.endMs - 1 },
      },
      { ...value, urlCount: 0 },
      { ...value, urlCount: 10001 },
      { ...value, providerBodyBytes: 0 },
      { ...value, providerBodyBytes: 2097153 },
      {
        ...value,
        reservation: { ...value.reservation, tokens: -1 },
      },
    ];
    for (const invalid of invalidTuples)
      expectLedgerError(
        () => computeRetryPlanFingerprint(invalid),
        'InvalidLedgerInput',
      );
    const writer = verifiedWriter(f, h);
    expectRetryError(
      () => writer.prepareVerifiedRetryIntent(b.input, a.proof),
      'RetryProofInvalid',
    );
  }));

for (const kind of ['expiry', 'utc'] as const)
  test(
    'P0-02 ' +
      kind +
      ' is rechecked immediately before insertion and consumes failed proof',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f);
        let armed = false;
        let calls = 0;
        const clock = {
          utcMs() {
            return (
              retryFixtureUtc +
              (armed && kind === 'utc' && ++calls >= 4 ? 86400000 : 0)
            );
          },
          monotonicMs() {
            return armed && kind === 'expiry' && ++calls >= 3 ? 60100 : 100;
          },
        };
        const composition = composeVerifiedRetryAdmission({
          configuration: h.configuration,
          verifier: h.verifier,
          clock,
        });
        const c = candidate(await composition.collect(h.selection));
        const writer = f.track(composition.open());
        const before = verifiedLogical(h.db);
        armed = true;
        if (kind === 'expiry')
          expectRetryError(
            () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
            'RetryProofExpired',
          );
        else
          expectLedgerError(
            () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
            'StalePeriodContext',
          );
        expect(verifiedLogical(h.db)).toEqual(before);
        armed = false;
        expectRetryError(
          () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
          'RetryProofInvalid',
        );
      }),
  );

for (const race of ['same-id', 'disjoint'] as const)
  test(
    'P0-04 independently composed owned process ' +
      race +
      ' admission race has one creator',
    () =>
      retryProcessCase(async (f, children) => {
        const h = verifiedFixture(f);
        const first = candidate(await h.composition.collect(h.selection));
        const secondUrls = [
          'https://example.test/disjoint-indexed',
          'https://example.test/disjoint-a',
          'https://example.test/disjoint-b',
        ];
        const a = await startRetryProcess(f, children, {
          role: 'verified',
          stateDirectory: h.state,
          input: first.input,
        });
        const b = await startRetryProcess(f, children, {
          role: 'verified',
          stateDirectory: h.state,
          input:
            race === 'same-id'
              ? first.input
              : {
                  ...first.input,
                  intent: {
                    ...first.input.intent,
                    requestId: 'disjoint-child',
                  },
                },
          ...(race === 'same-id' ? {} : { verifiedUrls: secondUrls }),
        });
        await Promise.all([retryControl(a, 'GO'), retryControl(b, 'GO')]);
        const results = await Promise.all([
          retryProcessResult(a),
          retryProcessResult(b),
        ]);
        expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
        if (race === 'same-id') {
          expect(results.map((r) => r.kind).sort()).toEqual([
            'created',
            'replay',
          ]);
          expect(results.map((r) => r.capability).sort()).toEqual([
            false,
            true,
          ]);
        } else
          expect(results.find((r) => r.kind === 'error')?.code).toBe(
            'SnapshotConflict',
          );
        const after = verifiedLogical(h.db);
        expect(after.intents).toHaveLength(1);
        expect(after.contexts).toHaveLength(1);
        expect(after.events).toHaveLength(1);
        expect(after.urls).toHaveLength(2);
        expect(
          readRetrySnapshot({ stateDirectory: h.state }, retryFixtureBinding)
            .availability,
        ).toBe('available');
      }),
  );

for (const kind of ['expiry', 'utc'] as const)
  test(
    'P0-04 real native SQL lock contention then ' +
      kind +
      ' refuses unchanged unconsumed proof after acquisition',
    () =>
      retryProcessCase(async (f, children) => {
        const h = verifiedFixture(f);
        const c = candidate(await h.composition.collect(h.selection));
        const child = await startRetryProcess(f, children, {
          role: 'verified_lock_wait',
          stateDirectory: h.state,
          input: c.input,
          clockAfterWait: kind,
        });
        const before = verifiedLogical(h.db);
        h.db.run('BEGIN IMMEDIATE');
        try {
          await retryControl(child, 'GO', false);
          await waitRetryMessage(child, (m) => m.phase === 'lock_waited');
          await retryControl(child, 'RETRY');
          await waitRetryMessage(child, (m) => m.phase === 'prepare_attempt');
        } finally {
          h.db.run('ROLLBACK');
        }
        const result = await retryProcessResult(child);
        expect(result).toMatchObject({
          kind: 'error',
          code: kind === 'expiry' ? 'RetryProofExpired' : 'StalePeriodContext',
        });
        expect(verifiedLogical(h.db)).toEqual(before);
      }),
    10000,
  );

for (const phase of ['before_context', 'after_prepare_commit'] as const)
  test(
    'P0-04 verified external native ' +
      phase +
      ' crash preserves atomic child and holds',
    () =>
      retryProcessCase(async (f, children) => {
        const h = verifiedFixture(f);
        const c = candidate(await h.composition.collect(h.selection));
        const before = verifiedLogical(h.db);
        const child = await startRetryProcess(f, children, {
          role: 'verified',
          stateDirectory: h.state,
          input: c.input,
          pauseAt: phase,
        });
        await retryControl(child, 'GO');
        await waitRetryMessage(child, (m) => m.phase === phase);
        await finishRetryProcess(child, true);
        if (phase === 'before_context')
          expect(verifiedLogical(h.db)).toEqual(before);
        else {
          const snap = readRetrySnapshot(
            { stateDirectory: h.state },
            retryFixtureBinding,
          );
          expect(snap.availability).toBe('available');
          if (snap.availability !== 'available')
            throw new Error('Missing snapshot.');
          expect(snap.retryChildren).toHaveLength(1);
          expect(snap.holds).toHaveLength(1);
          expect(snap.holds[0]!.urls.map((u) => u.url)).toEqual(
            h.evidence.eligibleUrls,
          );
          h.clock.mono += 60000;
          const writer = verifiedWriter(f, h);
          const replay = writer.prepareVerifiedRetryIntent(c.input);
          expect(replay.kind).toBe('replay');
          expect('dispatchCapability' in replay).toBe(false);
          expect(
            writer.cancelPrepared(
              retryFixtureBinding,
              c.input.intent.requestId,
              1,
            ).kind,
          ).toBe('lost');
        }
      }),
  );

test('P0-04 ordinary/retry process exact overlap has one winner and closed stale-or-overlap loser', () =>
  retryProcessCase(async (f, children) => {
    const h = verifiedFixture(f);
    const c = candidate(await h.composition.collect(h.selection));
    const ordinary = { ...c.input.intent, requestId: 'ordinary-racer' };
    const a = await startRetryProcess(f, children, {
      role: 'verified',
      stateDirectory: h.state,
      input: c.input,
    });
    const b = await startRetryProcess(f, children, {
      role: 'ordinary',
      stateDirectory: h.state,
      input: c.input,
      ordinaryIntent: ordinary,
    });
    await Promise.all([retryControl(a, 'GO'), retryControl(b, 'GO')]);
    const results = await Promise.all([
      retryProcessResult(a),
      retryProcessResult(b),
    ]);
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(['SnapshotConflict', 'UrlOverlap']).toContain(
      results.find((r) => r.kind === 'error')!.code!,
    );
    expect(verifiedLogical(h.db).intents).toHaveLength(1);
  }));

for (const family of [
  'google/checker',
  'backlink/checker',
  'yandex/indexer',
] as const)
  test(
    'P0-04 fresh collection sees old-period ' +
      family +
      ' exact held URL across scopes',
    () =>
      retryProcessCase(async (f) => {
        const h = verifiedFixture(f);
        const hold = {
          ...input('held'),
          taskFamily: family,
          providerRoute: `/v2/task/${family}/create` as const,
          budget: {
            ...input().budget,
            credentialFingerprint: retryFixtureBinding,
            budgetScope: 'other-scope',
          },
          submittedUrls: [h.evidence.eligibleUrls[0]!],
        };
        newIntent(h.ordinary, hold);
        const before = verifiedLogical(h.db);
        expect(await h.composition.collect(h.selection)).toEqual({
          kind: 'blocked',
          code: 'UrlOverlap',
        });
        expect(verifiedLogical(h.db)).toEqual(before);
      }),
  );

test('P0-04 fresh revision all-state attempt count and each unit cap pressure refuse new admission; no-ID unknown retry blocks other parents', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const c = candidate(await h.composition.collect(h.selection));
    const writer = verifiedWriter(f, h);
    const created = writer.prepareVerifiedRetryIntent(c.input, c.proof);
    if (created.kind !== 'created') throw new Error('Missing creator.');
    expect(
      writer.cancelPrepared(retryFixtureBinding, c.input.intent.requestId, 0)
        .kind,
    ).toBe('cancelled');
    writer.close();
    const limited = composeVerifiedRetryAdmission({
      configuration: fixtureRetryConfiguration(
        join(f.root, 'limited.json'),
        h.state,
        {
          retry: {
            enabled: true,
            allowUnattributedParents: true,
            maxAttemptsPerSource: 1,
          },
        },
      ),
      verifier: h.verifier,
      clock: h.clock,
    });
    expect(
      await limited.collect({ ...h.selection, requestId: 'count-loser' }),
    ).toEqual({ kind: 'blocked', code: 'RetryPermissionDenied' });
    for (const unit of ['tokens', 'indexer', 'checker'] as const) {
      const caps = { tokens: 10000, indexer: 100, checker: 100 };
      caps[unit] = 0;
      const reservations = { tokens: 0, indexer: 0, checker: 0 };
      reservations[unit] = 1;
      const hold = {
        ...input('pressure-' + unit),
        budget: {
          ...c.input.intent.budget,
          policyDigest: hash('pressure'),
          caps: { tokens: 10000, indexer: 100, checker: 100 },
        },
        submittedUrls: ['https://example.test/pressure-' + unit],
        reservation: reservations,
      };
      newIntent(h.ordinary, hold);
      const comp = composeVerifiedRetryAdmission({
        configuration: fixtureRetryConfiguration(
          join(f.root, 'cap-' + unit + '.json'),
          h.state,
          { caps },
        ),
        verifier: h.verifier,
        clock: h.clock,
      });
      expect(
        await comp.collect({ ...h.selection, requestId: 'cap-loser-' + unit }),
      ).toEqual({ kind: 'blocked', code: 'BudgetExceeded' });
    }
    const newc = candidate(
      await h.composition.collect({
        ...h.selection,
        requestId: 'unknown-child',
      }),
    );
    const next = verifiedWriter(f, h);
    const prepared = next.prepareVerifiedRetryIntent(newc.input, newc.proof);
    if (prepared.kind !== 'created') throw new Error('Missing creator.');
    const claim = next.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed') throw new Error('Missing claim.');
    next.recordDispatchOutcome({
      credentialFingerprint: retryFixtureBinding,
      requestId: newc.input.intent.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
      outcome: { kind: 'unknown' },
    });
    next.close();
    const other = composeVerifiedRetryAdmission({
      configuration: h.configuration,
      verifier: fixtureRetryVerifier(
        fixtureRetryEvidence([
          'https://example.test/other0',
          'https://example.test/other1',
        ]),
      ),
      clock: h.clock,
    });
    expect(
      await other.collect({
        requestId: 'other-new',
        parent: { ...externalParent, taskId: 'other-parent' },
      }),
    ).toEqual({ kind: 'blocked', code: 'UnknownRetryDispatch' });
  }));

test('P0-04 external child keeps native owner-first duplicate/self-parent ACK guards and dispatching holds', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    seedVerifiedParent(h.ordinary, 'accepted', 'existing-ack', [
      'https://example.test/independent-parent',
    ]);
    const c = candidate(await h.composition.collect(h.selection));
    const writer = verifiedWriter(f, h);
    const prepared = writer.prepareVerifiedRetryIntent(c.input, c.proof);
    if (prepared.kind !== 'created') throw new Error('Missing creator.');
    const claim = writer.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed') throw new Error('Missing claim.');
    expect(writer.claimDispatch(prepared.dispatchCapability, 0).kind).toBe(
      'lost',
    );
    expect(
      writer.cancelPrepared(retryFixtureBinding, c.input.intent.requestId, 0)
        .kind,
    ).toBe('lost');
    const otherPrepared = newIntent(h.ordinary, {
      ...input('other-owner'),
      budget: {
        ...input().budget,
        credentialFingerprint: retryFixtureBinding,
        budgetScope: 'other-owner',
      },
      submittedUrls: ['https://example.test/other-owner'],
    });
    const otherClaim = h.ordinary.claimDispatch(
      otherPrepared.dispatchCapability,
      0,
    );
    if (otherClaim.kind !== 'claimed') throw new Error('Missing other owner.');
    const base = {
      credentialFingerprint: retryFixtureBinding,
      requestId: c.input.intent.requestId,
      expectedStateVersion: 1,
      outcomeToken: claim.outcomeToken,
    };
    for (const taskId of [externalParent.taskId, 'existing-ack']) {
      const before = verifiedLogical(h.db);
      expectLedgerError(
        () =>
          writer.recordDispatchOutcome({
            ...base,
            outcomeToken: otherClaim.outcomeToken,
            outcome: {
              kind: 'accepted',
              providerType: externalParent.family,
              providerTaskId: taskId,
            },
          }),
        'DispatchOutcomeClaimLost',
      );
      expect(verifiedLogical(h.db)).toEqual(before);
      expectRetryError(
        () =>
          writer.recordDispatchOutcome({
            ...base,
            outcome: {
              kind: 'accepted',
              providerType: externalParent.family,
              providerTaskId: taskId,
            },
          }),
        'RetryLineageConflict',
      );
      expect(verifiedLogical(h.db)).toEqual(before);
    }
    writer.recordDispatchOutcome({
      ...base,
      outcome: {
        kind: 'accepted',
        providerType: externalParent.family,
        providerTaskId: 'genuine-child-ack',
      },
    });
    expect(
      writer.readIntent(retryFixtureBinding, c.input.intent.requestId)?.state,
    ).toBe('accepted');
    expect(verifiedLogical(h.db).intents).toHaveLength(3);
  }));

test('WRAPPER-FOREIGN-BINDING-1 readIntent rejects a foreign prepared row without disclosure or state change', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const foreignBinding = hash('wrapper-foreign-read-binding');
    expect(foreignBinding).not.toBe(retryFixtureBinding);
    const foreignInput = input('wrapper-foreign-read');
    const foreign = newIntent(h.ordinary, {
      ...foreignInput,
      budget: {
        ...foreignInput.budget,
        credentialFingerprint: foreignBinding,
      },
    });
    expect(
      h.ordinary.readIntent(foreignBinding, foreign.intent.requestId)?.state,
    ).toBe('prepared');

    const writer = verifiedWriter(f, h);
    const before = verifiedLogical(h.db);
    expectLedgerError(
      () => writer.readIntent(foreignBinding, foreign.intent.requestId),
      'InvalidLedgerInput',
    );
    expect(verifiedLogical(h.db)).toEqual(before);
  }));

test('WRAPPER-FOREIGN-BINDING-1 cancelPrepared rejects a foreign prepared row despite a valid native cancel control', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const foreignBinding = hash('wrapper-foreign-cancel-binding');
    expect(foreignBinding).not.toBe(retryFixtureBinding);
    const targetInput = input('wrapper-foreign-cancel-target');
    const target = newIntent(h.ordinary, {
      ...targetInput,
      budget: {
        ...targetInput.budget,
        credentialFingerprint: foreignBinding,
      },
      submittedUrls: ['https://example.test/wrapper-foreign-cancel-target'],
    });
    const controlInput = input('wrapper-foreign-cancel-control');
    const control = newIntent(h.ordinary, {
      ...controlInput,
      budget: {
        ...controlInput.budget,
        credentialFingerprint: foreignBinding,
      },
      submittedUrls: ['https://example.test/wrapper-foreign-cancel-control'],
    });
    expect(
      h.ordinary.cancelPrepared(foreignBinding, control.intent.requestId, 0),
    ).toEqual({ kind: 'cancelled', stateVersion: 1 });
    expect(
      h.ordinary.readIntent(foreignBinding, target.intent.requestId)?.state,
    ).toBe('prepared');

    const writer = verifiedWriter(f, h);
    const before = verifiedLogical(h.db);
    expectLedgerError(
      () => writer.cancelPrepared(foreignBinding, target.intent.requestId, 0),
      'InvalidLedgerInput',
    );
    expect(verifiedLogical(h.db)).toEqual(before);
  }));

test('WRAPPER-FOREIGN-BINDING-1 recordDispatchOutcome rejects a foreign dispatching row with a genuine native token', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const foreignBinding = hash('wrapper-foreign-outcome-binding');
    expect(foreignBinding).not.toBe(retryFixtureBinding);
    const targetInput = input('wrapper-foreign-outcome-target');
    const target = newIntent(h.ordinary, {
      ...targetInput,
      budget: {
        ...targetInput.budget,
        credentialFingerprint: foreignBinding,
      },
      submittedUrls: ['https://example.test/wrapper-foreign-outcome-target'],
    });
    const targetClaim = h.ordinary.claimDispatch(target.dispatchCapability, 0);
    if (targetClaim.kind !== 'claimed')
      throw new Error('Expected genuine foreign dispatch claim.');
    expect(
      h.ordinary.readIntent(foreignBinding, target.intent.requestId)?.state,
    ).toBe('dispatching');

    const controlInput = input('wrapper-foreign-outcome-control');
    const control = newIntent(h.ordinary, {
      ...controlInput,
      budget: {
        ...controlInput.budget,
        credentialFingerprint: foreignBinding,
      },
      submittedUrls: ['https://example.test/wrapper-foreign-outcome-control'],
    });
    const controlClaim = h.ordinary.claimDispatch(
      control.dispatchCapability,
      0,
    );
    if (controlClaim.kind !== 'claimed')
      throw new Error('Expected genuine native control claim.');
    expect(
      h.ordinary.recordDispatchOutcome({
        credentialFingerprint: foreignBinding,
        requestId: control.intent.requestId,
        expectedStateVersion: controlClaim.stateVersion,
        outcomeToken: controlClaim.outcomeToken,
        outcome: { kind: 'unknown' },
      }).state,
    ).toBe('unknown');

    const writer = verifiedWriter(f, h);
    const before = verifiedLogical(h.db);
    expectLedgerError(
      () =>
        writer.recordDispatchOutcome({
          credentialFingerprint: foreignBinding,
          requestId: target.intent.requestId,
          expectedStateVersion: targetClaim.stateVersion,
          outcomeToken: targetClaim.outcomeToken,
          outcome: { kind: 'unknown' },
        }),
      'InvalidLedgerInput',
    );
    expect(verifiedLogical(h.db)).toEqual(before);
  }));

test('P0-02 boundary raw entries and safety digests succeed without truncation', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    for (const r of h.evidence.reports)
      r.indexedUrls = Array(9998).fill(r.indexedUrls[0]!);
    h.evidence.safetyEvidenceDigests = Array.from({ length: 64 }, (_, i) =>
      hash('fence-' + i),
    );
    const c = candidate(await h.composition.collect(h.selection));
    const writer = verifiedWriter(f, h);
    expect(writer.prepareVerifiedRetryIntent(c.input, c.proof).kind).toBe(
      'created',
    );
    expect(c.request.input.urls).toEqual(h.evidence.eligibleUrls);
  }));

test('P0-02 same composition rejects replaced ledger identity; invalid/unbound configuration and V1 remain unavailable', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const c = candidate(await h.composition.collect(h.selection));
    h.db
      .query('UPDATE retry_ledger_meta SET ledger_id=?')
      .run(hash('replacement-ledger'));
    const writer = verifiedWriter(f, h);
    const before = verifiedLogical(h.db);
    expectRetryError(
      () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
      'RetryProofInvalid',
    );
    expect(verifiedLogical(h.db)).toEqual(before);
    writer.close();
    for (const field of ['key', 'digest', 'state'] as const) {
      const configuration = structuredClone(h.configuration);
      if (field === 'key')
        (configuration.credential as { fingerprint: string }).fingerprint =
          hash('wrong-key');
      if (field === 'digest')
        (configuration.snapshot as { digest: string }).digest =
          hash('wrong-policy');
      if (field === 'state')
        (configuration as { state: string }).state = 'invalid';
      expectLedgerError(
        () =>
          composeVerifiedRetryAdmission({
            configuration,
            verifier: h.verifier,
            clock: h.clock,
          }),
        'InvalidLedgerInput',
      );
    }
    const state = join(f.root, 'v1');
    f.init(state, 1);
    const composition = composeVerifiedRetryAdmission({
      configuration: fixtureRetryConfiguration(
        join(f.root, 'v1-policy.json'),
        state,
      ),
      verifier: h.verifier,
      clock: h.clock,
    });
    expectRetryError(() => composition.open(), 'UpgradeRequired');
    expect(await composition.collect(h.selection)).toEqual({
      kind: 'blocked',
      code: 'SnapshotUnavailable',
    });
  }));

test('P0-02 caller cancellation after collection consumes no new hold or replacement capability', () =>
  retryProcessCase(async (f) => {
    const h = verifiedFixture(f);
    const abort = new AbortController();
    const c = candidate(await h.composition.collect(h.selection, abort.signal));
    abort.abort();
    const writer = verifiedWriter(f, h);
    const before = verifiedLogical(h.db);
    expectRetryError(
      () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
      'RetryCancelled',
    );
    expect(verifiedLogical(h.db)).toEqual(before);
    expectRetryError(
      () => writer.prepareVerifiedRetryIntent(c.input, c.proof),
      'RetryProofInvalid',
    );
    writer.close();
    const fresh = candidate(await h.composition.collect(h.selection));
    expect(fresh.proof).not.toBe(c.proof);
  }));
