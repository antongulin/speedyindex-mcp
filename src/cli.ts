#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { version } from '../package.json';
import { createServer } from './server';
import { SubmissionHost } from './submission-host';
import {
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
} from './submission-policy';
import { initializeLedger } from './submission-ledger';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`speedyindex-mcp ${version}
Usage: bun src/cli.ts [--help | --version]
       bun dist/cli.js [--help | --version]

Stdio MCP server exposing get_balance, list_tasks, get_task_status,
get_task_report, and create_indexing_task. Indexing writes are disabled by default;
pure previews need no credentials, policy or state.
Set SPEEDYINDEX_API_KEY in the process environment.
Provider requests have a 10-second deadline, support cancellation, and never retry.

Local modes (exclusive; no network or MCP server):
  --submission-credential-fingerprint
  --init-submission-state <canonical-absolute-new-directory>
Stdio configuration (explicit trusted paths; no automatic initialization):
  --submission-policy <canonical-absolute-file>
  --submission-state <canonical-absolute-existing-directory>
Incomplete or invalid configuration disables writes while reads remain available.
Failed initialization may leave state for inspection; no automatic repair occurs.
Launch Bun with --no-env-file before the script to disable automatic .env loading.
Restart all cooperating hosts after changing policy; there is no reload loop.`);
} else if (args.length === 1 && args[0] === '--version') {
  console.log(version);
} else {
  const values = new Map<string, string>();
  let syntaxError = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (values.has(flag)) {
      syntaxError = true;
      break;
    }
    if (flag === '--submission-credential-fingerprint') values.set(flag, '');
    else if (
      [
        '--init-submission-state',
        '--submission-policy',
        '--submission-state',
      ].includes(flag)
    ) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        syntaxError = true;
        break;
      }
      values.set(flag, value);
    } else {
      syntaxError = true;
      break;
    }
  }
  const fingerprint = values.has('--submission-credential-fingerprint');
  const initialize = values.has('--init-submission-state');
  if ((fingerprint || initialize) && values.size !== 1) syntaxError = true;
  if (syntaxError) {
    console.error('Unsupported arguments. Use --help for usage.');
    process.exitCode = 1;
  } else if (fingerprint) {
    try {
      console.log(
        submissionCredentialFingerprint(process.env.SPEEDYINDEX_API_KEY),
      );
    } catch {
      console.error('Set SPEEDYINDEX_API_KEY to a valid submission API key.');
      process.exitCode = 1;
    }
  } else if (initialize) {
    try {
      initializeLedger({
        stateDirectory: values.get('--init-submission-state')!,
      }).close();
      console.log(JSON.stringify({ initialized: true, schemaVersion: 1 }));
    } catch {
      console.error('Could not initialize submission state.');
      process.exitCode = 1;
    }
  } else {
    try {
      const configuration = loadSubmissionConfiguration({
        policyPath: values.get('--submission-policy'),
        stateDirectory: values.get('--submission-state'),
        apiKey: process.env.SPEEDYINDEX_API_KEY,
      });
      const server = createServer(undefined, new SubmissionHost(configuration));
      server.server.onerror = () => {
        console.error('MCP transport error.');
      };
      await server.connect(new StdioServerTransport());
    } catch {
      console.error('Could not start the MCP stdio server.');
      process.exitCode = 1;
    }
  }
}
