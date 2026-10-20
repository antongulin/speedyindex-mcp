import {
  openLedger,
  SubmissionLedgerError,
  type DispatchCapability,
  type DispatchOutcomeToken,
  type PrepareIntentInput,
} from '../../src/submission-ledger';
import type { TaskFamily } from '../../src/task-status';

interface ChildConfig {
  mode: 'prepare-race' | 'claim-race' | 'crash-after-claim';
  stateDirectory: string;
  input: PrepareIntentInput;
  capability?: string;
}

async function* readLines() {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

const lines = readLines()[Symbol.asyncIterator]();

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function nextControl() {
  const result = await lines.next();
  if (result.done) return 'STOP';
  return result.value;
}

function errorCode(error: unknown) {
  return error instanceof SubmissionLedgerError
    ? error.code
    : 'LedgerUnavailable';
}

function captureCode(operation: () => unknown) {
  try {
    operation();
    return 'NO_ERROR';
  } catch (error) {
    return errorCode(error);
  }
}

async function main() {
  const first = await lines.next();
  if (first.done) throw new Error('Missing child fixture input.');
  const config = JSON.parse(first.value) as ChildConfig;
  const ledger = openLedger({ stateDirectory: config.stateDirectory });

  if (config.mode === 'prepare-race') {
    send({ event: 'READY' });
    if ((await nextControl()) !== 'GO') {
      ledger.close();
      return;
    }
    try {
      const result = ledger.prepareIntent(config.input);
      send({
        event: 'PREPARED',
        kind: result.kind,
        ...(result.kind === 'created'
          ? { dispatchCapability: result.dispatchCapability }
          : {}),
      });
    } catch (error) {
      send({ event: 'PREPARED', kind: 'error', code: errorCode(error) });
    }
    ledger.close();
    return;
  }

  if (config.mode === 'crash-after-claim') {
    const prepared = ledger.prepareIntent(config.input);
    if (prepared.kind !== 'created')
      throw new Error('Expected fresh test intent.');
    const claim = ledger.claimDispatch(prepared.dispatchCapability, 0);
    if (claim.kind !== 'claimed')
      throw new Error('Expected test dispatch claim.');
    send({ event: 'CLAIM_COMMITTED' });
    await nextControl();
    ledger.close();
    return;
  }

  if (!config.capability)
    throw new Error('Missing synthetic claim capability.');
  send({ event: 'READY' });
  if ((await nextControl()) !== 'GO') {
    ledger.close();
    return;
  }
  const capability = config.capability as DispatchCapability;
  const claim = ledger.claimDispatch(capability, 0);
  if (claim.kind === 'lost') {
    send({ event: 'CLAIM', kind: 'lost' });
    const invalidProof = captureCode(() =>
      ledger.recordDispatchOutcome({
        credentialFingerprint: config.input.budget.credentialFingerprint,
        requestId: config.input.requestId,
      } as never),
    );
    const oldCapabilityProof = captureCode(() =>
      ledger.recordDispatchOutcome({
        credentialFingerprint: config.input.budget.credentialFingerprint,
        requestId: config.input.requestId,
        expectedStateVersion: 1,
        outcomeToken: capability as unknown as DispatchOutcomeToken,
        outcome: {
          kind: 'accepted',
          providerTaskId: 'synthetic-loser-task',
          providerType: config.input.taskFamily,
        },
      }),
    );
    send({ event: 'LOSER_CHECKS', invalidProof, oldCapabilityProof });
    ledger.close();
    return;
  }

  send({
    event: 'CLAIM',
    kind: 'claimed',
    stateVersion: claim.stateVersion,
    outcomeToken: claim.outcomeToken,
  });
  if ((await nextControl()) !== 'RECORD') {
    ledger.close();
    return;
  }
  const outcome = ledger.recordDispatchOutcome({
    credentialFingerprint: config.input.budget.credentialFingerprint,
    requestId: config.input.requestId,
    expectedStateVersion: claim.stateVersion,
    outcomeToken: claim.outcomeToken,
    outcome: {
      kind: 'accepted',
      providerTaskId: 'synthetic-winner-task',
      providerType: config.input.taskFamily as TaskFamily,
    },
  });
  send({
    event: 'RECORDED',
    state: outcome.state,
    stateVersion: outcome.stateVersion,
  });
  ledger.close();
}

try {
  await main();
} catch (error) {
  send({ event: 'ERROR', code: errorCode(error) });
  process.exitCode = 1;
}
