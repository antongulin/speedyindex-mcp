import { writeSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DispatchCapability,
  PrepareIntentInput,
  PrepareRetryIntentInput,
  RetryLedgerPhase,
} from '../../src/submission-ledger';

function denyNetwork(): never {
  throw new Error('Retry child network access is forbidden.');
}
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

interface Setup {
  role:
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
async function main() {
  const first = await lines.next();
  if (first.done) throw new Error('Missing child setup.');
  const config = JSON.parse(first.value) as Setup;
  if (
    ![
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
    const ledger = openRetryLedgerV2(
      { stateDirectory: config.stateDirectory },
      {
        onPhase(phase) {
          if (phase === config.pauseAt) stop(phase);
          else send({ event: 'phase', phase });
        },
      },
    );
    handles.push(ledger);
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
        const prepared = ledger.prepareIntent(config.ordinaryIntent);
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
        const prepared = ledger.prepareRetryIntent(config.input);
        if (config.role === 'retry') {
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
