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
import { join } from 'node:path';
import { Database, constants } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  initializeLedger,
  initializeLedgerV2,
  migrateLedgerV2,
  LedgerMigrationError,
  openLedger,
  SubmissionLedgerError,
  type PrepareIntentInput,
  type SubmissionLedger,
} from '../src/submission-ledger';

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
  const cleanup = () => {
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
    rmSync(root, { recursive: true });
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
