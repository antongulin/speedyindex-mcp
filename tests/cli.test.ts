import { expect, test } from 'bun:test';
import { bounded, fixture } from './helpers';

for (const arg of ['--help', '--version', '--unsupported']) {
  test(`F08: ${arg} needs no credentials/network, respects stdout/stderr`, async () => {
    const api = await fixture((_req, res) => res.end('unexpected'));
    const child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        './tests/fixtures/redirect-fetch.ts',
        'src/cli.ts',
        arg,
      ],
      {
        env: { TEST_ACCOUNT_ORIGIN: api.origin },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    try {
      const [code, stdout, stderr] = await bounded(
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
      );
      expect(api.requests).toHaveLength(0);
      if (arg === '--unsupported') {
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe('Unsupported arguments. Use --help for usage.\n');
      } else {
        expect(code).toBe(0);
        expect(stderr).toBe('');
        if (arg === '--version') expect(stdout).toBe('0.1.0\n');
        else {
          expect(stdout).toContain('get_balance');
          expect(stdout).toContain('list_tasks');
        }
      }
    } finally {
      child.kill();
      await child.exited;
      await api.close();
    }
  });
}
