import type { McpServer } from '@modelcontextprotocol/server';
import { retryPlanInputSchema } from '../plan-retry';
import { planRetryResultSchema } from '../plan-retry-result';
import type { SubmissionHost } from '../submission-host';

export function registerPlanRetry(server: McpServer, host: SubmissionHost) {
  server.registerTool(
    'plan_retry',
    {
      title: 'Plan a SpeedyIndex retry',
      description:
        'Observe the latest completed indexer task and return a read-only retry plan, no_source, blockers, or a fixed error. Defaults to Google. Planning creates no jobs, reservations, parent adoption, or retry authority; comparison fingerprints are opaque commitments.',
      inputSchema: retryPlanInputSchema,
      outputSchema: planRetryResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, context) => host.planRetryToolResult(input, context.mcpReq.signal),
  );
}
