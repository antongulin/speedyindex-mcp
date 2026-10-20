import type { McpServer } from '@modelcontextprotocol/server';
import {
  TaskReportError,
  taskReportInputSchema,
  taskReportOutputSchema,
} from '../task-report';
import type { SpeedyIndexClient } from '../client';

export function registerGetTaskReport(
  server: McpServer,
  client: SpeedyIndexClient,
) {
  server.registerTool(
    'get_task_report',
    {
      title: 'Get SpeedyIndex task report',
      description:
        'Read one report for one existing task in a single request. Supports the five generic task families and backlink/checker. Generic reports return provider link arrays without URL rewriting. Backlink reports return one page of opaque donor objects; page defaults to 0 and limit defaults to 100 (maximum 100). Report fields do not establish completeness or fresh indexing truth. Makes no retries or follow-up requests.',
      inputSchema: taskReportInputSchema,
      outputSchema: taskReportOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      try {
        const result = await client.getTaskReport(input, context.mcpReq.signal);
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
                error instanceof TaskReportError
                  ? error.message
                  : 'Could not read the SpeedyIndex task-report endpoint.',
            },
          ],
        };
      }
    },
  );
}
