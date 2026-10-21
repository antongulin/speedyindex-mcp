import type { McpServer } from '@modelcontextprotocol/server';
import {
  createBacklinkCheckInputSchema,
  createBacklinkCheckResultSchema,
  createBacklinkCheckToolResult,
} from '../create-backlink-check';
import type { SubmissionHost } from '../submission-host';

export function registerCreateBacklinkCheck(
  server: McpServer,
  host: SubmissionHost,
) {
  server.registerTool(
    'create_backlink_check',
    {
      title: 'Preview or create a SpeedyIndex backlink check',
      description:
        'Preview donor URLs and exact target domain text with optional operator reservations, or submit one paid backlink check under a trusted local policy and stable requestId. Writes default off; submission requires enabled configuration, explicit backlink permission and a complete reservation profile. Reservations are not provider fees. Preview opens no ledger and checks no balance. Exact replays return durable local state without resending; unresolved donor URLs retain holds across targets and create tools. No retries, redirects or provider idempotency guarantee.',
      inputSchema: createBacklinkCheckInputSchema,
      outputSchema: createBacklinkCheckResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        return createBacklinkCheckToolResult(
          await host.createBacklinkCheck(input, context.mcpReq.signal),
        );
      } catch {
        // Own validation also covers isError results, which the SDK skips.
        return createBacklinkCheckToolResult(undefined);
      }
    },
  );
}
