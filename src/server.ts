import { McpServer } from '@modelcontextprotocol/server';
import { version } from '../package.json';
import { SpeedyIndexClient } from './client';
import { registerGetBalance } from './tools/get-balance';

export function createServer(
  client = new SpeedyIndexClient(process.env.SPEEDYINDEX_API_KEY),
) {
  const server = new McpServer({ name: 'speedyindex-mcp', version });
  registerGetBalance(server, client);
  return server;
}
