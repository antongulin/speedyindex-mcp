import type { McpServer } from '@modelcontextprotocol/server';
import {
  createIndexCheckInputSchema,
  createIndexCheckResultSchema,
  createIndexCheckToolResult,
} from '../create-index-check';
import type { SubmissionHost } from '../submission-host';

export function registerCreateIndexCheck(
  server: McpServer,
  host: SubmissionHost,
) {
  server.registerTool(
    'create_index_check',
    {
      title: 'Preview or create a SpeedyIndex index check',
      description:
        'Explicitly preview a Google, Yandex or Bing index check with optional operator reservation estimates, or submit one paid check under a trusted local policy and stable requestId. Writes are disabled by default; checks require explicit permission and an engine profile. Reservations are not provider fees. Preview checks no ledger or balance. Exact replays return durable local state without resending; unresolved attempts retain reservations. No retries, redirects or provider idempotency guarantee.',
      inputSchema: createIndexCheckInputSchema,
      outputSchema: createIndexCheckResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        return createIndexCheckToolResult(
          await host.createIndexCheck(input, context.mcpReq.signal),
        );
      } catch {
        // Own validation also covers isError results, which the SDK skips.
        return createIndexCheckToolResult(undefined);
      }
    },
  );
}
