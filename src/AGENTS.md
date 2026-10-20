# Src contract

## Purpose

Serve read-only SpeedyIndex account balances, task listings, and task status over MCP stdio.

## Ownership

`cli.ts` owns arguments and transport; `server.ts` registers tools; `client.ts` owns HTTP/validation/errors; `task-status.ts` owns task-status schemas, errors, and normalization; `tools/get-balance.ts`, `tools/list-tasks.ts`, and `tools/get-task-status.ts` own their public tools.

## Local Contracts

Use fixed production HTTPS endpoints and the raw Authorization key. `get_balance` reads the account endpoint; `list_tasks` reads one validated task-list page; `get_task_status` sends one JSON POST to one of six fixed read-only status routes. Validate one family and exactly one ID form, preserve opaque IDs, correlate returned roots by exact ID, and omit unreturned records without claiming they do not exist. Cap decoded response-body bytes at the compiled-in 16 MiB limit before JSON decoding. Keep stdout exclusively protocol except explicit help/version. No redirects, automated retries, paid operations, or raw error reflection. Pass SDK cancellation to fetch and retain the deadline. Keep CodeGraph outside runtime dependencies.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
