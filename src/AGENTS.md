# Src contract

## Purpose

Serve read-only SpeedyIndex account balances over MCP stdio.

## Ownership

`cli.ts` owns arguments and transport; `server.ts` registers tools; `client.ts` owns HTTP/validation/errors; `tools/get-balance.ts` owns the public tool.

## Local Contracts

Use the fixed production HTTPS account endpoint and raw Authorization key. Keep stdout exclusively protocol except explicit help/version. No redirects, automated retries, paid operations, or raw error reflection. Pass SDK cancellation to fetch and retain the deadline. Keep CodeGraph outside runtime dependencies.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run test:built`.

## Child DOX Index

None.
