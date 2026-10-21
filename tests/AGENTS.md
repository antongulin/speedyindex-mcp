# Tests contract

## Purpose

Verify the public account/task reads, guarded indexing, local operator commands, and source/built stdio contracts using synthetic data.

## Ownership

HTTP fixtures, subprocess harnesses, CLI, provider, transport, pure create schemas/quotes, private policy loading, real SQLite/host process cases, and built-artifact tests.

## Local Contracts

Never call the live provider. All keys/data/caps are synthetic. Endpoint rewrites belong only to guarded test preloads/injected fetch: verify the original production HTTPS origin, method and exact allowed read/create route before rewriting to an owned literal loopback origin. Host tests install the strict nonloopback guard before constructing a default transport. Report tests cover one POST only and one backlink page; preserve opaque URL strings and donor JSON. Built tests require the current build.

`submission-ledger.test.ts` uses only synthetic IDs, fingerprints, URLs, limits, and private temporary POSIX directories with real Bun SQLite. Its child fixture receives an empty allowlisted environment and uses READY/release messages; deadlines only bound hangs. Release or terminate and reap every child, close every database handle, then remove only the test-owned temporary tree. These cases prove local SQLite coordination and startup checks; they do not simulate provider HTTP or prove provider-side idempotency.

`create-indexing-task.test.ts`, `submission-policy.test.ts` and `submission-host.test.ts` are explicit source-suite entries. Prefer their lowest useful layers over duplicating core invariants in stdio. Actual host crash/concurrency/persistence cases use real SQLite, owned HTTP receivers and phase barriers, not seeded-state claims of crash proof. Queued cancellation tests use real SDK frames/pipe flush and SQL locks; timing observations supply no hard latency guarantee. SDK child stdout contains protocol frames only, with safe phase markers on stderr. Own result validation must cover `isError` application results; SDK-owned input rejection has a different boundary.

Spawn children with Bun `--no-env-file` before the entrypoint and an allowlisted synthetic environment. MCP server children also use a private HOME and the guarded fetch preload; other fixtures must install a guard before constructing an HTTP transport. Register handles/SDK cleanup before startup serialization, reads or writes. Release all fences/locks, settle calls and receivers, attempt cleanup for every child with allSettled, kill only owned children (SIGKILL for stopped children), reap and close streams/databases/listeners before removing owned temporary roots. Preserve fixtures and fail on cleanup/receiver errors. No arbitrary sleeps for synchronization, live operator state, shared environment-file reads or network probes.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run test`; after `bun run build`, `bun run test:built`.

## Child DOX Index

None.
