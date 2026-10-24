// Test-only entry. Sanity dispatch is before every production/SDK/socket import.
import {
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  HistoryControlDecoder,
  HistoryPhaseDecoder,
  HISTORY_PHASE_PREFIX,
  HISTORY_SANITY_PREFIX,
  type HistoryPhase,
} from './get-retry-history-protocol';

const entries = {
  nativeEntries: 0,
  sdkEntries: 0,
  socketEntries: 0,
  httpAttempts: 0,
};
function refuse(): never {
  throw new Error('Invalid history fixture entry.');
}
function write(line: string) {
  const bytes = Buffer.from(line);
  let offset = 0;
  while (offset < bytes.length) {
    const size = writeSync(2, bytes, offset, bytes.length - offset);
    if (size <= 0) refuse();
    offset += size;
  }
}
function privateRoot(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    refuse();
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    refuse();
  return path;
}
function sanity(path: string) {
  const temporary = privateRoot(process.env.TMPDIR ?? '');
  const root = privateRoot(dirname(path));
  if (!root.startsWith(temporary + sep) || realpathSync(path) !== path)
    refuse();
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 65_536
  )
    refuse();
  const raw = readFileSync(path);
  if (raw.byteLength > 65_536) refuse();
  const fixture: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw),
  );
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture))
    refuse();
  const v = fixture as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'controlChunks,phaseChunks,version' ||
    v.version !== 1
  )
    refuse();
  function chunks(value: unknown): Buffer[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 64)
      refuse();
    return value.map((text: unknown) => {
      if (typeof text !== 'string' || text.length > 21_848) refuse();
      const bytes = Buffer.from(text, 'base64');
      if (!bytes.length || bytes.toString('base64') !== text) refuse();
      return bytes;
    });
  }
  const phase = new HistoryPhaseDecoder();
  const control = new HistoryControlDecoder();
  for (const chunk of chunks(v.phaseChunks)) phase.push(chunk);
  phase.finish();
  let controls = 0;
  for (const chunk of chunks(v.controlChunks))
    controls += control.push(chunk).length;
  control.finish();
  write(
    HISTORY_SANITY_PREFIX +
      JSON.stringify({
        event: 'SANITY_COMPLETE',
        phaseEvents: phase.events.length,
        controlFrames: controls,
        ...entries,
      }) +
      '\n',
  );
}

/** Authored for the later ROOT gate; never reached by --phase-sanity. */
async function normal(mode: 'observe' | 'bounded' | 'cancel', root: string) {
  privateRoot(root);
  const socketPath = join(root, 'control.sock');
  // Darwin sockaddr_un.sun_path is 104 bytes, including the terminating NUL.
  if (Buffer.byteLength(socketPath) > 103) refuse();
  const state = process.env.TEST_SUBMISSION_STATE;
  const policy = process.env.TEST_SUBMISSION_POLICY;
  if (
    !state?.startsWith(root + sep) ||
    !policy?.startsWith(root + sep) ||
    resolve(state) !== state ||
    resolve(policy) !== policy ||
    process.env.SPEEDYINDEX_API_KEY !== 'synthetic-test-key-do-not-use'
  )
    refuse();

  // Deny and count before importing or constructing any production transport.
  const deny = (): never => {
    entries.httpAttempts++;
    throw new Error('History fixture HTTP denied.');
  };
  globalThis.fetch = new Proxy(globalThis.fetch, {
    apply: deny,
    get(target, name, receiver) {
      return name === 'preconnect' ? deny : Reflect.get(target, name, receiver);
    },
  });
  entries.nativeEntries++;
  const { SubmissionHost } = await import('../../src/submission-host');
  const { loadSubmissionConfiguration } =
    await import('../../src/submission-policy');
  entries.sdkEntries++;
  const { createServer } = await import('../../src/server');
  const { StdioServerTransport } =
    await import('@modelcontextprotocol/server/stdio');
  entries.socketEntries++;
  const { createServer: createControlServer } = await import('node:net');

  const configuration = loadSubmissionConfiguration({
    stateDirectory: state,
    policyPath: policy,
    apiKey: process.env.SPEEDYINDEX_API_KEY,
  });
  if (configuration.state !== 'configured') refuse();
  const validator = new HistoryPhaseDecoder();
  function phase(event: HistoryPhase) {
    const line = HISTORY_PHASE_PREFIX + JSON.stringify(event) + '\n';
    validator.push(Buffer.from(line));
    write(line);
  }
  let operation = 0;
  let active = 0;
  let activeSignal: AbortSignal | undefined;
  let nativeReads = 0;
  let nativeCloses = 0;
  let budgetSettlements = 0;
  let held = false;
  const gate = Promise.withResolvers<void>();
  // Only rejection during owned teardown; no teardown produces success phases.
  void gate.promise.catch(() => undefined);
  const pending = new Set<Promise<unknown>>();
  class ObservedHost extends SubmissionHost {
    override async getRetryHistoryToolResult(
      value: unknown,
      signal?: AbortSignal,
    ) {
      if (active || operation >= 32) refuse();
      const number = ++operation;
      active = number;
      activeSignal = signal;
      phase({ event: 'HANDLER_ENTER', operation: number });
      const onAbort = () =>
        phase({ event: 'SIGNAL_ABORTED', operation: number });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const owned = super.getRetryHistoryToolResult(value, signal);
      pending.add(owned);
      try {
        const result = await owned;
        const payload = result.structuredContent;
        phase({
          event: 'OWNER_SETTLED',
          operation: number,
          aborted: signal?.aborted === true,
          status: payload.status,
          code: payload.status === 'error' ? payload.error.code : null,
        });
        return result;
      } finally {
        pending.delete(owned);
        signal?.removeEventListener('abort', onAbort);
        active = 0;
        activeSignal = undefined;
      }
    }
  }
  const host = new ObservedHost(configuration, {
    history: {
      ...(mode === 'bounded' ? { resultBytes: 1_024 } : {}),
      onPhase(name) {
        if (name === 'before_read') nativeReads++;
      },
      snapshotHooks: {
        afterNativeClose() {
          nativeCloses++;
          phase({ event: 'NATIVE_CLOSED', operation: active });
        },
      },
      async afterReadIO() {
        if (mode === 'cancel' && active === 1) {
          held = true;
          phase({ event: 'READ_IO_HELD', operation: 1 });
          await gate.promise;
        }
      },
      async afterBudgetClose() {
        budgetSettlements++;
        phase({ event: 'BUDGET_CLOSED', operation: active });
      },
    },
  });
  const server = createServer(undefined, host);
  const controls = new HistoryControlDecoder();
  let connection: import('node:net').Socket | undefined;
  let connected = false;
  let bound = false;
  let shuttingDown = false;
  const control = createControlServer((socket) => {
    if (connected) {
      socket.destroy();
      fail();
      return;
    }
    connected = true;
    connection = socket;
    socket.on('data', (bytes) => {
      try {
        if (typeof bytes === 'string') {
          fail();
          return;
        }
        for (const command of controls.push(bytes)) {
          if (command.event === 'BARRIER') {
            phase({
              event: 'BARRIER',
              sequence: command.sequence,
              handlerEntries: operation,
              nativeReads,
              nativeCloses,
              budgetSettlements,
              httpAttempts: entries.httpAttempts,
            });
          } else {
            if (
              mode !== 'cancel' ||
              active !== 1 ||
              !held ||
              activeSignal?.aborted !== true
            )
              refuse();
            gate.resolve();
          }
        }
      } catch {
        fail();
      }
    });
    socket.on('end', () => {
      try {
        controls.finish();
      } catch {
        fail();
      }
    });
    socket.on('error', fail);
  });
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    gate.reject(new Error('History fixture closed.'));
    await Promise.allSettled([...pending]);
    await server.close();
    connection?.destroy();
    if (bound)
      await new Promise<void>((done, reject) =>
        control.close((error) => (error ? reject(error) : done())),
      );
    // Node normally unlinks its own Unix socket when closing the listener.
    if (bound) {
      try {
        const stat = lstatSync(socketPath);
        if (!stat.isSocket() || stat.uid !== process.getuid?.()) refuse();
        unlinkSync(socketPath);
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    validator.finish();
  }
  let failed = false;
  function fail() {
    if (!failed) {
      failed = true;
      write(HISTORY_PHASE_PREFIX + '{"event":"FIXTURE_ERROR"}\n');
    }
    process.exitCode = 1;
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  }
  control.on('error', fail);
  server.server.onerror = fail;
  process.stdin.once('end', () => {
    void shutdown().catch(fail);
  });
  try {
    await new Promise<void>((done, reject) => {
      control.once('error', reject);
      control.listen(socketPath, () => {
        control.removeListener('error', reject);
        bound = true;
        done();
      });
    });
    await server.connect(new StdioServerTransport());
    phase({ event: 'BOOT_READY' });
  } catch {
    fail();
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--phase-sanity') {
    sanity(args[1] ?? '');
  } else if (
    args.length === 4 &&
    args[0] === '--mode' &&
    args[2] === '--control-root' &&
    (args[1] === 'observe' || args[1] === 'bounded' || args[1] === 'cancel')
  ) {
    await normal(args[1], args[3] ?? '');
  } else refuse();
} catch {
  write(HISTORY_PHASE_PREFIX + '{"event":"FIXTURE_ERROR"}\n');
  process.exitCode = 1;
}
