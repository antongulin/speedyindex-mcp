# Tests contract

## Purpose

Verify the public account and stdio contracts using synthetic data.

## Ownership

HTTP fixtures, subprocess harnesses, CLI, provider, transport, and built-artifact tests.

## Local Contracts

Never call the live provider. All keys/data are dummy fixtures. Any endpoint rewrite belongs only to test preloads/injected fetch. Bound async operations, synchronize cancellation on request arrival, and close listeners/processes. Built tests require the current build.

## Work Guidance

Reconcile affected contracts and verify behavior through public boundaries.

## Verification

`bun run test`; after `bun run build`, `bun run test:built`.

## Child DOX Index

None.
