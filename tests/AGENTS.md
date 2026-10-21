# Tests contract

## Purpose

Verify the public account/task reads, guarded indexing, index-check and backlink-check reservations, local operator commands, and source/built stdio contracts using synthetic data.

## Ownership

HTTP fixtures, subprocess harnesses, CLI, provider, transport, pure create schemas/quotes, private policy loading, real SQLite/host process cases, and built-artifact tests.

## Local Contracts

Never call the live provider. All keys/data/caps are synthetic. Endpoint rewrites belong only to guarded test preloads/injected fetch: verify the original production HTTPS origin, method and exact allowed read/create route before rewriting to an owned literal loopback origin. Host tests install the strict nonloopback guard before constructing a default transport. Report tests cover one POST only and one backlink page; preserve opaque URL strings and donor JSON. Built tests require the current build.

`submission-ledger.test.ts` and the explicit `retry-ledger.test.ts` suite use only synthetic IDs, fingerprints, URLs, limits, and private temporary POSIX directories with real Bun SQLite. Their child fixtures receive allowlisted synthetic environments and use explicit readiness/phase barriers; deadlines only bound hangs. Release or terminate and reap every child, close every database handle, then remove only the test-owned temporary tree. These cases prove local SQLite coordination and startup checks; they do not simulate provider HTTP or prove provider-side idempotency.

`create-indexing-task.test.ts`, `create-index-check.test.ts`, `create-backlink-check.test.ts`, `submission-policy.test.ts` and `submission-host.test.ts` are explicit source-suite entries. Prefer their lowest useful layers over duplicating core invariants in stdio. Actual host crash/concurrency/persistence cases use real SQLite, owned HTTP receivers and phase barriers, not seeded-state claims of crash proof. Queued cancellation tests use real SDK frames/pipe flush and SQL locks; timing observations supply no hard latency guarantee. Source and built SDK cases list seven tools, validate the index-check/backlink quote unions and exercise exact replay. A checker cancellation after full POST receipt waits for durable outcome/close before inspecting all three held units and restart overlap; built writes use operator policy without acknowledgement, while the source SDK fixture injects a clock for current-acknowledgement coverage. SDK child stdout contains protocol frames only, with safe phase markers on stderr. Own result validation must cover `isError` application results; SDK-owned input rejection has a different boundary.

Backlink cases cover strict target text/count/body identity, whole-policy invalidation, admitted snapshot ownership, conservative ACKs and both legal unrecorded held-result shapes. Host tests use real private SQLite/owned receivers for donor-wide holds, shared three-unit sums/caps, busy gates and exact replay. Source SDK tests reuse the existing private controlled-clock fixture for current caller ACK and next-day no-ACK replay with unchanged tables. Built backlink writes use synthetic operator policy, verify exact wire/recorded acceptance, restart replay and supplied bad-ACK rejection with no extra POST. Preserve the existing six tool journeys and real-clock test allocation; no production clock/environment/endpoint selector.

Spawn children with Bun `--no-env-file` before the entrypoint and an allowlisted synthetic environment. MCP server children also use a private HOME and the guarded fetch preload; other fixtures must install a guard before constructing an HTTP transport. Register handles/SDK cleanup before startup serialization, reads or writes. Release all fences/locks, settle calls and receivers, attempt cleanup for every child with allSettled, kill only owned children (SIGKILL for stopped children), reap and close streams/databases/listeners before removing owned temporary roots. Preserve fixtures and fail on cleanup/receiver errors. No arbitrary sleeps for synchronization, live operator state, shared environment-file reads or network probes.

`retry-ledger.test.ts` covers strict V1/V2 initialization, guarded offline migration/backup, coherent bounded snapshots, exact revision/manifest identity and atomic retry admission/replay/ownership with independent integer/row/hash oracles. Real readiness/phase-barrier cases in `fixtures/retry-admission-child.ts` cover revision races, lock/cap gates, native prepare/outcome commit boundaries and cancellation/claim ownership. Preserve the corrected same-family cross-engine parent-conflict case, fresh-revision unknown-dispatch barrier, and owner-first duplicate/self-parent ACK guards. P0-03 planning-read cases add one pinned snapshot/period/cap/all-state exact-parent count view, a real second-connection barrier commit, exact aggregate usage above SQLite SUM range, current/stored-period checks and full logical nonmutation. P0-05 extends the existing local replay/state/mismatch fixtures through the narrow reader, including original policy comparison and lower full-projection limits; it supplies no public identity-preimage or external-proof coverage. Owned process fixtures prove native commit/rollback boundaries and durable uncertainty; they do not prove hardware/power-loss or provider exactly-once behavior. Shared V2-10 helpers run the same explicit maintenance grammar and three-create V2 persistence/replay SDK journey against source and current built CLI, including restart unknown holds and cross-family overlap. Failed new integration fixtures remain private for diagnosis after resource closure. Preserve old V1 identity/cancellation/policy tests; no production environment/CLI authority selectors.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run test`; after `bun run build`, `bun run test:built`.

## Child DOX Index

None.
