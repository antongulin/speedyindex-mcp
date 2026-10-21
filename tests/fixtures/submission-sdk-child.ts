// Loaded only by the synthetic SDK process suite, after redirect-fetch preload.
// stdout belongs exclusively to the real SDK StdioServerTransport.
import { writeSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../../src/server';
import { SubmissionHost } from '../../src/submission-host';
import { loadSubmissionConfiguration } from '../../src/submission-policy';
import {
  openLedger,
  SubmissionLedgerError,
  type SubmissionLedger,
} from '../../src/submission-ledger';

function phase(event: string, fields: Record<string, unknown> = {}) {
  const bytes = Buffer.from(
    `SUBMISSION_PHASE ${JSON.stringify({ event, ...fields })}\n`,
  );
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(2, bytes, offset, bytes.length - offset);
}

let preopened: SubmissionLedger | undefined;
async function main() {
  const stateDirectory = process.env.TEST_SUBMISSION_STATE!;
  const configuration = loadSubmissionConfiguration({
    stateDirectory,
    policyPath: process.env.TEST_SUBMISSION_POLICY,
    apiKey: process.env.SPEEDYINDEX_API_KEY,
  });
  if (configuration.state !== 'configured')
    throw new Error('Invalid synthetic SDK configuration.');
  // This fixture deliberately verifies the first real handle before READY, so
  // a parent lock targets prepare rather than the normal opener's WAL checks.
  preopened = openLedger({ stateDirectory });
  let operation = 0;
  function instrument(ledger: SubmissionLedger) {
    const number = ++operation;
    return new Proxy(ledger, {
      get(target, property) {
        if (property === 'prepareIntent')
          return (...args: Parameters<SubmissionLedger['prepareIntent']>) => {
            const started = performance.now();
            phase('PREPARE_ENTER', { operation: number });
            try {
              const result = target.prepareIntent(...args);
              phase('PREPARE_LEAVE', {
                operation: number,
                kind: result.kind,
                elapsedMs: performance.now() - started,
              });
              return result;
            } catch (error) {
              phase('PREPARE_LEAVE', {
                operation: number,
                code:
                  error instanceof SubmissionLedgerError
                    ? error.code
                    : 'unavailable',
                elapsedMs: performance.now() - started,
              });
              throw error;
            }
          };
        if (property === 'claimDispatch')
          return (...args: Parameters<SubmissionLedger['claimDispatch']>) => {
            const result = target.claimDispatch(...args);
            phase('CLAIM', { operation: number, kind: result.kind });
            return result;
          };
        if (property === 'cancelPrepared')
          return (...args: Parameters<SubmissionLedger['cancelPrepared']>) => {
            const result = target.cancelPrepared(...args);
            phase('CANCEL', { operation: number, kind: result.kind });
            return result;
          };
        if (property === 'close')
          return () => {
            target.close();
            phase('CLOSED', { operation: number });
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const host = new SubmissionHost(configuration, {
    clock: () => Number(process.env.TEST_SUBMISSION_NOW),
    openLedger: (options) => {
      const ledger = preopened ?? openLedger(options);
      preopened = undefined;
      return instrument(ledger);
    },
  });
  const server = createServer(undefined, host);
  server.server.onerror = () => phase('PROTOCOL_ERROR');
  server.server.onclose = () => {
    preopened?.close();
    preopened = undefined;
  };
  await server.connect(new StdioServerTransport());
  phase('READY');
}
try {
  await main();
} catch {
  try {
    preopened?.close();
  } catch {
    /* Report only a fixed test phase. */
  }
  phase('FIXTURE_ERROR');
  process.exitCode = 1;
}
