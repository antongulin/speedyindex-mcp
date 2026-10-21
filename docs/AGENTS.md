# Documentation contract

## Purpose

Maintain the roadmap, runtime architecture, dependency decisions, and source attribution.

## Ownership

`implementation-plan.md` owns proposed scope and delivery gates. `architecture.md` describes runtime boundaries; `dependencies.md` records compatibility decisions; [state-maintenance.md](state-maintenance.md) owns explicit V1/V2 commands, private backup and manual recovery boundaries. `provenance.md` owns documentation sources and revisions. `dox-LICENSE.txt` preserves the upstream notice verbatim.

## Local Contracts

Describe actual state accurately: four read tools and guarded `create_indexing_task`/`create_index_check`/`create_backlink_check` are implemented; five tools remain on the roadmap. Checker reservation profiles and explicit opt-in are optional private operator choices; reservations are not vendor fees, and missing profiles remain unpriced. All three create tools share unchanged V1/V2 caps/holds. Explicit offline migration preserves existing core history and marks legacy attribution unknown; internal retry APIs add no public tools or activation. Never restore stale V1 over any V2 activity, and distinguish missing receipts from failed commits. Default writes are disabled and previews need no key/state. Describe explicit private policy/new-only init, independent estimated caps, UTC reservation periods, immutable policy snapshots/restart, unresolved holds and synchronous SQL/cancellation limits without selecting operator values. Distinguish durable accepted state from an unrecorded ACK; do not imply provider idempotency, wallet enforcement, human authentication or V1 lineage. Preserve the normal-open WAL sidecar caveat. Document `get_task_report` as one fixed request and one bounded backlink page, without completeness or fresh indexing claims. Keep operational records, credentials, account data and machine-specific details out of public docs. Preserve source links, referral disclosure and license attribution.

Backlink documentation must distinguish donor URLs from 1 to 50 safe target strings (8,192 UTF-8 bytes each), preserve target case/order/duplicates without DNS normalization, and explain the 10,000-donor/2 MiB bounds. Full-body identity includes targets; V1 stores donor-wide unresolved holds without raw target lists/pairs. Submission needs enabled configuration plus its own opt-in and complete profile. Describe the dated 2-token local floor using the direct [official English API](https://en.speedyindex.com/api.php#backlink-create); other fees and target-count effects remain unknown. Explicit zero is a local operator choice, not a provider fee. Invalid optional fields block all three creates until corrected and all hosts restart. Both new keys absent preserve legacy identity; present false/profile values bind policy identity. Accepted acknowledges creation, not completed analysis. Select no default or active operator values.

## Work Guidance

Update the roadmap as verified behavior ships. Reconcile this contract and its parent index when documentation ownership changes.

## Verification

Check relative links, source revisions, and claims against the actual tree. Run `git diff --check`. Compare the DOX notice with its recorded source when updating attribution.

## Child DOX Index

None.
