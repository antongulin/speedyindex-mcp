import { writeSync } from 'node:fs';
import type { SubmissionLedger } from '../../src/submission-ledger';

interface Setup {
  stateDirectory: string;
  policyPath: string;
  apiKey: string;
  origin: string;
  now: number;
  input: unknown;
  operation?: 'indexer' | 'checker';
  mode:
    | 'normal'
    | 'already_aborted'
    | 'abort_after_prepare'
    | 'stop_after_prepare'
    | 'abort_after_claim'
    | 'stop_after_claim'
    | 'abort_before_record'
    | 'read_fault_after_write_failure';
}

function send(message: Record<string, unknown>) {
  // Explicit synchronous writes also flush the phase before SIGSTOP. Never
  // include a ledger result/capability/token or a caught exception here.
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(1, bytes, offset, bytes.length - offset);
}

const nativeFetch = globalThis.fetch;
let allowedOrigin: string | undefined;
let violations = 0;
globalThis.fetch = ((input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.origin !== allowedOrigin ||
    target.username ||
    target.password ||
    init?.redirect !== 'error'
  ) {
    violations++;
    writeSync(2, 'Child network isolation violation.\n');
    throw new Error('Child network isolation violation.');
  }
  return nativeFetch(input, init);
}) as typeof fetch;

async function* readLines() {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}

function pauseAt(event: string) {
  send({ event });
  process.kill(process.pid, 'SIGSTOP');
  send({ event: 'RESUMED', after: event });
}

async function main() {
  const lines = readLines();
  const first = await lines.next();
  if (first.done) throw new Error('Missing synthetic setup.');
  const setup = first.value as unknown as Setup;
  const origin = new URL(setup.origin);
  if (
    origin.origin !== setup.origin ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.username ||
    origin.password ||
    setup.apiKey !== 'synthetic-host-key-only' ||
    (setup.operation !== undefined &&
      setup.operation !== 'indexer' &&
      setup.operation !== 'checker')
  )
    throw new Error('Invalid synthetic setup.');
  allowedOrigin = setup.origin;
  // No host import/default transport capture can precede the global guard.
  const { SubmissionHost } = await import('../../src/submission-host');
  const { loadSubmissionConfiguration } =
    await import('../../src/submission-policy');
  const { openLedger, SubmissionLedgerError } =
    await import('../../src/submission-ledger');
  const configuration = loadSubmissionConfiguration(setup);
  if (configuration.state !== 'configured')
    throw new Error('Invalid fixture policy.');
  const ledger = openLedger({ stateDirectory: setup.stateDirectory });
  let closed = false;
  const close = () => {
    if (!closed) {
      ledger.close();
      closed = true;
    }
  };
  const controller = new AbortController();
  let fetchInvocations = 0;
  let writeFailed = false;
  const wrapped = new Proxy(ledger, {
    get(target, property) {
      if (property === 'close') return close;
      if (property === 'prepareIntent')
        return (...args: Parameters<SubmissionLedger['prepareIntent']>) => {
          const prepared = target.prepareIntent(...args);
          send({ event: 'PREPARED', kind: prepared.kind });
          if (prepared.kind === 'created') {
            if (setup.mode === 'abort_after_prepare') controller.abort();
            if (setup.mode === 'stop_after_prepare') pauseAt('PREPARED_STOP');
          }
          return prepared;
        };
      if (property === 'claimDispatch')
        return (...args: Parameters<SubmissionLedger['claimDispatch']>) => {
          const claimed = target.claimDispatch(...args);
          if (claimed.kind === 'claimed') {
            if (setup.mode === 'stop_after_claim') pauseAt('CLAIMED_STOP');
            else send({ event: 'CLAIMED' });
            if (setup.mode === 'abort_after_claim') controller.abort();
          }
          return claimed;
        };
      if (property === 'recordDispatchOutcome')
        return (
          ...args: Parameters<SubmissionLedger['recordDispatchOutcome']>
        ) => {
          send({ event: 'RECORD_ENTER', outcome: args[0].outcome.kind });
          if (setup.mode === 'abort_before_record') {
            controller.abort();
            send({
              event: 'ABORT_BEFORE_RECORD',
              outcome: args[0].outcome.kind,
            });
          }
          const start = performance.now();
          try {
            const result = target.recordDispatchOutcome(...args);
            send({
              event: 'RECORDED',
              state: result.state,
              stateVersion: result.stateVersion,
            });
            return result;
          } catch (error) {
            writeFailed = true;
            send({
              event: 'WRITE_FAILED',
              code:
                error instanceof SubmissionLedgerError
                  ? error.code
                  : 'unavailable',
              elapsedMs: performance.now() - start,
            });
            throw error;
          }
        };
      if (
        property === 'readIntent' &&
        setup.mode === 'read_fault_after_write_failure'
      )
        return (...args: Parameters<SubmissionLedger['readIntent']>) => {
          if (writeFailed) {
            send({ event: 'FINAL_READ_FAULT' });
            throw new Error(
              'Synthetic final-read fault after actual write failure.',
            );
          }
          return target.readIntent(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let opened = false;
  const host = new SubmissionHost(configuration, {
    clock: () => setup.now,
    openLedger: () => {
      if (opened) throw new Error('Only one host call is allowed per child.');
      opened = true;
      return wrapped;
    },
    fetchRequest: ((input, init) => {
      fetchInvocations++;
      send({ event: 'FETCH_INVOKED', count: fetchInvocations });
      const target = new URL(String(input));
      if (
        target.origin !== 'https://api.speedyindex.com' ||
        init?.method !== 'POST' ||
        ![
          '/v2/task/google/indexer/create',
          '/v2/task/yandex/indexer/create',
          '/v2/task/google/checker/create',
          '/v2/task/yandex/checker/create',
          '/v2/task/bing/checker/create',
        ].includes(target.pathname) ||
        target.search ||
        target.hash
      ) {
        violations++;
        writeSync(2, 'Invalid production create request.\n');
        throw new Error('Invalid production create request.');
      }
      return fetch(new URL(target.pathname, setup.origin), init);
    }) as typeof fetch,
  });
  send({ event: 'READY' });
  let running = false;
  try {
    for await (const control of lines) {
      if (control.event === 'CANCEL') {
        controller.abort();
        send({ event: 'CANCEL_APPLIED' });
      } else if (control.event === 'GO' && !running) {
        running = true;
        if (setup.mode === 'already_aborted') controller.abort();
        // Do not await here: stdin cancellation must remain readable while the
        // host awaits HTTP or yields after synchronous SQLite operations.
        const operation =
          setup.operation === 'checker'
            ? host.createIndexCheck(setup.input, controller.signal)
            : host.createIndexingTask(setup.input, controller.signal);
        void operation.then(
          (result) => {
            close();
            send({ event: 'RESULT', result, fetchInvocations, violations });
            process.exit(0);
          },
          () => {
            close();
            send({ event: 'ERROR', code: 'HostFixtureFailed' });
            process.exit(1);
          },
        );
      }
    }
  } finally {
    controller.abort();
    if (!running) close();
  }
}

try {
  await main();
} catch {
  send({ event: 'ERROR', code: 'HostFixtureFailed' });
  process.exitCode = 1;
}
