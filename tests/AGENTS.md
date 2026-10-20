# Tests contract

## Purpose

Verify the public account, task-list, task-status, and stdio contracts using synthetic data.

## Ownership

HTTP fixtures, subprocess harnesses, CLI, provider, transport, and built-artifact tests.

## Local Contracts

Never call the live provider. All keys/data are dummy fixtures. Endpoint rewrites belong only to test preloads/injected fetch and use exact method/path allowlists for documented reads. Bound async operations, synchronize cancellation on request arrival, and close listeners/processes. Built tests require the current build.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run test`; after `bun run build`, `bun run test:built`.

## Child DOX Index

None.
