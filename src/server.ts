import { McpServer } from '@modelcontextprotocol/server';
import { version } from '../package.json';
import { SpeedyIndexClient } from './client';
import { registerGetBalance } from './tools/get-balance';
import { registerListTasks } from './tools/list-tasks';
import { registerGetTaskStatus } from './tools/get-task-status';
import { registerGetTaskReport } from './tools/get-task-report';
import { registerCreateIndexingTask } from './tools/create-indexing-task';
import { registerCreateIndexCheck } from './tools/create-index-check';
import { registerCreateBacklinkCheck } from './tools/create-backlink-check';
import { SubmissionHost } from './submission-host';

export function createServer(
  client = new SpeedyIndexClient(process.env.SPEEDYINDEX_API_KEY),
  submissionHost = new SubmissionHost(),
) {
  const server = new McpServer({ name: 'speedyindex-mcp', version });
  registerGetBalance(server, client);
  registerListTasks(server, client);
  registerGetTaskStatus(server, client);
  registerGetTaskReport(server, client);
  registerCreateIndexingTask(server, submissionHost);
  registerCreateIndexCheck(server, submissionHost);
  registerCreateBacklinkCheck(server, submissionHost);
  return server;
}
