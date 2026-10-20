import type { McpServer } from '@modelcontextprotocol/server';
import {
  createIndexingTaskInputSchema,
  createIndexingTaskResultSchema,
  createIndexingTaskToolResult,
} from '../create-indexing-task';
import type { SubmissionHost } from '../submission-host';

export function registerCreateIndexingTask(
  server: McpServer,
  host: SubmissionHost,
) {
  server.registerTool(
    'create_indexing_task',
    {
      title: 'Preview or create a SpeedyIndex indexing task',
      description:
        'Explicitly preview a Google or Yandex batch quote, or submit one paid indexing task under a trusted local policy and stable requestId. Writes are disabled by default. Preview checks no ledger or balance. Acknowledgement digests detect context changes, not human identity. Replays return local durable state without resending; unresolved attempts retain their reservations. No retries, redirects, splitting or provider idempotency guarantee.',
      inputSchema: createIndexingTaskInputSchema,
      outputSchema: createIndexingTaskResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        return createIndexingTaskToolResult(
          await host.createIndexingTask(input, context.mcpReq.signal),
        );
      } catch {
        // Own validation also covers isError results, which the SDK skips.
        return createIndexingTaskToolResult(undefined);
      }
    },
  );
}
