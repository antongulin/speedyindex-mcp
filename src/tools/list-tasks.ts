import type { McpServer } from '@modelcontextprotocol/server';
import {
  listTasksInputSchema,
  listTasksResultSchema,
  TaskListError,
  type SpeedyIndexClient,
} from '../client';

export function registerListTasks(
  server: McpServer,
  client: SpeedyIndexClient,
) {
  server.registerTool(
    'list_tasks',
    {
      title: 'List SpeedyIndex tasks',
      description:
        'Read one zero-based page of up to 1,000 tasks, newest first. Bing supports checker tasks only. The response includes lastPage, the inclusive zero-based final page index; when fetching sequentially, stop after a page where page >= lastPage. Omit filter to include standard and pay-per-indexed tasks while excluding drip-feed tasks. Filters apply only to Google indexer tasks; payPerIndexed applies only with the drip_feed filter.',
      inputSchema: listTasksInputSchema,
      outputSchema: listTasksResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        const result = await client.listTasks(input, context.mcpReq.signal);
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
                error instanceof TaskListError
                  ? error.message
                  : 'Could not read the SpeedyIndex task-list endpoint.',
            },
          ],
        };
      }
    },
  );
}
