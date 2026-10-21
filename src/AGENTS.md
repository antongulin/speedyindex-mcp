# Src contract

## Purpose

Serve SpeedyIndex account/task reads and guarded indexing, index-check and backlink-check previews/submissions over MCP stdio.

## Ownership

`cli.ts` owns arguments, exclusive local fingerprint/init/migration modes, trusted configuration and transport; `server.ts` registers tools. `client.ts`, `task-status.ts` and `task-report.ts` own read HTTP, schemas and normalization. `submission-contract.ts` owns pure submission scalar/unit/authorization contracts and coordinator DTOs; `create-indexing-task.ts` retains their public indexing aliases and owns indexing schemas, frozen bodies, quotes and ACK classification. `create-index-check.ts` owns pure index-check input, reservation quotes, result validation and ACK classification; `create-backlink-check.ts` owns the corresponding backlink contracts with target counts. `submission-policy.ts` owns private policy loading and trusted context; `submission-host.ts` owns the shared coordinator, internal indexing, index-check and backlink-check strategies and guarded paid dispatch. `submission-ledger.ts` owns versioned V1/V2 SQLite validation, intent/reservation transactions and explicit guarded offline maintenance; `retry-ledger-snapshot.ts` owns internal scoped projection, frozen DTOs and exact revision hashes. The seven files under `tools/` own their public adapters.

## Local Contracts

Use fixed production HTTPS endpoints and the raw Authorization key. `get_balance` reads the account endpoint; `list_tasks` reads one validated task-list page; `get_task_status` sends one JSON POST to one of six fixed read-only status routes. Validate one family and exactly one ID form, preserve opaque IDs, correlate returned roots by exact ID, and treat `unreturnedIds` as omissions from one response, not proof that tasks do not exist. `get_task_report` sends one JSON POST to one of six fixed report routes. Report IDs remain opaque and are correlated exactly. Generic reports return validated URL strings unchanged; backlink reports return one page with explicit page/limit defaults and opaque finite-JSON donor objects. Do not infer completeness or fresh indexing truth. Cap read decoded response-body bytes at 16 MiB before JSON decoding. The read client has no paid method. Reject redirects, do not retry, pass SDK cancellation to fetch and retain the HTTP deadline. Keep CodeGraph outside runtime dependencies.

The submission host accepts only its loaded immutable trusted policy/key/state reference, with no MCP authority override. Preview performs pure validation/quoting without state or network. Submit opens existing complete V1 or V2, handles exact replay without dispatch, prepares/claims once, yields to actual I/O after prepare and claim, and checks cancellation before its single fixed-route POST. No SQL transaction spans an await. Enforce the separate 2 MiB request/64 KiB response bounds and strict root ACK identity. Record the outcome even after caller cancellation; distinguish unrecorded HTTP observations from durable state. Validate application error results locally because SDK output validation skips `isError`. Do not expose keys, credential fingerprints, paths, provider bodies/errors or raw capabilities/tokens.

All three create adapters use the same passed host and forward `context.mcpReq.signal`. Backlink admission requires enabled configuration, explicit `allowBacklinkChecks: true` and a complete private three-unit profile from the admitted snapshot; the key-free inactive view cannot override it. Tokens have a local 2026-10-21 floor of 2 per donor from the [official English API](https://en.speedyindex.com/api.php#backlink-create); other fees and target-count pricing effects remain unknown. Explicit zero in another unit is an operator reservation choice. Invalid new flag/profile fields block all three create tools until corrected and all hosts restart; both absent preserve legacy canonical identity, while present false/profile values bind policy identity.

Backlink target strings are 1 to 50 nonblank safe Unicode values up to 8,192 UTF-8 bytes each. Preserve case, spaces, order and exact duplicates without DNS parsing. Keep the 10,000 unique donor URL and 2 MiB whole-body limits. Serialize optional title, urls, then target_domains; bind the full body and both counts in the own quote. Preserve targetDomainCount through the structural coordinator DTO without widening older schemas. V1 holds only exact ordered donor URLs across target lists/families and stores no raw target list or pairs. Exact admitted replay precedes busy/current ACK and creates no new POST. Backlink ACKs need the exact family and conservative checker echoes; accepted denotes acknowledged creation, not completed analysis.

`submission-ledger.ts` stores request digests, exact private URL strings, unit reservations and state transitions, without keys, titles or raw bodies. Only explicit CLI init calls `initializeLedger` or `initializeLedgerV2` on a new private leaf; explicit offline `migrateLedgerV2` requires a new verified private backup before additive DDL. The host calls `openLedger` only on submit; normal open verifies complete V1/V2 before configuring WAL and never bootstraps, repairs or resets records. SQLite opening and reads can touch SHM bookkeeping even before version rejection. Unresolved holds persist. Synchronous SQL can delay stdio/cancellation; the HTTP deadline does not bound the whole tool. The ledger coordinates cooperating processes sharing one canonical local store/key/scope; it supplies no provider wallet cap, exactly-once guarantee, account identity or power-loss guarantee. Preserve exact V1 core identities/rows/events/ownership and grouped event validation. V2 ordinary context creation is atomic; legacy replay never acquires invented lineage. Internal retry snapshots/admission are separate from the common host interface and public tools. Keep transaction ownership in core, no async SQL or runtime authority selectors. Follow [maintenance](../docs/state-maintenance.md) for offline/uncertain-commit and no-restore boundaries.

Keep stdout exclusively MCP protocol except explicit help/version and local fingerprint/init/migration output. Fixed application errors must not reflect raw exceptions. No default paths/caps, environment-file loader, state initialization at startup, reload loop, reconciliation or scheduler. Restart all cooperating hosts after policy changes.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
