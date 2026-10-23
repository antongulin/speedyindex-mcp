import type { McpServer } from '@modelcontextprotocol/server';
import {
  retryHistoryInputSchema,
  retryHistoryResultSchema,
} from '../get-retry-history';
import type { SubmissionHost } from '../submission-host';

export function registerGetRetryHistory(
  server: McpServer,
  host: SubmissionHost,
) {
  server.registerTool(
    'get_retry_history',
    {
      title: 'Get local SpeedyIndex retry history',
      description:
        'Read recorded retry attempts from the configured local V2 state. Omitted engine selects both engines; omitted limit is 25. Returns exact provider and parent IDs, nullable metadata and revision-bound pages. Provider-wide coverage and original ancestry remain unknown; attempt references grant no retry or submission authority.',
      inputSchema: retryHistoryInputSchema,
      outputSchema: retryHistoryResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, context) =>
      host.getRetryHistoryToolResult(input, context.mcpReq.signal),
  );
}
