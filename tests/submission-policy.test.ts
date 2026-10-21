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
} from '../src/create-indexing-task';
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
