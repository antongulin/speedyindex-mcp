// Sanity dispatch precedes every SDK/product/socket/native-helper import.
import {
  lstatSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CompareControlDecoder,
  ComparePhaseDecoder,
  COMPARE_PHASE_PREFIX,
  COMPARE_SANITY_PREFIX,
  type ComparePhase,
} from './compare-reports-sdk-protocol';
function refuse(): never {
  throw new Error('Invalid comparison fixture entry.');
}
function write(text: string) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(2, bytes, offset, bytes.length - offset);
    if (n <= 0) refuse();
    offset += n;
  }
}
function privateRoot(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    refuse();
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700
  )
    refuse();
  return path;
}
function sanity(path: string) {
  const temporary = privateRoot(process.env.TMPDIR ?? '');
  const root = privateRoot(dirname(path));
  if (!root.startsWith(temporary + sep) || realpathSync(path) !== path)
    refuse();
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o600 ||
    s.size > 65_536
  )
    refuse();
  const raw = readFileSync(path);
  if (raw.length > 65_536) refuse();
  const v: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw),
  );
  if (!v || typeof v !== 'object' || Array.isArray(v)) refuse();
  const f = v as Record<string, unknown>;
  if (
    Object.keys(f).sort().join(',') !== 'controlChunks,phaseChunks,version' ||
    f.version !== 1
  )
    refuse();
  function chunks(value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 64) refuse();
    return value.map((t: unknown) => {
      if (typeof t !== 'string' || t.length > 21_848) refuse();
      const b = Buffer.from(t, 'base64');
      if (!b.length || b.toString('base64') !== t) refuse();
      return b;
    });
  }
  const phase = new ComparePhaseDecoder(),
    control = new CompareControlDecoder();
  let controls = 0;
  for (const b of chunks(f.phaseChunks)) phase.push(b);
  phase.finish();
  for (const b of chunks(f.controlChunks)) controls += control.push(b).length;
  control.finish();
  write(
    COMPARE_SANITY_PREFIX +
      JSON.stringify({
        event: 'SANITY_COMPLETE',
        phaseEvents: phase.events.length,
        controlFrames: controls,
        nativeEntries: 0,
        sdkEntries: 0,
        socketEntries: 0,
        httpAttempts: 0,
      }) +
      '\n',
  );
}
async function normal(mode: 'observe' | 'cancel', root: string) {
  process.umask(0o077);
  privateRoot(root);
  const socketPath = join(root, 'compare.sock');
  if (
    Buffer.byteLength(socketPath) > 103 ||
    existsSync(socketPath) ||
    process.env.SPEEDYINDEX_API_KEY !== 'synthetic-test-key-do-not-use'
  )
    refuse();
  const validator = new ComparePhaseDecoder();
  function phase(p: ComparePhase) {
    const line = COMPARE_PHASE_PREFIX + JSON.stringify(p) + '\n';
    validator.push(Buffer.from(line));
    write(line);
  }
  let handlers = 0,
    active = 0,
    readsEntered = 0,
    readsSettled = 0,
    cancelsSettled = 0,
    releases = 0,
    clientsSettled = 0,
    closes = 0,
    ownersSettled = 0,
    httpAttempts = 0;
  let shuttingDown = false,
    released = false;
  const gate = Promise.withResolvers<void>();
  void gate.promise.catch(() => undefined);
  const pending = new Set<Promise<unknown>>();
  const observerErrors: unknown[] = [];
  function observe<T>(
    p: Promise<T>,
    event: 'READ_SETTLED' | 'NATIVE_CANCEL' | 'NATIVE_CLOSED',
    operation: number,
  ) {
    const receipt = p.then(
      () => {
        if (event === 'NATIVE_CANCEL') cancelsSettled++;
        phase({ event, operation, outcome: 'fulfilled' });
      },
      () => {
        if (event === 'NATIVE_CANCEL') cancelsSettled++;
        phase({ event, operation, outcome: 'rejected' });
      },
    );
    void receipt.catch((e) => observerErrors.push(e));
    pending.add(receipt);
    void receipt.finally(() => pending.delete(receipt)).catch(() => undefined);
  }
  const preloadedFetch = globalThis.fetch;
  // Default-deny before importing the native helper or constructing a transport.
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (
        url.origin !== 'https://api.speedyindex.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        ![
          '/v2/task/google/indexer/status',
          '/v2/task/google/indexer/report',
        ].includes(url.pathname) ||
        init?.method !== 'POST' ||
        init.redirect !== 'error' ||
        headers.get('Authorization') !== 'synthetic-test-key-do-not-use' ||
        headers.get('Accept') !== 'application/json' ||
        headers.get('Content-Type') !== 'application/json' ||
        typeof init.body !== 'string' ||
        !init.signal
      )
        refuse();
      const expected = url.pathname.endsWith('/status')
        ? { task_ids: [' caller-before ', 'caller-after'] }
        : { task_id: JSON.parse(init.body).task_id as unknown };
      if (
        JSON.stringify(expected) !== init.body ||
        (!url.pathname.endsWith('/status') &&
          ![' caller-before ', 'caller-after'].includes(
            String((expected as { task_id: unknown }).task_id),
          ))
      )
        refuse();
      httpAttempts++;
      const response = await preloadedFetch(input, init);
      if (mode !== 'cancel' || httpAttempts !== 1) return response;
      const { decorateCompareNative } =
        await import('./compare-reports-native');
      return decorateCompareNative(response, {
        onReader(reader) {
          const read = reader.read.bind(reader),
            cancel = reader.cancel.bind(reader);
          let selected = false;
          observe(reader.closed, 'NATIVE_CLOSED', 1);
          Object.defineProperty(reader, 'read', {
            configurable: true,
            value: () => {
              const original = read();
              readsEntered++;
              let settled = false;
              const receipt = original.then(
                () => {
                  readsSettled++;
                  settled = true;
                },
                () => {
                  readsSettled++;
                  settled = true;
                },
              );
              void receipt.catch((e) => observerErrors.push(e));
              // An actual I/O opportunity distinguishes a surviving pending read from a delivered fragment.
              setImmediate(() => {
                if (!settled && !selected) {
                  selected = true;
                  phase({ event: 'READ_PENDING', operation: 1 });
                  observe(original, 'READ_SETTLED', 1);
                }
              });
              return original; // the actual native promise, with no replacement bytes/EOF
            },
          });
          Object.defineProperty(reader, 'cancel', {
            configurable: true,
            value: () => {
              if (!selected) refuse();
              const original = cancel();
              observe(original, 'NATIVE_CANCEL', 1);
              return original;
            },
          });
        },
        holdCancel: gate.promise,
        afterRelease() {
          releases++;
          phase({ event: 'READER_RELEASED', operation: 1 });
        },
      });
    },
    { preconnect: () => refuse() },
  ) as typeof fetch;
  const { SpeedyIndexClient } = await import('../../src/client');
  const { createCompareReportsOwner } =
    await import('../../src/compare-reports-owner');
  const { createServer } = await import('../../src/server');
  const { StdioServerTransport } =
    await import('@modelcontextprotocol/server/stdio');
  const { createServer: createControlServer } = await import('node:net');
  const assert: typeof import('node:assert/strict') = (
    await import('node:assert/strict')
  ).default;
  class ObservedClient extends SpeedyIndexClient {
    override async getTaskStatus(
      ...args: Parameters<
        InstanceType<typeof SpeedyIndexClient>['getTaskStatus']
      >
    ) {
      const selected = mode === 'cancel' && active === 1;
      let outcome: 'fulfilled' | 'rejected' = 'fulfilled';
      try {
        return await super.getTaskStatus(...args);
      } catch (e) {
        outcome = 'rejected';
        throw e;
      } finally {
        if (selected) {
          clientsSettled++;
          phase({ event: 'CLIENT_SETTLED', operation: 1, outcome });
        }
      }
    }
  }
  const client = new ObservedClient(process.env.SPEEDYINDEX_API_KEY);
  const owner = createCompareReportsOwner(client, {
    onPhase(name) {
      if (name === 'after_close') {
        closes++;
        if (mode === 'cancel' && active === 1)
          phase({ event: 'AFTER_CLOSE', operation: 1 });
      }
    },
  });
  const server = createServer(client, undefined, {
    async compare(input, signal) {
      if (active || handlers >= 32) refuse();
      const operation = ++handlers;
      active = operation;
      phase({ event: 'HANDLER_ENTER', operation });
      const aborted = () => phase({ event: 'SIGNAL_ABORTED', operation });
      signal?.addEventListener('abort', aborted, { once: true });
      const actual = owner.compare(input, signal);
      pending.add(actual);
      try {
        const result = await actual;
        let cancelledEnvelope = false;
        if (mode === 'cancel' && operation === 1) {
          const data = {
            status: 'error',
            error: {
              code: 'Cancelled',
              message: 'Report comparison was cancelled.',
            },
          };
          assert.deepEqual(result, {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          });
          cancelledEnvelope = true;
        }
        ownersSettled++;
        phase({
          event: 'OWNER_SETTLED',
          operation,
          aborted: signal?.aborted === true,
          status: result.structuredContent.status,
          code:
            result.structuredContent.status === 'compared'
              ? null
              : result.structuredContent.status === 'blocked'
                ? result.structuredContent.blocker.code
                : result.structuredContent.error.code,
          cancelledEnvelope,
        });
        return result;
      } finally {
        pending.delete(actual);
        signal?.removeEventListener('abort', aborted);
        active = 0;
      }
    },
  });
  const controls = new CompareControlDecoder();
  let connection: import('node:net').Socket | undefined;
  let connected = false;
  const done = Promise.withResolvers<void>();
  const control = createControlServer((socket) => {
    if (connected) {
      socket.destroy();
      process.exitCode = 1;
      return;
    }
    connected = true;
    connection = socket;
    socket.on('data', (bytes) => {
      try {
        if (typeof bytes === 'string') refuse();
        for (const command of controls.push(bytes)) {
          if (command.event === 'BARRIER')
            phase({
              event: 'BARRIER',
              sequence: command.sequence,
              handlers,
              readsEntered,
              readsSettled,
              cancelsSettled,
              releases,
              clientsSettled,
              closes,
              ownersSettled,
              httpAttempts,
            });
          else {
            if (
              mode !== 'cancel' ||
              active !== 1 ||
              released ||
              !cancelsSettled
            )
              refuse();
            released = true;
            gate.resolve();
          }
        }
      } catch {
        process.exitCode = 1;
        gate.reject(new Error('Comparison control failed.'));
        phase({ event: 'FIXTURE_ERROR' });
      }
    });
    socket.on('end', () => {
      try {
        controls.finish();
      } catch {
        process.exitCode = 1;
      }
    });
    socket.on('error', () => {
      if (!shuttingDown) process.exitCode = 1;
    });
  });
  control.on('error', () => {
    process.exitCode = 1;
    done.resolve();
  });
  server.server.onerror = () => {
    process.exitCode = 1;
    phase({ event: 'PROTOCOL_ERROR' });
  };
  server.server.onclose = () => done.resolve();
  const failures: unknown[] = [];
  try {
    process.umask(0o177);
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(socketPath, () => {
        control.off('error', reject);
        resolve();
      });
    });
    process.umask(0o077);
    const inode = lstatSync(socketPath);
    if (
      !inode.isSocket() ||
      inode.uid !== process.getuid?.() ||
      (inode.mode & 0o777) !== 0o600
    )
      refuse();
    await server.connect(new StdioServerTransport());
    phase({ event: 'BOOT_READY' });
    await done.promise;
  } catch (error) {
    failures.push(error);
  } finally {
    shuttingDown = true;
    if (active) {
      process.exitCode = 1;
      gate.reject(new Error('Comparison fixture closed with active owner.'));
    }
    const settled = await Promise.allSettled([...pending]);
    for (const result of settled)
      if (result.status === 'rejected') failures.push(result.reason);
    try {
      connection?.destroy();
    } catch (error) {
      failures.push(error);
    }
    try {
      await new Promise<void>((resolve, reject) =>
        control.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      failures.push(error);
    }
    failures.push(...observerErrors);
    try {
      validator.finish();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Comparison fixture failed.');
}
try {
  const [mode, path, ...extra] = process.argv.slice(2);
  if (extra.length || !path) refuse();
  if (mode === '--sanity') sanity(path);
  else if (mode === 'observe' || mode === 'cancel') await normal(mode, path);
  else refuse();
} catch {
  process.exitCode = 1;
  write(
    COMPARE_PHASE_PREFIX + JSON.stringify({ event: 'FIXTURE_ERROR' }) + '\n',
  );
}
