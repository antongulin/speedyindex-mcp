import { McpServer } from '@modelcontextprotocol/server';
import { version } from '../package.json';
import { SpeedyIndexClient } from './client';
import { registerGetBalance } from './tools/get-balance';
import { registerListTasks } from './tools/list-tasks';
import { registerGetTaskStatus } from './tools/get-task-status';
import { registerGetTaskReport } from './tools/get-task-report';

export function createServer(
  client = new SpeedyIndexClient(process.env.SPEEDYINDEX_API_KEY),
) {
  const server = new McpServer({ name: 'speedyindex-mcp', version });
  registerGetBalance(server, client);
  registerListTasks(server, client);
  registerGetTaskStatus(server, client);
  registerGetTaskReport(server, client);
  return server;
}
