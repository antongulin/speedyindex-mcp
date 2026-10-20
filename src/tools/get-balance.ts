import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  AccountError,
  balanceResultSchema,
  type SpeedyIndexClient,
} from '../client';

export function registerGetBalance(
  server: McpServer,
  client: SpeedyIndexClient,
) {
  server.registerTool(
    'get_balance',
    {
      title: 'Get SpeedyIndex balance',
      description:
        'Read token, indexer, and checker balances with the observation time. Creates no jobs.',
      inputSchema: z.strictObject({}),
      outputSchema: balanceResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_args, context) => {
      try {
        const result = await client.getBalance(context.mcpReq.signal);
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
                error instanceof AccountError
                  ? error.message
                  : 'Could not read the SpeedyIndex account endpoint.',
            },
          ],
        };
      }
    },
  );
}
