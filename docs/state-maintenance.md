# Local state maintenance

The existing CLI `--init-submission-state` creates only V1. V2 initialization and migration are trusted internal entries in `src/submission-ledger.ts`, without CLI or MCP exposure in this delivery. They require explicit private paths, no API key or provider request, and select no policy, caps or paid enablement.

## Internal initialization and offline migration

The trusted call `initializeLedgerV2({ stateDirectory })` returns a common `SubmissionLedger` handle; its caller must close that handle. It creates only a new private leaf below an existing trusted parent. It refuses existing, partial or unsafe paths, creates no parents, and does not repair or clean up failed initialization. Normal submit opens existing complete V1/V2 state; startup and preview open no ledger and never migrate.

Paths must be canonical absolute POSIX paths, with no symlink ancestors. Ancestors must be root/current-user owned and not group/other writable; root-owned sticky temporary directories are permitted. The final directory must be current-user owned, mode `0700`; database and sidecars must be current-user owned, regular, single-link files with mode `0600`. Resolve operating-system path aliases before invoking maintenance. These checks do not defend against a malicious process with the same user or root privileges.

Before the trusted synchronous call `migrateLedgerV2({ stateDirectory, backupDirectory })`, drain all in-flight paid calls and stop ALL cooperating hosts and every other process using this store. Select an explicit new private backup directory under a trusted existing parent. A SQL lock or successful maintenance result does not prove all hosts stopped. Never overwrite backups or manually delete sidecars. Restart ALL hosts on the V2-capable binary only after inspecting the resulting state and verified backup. Policy changes independently require restarting all hosts.

The internal result is either `migrated: true, schemaVersion: 2, backupVerified: true` or `migrated: false, schemaVersion: 2, reason: AlreadyV2`. AlreadyV2 creates no new backup or contexts. Retain the private backup and final `backup-manifest.json`, and keep a private maintenance audit. Errors are sanitized; private records and paths do not belong in public logs.

Migration audits the exact V1 schema, rows, event chains and foreign keys without repair. It requires WAL/FULL discipline and a successful TRUNCATE checkpoint with empty WAL, then acquires a writer transaction and rechecks schema, identity and empty WAL to catch an intervening writer. It holds that transaction through a bounded checked file-descriptor copy to a new exclusive private backup, complete logical verification, close and final fsync. The private manifest records final retained file hashes after verification bookkeeping. Only then does it add two tables and two nonunique indexes, seed `legacy_unattributed` contexts, assign a random ledger identity and commit version 2 once. The original database inode and complete core rows, events, URL ordinals, unit reservations, policy/quote identities, ownership digests and sequence values are preserved. It does not infer legacy ancestry.

Checkpointing and verification can change main-file bytes and WAL/SHM bookkeeping. Source byte identity from before maintenance is not promised. Backup creation or fsync failures retain private partial files for inspection; a failed attempt must not be called a verified backup. Precommit failure rolls back the schema transaction. Process-kill tests exercise native transaction rollback and committed state, not hardware or power-loss guarantees.

## Missing receipts and manual recovery

A missing receipt can mean COMMIT succeeded. Reopen and inspect the complete version/schema/data before deciding what happened. Never automatically restore, repeat DDL, downgrade, delete sidecars or reset state. AlreadyV2 is an inspection result, not evidence that a new backup was made.

**Never restore a stale V1 backup over ANY new V2 intent, context, event, claim, outcome or hold.** Such a restore would erase durable activity and permit unsafe resubmission. Preserve/archive the current complete state and its sidecars before any separately reviewed manual recovery. A manual offline restore also requires separate verification that the store has never been reactivated and has no post-migration activity beyond the seeded legacy contexts. After new V2 activity, use a separately reviewed forward recovery. This delivery supplies no restore/downgrade API or automatic recovery eligibility predicate.

Migration preserves capability and outcome-token digests, but cannot recover lost secrets or ownership. Prepared, dispatching and unknown holds never expire, release or reissue automatically. A lost prepare receipt does not mint a replacement capability on replay. An uncertain provider outcome is not permission to resend.

## Delivered scope

Ordinary V2 preparation inserts a `standalone` context in the same transaction as its core intent, URLs and event. This context records use of the ordinary preparation entry; it does not prove human intent or original ancestry. Migration leaves legacy attribution unknown and preserves all original core rows, ownership and holds. Common host interfaces, policy/body/quote/ACK contracts and the seven public tools remain unchanged. Internal snapshots and retry admission, V2 CLI commands, deterministic one-shot orchestration and the five remaining public tools are later work.
