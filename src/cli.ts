#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { version } from '../package.json';
import { createServer } from './server';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`speedyindex-mcp ${version}
Usage: bun src/cli.ts [--help | --version]
       bun dist/cli.js [--help | --version]

Stdio MCP server exposing read-only get_balance, list_tasks, and get_task_status.
Set SPEEDYINDEX_API_KEY in the process environment.
Provider requests have a 10-second deadline, support cancellation, and never retry.`);
} else if (args.length === 1 && args[0] === '--version') {
  console.log(version);
} else if (args.length > 0) {
  console.error('Unsupported arguments. Use --help for usage.');
  process.exitCode = 1;
} else {
  try {
    const server = createServer();
    server.server.onerror = () => {
      console.error('MCP transport error.');
    };
    await server.connect(new StdioServerTransport());
  } catch {
    console.error('Could not start the MCP stdio server.');
    process.exitCode = 1;
  }
}
