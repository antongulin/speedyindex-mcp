# Local state maintenance

These commands operate only on explicitly selected private local state. They require no API key, policy, provider request or MCP session. They do not enable paid submissions, choose caps or add public tools. Use Bun's `--no-env-file` before the entrypoint; the source entrypoint is `src/cli.ts`, and the current build is `dist/cli.js`.

## New state

The original command still creates V1:

```sh
bun --no-env-file dist/cli.js --init-submission-state '<canonical-absolute-new-directory>'
```

To create V2 explicitly:

```sh
bun --no-env-file dist/cli.js --init-submission-state-v2 '<canonical-absolute-new-directory>'
```

Successful initialization prints only `{"initialized":true,"schemaVersion":1}` or `{"initialized":true,"schemaVersion":2}`. Both commands require a new leaf below an existing trusted parent. They refuse existing, partial or unsafe paths and do not create parents, repair permissions or clean up failed initialization. Inspect any retained files. Never initialize replacement state to bypass reservations.

Paths must be canonical absolute POSIX paths, with no symlink ancestors. Ancestors must be root/current-user owned and not group/other writable; root-owned sticky temporary directories are permitted. The final directory must be current-user owned, mode `0700`; database and sidecars must be current-user owned, regular, single-link files with mode `0600`. Resolve operating-system path aliases before invoking maintenance. These checks do not defend against a malicious process with the same user or root privileges.

## Offline V1 to V2 migration

1. Drain all in-flight paid calls, then stop **ALL cooperating hosts**, scheduler/automation and other processes using this store. Stopping a host can lose its in-memory dispatch capability or outcome token. A SQL lock, idle-looking process or successful command does not prove that every old host stopped. Do not run old and new binaries together during migration.
2. Preserve the existing state and select an explicit new private backup directory under a trusted existing parent. Do not overwrite an earlier backup or remove WAL, SHM or rollback-journal files manually.
3. Run the exclusive local command:

   ```sh
   bun --no-env-file dist/cli.js \
     --migrate-submission-state-v2 '<canonical-absolute-existing-v1-directory>' \
     --backup-directory '<canonical-absolute-new-backup-directory>'
   ```

4. Retain the verified private backup, its `backup-manifest.json`, and a private maintenance audit. Inspect the resulting strict V2 state and command receipt. Restart **ALL cooperating hosts on the V2-capable binary** before resuming work. Policy changes independently require restarting all hosts.

A completed migration prints only `{"migrated":true,"schemaVersion":2,"backupVerified":true}`. A strict store already at V2 prints `{"migrated":false,"schemaVersion":2,"reason":"AlreadyV2"}` and creates no new backup or contexts. Mixed modes, duplicate, unknown or missing options fail before command writes; local modes cannot be combined with fingerprint or stdio policy/state options. Errors are fixed sanitized messages, without paths, SQL or private records.

Migration audits the exact V1 schema, rows, event chains and foreign keys without repair. It requires WAL/FULL discipline and a successful TRUNCATE checkpoint with empty WAL, then acquires a writer transaction and rechecks schema, identity and empty WAL to catch an intervening writer. It holds that transaction through a bounded checked file-descriptor copy to a new exclusive private backup, complete logical verification, close and final fsync. The private manifest records final retained file hashes after verification bookkeeping. Only then does it add two tables and two nonunique indexes, seed `legacy_unattributed` contexts, assign a random ledger identity and commit version 2 once. The original database inode and complete core rows, events, URL ordinals, unit reservations, policy/quote identities, ownership digests and sequence values are preserved. It does not infer legacy ancestry.

Checkpointing and verification can change main-file bytes and WAL/SHM bookkeeping. Source byte identity from before maintenance is not promised. Backup creation or fsync failures retain private partial files for inspection; a failed attempt must not be called a verified backup. Precommit failure rolls back the schema transaction. Process-kill tests exercise native transaction rollback and committed state, not hardware or power-loss guarantees.

## Missing receipts and manual recovery

A missing receipt can mean COMMIT succeeded. Reopen and inspect the complete version/schema/data before deciding what happened. Never automatically restore, repeat DDL, downgrade, delete sidecars or reset state. AlreadyV2 is an inspection result, not evidence that a new backup was made.

**Never restore a stale V1 backup over ANY new V2 intent, context, event, claim, outcome or hold.** Such a restore would erase durable activity and permit unsafe resubmission. Preserve/archive the current complete state and its sidecars before any separately reviewed manual recovery. This project provides no restore/downgrade API or automatic recovery eligibility predicate.

Migration preserves capability and outcome-token digests, but cannot recover lost secrets or ownership. Prepared, dispatching and unknown holds never expire, release or reissue automatically. A lost prepare receipt does not mint a replacement capability on replay. An uncertain provider outcome is not permission to resend.

## Internal V2 boundaries

Ordinary public submissions work on V1 or V2 with unchanged policy, quote, body and acknowledgement contracts. On V2, new ordinary intents receive a `standalone` context in the same transaction; exact legacy replay leaves metadata unchanged. Common startup and preview open no ledger; normal submit opens existing complete state without migration, initialization or repair.

Internal V2 APIs provide a coherent frozen retry snapshot and deterministic retry admission. They are not MCP tools, approval, source eligibility, provider-global ancestry or evidence of report finality. Legacy attribution remains unknown. Local accepted manifests describe exact submitted URLs and durable local ACKs; backlink manifests cannot reconstruct target lists. Ambiguous provider references are explicit, and retry child state/ACK is joined from the core rather than a second ACK store.

Snapshot reads use an existing guarded file, query-only connection and one synchronous read transaction. Semantic read-only means no logical schema, event or reservation mutation; SQLite can still write physical WAL/SHM bookkeeping or checkpoint main-file bytes. Available means complete for the selected key's local history across scopes/families, not source-ready or approved. Missing, old, corrupt, busy, unreadable or incomplete/over-limit state produces a sanitized unavailable result, never a partial available result.

Per-binding completeness bounds are 2,000 intents, 6,000 events, 20,000 URL rows and 16 MiB retained UTF-8 projection/DTO data. They are technical resource bounds, not financial or retry allowances, and do not limit migration or ordinary valid larger stores. Revisions bind exact scoped identity, ownership, state, units, ACKs, contexts and ordered URLs/events with exact integer text; time alone and unrelated-key writes do not change them. Private ownership digests and credential bindings are never returned in snapshot DTOs.

New internal retry admission recomputes that projection in its own writer transaction, requires an exact unambiguous local indexer parent/manifest/subset, and retains existing independent unit caps and cross-scope unresolved URL holds. Dispatching/unknown retry children without durable IDs block new retry admission. Exact replay creates no capability, reservation or event. This prerequisite does not implement the five remaining public tools, deterministic one-shot orchestration, scheduling or provider adoption. See [architecture](architecture.md) and the [implementation plan](implementation-plan.md).
