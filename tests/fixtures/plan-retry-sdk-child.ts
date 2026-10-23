// Test-only completion observations. stdout is exclusively SDK JSON-RPC.
import { writeSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../../src/server';
import { SubmissionHost } from '../../src/submission-host';
import { loadSubmissionConfiguration } from '../../src/submission-policy';
import type { PlanRetryToolResult } from '../../src/plan-retry-result';

const statuses = new Set(['ready', 'no_source', 'blocked', 'error']);
const codes = new Set([
  'InvalidInput',
  'MissingCredentials',
  'SubmissionBusy',
  'Cancelled',
  'DeadlineExceeded',
  'ReadFailed',
  'ResourceLimitExceeded',
  'InternalError',
]);
function phase(
  event:
    | 'BOOT_READY'
    | 'SIGNAL_ABORTED'
    | 'AFTER_CLOSE'
    | 'OWNER_SETTLED'
    | 'FIXTURE_ERROR'
    | 'PROTOCOL_ERROR',
  fields: Record<string, string | number | boolean | null> = {},
) {
  const bytes = Buffer.from(
    'RETRY_PHASE ' + JSON.stringify({ event, ...fields }) + '\n',
  );
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(2, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Fixture phase write failed.');
    offset += written;
  }
}
let operation = 0;
let activeOperation = 0;
class ObservedHost extends SubmissionHost {
  override async planRetryToolResult(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<PlanRetryToolResult> {
    const number = ++operation;
    activeOperation = number;
    const onAbort = () => phase('SIGNAL_ABORTED', { operation: number });
    signal?.addEventListener('abort', onAbort, { once: true });
    let result: PlanRetryToolResult | undefined;
    try {
      result = await super.planRetryToolResult(value, signal);
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (result) {
        const payload = result.structuredContent;
        const code = payload.status === 'error' ? payload.error.code : null;
        if (statuses.has(payload.status) && (code === null || codes.has(code)))
          phase('OWNER_SETTLED', {
            operation: number,
            aborted: signal?.aborted === true,
            status: payload.status,
            code,
          });
        else phase('FIXTURE_ERROR');
      } else phase('FIXTURE_ERROR');
      activeOperation = 0;
    }
  }
}
async function main() {
  const configuration = loadSubmissionConfiguration({
    stateDirectory: process.env.TEST_SUBMISSION_STATE,
    policyPath: process.env.TEST_SUBMISSION_POLICY,
    apiKey: process.env.SPEEDYINDEX_API_KEY,
  });
  if (configuration.state !== 'configured')
    throw new Error('Invalid synthetic configuration.');
  const host = new ObservedHost(configuration, {
    retry: {
      hooks: {
        onOwnerPhase(ownerPhase) {
          if (ownerPhase === 'after_close')
            phase('AFTER_CLOSE', { operation: activeOperation });
        },
      },
    },
  });
  const server = createServer(undefined, host);
  server.server.onerror = () => phase('PROTOCOL_ERROR');
  await server.connect(new StdioServerTransport());
  phase('BOOT_READY');
}
try {
  await main();
} catch {
  phase('FIXTURE_ERROR');
  process.exitCode = 1;
}
