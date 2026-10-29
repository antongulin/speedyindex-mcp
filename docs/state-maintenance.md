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

A completed migration prints only `{"migrated":true,"schemaVersion":2,"backupVerified":true}`. A strict store already at V2 prints `{"migrated":false,"schemaVersion":2,"reason":"AlreadyV2"}` and creates no new backup or contexts. The CLI validates the entire argument grammar before reading a key or configuration, opening state, making network requests or starting the MCP server. Mixed modes, duplicate, unknown or missing options fail at that boundary; local modes cannot be combined with fingerprint or stdio policy/state options. Errors are fixed sanitized messages, without paths, SQL or private records.

Migration audits the exact V1 schema, rows, event chains and foreign keys without repair. It requires WAL/FULL discipline and a successful TRUNCATE checkpoint with empty WAL, then acquires a writer transaction and rechecks schema, identity and empty WAL to catch an intervening writer. It holds that transaction through a bounded checked file-descriptor copy to a new exclusive private backup, complete logical verification, close and final fsync. The private manifest records final retained file hashes after verification bookkeeping. Only then does it add two tables and two nonunique indexes, seed `legacy_unattributed` contexts, assign a random ledger identity and commit version 2 once. The original database inode and complete core rows, events, URL ordinals, unit reservations, policy/quote identities, ownership digests and sequence values are preserved. It does not infer legacy ancestry.

Checkpointing and verification can change main-file bytes and WAL/SHM bookkeeping. Source byte identity from before maintenance is not promised. Backup creation or fsync failures retain private partial files for inspection; a failed attempt must not be called a verified backup. Precommit failure rolls back the schema transaction. Process-kill tests exercise native transaction rollback and committed state, not hardware or power-loss guarantees.

## Missing receipts and manual recovery

A missing receipt can mean COMMIT succeeded. Reopen and inspect the complete version/schema/data before deciding what happened. Never automatically restore, repeat DDL, downgrade, delete sidecars or reset state. AlreadyV2 is an inspection result, not evidence that a new backup was made.

**Never restore a stale V1 backup over ANY new V2 intent, context, event, claim, outcome or hold.** Such a restore would erase durable activity and permit unsafe resubmission. Preserve/archive the current complete state and its sidecars before any separately reviewed manual recovery. A manual offline restore also requires separate verification that the store has never been reactivated and has no post-migration activity beyond the seeded legacy contexts. After new V2 activity, use a separately reviewed forward recovery. This delivery supplies no restore/downgrade API or automatic recovery eligibility predicate.

Migration preserves capability and outcome-token digests, but cannot recover lost secrets or ownership. Prepared, dispatching and unknown holds never expire, release or reissue automatically. A lost prepare receipt does not mint a replacement capability on replay. An uncertain provider outcome is not permission to resend.

## Implemented state and planning scope

Ordinary V2 preparation inserts a `standalone` context in the same transaction as its core intent, URLs and event. This context records use of the ordinary preparation entry; it does not prove human intent or original ancestry. Migration leaves legacy attribution unknown and preserves all original core rows, ownership and holds. The original seven public tools retain their host, policy/body/quote/ACK contracts. Internal snapshots and atomic retry admission now exist as trusted module APIs. Explicit V2 CLI commands and shared source/built maintenance and three-create integration journeys complete this local foundation. Read-only `plan_retry` and `get_retry_history` bring this source branch to nine tools, and read-only `compare_reports` adds a tenth without opening this ledger or changing its holds; `submit_retry`, `summarize_campaigns`, deterministic one-shot execution and scheduling remain later work. Implementation is not release or delivery evidence.

## Read-only public planning

`plan_retry` uses the existing configured host, matching key, enabled private policy/retry and complete existing V2 state. It accepts only an optional Google/Yandex engine, default Google. It adds no maintenance mode, path default, automatic init/migration, reservation, retry/adoption row or parent history. A V1 store requires the explicit offline maintenance process above before planning can use it; ordinary V1 creates/replay remain supported. No active operator configuration or paid retry submission is selected here.

The planner combines the selected key's bounded local history across scopes/families with two non-atomic provider passes. Complete accepted local manifests and explicitly permitted external observed corpora retain distinct provenance; external original ancestry stays unknown. Ready is a comparison proposal, no_source records complete source absence, blocked records fixed safety refusals, and error is a fixed sanitized failure. Application isError is true exactly for error. No outcome releases existing holds or supplies a replacement dispatch capability. Opaque comparison hashes cannot reconstruct discarded history or authorize future paid work.

Planning preserves complete logical SQLite schema, rows, versions, events and reservations. Query-only reads still require writable private storage and may change physical WAL/SHM bookkeeping or checkpoint main-file bytes. The owner retains one original budget/day through final readers, bounded public serialization, awaited native settlement/close and final freshness before completion. The complete application envelope, including escaped text, duplicate structured data and isError, fits 2,097,152 UTF-8 bytes inclusively; SDK framing, RSS and hard latency are outside this bound. Synchronous SQL/CPU can delay cancellation and SDK cancellation can suppress the reply. Client rejection or a missing reply alone proves neither owner completion nor a state change. Preserve uncertain artifacts and inspect through the established local boundaries; do not reset state or retry a paid operation on that evidence. See the [public contract](../README.md#read-only-retry-planning) and [architecture](architecture.md#public-retry-planning).

## Read-only local history

`get_retry_history` uses the configured host's immutable selected key and state reference. The CLI's existing configuration loader needs explicit valid policy/state paths, an enabled policy and matching key. Retry permission may be absent or disabled. History performs no HTTP, paid admission, logical write, automatic init, migration or repair. Default selection covers both Google/Yandex indexer retry histories with a 25-entry page; exact filters and revision/query-bound cursors are described in the [public contract](../README.md#read-only-local-retry-history).

An absent leaf stays absent and returns fixed `StateMissing`; a V1 store returns `V2Required` on repeat without changing its schema/history. A complete initialized empty V2 returns `ok` with zero matching retries and unknown inception/provider-wide coverage. After a settled missing-state refusal, an operator may use the existing explicit new-only V2 initializer and then read on the same configured host. This does not authorize live V1 migration: drain/stop all cooperating hosts before the offline procedure and restart them afterward.

Each history call pins one complete query-only snapshot and closes its native handle before returning owned data. Filters/pages do not reduce the full audit or its technical ceilings. A changed revision invalidates continuation with `SnapshotChanged`; restart the query rather than restore state or silently recompute a page. Terminal timestamps/reservations and some URL counts were discarded by the existing snapshot projection and remain null; legacy ancestry, coverage inception and earlier discarded/provider-wide history remain unknown. Logical SQL equality permits physical WAL/SHM/checkpoint changes and still needs writable private storage.

The history owner keeps its independent guard and original budget through real I/O cancellation delivery, native/budget settlement and a final clock/signal check. SDK cancellation can suppress the application response; client rejection alone does not prove owner settlement. Clean refusal/cancellation permits reuse after settlement. An opaque snapshot `ReadFailure` disables only this host's history reader until restart, without diagnosing the underlying native cause or granting permission to reset/replay paid work. The fixed application envelope stays within the inclusive 2 MiB application-only bound. See [architecture](architecture.md#local-retry-history) for public metadata and lifetime limits; all uncertain-commit and no-stale-restore rules above remain unchanged.

## Internal snapshots and retry admission

`readRetrySnapshot` reads one existing guarded complete V2 store for the trusted caller’s selected key binding. It returns a copied deeply frozen DTO only after one coherent synchronous read transaction and successful handle closure/path checks. Coverage spans that binding’s local history across all budget scopes, periods and families. Holds, unambiguous accepted manifests, joined retry children in every state, unresolved unit/event history, legacy attribution gaps and ambiguous provider references remain explicit. Available does not mean source-ready or approved; provider-wide account coverage and unknown legacy ancestry remain unproven. Backlink URL manifests do not reconstruct target lists.

The reader opens without CREATE and sets `query_only=ON` before application queries. It inspects existing WAL mode without changing journal mode, repair or migration. Semantic read-only means no logical row/schema/event/reservation changes. SQLite may still write WAL/SHM bookkeeping or checkpoint main-file bytes, including on close, and requires writable private storage. Missing, V1, invalid, busy, unreadable or over-limit input yields a sanitized unavailable result without partial arrays or a revision.

The per-binding technical completeness ceilings are 2,000 intents, 6,000 events, 20,000 URL rows and 16 MiB retained UTF-8 projection/DTO bytes. They are resource bounds, not financial caps, retry allowances or migration/ordinary-write limits. Larger valid stores retain their records and ordinary behavior; snapshots return unavailable rather than a truncated available result.

Revision identity binds the ledger identity, selected binding and complete ordered core/context/URL/event projections, including reservations, ownership, state and ACK fields, with exact decimal integer text and stable BINARY row ordering. Private ownership digests participate only in hashing and never enter DTOs; the binding also stays out of the DTO. Capture time and unrelated-key writes do not change the revision. The manifest digest binds family and exact ordered submitted URL strings, preserving case and URL ordinals. Neither digest authenticates a caller or proves provider finality.

The separate trusted internal `openRetryLedgerV2` returns a retry-capable handle that its caller must close; the common public host interface stays unchanged. New `prepareRetryIntent` work recomputes the projection in its own writer transaction and requires the current revision, an unambiguous accepted local same-engine indexer parent, its exact manifest digest and an exact child-URL subset. Known own accepted retry children cannot become new parents. Preparation atomically records the core intent, retry relation, exact URL holds, event and independent period/unit reservations. No external/adopted source route or caller boolean grants authority here.

Existing exact retry replay matches the full ordinary identity plus retry parent, manifest and plan identity before current revision/resource/overlap/cap gates. It creates no event, reservation, context or replacement capability. Ordinary and retry entries reject mode crossover under the same request ID; ordinary legacy replay keeps its original unattributed context. Dispatching/unknown retry children without durable provider IDs block new retry admission, even for another parent; replay never resends. Prepared children retain their exact URL holds and all three unit reservations under the existing period/cap rules.

V2 accepted-outcome recording checks the owner token and state CAS before duplicate accepted binding/family/provider-reference and retry self-parent ACK guards. A failed association conservatively retains the dispatching context, URLs and three-unit holds without a partial accepted event. Retry state/provider IDs come from the durable core join, not a second ACK store. These local contracts supply no provider idempotency, fresh indexing truth, global account budget or permission to send a paid job. Public retry submission, parent adoption, one-shot execution and scheduling need separately accepted work. See [architecture](architecture.md) and the [implementation plan](implementation-plan.md).
