# Src contract

## Purpose

Serve SpeedyIndex account/task reads and guarded indexing previews/submissions over MCP stdio.

## Ownership

`cli.ts` owns arguments, local fingerprint/init modes, trusted configuration and transport; `server.ts` registers tools. `client.ts`, `task-status.ts` and `task-report.ts` own read HTTP, schemas and normalization. `create-indexing-task.ts` owns pure public schemas, frozen bodies, quotes and ACK classification; `submission-policy.ts` owns private policy loading and trusted context; `submission-host.ts` owns guarded paid dispatch. `submission-ledger.ts` owns the V1 SQLite intent/reservation core. The five files under `tools/` own their public adapters.

## Local Contracts

Use fixed production HTTPS endpoints and the raw Authorization key. `get_balance` reads the account endpoint; `list_tasks` reads one validated task-list page; `get_task_status` sends one JSON POST to one of six fixed read-only status routes. Validate one family and exactly one ID form, preserve opaque IDs, correlate returned roots by exact ID, and treat `unreturnedIds` as omissions from one response, not proof that tasks do not exist. `get_task_report` sends one JSON POST to one of six fixed report routes. Report IDs remain opaque and are correlated exactly. Generic reports return validated URL strings unchanged; backlink reports return one page with explicit page/limit defaults and opaque finite-JSON donor objects. Do not infer completeness or fresh indexing truth. Cap read decoded response-body bytes at 16 MiB before JSON decoding. The read client has no paid method. Reject redirects, do not retry, pass SDK cancellation to fetch and retain the HTTP deadline. Keep CodeGraph outside runtime dependencies.

The submission host accepts only its loaded immutable trusted policy/key/state reference, with no MCP authority override. Preview performs pure validation/quoting without state or network. Submit opens existing V1, handles exact replay without dispatch, prepares/claims once, yields to actual I/O after prepare and claim, and checks cancellation before its single fixed-route POST. No SQL transaction spans an await. Enforce the separate 2 MiB request/64 KiB response bounds and strict root ACK identity. Record the outcome even after caller cancellation; distinguish unrecorded HTTP observations from durable state. Validate application error results locally because SDK output validation skips `isError`. Do not expose keys, credential fingerprints, paths, provider bodies/errors or raw capabilities/tokens.

`submission-ledger.ts` stores request digests, exact private URL strings, unit reservations and state transitions, without keys, titles or raw bodies. Only explicit CLI init calls `initializeLedger` on a new private leaf. The host calls `openLedger` only on submit; normal open verifies V1 without bootstrap/repair/reset, but WAL configuration can touch sidecars even before schema rejection. Unresolved holds persist. Synchronous SQL can delay stdio/cancellation; the HTTP deadline does not bound the whole tool. The ledger coordinates cooperating processes sharing one canonical local store/key/scope; it supplies no provider wallet cap, exactly-once guarantee, account identity or power-loss guarantee. Preserve V1 without speculative lineage/migration code.

Keep stdout exclusively MCP protocol except explicit help/version and local fingerprint/init output. Fixed application errors must not reflect raw exceptions. No default paths/caps, environment-file loader, state initialization at startup, reload loop, reconciliation or scheduler. Restart all cooperating hosts after policy changes.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
