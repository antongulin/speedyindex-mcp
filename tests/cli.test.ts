import { expect, test } from 'bun:test';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bounded, fixture } from './helpers';

test('P2-08 preload rejects extra, duplicate, PPR and other-route queries before receiver arrival', async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'speedyindex-p2-query-')),
  );
  const api = await fixture((_request, response) =>
    response.end('unexpected arrival'),
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const reads: Promise<unknown>[] = [];
  const results: unknown[] = [];
  const errors: unknown[] = [],
    cleanup: unknown[] = [];
  try {
    for (const suffix of [
      '/v2/task/google/indexer/list/0?filter=drip_feed&extra=1',
      '/v2/task/google/indexer/list/0?filter=drip_feed&filter=drip_feed',
      '/v2/task/google/indexer/list/0?filter=drip_feed&subfilter=pay_per_indexed',
      '/v2/task/yandex/indexer/list/0?filter=drip_feed',
    ]) {
      const script =
        'try { await fetch(' +
        JSON.stringify('https://api.speedyindex.com' + suffix) +
        ', { redirect: "error" }); console.log(JSON.stringify({rejected:false})); process.exitCode=2; }' +
        ' catch(error) { if (!(error instanceof Error) || error.message !== "Unexpected production URL") throw error;' +
        ' console.log(JSON.stringify({rejected:true})); }';
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          '--preload',
          './tests/fixtures/redirect-fetch.ts',
          '--eval',
          script,
        ],
        {
          cwd: process.cwd(),
          env: { HOME: root, TEST_ACCOUNT_ORIGIN: api.origin },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      children.push(child);
      const reading = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      reads.push(reading);
      const [code, stdout, stderr] = await bounded(reading, 5000);
      results.push({ suffix, code, stdout, stderr });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ rejected: true });
      expect(stderr).toBe('Test network isolation violation.\n');
      expect(api.requests).toEqual([]);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    const stopped = await Promise.allSettled(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await bounded(child.exited, 5000);
      }),
    );
    for (const item of stopped)
      if (item.status === 'rejected') cleanup.push(item.reason);
    const settled = await Promise.allSettled(reads);
    for (const item of settled)
      if (item.status === 'rejected') cleanup.push(item.reason);
    try {
      await api.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  const result = {
    root,
    results,
    requests: api.requests,
    passed: errors.length === 0 && cleanup.length === 0,
    settled: cleanup.length === 0,
    children: children.map((child) => ({
      pid: child.pid,
      code: child.exitCode,
      signal: child.signalCode,
    })),
    errors: [...errors, ...cleanup].map((error) => String(error)),
  };
  writeFileSync(
    join(root, 'query-guard.json'),
    JSON.stringify(result, null, 2) + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  console.error(
    'P2_QUERY_FIXTURE ' +
      JSON.stringify({
        root,
        passed: result.passed,
        settled: result.settled,
      }),
  );
  if (errors.length || cleanup.length)
    throw new AggregateError(
      [...errors, ...cleanup],
      'Query guard failed; preserving ' + root,
    );
});

for (const arg of ['--help', '--version', '--unsupported']) {
  test(`F08: ${arg} needs no credentials/network, respects stdout/stderr`, async () => {
    await withLocalCli(async (h) => {
      const { code, stdout, stderr } = await h.run([arg]);
      if (arg === '--unsupported') {
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe('Unsupported arguments. Use --help for usage.\n');
      } else {
        expect(code).toBe(0);
        expect(stderr).toBe('');
        if (arg === '--version') expect(stdout).toBe('0.1.0\n');
        else
          for (const tool of [
            'get_balance',
            'list_tasks',
            'get_task_status',
            'get_task_report',
            'create_indexing_task',
            'plan_retry',
          ])
            expect(stdout).toContain(tool);
      }
    });
  });
}

function localSnapshot(root: string): unknown[] {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name),
        stat = lstatSync(path, { bigint: true });
      return [
        name,
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
        stat.isDirectory()
          ? localSnapshot(path)
          : stat.isFile()
            ? createHash('sha256').update(readFileSync(path)).digest('hex')
            : 'symlink',
      ];
    });
}
async function withLocalCli(
  operation: (h: {
    root: string;
    run: (
      args: string[],
      key?: string,
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'speedyindex-cli-'));
  chmodSync(root, 0o700);
  const commandHome = mkdtempSync(
    join(realpathSync('/tmp'), 'speedyindex-cli-home-'),
  );
  chmodSync(commandHome, 0o700);
  let api: Awaited<ReturnType<typeof fixture>>;
  try {
    api = await fixture((_request, response) => response.end('unexpected'));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(commandHome, { recursive: true, force: true });
    throw error;
  }
  const children: ReturnType<typeof spawnLocal>[] = [];
  const reads: Promise<unknown>[] = [];
  function spawnLocal(args: string[], key?: string) {
    return Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--preload',
        './tests/fixtures/redirect-fetch.ts',
        'src/cli.ts',
        ...args,
      ],
      {
        env: {
          HOME: commandHome,
          TEST_ACCOUNT_ORIGIN: api.origin,
          ...(key === undefined ? {} : { SPEEDYINDEX_API_KEY: key }),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  }
  const operationErrors: unknown[] = [];
  try {
    await operation({
      root,
      async run(args, key) {
        const child = spawnLocal(args, key);
        children.push(child); // before stream reads or any startup serialization
        const reading = Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        reads.push(reading);
        const [code, stdout, stderr] = await bounded(reading, 8_000);
        expect(api.requests).toHaveLength(0);
        return { code, stdout, stderr };
      },
    });
  } catch (error) {
    operationErrors.push(error);
  }
  {
    const cleanup: unknown[] = [];
    const exited = await Promise.allSettled(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await bounded(child.exited, 5_000);
      }),
    );
    for (const result of exited)
      if (result.status === 'rejected') cleanup.push(result.reason);
    try {
      await bounded(Promise.allSettled(reads), 5_000);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await api.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(
        [...operationErrors, ...cleanup],
        `CLI cleanup failed; preserving owned root ${root}.`,
        { cause: cleanup[0] },
      );
    rmSync(root, { recursive: true, force: true });
    rmSync(commandHome, { recursive: true, force: true });
  }
  if (operationErrors.length) throw operationErrors[0];
}

test('C16 CLI: explicit fingerprint trims and domain-binds only the supplied dummy key without state or network', async () => {
  await withLocalCli(async (h) => {
    const before = localSnapshot(h.root);
    const result = await h.run(
      ['--submission-credential-fingerprint'],
      ' \tsynthetic-cli-key\r\n',
    );
    const expected = createHash('sha256')
      .update('speedyindex-credential-v1\0synthetic-cli-key')
      .digest('hex');
    expect(result).toEqual({ code: 0, stdout: `${expected}\n`, stderr: '' });
    for (const key of [undefined, '', '   ', 'non-ascii-é', 'a'.repeat(8193)]) {
      expect(await h.run(['--submission-credential-fingerprint'], key)).toEqual(
        {
          code: 1,
          stdout: '',
          stderr: 'Set SPEEDYINDEX_API_KEY to a valid submission API key.\n',
        },
      );
    }
    expect(localSnapshot(h.root)).toEqual(before);
  });
}, 30_000);

test('C16 CLI: explicit new-only initialization creates private V1 without a key and refuses reinitialization', async () => {
  await withLocalCli(async (h) => {
    const state = join(h.root, 'state');
    expect(await h.run(['--init-submission-state', state])).toEqual({
      code: 0,
      stdout: '{"initialized":true,"schemaVersion":1}\n',
      stderr: '',
    });
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    const file = join(state, 'ledger.sqlite');
    const metadata = lstatSync(file);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.uid).toBe(process.geteuid!());
    expect(metadata.nlink).toBe(1);
    const db = new Database(
      file,
      sqliteConstants.SQLITE_OPEN_READONLY |
        sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({
        user_version: 1,
      });
      expect(db.query('SELECT count(*) AS n FROM intents').get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
    const before = localSnapshot(h.root);
    expect(await h.run(['--init-submission-state', state])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Could not initialize submission state.\n',
    });
    expect(localSnapshot(h.root)).toEqual(before);
  });
}, 30_000);

test('C16 CLI: init preserves existing missing/zero/truncated/wrong-version/symlink sentinels and never creates parents', async () => {
  await withLocalCli(async (h) => {
    const paths: string[] = [];
    for (const label of ['missing-db', 'zero', 'truncated', 'wrong-version']) {
      const state = join(h.root, label);
      paths.push(state);
      if (label === 'wrong-version') {
        expect((await h.run(['--init-submission-state', state])).code).toBe(0);
        const db = new Database(join(state, 'ledger.sqlite'));
        try {
          db.exec('PRAGMA user_version = 2');
        } finally {
          db.close();
        }
      } else {
        mkdirSync(state, { mode: 0o700 });
        writeFileSync(
          join(state, label === 'missing-db' ? 'sentinel' : 'ledger.sqlite'),
          label === 'zero' ? '' : 'preserve synthetic sentinel',
          { mode: 0o600 },
        );
      }
    }
    const alias = join(h.root, 'symlink');
    symlinkSync(paths[0]!, alias);
    paths.push(alias);
    paths.push(
      join(h.root, 'absent-parent', 'state'),
      `${h.root}/../noncanonical-state`,
      'relative-synthetic-state',
    );
    const before = localSnapshot(h.root);
    for (const path of paths) {
      expect(await h.run(['--init-submission-state', path])).toEqual({
        code: 1,
        stdout: '',
        stderr: 'Could not initialize submission state.\n',
      });
      expect(localSnapshot(h.root)).toEqual(before);
    }
    expect(existsSync(join(h.root, 'absent-parent'))).toBe(false);
  });
}, 30_000);

test('C16 CLI: local modes are exclusive and malformed/duplicate arguments have one fixed error', async () => {
  await withLocalCli(async (h) => {
    for (const args of [
      ['--init-submission-state'],
      ['--submission-policy'],
      ['--submission-state'],
      ['--submission-policy', '--submission-state', join(h.root, 'state')],
      [
        '--submission-state',
        join(h.root, 'one'),
        '--submission-state',
        join(h.root, 'two'),
      ],
      [
        '--submission-credential-fingerprint',
        '--submission-credential-fingerprint',
      ],
      [
        '--submission-credential-fingerprint',
        '--init-submission-state',
        join(h.root, 'state'),
      ],
      [
        '--submission-credential-fingerprint',
        '--submission-policy',
        join(h.root, 'policy'),
      ],
      [
        '--init-submission-state',
        join(h.root, 'state'),
        '--submission-state',
        join(h.root, 'other'),
      ],
      ['--help', '--submission-credential-fingerprint'],
      ['--version', '--submission-state', 'ignored'],
      ['--unknown', 'synthetic-private-argument'],
    ])
      expect(await h.run(args)).toEqual({
        code: 1,
        stdout: '',
        stderr: 'Unsupported arguments. Use --help for usage.\n',
      });
    expect(localSnapshot(h.root)).toEqual([]);
  });
}, 30_000);

import { verifyV2Maintenance } from './helpers';
test(
  'V2-10 SOURCE maintenance grammar, private V2 init and populated V1 offline migration',
  () => verifyV2Maintenance('src/cli.ts'),
  60_000,
);
