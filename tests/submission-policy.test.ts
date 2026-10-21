import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  CreateIndexingTaskError,
  indexingAuthorizationSchema,
  createIndexingTaskErrorCodeSchema,
} from '../src/create-indexing-task';
import {
  buildCreateIndexCheckRequest,
  quoteIndexCheckRequest,
} from '../src/create-index-check';
import {
  buildCreateBacklinkCheckRequest,
  quoteBacklinkCheckRequest,
} from '../src/create-backlink-check';
import {
  createSubmissionContext,
  getSubmissionAuthorization,
  loadSubmissionConfiguration,
  loadSubmissionPolicy,
  submissionCredentialFingerprint,
  submissionPolicySchema,
  type ConfiguredSubmission,
  type SubmissionPolicy,
} from '../src/submission-policy';

const dummyKey = 'fixture-key-only';
const quote = '1'.repeat(64);
const now = Date.parse('2026-10-20T12:00:00Z');

function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
const expectedKeyFingerprint = sha(
  'speedyindex-credential-v1\0fixture-key-only',
);

function policy(): SubmissionPolicy {
  return {
    version: 1,
    enabled: true,
    mode: 'caller_acknowledgement',
    policyRevision: 'fixture-v1',
    budgetScope: 'fixture-scope',
    credentialFingerprint: expectedKeyFingerprint,
    period: { kind: 'utc_day' },
    caps: { tokens: 12_000, indexer: 37, checker: 0 },
  };
}

interface Fixture {
  root: string;
  policyPath: string;
  stateDirectory: string;
}
function withFixture(operation: (fixture: Fixture) => void) {
  // Resolve the OS temp alias explicitly before passing a path to the loader.
  const root = mkdtempSync(join(realpathSync('/tmp'), 'speedyindex-policy-'));
  try {
    chmodSync(root, 0o700);
    const fixture = {
      root,
      policyPath: join(root, 'policy.json'),
      stateDirectory: join(root, 'unopened-state'),
    };
    writeFileSync(fixture.policyPath, JSON.stringify(policy()), {
      mode: 0o600,
    });
    operation(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePolicy(fixture: Fixture, value: unknown) {
  writeFileSync(fixture.policyPath, JSON.stringify(value));
}
function configured(
  fixture: Fixture,
  apiKey: unknown = dummyKey,
): ConfiguredSubmission {
  const config = loadSubmissionConfiguration({ ...fixture, apiKey });
  expect(config.state).toBe('configured');
  if (config.state !== 'configured')
    throw new Error('Expected configured fixture.');
  return config;
}
function fixedError(
  operation: () => unknown,
  code:
    | 'InvalidPolicy'
    | 'MissingCredentials'
    | 'StateUnavailable'
    | 'InvalidInput',
) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CreateIndexingTaskError);
  const error = caught as CreateIndexingTaskError;
  expect(error.code).toBe(code);
  const messages = {
    InvalidPolicy: 'Submission policy is invalid or unavailable.',
    MissingCredentials: 'Submission credentials are missing or invalid.',
    StateUnavailable: 'Submission state is unavailable.',
    InvalidInput: 'Invalid create-indexing request.',
  };
  expect(error.message).toBe(messages[code]);
}

test('C01/C04-POLICY: no flags or incomplete configuration stays inactive without choosing state', () => {
  withFixture((fixture) => {
    for (const options of [{}, { apiKey: dummyKey }]) {
      const config = loadSubmissionConfiguration(options);
      expect(config.state).toBe('unconfigured');
      expect(getSubmissionAuthorization(config, quote, NaN)).toEqual({
        state: 'unconfigured',
        stateChecked: false,
      });
      if (config.state === 'configured')
        throw new Error('Unexpected configured fixture.');
      expect(config.error.code).toBe('WritesDisabled');
    }
    for (const options of [
      { policyPath: fixture.policyPath },
      { stateDirectory: fixture.stateDirectory },
      { ...fixture, policyPath: '' },
      { ...fixture, stateDirectory: '' },
      { ...fixture, stateDirectory: 'relative/state' },
      { ...fixture, stateDirectory: `${fixture.root}/../state` },
      { ...fixture, stateDirectory: `${fixture.root}//state` },
      { ...fixture, stateDirectory: `${fixture.root}/state/` },
      { ...fixture, stateDirectory: '/' },
      { ...fixture, stateDirectory: `${fixture.root}/bad\0state` },
    ]) {
      const config = loadSubmissionConfiguration({
        ...options,
        apiKey: dummyKey,
      });
      expect(config.state).toBe('invalid');
      expect(getSubmissionAuthorization(config, quote, now)).toEqual({
        state: 'invalid',
        stateChecked: false,
      });
      if (config.state === 'configured')
        throw new Error('Unexpected configured fixture.');
      expect(config.error.code).toBe('InvalidPolicy');
    }
    expect(existsSync(fixture.stateDirectory)).toBe(false);
    expect(readFileSync(fixture.policyPath, 'utf8')).toBe(
      JSON.stringify(policy()),
    );
  });
});

test('C01/C04-POLICY: disabled, missing/invalid/mismatched key and configured states stay distinct', () => {
  withFixture((fixture) => {
    writePolicy(fixture, { ...policy(), enabled: false });
    const disabled = loadSubmissionConfiguration({
      ...fixture,
      apiKey: dummyKey,
    });
    expect(disabled.state).toBe('disabled');
    expect(getSubmissionAuthorization(disabled, quote, now)).toEqual({
      state: 'disabled',
      stateChecked: false,
    });
    writePolicy(fixture, policy());
    for (const apiKey of [
      undefined,
      '',
      ' \t\n',
      'bad\0key',
      'not-visible-é',
    ]) {
      const config = loadSubmissionConfiguration({ ...fixture, apiKey });
      expect(config.state).toBe('credential_missing');
      expect(getSubmissionAuthorization(config, quote, now)).toEqual({
        state: 'credential_missing',
        stateChecked: false,
      });
      if (config.state === 'configured')
        throw new Error('Unexpected configured fixture.');
      expect(config.error.code).toBe('MissingCredentials');
    }
    const mismatch = loadSubmissionConfiguration({
      ...fixture,
      apiKey: 'different-fixture-key',
    });
    expect(mismatch.state).toBe('credential_mismatch');
    expect(getSubmissionAuthorization(mismatch, quote, now)).toEqual({
      state: 'credential_mismatch',
      stateChecked: false,
    });
    for (const mode of ['caller_acknowledgement', 'operator_policy'] as const) {
      writePolicy(fixture, { ...policy(), mode });
      const config = configured(fixture, ' \tfixture-key-only\n ');
      expect(config.credential.effectiveKey).toBe(dummyKey);
      const summary = getSubmissionAuthorization(config, quote, now);
      expect(summary.state).toBe('configured');
      expect(summary.mode).toBe(mode);
      expect(summary.stateChecked).toBe(false);
    }
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('C01/C04-POLICY: strict complete policy has no default units, mode or authority fields', () => {
  withFixture((fixture) => {
    const original = policy();
    const bad: unknown[] = [
      null,
      [],
      'policy',
      {},
      { ...original, extra: true },
      { ...original, version: 2 },
      { ...original, version: '1' },
      { ...original, enabled: 'true' },
      { ...original, mode: 'human_approval' },
      { ...original, mode: 'operator' },
      { ...original, credentialFingerprint: 'A'.repeat(64) },
      { ...original, credentialFingerprint: 'a'.repeat(63) },
      { ...original, period: { kind: 'rolling' } },
      { ...original, period: { kind: 'utc_day', reset: true } },
      { ...original, caps: { ...original.caps, extra: 0 } },
      { ...original, currentPeriod: 'caller-reset' },
    ];
    for (const name of Object.keys(original)) {
      const missing: Record<string, unknown> = { ...original };
      delete missing[name];
      bad.push(missing);
    }
    for (const field of ['policyRevision', 'budgetScope']) {
      for (const value of ['', 'a'.repeat(129), 'bad label', 'é', 'bad\nlabel'])
        bad.push({ ...original, [field]: value });
    }
    for (const unit of ['tokens', 'indexer', 'checker'] as const) {
      const missing: Record<string, unknown> = { ...original.caps };
      delete missing[unit];
      bad.push({ ...original, caps: missing });
      for (const value of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        null,
      ])
        bad.push({ ...original, caps: { ...original.caps, [unit]: value } });
    }
    for (const value of bad) {
      expect(submissionPolicySchema.safeParse(value).success).toBe(false);
      writePolicy(fixture, value);
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
      const config = loadSubmissionConfiguration({
        ...fixture,
        apiKey: dummyKey,
      });
      expect(config.state).toBe('invalid');
    }
    const finite = {
      ...original,
      policyRevision: '~'.repeat(128),
      budgetScope: '!',
      caps: { tokens: Number.MAX_SAFE_INTEGER, indexer: 0, checker: 0 },
    };
    writePolicy(fixture, finite);
    expect(loadSubmissionPolicy(fixture.policyPath).policy).toEqual(finite);
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('C04-POLICY-FS: real private regular file loads without modifying bytes or metadata', () => {
  withFixture((fixture) => {
    const before = lstatSync(fixture.policyPath, { bigint: true });
    expect(Number(before.uid)).toBe(process.geteuid!());
    expect(before.nlink).toBe(1n);
    expect(before.mode & 0o7777n).toBe(0o600n);
    expect(loadSubmissionPolicy(fixture.policyPath).policy).toEqual(policy());
    const after = lstatSync(fixture.policyPath, { bigint: true });
    expect([
      after.dev,
      after.ino,
      after.uid,
      after.mode,
      after.nlink,
      after.size,
      after.mtimeNs,
      after.ctimeNs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.uid,
      before.mode,
      before.nlink,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(readFileSync(fixture.policyPath, 'utf8')).toBe(
      JSON.stringify(policy()),
    );
  });
});

test('C04-POLICY-FS: canonical root-sticky temp ancestor is usable without permitting unsafe owned ancestors', () => {
  withFixture((fixture) => {
    const temp = lstatSync(realpathSync('/tmp'));
    expect(temp.uid).toBe(0);
    expect(temp.mode & 0o1000).toBe(0o1000);
    expect(loadSubmissionPolicy(fixture.policyPath).policy.enabled).toBe(true);
    const ancestor = join(fixture.root, 'unsafe');
    mkdirSync(ancestor, { mode: 0o700 });
    const file = join(ancestor, 'policy.json');
    writeFileSync(file, JSON.stringify(policy()), { mode: 0o600 });
    for (const mode of [0o770, 0o777]) {
      chmodSync(ancestor, mode);
      fixedError(() => loadSubmissionPolicy(file), 'InvalidPolicy');
      expect(lstatSync(ancestor).mode & 0o7777).toBe(mode);
      expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(policy()));
    }
  });
});

test('C04-POLICY-FS: missing, relative, noncanonical and directory paths are rejected without creation', () => {
  withFixture((fixture) => {
    const directory = join(fixture.root, 'directory');
    mkdirSync(directory, { mode: 0o700 });
    const missing = join(fixture.root, 'missing', 'policy.json');
    const bad: unknown[] = [
      undefined,
      null,
      '',
      '/',
      'relative.json',
      relative(process.cwd(), fixture.policyPath),
      missing,
      directory,
      `${fixture.root}/./policy.json`,
      `${fixture.root}//policy.json`,
      `${fixture.root}/directory/../policy.json`,
      `${fixture.policyPath}/`,
      `${fixture.root}/bad\0policy`,
    ];
    for (const path of bad)
      fixedError(() => loadSubmissionPolicy(path), 'InvalidPolicy');
    expect(existsSync(join(fixture.root, 'missing'))).toBe(false);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(fixture.policyPath, 'utf8')).toBe(
      JSON.stringify(policy()),
    );
  });
});

test('C04-POLICY-FS: leaf/ancestor symlinks and multiple hard links retain their sentinels', () => {
  withFixture((fixture) => {
    const leaf = join(fixture.root, 'leaf.json');
    symlinkSync(fixture.policyPath, leaf);
    fixedError(() => loadSubmissionPolicy(leaf), 'InvalidPolicy');
    expect(readlinkSync(leaf)).toBe(fixture.policyPath);
    const alias = join(fixture.root, 'alias');
    const realDirectory = join(fixture.root, 'real');
    mkdirSync(realDirectory, { mode: 0o700 });
    const inside = join(realDirectory, 'policy.json');
    writeFileSync(inside, JSON.stringify(policy()), { mode: 0o600 });
    symlinkSync(realDirectory, alias);
    fixedError(
      () => loadSubmissionPolicy(join(alias, 'policy.json')),
      'InvalidPolicy',
    );
    expect(readlinkSync(alias)).toBe(realDirectory);
    const secondLink = join(fixture.root, 'hard.json');
    linkSync(fixture.policyPath, secondLink);
    const inode = lstatSync(fixture.policyPath).ino;
    for (const path of [fixture.policyPath, secondLink]) {
      fixedError(() => loadSubmissionPolicy(path), 'InvalidPolicy');
      expect(lstatSync(path).ino).toBe(inode);
      expect(lstatSync(path).nlink).toBe(2);
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(policy()));
    }
    expect(readFileSync(inside, 'utf8')).toBe(JSON.stringify(policy()));
  });
});

test.each([0o644, 0o660, 0o400])(
  'C04-POLICY-FS: unsafe or incomplete file mode %i is never repaired',
  (mode) => {
    withFixture((fixture) => {
      chmodSync(fixture.policyPath, mode);
      const before = lstatSync(fixture.policyPath, { bigint: true });
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
      const after = lstatSync(fixture.policyPath, { bigint: true });
      expect(after.mode & 0o7777n).toBe(BigInt(mode));
      expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
        before.ino,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ]);
      expect(readFileSync(fixture.policyPath, 'utf8')).toBe(
        JSON.stringify(policy()),
      );
    });
  },
);

test('C04-POLICY-FS: actual bytes accept 16,384 and reject 16,385 without truncation', () => {
  withFixture((fixture) => {
    const json = JSON.stringify(policy());
    const exact = json + ' '.repeat(16_384 - Buffer.byteLength(json, 'utf8'));
    writeFileSync(fixture.policyPath, exact);
    const snapshot = loadSubmissionPolicy(fixture.policyPath);
    expect(snapshot.policy).toEqual(policy());
    expect(readFileSync(fixture.policyPath, 'utf8')).toBe(exact);
    writeFileSync(fixture.policyPath, exact + ' ');
    fixedError(() => loadSubmissionPolicy(fixture.policyPath), 'InvalidPolicy');
    expect(lstatSync(fixture.policyPath).size).toBe(16_385);
    expect(readFileSync(fixture.policyPath, 'utf8')).toBe(exact + ' ');
  });
});

test('C04-POLICY-FS: malformed JSON and invalid UTF-8 fail with fixed errors', () => {
  withFixture((fixture) => {
    for (const data of [
      Buffer.from(''),
      Buffer.from('{"version":1,'),
      Buffer.concat([
        Buffer.from(JSON.stringify(policy())),
        Buffer.from([0xff]),
      ]),
    ]) {
      writeFileSync(fixture.policyPath, data);
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
      expect(readFileSync(fixture.policyPath)).toEqual(data);
      expect(
        loadSubmissionConfiguration({ ...fixture, apiKey: dummyKey }).state,
      ).toBe('invalid');
    }
  });
});

test('C04-POLICY-FS: state is an unchecked reference even when absent, a file or a symlink', () => {
  withFixture((fixture) => {
    const missing = configured(fixture);
    expect(getSubmissionAuthorization(missing, quote, now).stateChecked).toBe(
      false,
    );
    expect(existsSync(fixture.stateDirectory)).toBe(false);
    const sentinel = Buffer.from('synthetic state sentinel, not a database');
    writeFileSync(fixture.stateDirectory, sentinel, { mode: 0o600 });
    const before = lstatSync(fixture.stateDirectory, { bigint: true });
    expect(
      getSubmissionAuthorization(configured(fixture), quote, now).stateChecked,
    ).toBe(false);
    const after = lstatSync(fixture.stateDirectory, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(readFileSync(fixture.stateDirectory)).toEqual(sentinel);
    const alias = join(fixture.root, 'state-alias');
    symlinkSync(fixture.stateDirectory, alias);
    const aliasConfig = loadSubmissionConfiguration({
      policyPath: fixture.policyPath,
      stateDirectory: alias,
      apiKey: dummyKey,
    });
    expect(aliasConfig.state).toBe('configured');
    expect(
      getSubmissionAuthorization(aliasConfig, quote, now).stateChecked,
    ).toBe(false);
    expect(readlinkSync(alias)).toBe(fixture.stateDirectory);
    expect(readFileSync(fixture.stateDirectory)).toEqual(sentinel);
  });
});

function expectedPolicyDigest() {
  const canonical =
    '{"version":1,"enabled":true,"mode":"caller_acknowledgement","policyRevision":"fixture-v1","budgetScope":"fixture-scope","credentialFingerprint":"' +
    expectedKeyFingerprint +
    '","period":{"kind":"utc_day"},"caps":{"tokens":12000,"indexer":37,"checker":0}}';
  return sha('speedyindex-submission-policy-v1\0' + canonical);
}

test('C04-POLICY-IDENTITY: canonical digest ignores spelling and binds every policy authority field', () => {
  withFixture((fixture) => {
    const original = policy();
    const baseline = loadSubmissionPolicy(fixture.policyPath);
    expect(baseline.digest).toBe(expectedPolicyDigest());
    const reordered = {
      caps: { checker: 0, indexer: 37, tokens: 12_000 },
      period: { kind: 'utc_day' },
      credentialFingerprint: expectedKeyFingerprint,
      budgetScope: 'fixture-scope',
      policyRevision: 'fixture-v1',
      mode: 'caller_acknowledgement',
      enabled: true,
      version: 1,
    };
    writeFileSync(
      fixture.policyPath,
      JSON.stringify(reordered, null, 2) + '\n',
    );
    expect(loadSubmissionPolicy(fixture.policyPath)).toEqual(baseline);
    for (const changed of [
      { ...original, enabled: false },
      { ...original, mode: 'operator_policy' },
      { ...original, policyRevision: 'fixture-v2' },
      { ...original, budgetScope: 'other-fixture-scope' },
      { ...original, credentialFingerprint: sha('different-fixture') },
      ...(['tokens', 'indexer', 'checker'] as const).map((unit) => ({
        ...original,
        caps: { ...original.caps, [unit]: original.caps[unit] + 1 },
      })),
    ]) {
      writePolicy(fixture, changed);
      expect(loadSubmissionPolicy(fixture.policyPath).digest).not.toBe(
        baseline.digest,
      );
    }
  });
});

test('C04-POLICY-IDENTITY: frozen snapshot and public projection do not reload or reveal trusted secrets', () => {
  withFixture((fixture) => {
    const config = configured(fixture);
    const before = createSubmissionContext(config, quote, now);
    expect(() =>
      Object.assign(config.snapshot, { digest: 'f'.repeat(64) }),
    ).toThrow();
    expect(() =>
      Object.assign(config.snapshot.policy, { enabled: false }),
    ).toThrow();
    expect(() =>
      Object.assign(config.snapshot.policy.caps, { tokens: 0 }),
    ).toThrow();
    expect(() =>
      Object.assign(config.snapshot.policy.period, { kind: 'rolling' }),
    ).toThrow();
    expect(() =>
      Object.assign(config.credential, { effectiveKey: 'replacement-key' }),
    ).toThrow();
    expect(() =>
      Object.assign(config, { stateDirectory: 'different' }),
    ).toThrow();
    expect(() => Object.assign(before.budget.caps, { checker: 100 })).toThrow();
    expect(() =>
      Object.assign(before.authorization.period!, { id: 'reset-period' }),
    ).toThrow();
    writePolicy(fixture, {
      ...policy(),
      enabled: false,
      caps: { tokens: 0, indexer: 0, checker: 0 },
    });
    expect(
      loadSubmissionConfiguration({ ...fixture, apiKey: dummyKey }).state,
    ).toBe('disabled');
    rmSync(fixture.policyPath);
    const summary = getSubmissionAuthorization(config, quote, now);
    expect(summary).toEqual(before.authorization);
    expect(indexingAuthorizationSchema.safeParse(summary).success).toBe(true);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'state',
        'stateChecked',
        'mode',
        'policyRevision',
        'policyDigest',
        'budgetScope',
        'caps',
        'period',
        'fingerprint',
      ].sort(),
    );
    const publicJson = JSON.stringify(summary);
    for (const privateValue of [
      dummyKey,
      expectedKeyFingerprint,
      fixture.policyPath,
      fixture.stateDirectory,
    ])
      expect(publicJson.includes(privateValue)).toBe(false);
    expect(summary.stateChecked).toBe(false);
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('C05-POLICY-CONTEXT: UTC boundary changes authorization, preserving quote and policy identity', () => {
  withFixture((fixture) => {
    const config = configured(fixture);
    const before = createSubmissionContext(
      config,
      quote,
      Date.parse('2026-10-20T23:59:59.999Z'),
    );
    const sameDay = createSubmissionContext(config, quote, now);
    const after = createSubmissionContext(
      config,
      quote,
      Date.parse('2026-10-21T00:00:00Z'),
    );
    const startMs = Date.parse('2026-10-20T00:00:00Z');
    const endMs = Date.parse('2026-10-21T00:00:00Z');
    expect(before.authorization.period).toEqual({
      id: 'utc-day:2026-10-20',
      startMs,
      endMs,
    });
    expect(after.authorization.period).toEqual({
      id: 'utc-day:2026-10-21',
      startMs: endMs,
      endMs: Date.parse('2026-10-22T00:00:00Z'),
    });
    expect(before.budget).toEqual({
      credentialFingerprint: expectedKeyFingerprint,
      budgetScope: 'fixture-scope',
      periodId: 'utc-day:2026-10-20',
      periodStartMs: startMs,
      policyRevision: 'fixture-v1',
      policyDigest: expectedPolicyDigest(),
      caps: { tokens: 12_000, indexer: 37, checker: 0 },
    });
    expect(sameDay.authorization.fingerprint).toBe(
      before.authorization.fingerprint,
    );
    expect(after.authorization.fingerprint).not.toBe(
      before.authorization.fingerprint,
    );
    expect(after.budget.policyDigest).toBe(before.budget.policyDigest);
    expect(config.snapshot.digest).toBe(expectedPolicyDigest());
    const expectedFingerprint = sha(
      'speedyindex-submission-authorization-v1\0' +
        JSON.stringify({
          quoteFingerprint: quote,
          policyDigest: expectedPolicyDigest(),
          credentialFingerprint: expectedKeyFingerprint,
          budgetScope: 'fixture-scope',
          periodId: 'utc-day:2026-10-20',
          periodStartMs: startMs,
        }),
    );
    expect(before.authorization.fingerprint).toBe(expectedFingerprint);
    expect(
      createSubmissionContext(config, '2'.repeat(64), now).authorization
        .fingerprint,
    ).not.toBe(expectedFingerprint);
    const epoch = createSubmissionContext(config, quote, -1);
    expect(epoch.authorization.period).toEqual({
      id: 'utc-day:1969-12-31',
      startMs: -86_400_000,
      endMs: 0,
    });
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('C05-POLICY-CONTEXT: changed caps, scope, key, mode and revision bind new authorization context', () => {
  withFixture((fixture) => {
    const original = policy();
    const baseline = createSubmissionContext(configured(fixture), quote, now);
    const differentKey = 'different-fixture-key';
    for (const [value, apiKey] of [
      [{ ...original, caps: { ...original.caps, tokens: 12_001 } }, dummyKey],
      [{ ...original, budgetScope: 'other-scope' }, dummyKey],
      [{ ...original, policyRevision: 'fixture-v2' }, dummyKey],
      [{ ...original, mode: 'operator_policy' }, dummyKey],
      [
        {
          ...original,
          credentialFingerprint: sha(
            'speedyindex-credential-v1\0' + differentKey,
          ),
        },
        differentKey,
      ],
    ] as const) {
      writePolicy(fixture, value);
      const changed = createSubmissionContext(
        configured(fixture, apiKey),
        quote,
        now,
      );
      expect(changed.authorization.fingerprint).not.toBe(
        baseline.authorization.fingerprint,
      );
      expect(changed.budget.policyDigest).not.toBe(
        baseline.budget.policyDigest,
      );
      expect(changed.budget.periodId).toBe(baseline.budget.periodId);
      expect(changed.budget.periodStartMs).toBe(baseline.budget.periodStartMs);
    }
  });
});

test('C05-POLICY-CONTEXT: invalid trusted clocks fail closed without creating or reading state', () => {
  withFixture((fixture) => {
    const config = configured(fixture);
    for (const clock of [
      NaN,
      Infinity,
      -Infinity,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      8_640_000_000_000_001,
      8_640_000_000_000_000,
      undefined,
      null,
      '2026-10-20',
    ])
      fixedError(
        () => createSubmissionContext(config, quote, clock),
        'StateUnavailable',
      );
    for (const fingerprint of ['', 'A'.repeat(64), 'a'.repeat(63)])
      fixedError(
        () => createSubmissionContext(config, fingerprint, now),
        'InvalidInput',
      );
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('C16-POLICY-KEY: effective trim, domain and inclusive ASCII byte bound determine identity', () => {
  expect(submissionCredentialFingerprint(dummyKey)).toBe(
    expectedKeyFingerprint,
  );
  expect(submissionCredentialFingerprint(' \t\nfixture-key-only\r ')).toBe(
    expectedKeyFingerprint,
  );
  expect(submissionCredentialFingerprint('other-fixture-key')).not.toBe(
    expectedKeyFingerprint,
  );
  expect(submissionCredentialFingerprint(dummyKey)).toMatch(/^[0-9a-f]{64}$/);
  const maximum = '~'.repeat(8_192);
  expect(submissionCredentialFingerprint(' \t' + maximum + '\n ')).toBe(
    sha('speedyindex-credential-v1\0' + maximum),
  );
  fixedError(
    () => submissionCredentialFingerprint(maximum + 'a'),
    'MissingCredentials',
  );
  for (const value of [
    undefined,
    null,
    123,
    {},
    [],
    '',
    ' \t\n',
    'internal space',
    'a\tb',
    'a\nb',
    'a\0b',
    'a\x7fb',
    'é',
    '🦊',
    '\ud800',
  ])
    fixedError(
      () => submissionCredentialFingerprint(value),
      'MissingCredentials',
    );
});

// Explicit synthetic operator declarations only, never provider price fixtures.
const checkerProfiles = {
  google: { tokens: 7, indexer: 5, checker: 11 },
  yandex: { tokens: 2, indexer: 0, checker: 0 },
  bing: { tokens: 2, indexer: 0, checker: 13 },
};
const checkRequest = buildCreateIndexCheckRequest({
  mode: 'preview',
  searchEngine: 'google',
  urls: ['https://example.test/one', 'https://example.test/two'],
});
test('IC03 POLICY: absent extensions retain literal legacy bytes; explicit false and empty map bind distinct identities', () => {
  withFixture((fixture) => {
    const legacy = loadSubmissionPolicy(fixture.policyPath);
    expect(legacy.digest).toBe(expectedPolicyDigest());
    expect(Object.hasOwn(legacy.policy, 'allowIndexChecks')).toBe(false);
    expect(Object.hasOwn(legacy.policy, 'indexCheckReservations')).toBe(false);
    expect(Object.hasOwn(legacy.policy, 'allowBacklinkChecks')).toBe(false);
    expect(Object.hasOwn(legacy.policy, 'backlinkCheckReservations')).toBe(
      false,
    );
    const hashes = new Set([legacy.digest]);
    for (const extension of [
      { allowIndexChecks: false },
      { indexCheckReservations: {} },
      { allowIndexChecks: false, indexCheckReservations: {} },
      { allowIndexChecks: true },
      { allowBacklinkChecks: false },
      { backlinkCheckReservations: { tokens: 4, indexer: 3, checker: 2 } },
      {
        allowBacklinkChecks: true,
        backlinkCheckReservations: { tokens: 4, indexer: 3, checker: 2 },
      },
    ]) {
      writePolicy(fixture, { ...policy(), ...extension });
      const loaded = loadSubmissionPolicy(fixture.policyPath);
      expect(JSON.stringify(loaded.policy)).toBe(
        JSON.stringify({ ...policy(), ...extension }),
      );
      hashes.add(loaded.digest);
    }
    expect(hashes.size).toBe(8);
    // Checker-only schema growth must not widen either old public enum alias.
    expect(
      indexingAuthorizationSchema.safeParse({
        state: 'reservation_unavailable',
        stateChecked: false,
      }).success,
    ).toBe(false);
    for (const code of ['ReservationProfileRequired', 'ReservationOverflow'])
      expect(createIndexingTaskErrorCodeSchema.safeParse(code).success).toBe(
        false,
      );
  });
});
test('IC03 POLICY: strict partial profiles require all three safe units and compiled local floors', () => {
  withFixture((fixture) => {
    for (const indexCheckReservations of [
      {},
      { google: { tokens: 3, indexer: 0, checker: 0 } },
      { yandex: checkerProfiles.yandex },
      { bing: checkerProfiles.bing },
      checkerProfiles,
    ]) {
      writePolicy(fixture, { ...policy(), indexCheckReservations });
      expect(
        loadSubmissionPolicy(fixture.policyPath).policy.indexCheckReservations,
      ).toEqual(indexCheckReservations);
    }
    const bad: unknown[] = [
      null,
      [],
      { other: checkerProfiles.google },
      { google: null },
      { google: { tokens: 3, indexer: 0 } },
      { google: { tokens: 3, checker: 0 } },
      { google: { indexer: 0, checker: 0 } },
      { google: { ...checkerProfiles.google, extra: 0 } },
      {
        google: checkerProfiles.google,
        bing: { tokens: 1, indexer: 0, checker: 0 },
      },
    ];
    for (const [engine, floor] of [
      ['google', 3],
      ['yandex', 2],
      ['bing', 2],
    ] as const)
      bad.push({ [engine]: { tokens: floor - 1, indexer: 0, checker: 0 } });
    for (const unit of ['tokens', 'indexer', 'checker'])
      for (const value of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        '0',
      ])
        bad.push({ google: { ...checkerProfiles.google, [unit]: value } });
    for (const indexCheckReservations of bad) {
      const value = { ...policy(), indexCheckReservations };
      expect(submissionPolicySchema.safeParse(value).success).toBe(false);
      writePolicy(fixture, value);
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
      const config = loadSubmissionConfiguration({
        policyPath: fixture.policyPath,
      });
      expect(config.state).toBe('invalid');
      expect(config.indexCheckReservationSource).toEqual({ state: 'invalid' });
    }
    for (const allowIndexChecks of [null, 1, 'true', {}]) {
      writePolicy(fixture, { ...policy(), allowIndexChecks });
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
    }
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});
test('IC03/IC05 POLICY: canonical profile order and unselected changes bind policy/auth but not selected quote', () => {
  withFixture((fixture) => {
    writePolicy(fixture, {
      indexCheckReservations: {
        bing: { checker: 13, indexer: 0, tokens: 2 },
        yandex: checkerProfiles.yandex,
        google: { checker: 11, tokens: 7, indexer: 5 },
      },
      allowIndexChecks: true,
      ...policy(),
    });
    const config = configured(fixture);
    const canonical =
      JSON.stringify(policy()).slice(0, -1) +
      ',"allowIndexChecks":true,"indexCheckReservations":{"google":{"tokens":7,"indexer":5,"checker":11},"yandex":{"tokens":2,"indexer":0,"checker":0},"bing":{"tokens":2,"indexer":0,"checker":13}}}';
    expect(JSON.stringify(config.snapshot.policy)).toBe(canonical);
    expect(config.snapshot.digest).toBe(
      sha('speedyindex-submission-policy-v1\0' + canonical),
    );
    expect(config.indexCheckReservationSource.state).toBe('loaded');
    if (config.indexCheckReservationSource.state !== 'loaded')
      throw new Error('Expected loaded source.');
    expect(config.indexCheckReservationSource.profiles).toBe(
      config.snapshot.policy.indexCheckReservations!,
    );
    const quote = quoteIndexCheckRequest(
      checkRequest,
      config.indexCheckReservationSource,
    );
    if (quote.availability !== 'available')
      throw new Error('Expected available reservation.');
    const auth = createSubmissionContext(config, quote.fingerprint, now);
    for (const extension of [
      { allowIndexChecks: false, indexCheckReservations: checkerProfiles },
      {
        allowIndexChecks: true,
        indexCheckReservations: {
          ...checkerProfiles,
          bing: { ...checkerProfiles.bing, checker: 14 },
        },
      },
    ]) {
      writePolicy(fixture, { ...policy(), ...extension });
      const changed = configured(fixture);
      expect(changed.snapshot.digest).not.toBe(config.snapshot.digest);
      expect(
        quoteIndexCheckRequest(
          checkRequest,
          changed.indexCheckReservationSource,
        ),
      ).toEqual(quote);
      expect(
        createSubmissionContext(changed, quote.fingerprint, now).authorization
          .fingerprint,
      ).not.toBe(auth.authorization.fingerprint);
    }
    const changedDay = createSubmissionContext(
      config,
      quote.fingerprint,
      now + 86_400_000,
    );
    expect(changedDay.authorization.fingerprint).not.toBe(
      auth.authorization.fingerprint,
    );
    expect(
      quoteIndexCheckRequest(checkRequest, config.indexCheckReservationSource),
    ).toEqual(quote);
  });
});
test('IC03 POLICY: policy-only/inactive startup keeps only frozen profiles and never grants indexing permission or opens state', () => {
  withFixture((fixture) => {
    for (const extension of [
      { allowIndexChecks: true },
      { allowIndexChecks: false },
      {},
      { allowIndexChecks: true, enabled: false },
    ]) {
      writePolicy(fixture, {
        ...policy(),
        ...extension,
        indexCheckReservations: checkerProfiles,
      });
      for (const options of [
        { policyPath: fixture.policyPath },
        { policyPath: fixture.policyPath, stateDirectory: '' },
        { policyPath: fixture.policyPath, stateDirectory: 'relative' },
        { ...fixture },
        { ...fixture, apiKey: 'wrong-synthetic-key' },
      ]) {
        const config = loadSubmissionConfiguration(options);
        expect(config.state).not.toBe('configured');
        const expected =
          !options.stateDirectory || options.stateDirectory === 'relative'
            ? 'invalid'
            : extension.enabled === false
              ? 'disabled'
              : 'apiKey' in options
                ? 'credential_mismatch'
                : 'credential_missing';
        expect(config.state).toBe(expected);
        expect(getSubmissionAuthorization(config, quote, now)).toEqual({
          state: expected,
          stateChecked: false,
        });
        expect(Object.keys(config).sort()).toEqual(
          [
            'state',
            'error',
            'indexCheckReservationSource',
            'backlinkCheckReservationSource',
          ].sort(),
        );
        expect(config.indexCheckReservationSource).toEqual({
          state: 'loaded',
          profiles: checkerProfiles,
        });
        expect(config.backlinkCheckReservationSource).toEqual({
          state: 'loaded',
        });
        const serialized = JSON.stringify(config.indexCheckReservationSource);
        for (const secret of [
          dummyKey,
          expectedKeyFingerprint,
          fixture.policyPath,
          fixture.stateDirectory,
          'policyRevision',
          'budgetScope',
          'credential',
          'caps',
        ])
          expect(serialized.includes(secret)).toBe(false);
        expect(
          quoteIndexCheckRequest(
            checkRequest,
            config.indexCheckReservationSource,
          ),
        ).toMatchObject({
          availability: 'available',
          reservation: { tokens: 14, indexer: 10, checker: 22 },
        });
      }
    }
    expect(existsSync(fixture.stateDirectory)).toBe(false);
    expect(
      loadSubmissionConfiguration({ stateDirectory: fixture.stateDirectory })
        .indexCheckReservationSource,
    ).toEqual({ state: 'unconfigured' });
    expect(loadSubmissionConfiguration().indexCheckReservationSource).toEqual({
      state: 'unconfigured',
    });
    for (const policyPath of [
      fixture.policyPath + '.missing',
      'relative/policy',
    ])
      expect(
        loadSubmissionConfiguration({ policyPath }).indexCheckReservationSource,
      ).toEqual({ state: 'invalid' });
    chmodSync(fixture.policyPath, 0o644);
    expect(
      loadSubmissionConfiguration({ policyPath: fixture.policyPath })
        .indexCheckReservationSource,
    ).toEqual({ state: 'invalid' });
  });
});

const backlinkReservation = { tokens: 4, indexer: 3, checker: 2 };
const backlinkRequest = buildCreateBacklinkCheckRequest({
  mode: 'preview',
  urls: ['https://donor.example.test/a', 'https://donor.example.test/b'],
  targetDomains: ['target.example.test'],
});

test('BC02 POLICY: backlink profile requires all safe units and its token floor even when permission is false', () => {
  withFixture((fixture) => {
    for (const valid of [
      { tokens: 2, indexer: 0, checker: 0 },
      backlinkReservation,
    ]) {
      const value = {
        ...policy(),
        allowBacklinkChecks: false,
        backlinkCheckReservations: valid,
      };
      expect(submissionPolicySchema.safeParse(value).success).toBe(true);
      writePolicy(fixture, value);
      expect(
        loadSubmissionPolicy(fixture.policyPath).policy
          .backlinkCheckReservations,
      ).toEqual(valid);
    }

    const invalidProfiles: unknown[] = [
      null,
      [],
      {},
      { tokens: 2, indexer: 0 },
      { tokens: 2, checker: 0 },
      { indexer: 0, checker: 0 },
      { ...backlinkReservation, extra: 0 },
      { tokens: 1, indexer: 0, checker: 0 },
    ];
    for (const unit of ['tokens', 'indexer', 'checker'])
      for (const invalidUnit of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        '0',
      ])
        invalidProfiles.push({
          ...backlinkReservation,
          [unit]: invalidUnit,
        });

    for (const backlinkCheckReservations of invalidProfiles) {
      const value = {
        ...policy(),
        allowBacklinkChecks: false,
        backlinkCheckReservations,
      };
      expect(submissionPolicySchema.safeParse(value).success).toBe(false);
      writePolicy(fixture, value);
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
      const config = loadSubmissionConfiguration({
        policyPath: fixture.policyPath,
      });
      expect(config.state).toBe('invalid');
      expect(config.indexCheckReservationSource).toEqual({ state: 'invalid' });
      expect(config.backlinkCheckReservationSource).toEqual({
        state: 'invalid',
      });
    }

    for (const allowBacklinkChecks of [null, 0, 'true', {}]) {
      writePolicy(fixture, {
        ...policy(),
        allowBacklinkChecks,
        backlinkCheckReservations: backlinkReservation,
      });
      fixedError(
        () => loadSubmissionPolicy(fixture.policyPath),
        'InvalidPolicy',
      );
    }
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});

test('BC02 POLICY: optional backlink fields append after checker fields and freeze a key-free startup quote source', () => {
  withFixture((fixture) => {
    const value = {
      ...policy(),
      allowIndexChecks: true,
      indexCheckReservations: checkerProfiles,
      allowBacklinkChecks: true,
      backlinkCheckReservations: backlinkReservation,
    };
    writePolicy(fixture, value);
    const config = configured(fixture);
    const backlinkSource = config.backlinkCheckReservationSource;
    expect(backlinkSource).toEqual({
      state: 'loaded',
      profile: backlinkReservation,
    });
    expect(Object.keys(config.snapshot.policy)).toEqual([
      'version',
      'enabled',
      'mode',
      'policyRevision',
      'budgetScope',
      'credentialFingerprint',
      'period',
      'caps',
      'allowIndexChecks',
      'indexCheckReservations',
      'allowBacklinkChecks',
      'backlinkCheckReservations',
    ]);
    expect(JSON.stringify(config.snapshot.policy)).toBe(JSON.stringify(value));
    expect(config.snapshot.digest).toBe(
      sha('speedyindex-submission-policy-v1\0' + JSON.stringify(value)),
    );
    expect(Object.isFrozen(config.snapshot.policy)).toBe(true);
    expect(
      Object.isFrozen(config.snapshot.policy.backlinkCheckReservations),
    ).toBe(true);
    expect(backlinkSource && Object.isFrozen(backlinkSource)).toBe(true);
    if (backlinkSource?.state !== 'loaded')
      throw new Error('Expected loaded backlink reservation source.');
    expect(backlinkSource.profile).toBe(
      config.snapshot.policy.backlinkCheckReservations,
    );
    expect(() =>
      Object.assign(backlinkSource, { profile: undefined }),
    ).toThrow();
    expect(() =>
      Object.assign(backlinkSource.profile!, { checker: 99 }),
    ).toThrow();

    const quote = quoteBacklinkCheckRequest(backlinkRequest, backlinkSource);
    expect(quote).toMatchObject({
      basis: 'operator_configured_reservation',
      providerEnforced: false,
      providerFeesKnown: false,
      availability: 'available',
      perUrlReservation: backlinkReservation,
      reservation: { tokens: 8, indexer: 6, checker: 4 },
    });
    const inactive = loadSubmissionConfiguration({
      policyPath: fixture.policyPath,
      stateDirectory: fixture.stateDirectory,
    });
    expect(inactive.state).toBe('credential_missing');
    expect(inactive.backlinkCheckReservationSource).toEqual(backlinkSource);
    expect(
      quoteBacklinkCheckRequest(
        backlinkRequest,
        inactive.backlinkCheckReservationSource!,
      ),
    ).toEqual(quote);
    const serializedSource = JSON.stringify(
      inactive.backlinkCheckReservationSource,
    );
    for (const privateValue of [
      dummyKey,
      expectedKeyFingerprint,
      fixture.policyPath,
      fixture.stateDirectory,
      'credential',
      'caps',
    ])
      expect(serializedSource.includes(privateValue)).toBe(false);
    expect(existsSync(fixture.stateDirectory)).toBe(false);

    writePolicy(fixture, {
      ...policy(),
      allowBacklinkChecks: true,
    });
    expect(quoteBacklinkCheckRequest(backlinkRequest, backlinkSource)).toEqual(
      quote,
    );
    const missing = loadSubmissionConfiguration({
      policyPath: fixture.policyPath,
      stateDirectory: fixture.stateDirectory,
      apiKey: dummyKey,
    });
    expect(missing.backlinkCheckReservationSource).toEqual({
      state: 'loaded',
    });
    expect(
      quoteBacklinkCheckRequest(
        backlinkRequest,
        missing.backlinkCheckReservationSource!,
      ),
    ).toMatchObject({ availability: 'unavailable', reason: 'profile_missing' });
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});
test('IC03 POLICY: frozen startup profile source survives file change/removal and overflow does not open state', () => {
  withFixture((fixture) => {
    writePolicy(fixture, {
      ...policy(),
      allowIndexChecks: true,
      indexCheckReservations: checkerProfiles,
    });
    const config = configured(fixture);
    const source = config.indexCheckReservationSource;
    if (source.state !== 'loaded') throw new Error('Expected profile source.');
    const before = quoteIndexCheckRequest(checkRequest, source);
    expect(() => Object.assign(source, { profiles: {} })).toThrow();
    expect(() =>
      Object.assign(source.profiles!, { bing: checkerProfiles.google }),
    ).toThrow();
    expect(() =>
      Object.assign(source.profiles!.google!, { tokens: 0 }),
    ).toThrow();
    expect(() =>
      Object.assign(config.snapshot.policy.indexCheckReservations!.google!, {
        checker: 0,
      }),
    ).toThrow();
    writePolicy(fixture, {
      ...policy(),
      indexCheckReservations: {
        google: { tokens: Number.MAX_SAFE_INTEGER, indexer: 0, checker: 0 },
      },
    });
    const changed = loadSubmissionConfiguration({
      policyPath: fixture.policyPath,
    });
    expect(
      quoteIndexCheckRequest(checkRequest, changed.indexCheckReservationSource),
    ).toMatchObject({
      availability: 'unavailable',
      reason: 'reservation_overflow',
    });
    expect(quoteIndexCheckRequest(checkRequest, source)).toEqual(before);
    rmSync(fixture.policyPath);
    expect(quoteIndexCheckRequest(checkRequest, source)).toEqual(before);
    expect(existsSync(fixture.stateDirectory)).toBe(false);
  });
});
