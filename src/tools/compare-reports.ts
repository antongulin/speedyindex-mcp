import type { McpServer } from '@modelcontextprotocol/server';
import {
  compareReportsInputSchema,
  compareReportsResultSchema,
} from '../compare-reports';
import type { CompareReportsOwner } from '../compare-reports-owner';

export function registerCompareReports(
  server: McpServer,
  owner: CompareReportsOwner,
) {
  server.registerTool(
    'compare_reports',
    {
      title: 'Compare SpeedyIndex task reports',
      description:
        'Compare two caller-selected task reports in one supported family, preserving before/after direction and exact IDs. Observed evidence is non-atomic; results grant no retry or submission authority.',
      inputSchema: compareReportsInputSchema,
      outputSchema: compareReportsResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, context) => owner.compare(input, context.mcpReq.signal),
  );
}
