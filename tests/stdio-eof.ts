import { spawn } from 'node:child_process';
import { expect } from 'bun:test';
import { bounded, deferred } from './helpers';

export async function verifyEof(entry: string) {
  const child = spawn(process.execPath, ['--no-env-file', entry], {
    env: {},
    stdio: 'pipe',
  });
  const initialized = deferred<unknown>();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes('\n')) {
      try {
        initialized.resolve(JSON.parse(stdout.split('\n')[0]!));
      } catch (error) {
        initialized.resolve(error);
      }
    }
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eof-fixture', version: '1.0.0' } } })}\n`,
    );
    expect(await bounded(initialized.promise)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'speedyindex-mcp' } },
    });
    child.stdin.end();
    expect(await bounded(exited)).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await bounded(exited);
  }
}
