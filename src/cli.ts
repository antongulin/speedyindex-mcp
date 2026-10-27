#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { version } from '../package.json';
import { createServer } from './server';
import { SubmissionHost } from './submission-host';
import {
  loadSubmissionConfiguration,
  submissionCredentialFingerprint,
} from './submission-policy';
import {
  initializeLedger,
  initializeLedgerV2,
  migrateLedgerV2,
} from './submission-ledger';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`speedyindex-mcp ${version}
Usage: bun src/cli.ts [--help | --version]
       bun dist/cli.js [--help | --version]

Stdio MCP server exposing get_balance, list_tasks, get_task_status,
get_task_report, create_indexing_task, create_index_check, create_backlink_check,
plan_retry, get_retry_history, and compare_reports.
plan_retry observes and plans without writes under configured private retry policy.
get_retry_history reads configured local V2 history without provider requests.
compare_reports observes two caller-selected reports without writes or retry authority.
All three create tools default to disabled writes; pure previews need no key/state.
Index and backlink checks require explicit opt-in and operator-selected reservation
profiles in enabled trusted configuration. Reservations are not provider fees.
Set SPEEDYINDEX_API_KEY in the process environment.
Provider requests have a 10-second deadline, support cancellation, and never retry.

Local modes (exclusive; no network or MCP server):
  --submission-credential-fingerprint
  --init-submission-state <canonical-absolute-new-directory> (V1)
  --init-submission-state-v2 <canonical-absolute-new-directory>
  --migrate-submission-state-v2 <canonical-absolute-existing-directory>
    --backup-directory <canonical-absolute-new-directory>
Migration requires draining/stopping ALL hosts first and restarting ALL on V2.
A missing receipt may follow a successful commit; inspect before manual recovery.
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
        '--init-submission-state-v2',
        '--migrate-submission-state-v2',
        '--backup-directory',
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
  const initializeV2 = values.has('--init-submission-state-v2');
  const migrateV2 = values.has('--migrate-submission-state-v2');
  const backup = values.has('--backup-directory');
  if ((fingerprint || initialize || initializeV2) && values.size !== 1)
    syntaxError = true;
  if (migrateV2 && (!backup || values.size !== 2)) syntaxError = true;
  if (backup && !migrateV2) syntaxError = true;
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
  } else if (initialize || initializeV2) {
    try {
      const init = initializeV2 ? initializeLedgerV2 : initializeLedger;
      init({
        stateDirectory: values.get(
          initializeV2
            ? '--init-submission-state-v2'
            : '--init-submission-state',
        )!,
      }).close();
      console.log(
        JSON.stringify({
          initialized: true,
          schemaVersion: initializeV2 ? 2 : 1,
        }),
      );
    } catch {
      console.error('Could not initialize submission state.');
      process.exitCode = 1;
    }
  } else if (migrateV2) {
    try {
      console.log(
        JSON.stringify(
          migrateLedgerV2({
            stateDirectory: values.get('--migrate-submission-state-v2')!,
            backupDirectory: values.get('--backup-directory')!,
          }),
        ),
      );
    } catch {
      console.error('Could not migrate submission state.');
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
