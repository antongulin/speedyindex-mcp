# Src contract

## Purpose

Serve read-only SpeedyIndex account balances, task listings, task status, and task reports over MCP stdio.

## Ownership

`cli.ts` owns arguments and transport; `server.ts` registers tools; `client.ts` owns HTTP requests and client error mapping; `task-status.ts` owns task-status schemas, errors, and normalization; `task-report.ts` owns task-report schemas, errors, and normalization; `submission-ledger.ts` owns the internal local SQLite intent and reservation core; `tools/get-balance.ts`, `tools/list-tasks.ts`, `tools/get-task-status.ts`, and `tools/get-task-report.ts` own their public tools.

## Local Contracts

Use fixed production HTTPS endpoints and the raw Authorization key. `get_balance` reads the account endpoint; `list_tasks` reads one validated task-list page; `get_task_status` sends one JSON POST to one of six fixed read-only status routes. Validate one family and exactly one ID form, preserve opaque IDs, correlate returned roots by exact ID, and treat `unreturnedIds` as omissions from one response, not proof that tasks do not exist. `get_task_report` sends one JSON POST to one of six fixed report routes. Report IDs remain opaque and are correlated exactly. Generic reports return validated URL strings unchanged; backlink reports return one page with explicit page/limit defaults and opaque finite-JSON donor objects. Do not infer completeness or fresh indexing truth. Cap decoded response-body bytes at the compiled-in 16 MiB limit before JSON decoding. Keep stdout exclusively protocol except explicit help/version. No redirects, automated retries, paid operations, or raw error reflection. Pass SDK cancellation to fetch and retain the deadline. Keep CodeGraph outside runtime dependencies.

`submission-ledger.ts` is not imported by the server, CLI, or provider client. It stores local request digests, exact submitted URL strings, unit reservations, and safe state transitions; it does not store API keys, request bodies, titles, provider bodies, or provider error text. `initializeLedger` accepts only a new private state directory. `openLedger` accepts only an existing complete version-one database and never creates or repairs state. No runtime path, active allowance, operator configuration, or provider dispatch is selected here. The ledger coordinates only processes that share the same local database and credential fingerprint; it does not enforce provider-wide wallet limits or guarantee exactly-once jobs or power-loss durability.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
