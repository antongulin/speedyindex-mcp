# Src contract

## Purpose

Serve read-only SpeedyIndex account balances and task listings over MCP stdio.

## Ownership

`cli.ts` owns arguments and transport; `server.ts` registers tools; `client.ts` owns HTTP/validation/errors; `tools/get-balance.ts` and `tools/list-tasks.ts` own their public tools.

## Local Contracts

Use fixed production HTTPS endpoints and the raw Authorization key. `get_balance` reads the account endpoint; `list_tasks` reads one validated task-list page from a fixed provider route. Cap decoded response-body bytes at the compiled-in 16 MiB limit before JSON decoding. Keep stdout exclusively protocol except explicit help/version. No redirects, automated retries, paid operations, or raw error reflection. Pass SDK cancellation to fetch and retain the deadline. Keep CodeGraph outside runtime dependencies.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
