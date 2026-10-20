# Tests contract

## Purpose

Verify the public account, task-list, task-status, task-report, and stdio contracts using synthetic data.

## Ownership

HTTP fixtures, subprocess harnesses, CLI, provider, transport, the synthetic SQLite submission-ledger suite, and built-artifact tests.

## Local Contracts

Never call the live provider. All keys/data are dummy fixtures. Endpoint rewrites belong only to test preloads/injected fetch and use exact method/path allowlists for fixed account, list, status, and report reads. Report tests cover one POST only and one backlink page; preserve opaque URL strings and donor JSON. Bound async operations, synchronize cancellation on request arrival, and close listeners/processes. Built tests require the current build.

`submission-ledger.test.ts` uses only synthetic IDs, fingerprints, URLs, limits, and private temporary POSIX directories with real Bun SQLite. Its child fixture receives an empty allowlisted environment and uses READY/release messages; deadlines only bound hangs. Release or terminate and reap every child, close every database handle, then remove only the test-owned temporary tree. These cases prove local SQLite coordination and startup checks; they do not simulate provider HTTP or prove provider-side idempotency.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run test`; after `bun run build`, `bun run test:built`.

## Child DOX Index

None.
