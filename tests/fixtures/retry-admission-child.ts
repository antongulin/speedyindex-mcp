import { appendFileSync, lstatSync, readFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DispatchCapability,
  PrepareIntentInput,
  PrepareRetryIntentInput,
  RetryLedgerPhase,
} from '../../src/submission-ledger';

function denyNetwork(): never {
  throw new Error('Retry child network access is forbidden.');
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

interface Setup {
  role:
    | 'verified'
    | 'verified_lock_wait'
    | 'retry'
    | 'ordinary'
    | 'claim'
    | 'cancel'
    | 'claim_pause'
    | 'outcome'
    | 'lock';
  stateDirectory: string;
  input: PrepareRetryIntentInput;
  ordinaryIntent?: PrepareIntentInput;
  capability?: DispatchCapability;
  pauseAt?: RetryLedgerPhase;
  verifiedUrls?: string[];
  clockAfterWait?: 'expiry' | 'utc';
}
interface ProductionSetup {
  role: 'production_lock_wait';
  stateDirectory: string;
  production: {
    origin: string;
    boundary: 'expiry' | 'utc' | 'cancel';
    inspectOnly?: boolean;
    journal?: { nonce: string; path: string; parentPid: number };
  };
}
function send(message: object, fd = 1) {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw new Error('Retry child marker write failed.');
    offset += n;
  }
}
async function* readLines() {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(buffer) > 128 * 1024)
      throw new Error('Invalid child setup.');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      yield line;
    }
  }
  if (buffer !== '') throw new Error('Unterminated child setup.');
}
const lines = readLines()[Symbol.asyncIterator]();
async function control(expected: string) {
  const next = await lines.next();
  if (next.done || next.value !== expected)
    throw new Error('Invalid child control.');
}
function stop(phase: RetryLedgerPhase | 'locked' | 'claim_committed') {
  send({ event: 'phase', phase });
  process.kill(process.pid, 'SIGSTOP'); // Synchronous barrier; parent only kills/reaps this PID.
}
async function productionMain(config: ProductionSetup) {
  const origin = new URL(config.production.origin);
  if (
    Object.keys(process.env).some((key) => key !== 'HOME') ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.href !== origin.origin + '/' ||
    !['expiry', 'utc', 'cancel'].includes(config.production.boundary)
  )
    throw new Error('Invalid production child setup.');
  const journal = config.production.journal;
  if (config.production.boundary === 'cancel') {
    if (
      !journal ||
      Object.keys(journal).sort().join(',') !== 'nonce,parentPid,path' ||
      !/^p1c09-[a-f0-9-]{36}$/.test(journal.nonce) ||
      journal.path !==
        join(resolve(process.env.HOME!, '..'), 'p1c-native-phases.jsonl') ||
      !Number.isSafeInteger(journal.parentPid) ||
      journal.parentPid < 1
    )
      throw new Error('Invalid production child journal.');
    const info = lstatSync(journal.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== 0
    )
      throw new Error('Invalid production child journal file.');
  } else if (journal) throw new Error('Unexpected production child journal.');
  const record = (phase: string, attempt: 0 | 1 | 2) => {
    if (!journal) return;
    const line =
      JSON.stringify([
        'p1c09-native-phase-v1',
        journal.nonce,
        'child',
        phase,
        attempt,
        process.pid,
      ]) + '\n';
    if (
      Buffer.byteLength(line) > 256 ||
      lstatSync(journal.path).size > 4096 - Buffer.byteLength(line)
    )
      throw new Error('Production child journal bound.');
    appendFileSync(journal.path, line, 'utf8');
    const bytes = readFileSync(journal.path);
    const text = bytes.toString('utf8');
    if (
      bytes.length > 4096 ||
      !Buffer.from(text).equals(bytes) ||
      !text.endsWith('\n') ||
      !text.includes(line) ||
      text.indexOf(line) !== text.lastIndexOf(line)
    )
      throw new Error('Production child journal readback failed.');
  };
  const { Database, constants, SQLiteError } = await import('bun:sqlite');
  const {
    composeVerifiedRetryAdmission,
    RetryLedgerError,
    SubmissionLedgerError,
  } = await import('../../src/submission-ledger');
  const { fixtureRetryConfiguration, retryFixtureKey, retryFixtureUtc } =
    await import('./retry-verifier');
  const handles: { close(): void }[] = [];
  const failures: unknown[] = [];
  const controller = new AbortController();
  const signal = controller.signal;
  const nativeAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  )!.get!;
  let result: object | undefined;
  try {
    const configuration = fixtureRetryConfiguration(
      join(process.env.HOME!, 'synthetic-production-policy.json'),
      config.stateDirectory,
    );
    // Default network denial is installed before this narrowly bound transport exists.
    const guardedFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const list = /^\/v2\/task\/(google|yandex)\/indexer\/list\/0$/.exec(
          url.pathname,
        );
        const read = /^\/v2\/task\/yandex\/indexer\/(status|report)$/.exec(
          url.pathname,
        );
        const headers = new Headers(init?.headers);
        const body = String(init?.body ?? '');
        const expectedBody = read
          ? read[1] === 'report'
            ? '{"task_id":"production-parent"}'
            : '{"task_ids":["production-parent"]}'
          : '';
        const expectedHeaders = list
          ? ['accept', 'authorization', 'user-agent']
          : ['accept', 'authorization', 'content-type', 'user-agent'];
        if (
          url.origin !== 'https://api.speedyindex.com' ||
          url.username + url.password + url.hash !== '' ||
          (!list && !read) ||
          !(
            url.search === '' ||
            (list?.[1] === 'google' && url.search === '?filter=drip_feed')
          ) ||
          init?.method !== (list ? 'GET' : 'POST') ||
          init?.redirect !== 'error' ||
          headers.get('authorization') !== retryFixtureKey ||
          headers.get('accept') !== 'application/json' ||
          headers.get('user-agent') !== 'speedyindex-mcp/0.1.0' ||
          JSON.stringify([...headers.keys()].sort()) !==
            JSON.stringify(expectedHeaders) ||
          (read && headers.get('content-type') !== 'application/json') ||
          body !== expectedBody
        )
          throw new Error('Production child wire guard.');
        return nativeFetch(new URL(url.pathname + url.search, origin), init);
      },
      { preconnect: denyNetwork },
    ) as typeof fetch;
    const nativeOrigin = performance.now();
    let firstMono: number | undefined;
    let dayOffset = 0;
    const mono = () => {
      const value = 100 + performance.now() - nativeOrigin;
      firstMono ??= value;
      return value;
    };
    const horizonMs = config.production.boundary === 'expiry' ? 1000 : 60000;
    const composition = composeVerifiedRetryAdmission({
      configuration,
      transport: { fetch: guardedFetch },
      clock: { utcMs: () => retryFixtureUtc + dayOffset, monotonicMs: mono },
      owner: { limits: { horizonMs } },
    });
    const candidate = await composition.collectLatest(
      { searchEngine: 'yandex' },
      'production-child-' + config.production.boundary,
      signal,
    );
    if (!('kind' in candidate))
      throw new Error('Production child collection failed.');
    record('collected', 0);
    send({
      event: 'phase',
      phase: 'collected',
      clock: [firstMono, mono(), horizonMs],
    });
    const writer = composition.open();
    handles.push(writer);
    const probe = new Database(
      join(config.stateDirectory, 'ledger.sqlite'),
      constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
    );
    handles.push({ close: () => probe.close(true) });
    probe.run('PRAGMA busy_timeout = 0');
    const witnessLock = () => {
      try {
        probe.run('BEGIN IMMEDIATE');
        probe.run('ROLLBACK');
      } catch (error) {
        if (
          error instanceof SQLiteError &&
          error.code?.startsWith('SQLITE_BUSY')
        )
          return error.code;
        throw error;
      }
      throw new Error('Expected actual native writer lock.');
    };
    let enteringAdmission = false;
    Object.defineProperty(signal, 'aborted', {
      configurable: true,
      get() {
        const actual = nativeAborted.call(signal) as boolean;
        if (enteringAdmission) {
          enteringAdmission = false;
          // This native signal read occurs inside the real acquired writer transaction.
          const nativeCode = witnessLock();
          record('actual_admission_lock_witness', 2);
          send({
            event: 'phase',
            phase: 'admission_locked',
            nativeCode,
          });
        }
        return actual;
      },
    });
    send({ event: 'ready' });
    await control('GO');
    if (config.production.inspectOnly) {
      result = { event: 'result', kind: 'collected', capability: false };
    } else {
      send({
        event: 'phase',
        phase: 'parent_locked',
        nativeCode: witnessLock(),
      });
      const aborting =
        config.production.boundary === 'cancel'
          ? control('ABORT').then(() => {
              controller.abort();
              record('child_abort_observed', 1);
              send({
                event: 'phase',
                phase: 'abort_observed',
                nativeEpochMs: performance.timeOrigin + performance.now(),
              });
            })
          : undefined;
      void aborting?.catch(() => {});
      record('first_attempt', 1);
      send({
        event: 'phase',
        phase: 'prepare_attempt',
        nativeEpochMs: performance.timeOrigin + performance.now(),
      });
      try {
        writer.prepareVerifiedRetryIntent(candidate.input, candidate.proof);
        throw new Error('Expected first failed native BEGIN.');
      } catch (error) {
        if (
          !(error instanceof SubmissionLedgerError) ||
          error.code !== 'LedgerBusy'
        )
          throw error;
      }
      record('first_begin_busy_returned', 1);
      send({
        event: 'phase',
        phase: 'lock_waited',
        nativeEpochMs: performance.timeOrigin + performance.now(),
      });
      await aborting; // Failed BEGIN owns no transaction. This is a real stdin/I/O opportunity.
      await control('RETRY');
      if (config.production.boundary === 'utc') dayOffset = 86400000;
      enteringAdmission = true;
      record('second_attempt', 2);
      send({ event: 'phase', phase: 'prepare_attempt' });
      try {
        const prepared = writer.prepareVerifiedRetryIntent(
          candidate.input,
          candidate.proof,
        );
        result = {
          event: 'result',
          kind: prepared.kind,
          capability: prepared.kind === 'created',
        };
      } catch (error) {
        if (
          !(error instanceof RetryLedgerError) &&
          !(error instanceof SubmissionLedgerError)
        )
          throw error;
        result = {
          event: 'result',
          kind: 'error',
          code: error.code,
          capability: false,
        };
        if (error.code === 'RetryCancelled') record('RetryCancelled', 2);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    Reflect.deleteProperty(signal, 'aborted');
    for (const handle of handles.reverse()) {
      try {
        handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length || !result)
    throw new Error('Production child or close failed.');
  send(result);
}
async function main() {
  const first = await lines.next();
  if (first.done) throw new Error('Missing child setup.');
  const config = JSON.parse(first.value) as Setup | ProductionSetup;
  if (config.role === 'production_lock_wait') return productionMain(config);
  if (
    ![
      'verified',
      'verified_lock_wait',
      'retry',
      'ordinary',
      'claim',
      'cancel',
      'claim_pause',
      'outcome',
      'lock',
    ].includes(config.role) ||
    (config.pauseAt !== undefined &&
      ![
        'before_context',
        'after_prepare_commit',
        'before_accepted_commit',
        'after_accepted_commit',
      ].includes(config.pauseAt))
  )
    throw new Error('Invalid child role.');
  const { openRetryLedgerV2, RetryLedgerError, SubmissionLedgerError } =
    await import('../../src/submission-ledger');
  const handles: { close(): void }[] = [];
  let result: object | undefined;
  const failures: unknown[] = [];
  try {
    const localLedger = openRetryLedgerV2(
      { stateDirectory: config.stateDirectory },
      {
        onPhase(phase) {
          if (phase === config.pauseAt) stop(phase);
          else send({ event: 'phase', phase });
        },
      },
    );
    handles.push(localLedger);
    let ledger: Omit<
      import('../../src/submission-ledger').SubmissionLedger,
      'prepareIntent'
    > = localLedger;
    let retryPrepare = () => localLedger.prepareRetryIntent(config.input);
    let afterWait = false;
    if (config.role.startsWith('verified')) {
      const { composeVerifiedRetryAdmission } =
        await import('../../src/submission-ledger');
      const {
        fixtureRetryConfiguration,
        fixtureRetryEvidence,
        fixtureRetryVerifier,
        retryFixtureUtc,
      } = await import('./retry-verifier');
      const configuration = fixtureRetryConfiguration(
        join(process.env.HOME!, 'synthetic-policy.json'),
        config.stateDirectory,
      );
      const composition = composeVerifiedRetryAdmission({
        configuration,
        verifier: fixtureRetryVerifier(
          fixtureRetryEvidence(config.verifiedUrls),
        ),
        clock: {
          utcMs: () =>
            retryFixtureUtc +
            (afterWait && config.clockAfterWait === 'utc' ? 86400000 : 0),
          monotonicMs: () =>
            afterWait && config.clockAfterWait === 'expiry' ? 60100 : 100,
        },
        hooks: {
          onPhase(phase) {
            if (phase === config.pauseAt) stop(phase);
            else send({ event: 'phase', phase });
          },
        },
      });
      const result = await composition.collect({
        requestId: config.input.intent.requestId,
        parent: config.input.parent,
      });
      if (result.kind !== 'candidate')
        throw new Error('Synthetic verified child collection failed.');
      const verified = composition.open();
      handles.push(verified);
      ledger = verified;
      retryPrepare = () =>
        verified.prepareVerifiedRetryIntent(result.input, result.proof);
    }
    send({ event: 'ready' });
    await control('GO'); // No application transaction is open while waiting.
    try {
      if (config.role === 'lock') {
        const { Database, constants } = await import('bun:sqlite');
        const db = new Database(
          join(config.stateDirectory, 'ledger.sqlite'),
          constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
        );
        handles.push({ close: () => db.close(true) });
        db.run('BEGIN IMMEDIATE');
        stop('locked'); // No await/retry/poll inside the held transaction.
        throw new Error('Stopped lock child must be killed.');
      }
      if (config.role === 'ordinary') {
        if (!config.ordinaryIntent)
          throw new Error('Missing ordinary fixture input.');
        const prepared = localLedger.prepareIntent(config.ordinaryIntent);
        result = {
          event: 'result',
          kind: prepared.kind,
          capability:
            prepared.kind === 'created' &&
            typeof prepared.dispatchCapability === 'string',
        };
      } else if (config.role === 'cancel') {
        const cancelled = ledger.cancelPrepared(
          config.input.intent.budget.credentialFingerprint,
          config.input.intent.requestId,
          0,
        );
        result = { event: 'result', kind: cancelled.kind };
      } else if (config.role === 'claim') {
        if (!config.capability)
          throw new Error('Missing private synthetic capability.');
        const claimed = ledger.claimDispatch(config.capability, 0);
        result = { event: 'result', kind: claimed.kind }; // Never emit the outcome token.
      } else {
        if (config.role === 'verified_lock_wait') {
          try {
            retryPrepare();
            throw new Error('Expected held native SQL lock.');
          } catch (error) {
            if (
              !(error instanceof SubmissionLedgerError) ||
              error.code !== 'LedgerBusy'
            )
              throw error;
          }
          send({ event: 'phase', phase: 'lock_waited' });
          await control('RETRY'); // Failed BEGIN held no transaction and consumed no proof.
          afterWait = true;
          send({ event: 'phase', phase: 'prepare_attempt' });
        }
        const prepared = retryPrepare();
        if (
          config.role === 'retry' ||
          config.role === 'verified' ||
          config.role === 'verified_lock_wait'
        ) {
          result = {
            event: 'result',
            kind: prepared.kind,
            capability:
              prepared.kind === 'created' &&
              typeof prepared.dispatchCapability === 'string',
          };
        } else {
          if (prepared.kind !== 'created')
            throw new Error('Expected private retry creator.');
          const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
          if (claim.kind !== 'claimed')
            throw new Error('Expected private retry claim.');
          if (config.role === 'claim_pause') {
            stop('claim_committed');
            throw new Error('Stopped claim child must be killed.');
          }
          send({ event: 'phase', phase: 'claim_committed' });
          await control('RECORD'); // Claim API already committed; no SQL transaction spans this wait.
          ledger.recordDispatchOutcome({
            credentialFingerprint:
              config.input.intent.budget.credentialFingerprint,
            requestId: config.input.intent.requestId,
            expectedStateVersion: 1,
            outcomeToken: claim.outcomeToken,
            outcome: {
              kind: 'accepted',
              providerType: config.input.intent.taskFamily,
              providerTaskId: ' Process-child-é ',
            },
          });
          result = { event: 'result', kind: 'accepted' };
        }
      }
    } catch (error) {
      if (
        !(error instanceof RetryLedgerError) &&
        !(error instanceof SubmissionLedgerError)
      )
        throw error;
      result = {
        event: 'result',
        kind: 'error',
        code: error.code,
        ...(error instanceof SubmissionLedgerError && error.unit
          ? { unit: error.unit }
          : {}),
      };
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const handle of handles.reverse()) {
      try {
        handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length || result === undefined)
    throw new Error('Retry child operation or close failed.');
  send(result);
}
try {
  await main();
} catch {
  send({ event: 'child_failure' }, 2);
  process.exitCode = 1;
}
