import { writeSync } from 'node:fs';
import type { MigrationPhase } from '../../src/submission-ledger';

function denyNetwork(): never {
  throw new Error('Migration child network access is forbidden.');
}
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

function send(marker: MigrationPhase | 'receipt' | 'child_failure', fd = 1) {
  const bytes = Buffer.from(`${marker}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Migration marker write failed.');
    offset += written;
  }
}

async function main() {
  // Read setup before opening state. There is no await in the migration callback.
  let text = '';
  for await (const chunk of process.stdin) {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(text) > 8192) throw new Error('Invalid child setup.');
  }
  const config = JSON.parse(text) as {
    stateDirectory: string;
    backupDirectory: string;
    pauseAt: 'before_commit' | 'after_commit';
  };
  if (config.pauseAt !== 'before_commit' && config.pauseAt !== 'after_commit')
    throw new Error('Invalid child phase.');
  const { migrateLedgerV2 } = await import('../../src/submission-ledger');
  migrateLedgerV2(
    {
      stateDirectory: config.stateDirectory,
      backupDirectory: config.backupDirectory,
    },
    {
      onPhase(phase) {
        send(phase);
        if (phase === config.pauseAt) {
          // Established owned-fixture pattern: flush fixed marker, synchronously
          // stop this process, and let the parent SIGKILL/reap it at this phase.
          process.kill(process.pid, 'SIGSTOP');
        }
      },
    },
  );
  send('receipt');
}

try {
  await main();
} catch {
  send('child_failure', 2);
  process.exitCode = 1;
}
