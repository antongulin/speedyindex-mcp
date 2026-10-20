import type { McpServer } from '@modelcontextprotocol/server';
import {
  TaskStatusError,
  taskStatusInputSchema,
  taskStatusResultSchema,
} from '../task-status';
import type { SpeedyIndexClient } from '../client';

export function registerGetTaskStatus(
  server: McpServer,
  client: SpeedyIndexClient,
) {
  server.registerTool(
    'get_task_status',
    {
      title: 'Get SpeedyIndex task status',
      description:
        'Read existing task status for one of six families: google/indexer, google/checker, yandex/indexer, yandex/checker, bing/checker, or backlink/checker. Provide exactly one of taskId or taskIds; taskIds accepts 1 to 1,000 unique opaque IDs. Makes one read-only request. Returned tasks follow request order. unreturnedIds means the provider omitted a record from this response; it does not mean the task does not exist.',
      inputSchema: taskStatusInputSchema,
      outputSchema: taskStatusResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        const result = await client.getTaskStatus(input, context.mcpReq.signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof TaskStatusError
                  ? error.message
                  : 'Could not read the SpeedyIndex task-status endpoint.',
            },
          ],
        };
      }
    },
  );
}
