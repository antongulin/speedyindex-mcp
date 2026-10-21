# Documentation contract

## Purpose

Maintain the roadmap, runtime architecture, dependency decisions, and source attribution.

## Ownership

`implementation-plan.md` owns proposed scope and delivery gates. `architecture.md` describes runtime boundaries; `dependencies.md` records compatibility decisions. `provenance.md` owns documentation sources and revisions. `dox-LICENSE.txt` preserves the upstream notice verbatim.

## Local Contracts

Describe actual state accurately: four read tools and guarded `create_indexing_task`/`create_index_check` are implemented; six tools remain on the roadmap. Checker reservation profiles and explicit opt-in are optional private operator choices; reservations are not vendor fees, and missing profiles remain unpriced. Both create tools share V1 caps/holds. Default writes are disabled and previews need no key/state. Describe explicit private policy/new-only init, independent estimated caps, UTC reservation periods, immutable policy snapshots/restart, unresolved holds and synchronous SQL/cancellation limits without selecting operator values. Distinguish durable accepted state from an unrecorded ACK; do not imply provider idempotency, wallet enforcement, human authentication or V1 lineage. Preserve the normal-open WAL sidecar caveat. Document `get_task_report` as one fixed request and one bounded backlink page, without completeness or fresh indexing claims. Keep operational records, credentials, account data and machine-specific details out of public docs. Preserve source links, referral disclosure and license attribution.

## Work Guidance

Update the roadmap as verified behavior ships. Reconcile this contract and its parent index when documentation ownership changes.

## Verification

Check relative links, source revisions, and claims against the actual tree. Run `git diff --check`. Compare the DOX notice with its recorded source when updating attribution.

## Child DOX Index

None.
