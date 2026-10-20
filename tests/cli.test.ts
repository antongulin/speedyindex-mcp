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
import { bounded, fixture } from './helpers';

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
