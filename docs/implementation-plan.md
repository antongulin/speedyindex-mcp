# Implementation plan

The Bun/TypeScript stdio server implements `get_balance`, `list_tasks`, `get_task_status`, `get_task_report`, `create_indexing_task`, guarded `create_index_check`, and guarded `create_backlink_check`. The other five tools remain planned and unimplemented. No package or release is published.

| Order       | Planned tool            | Intended scope                                       |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Implemented | `get_balance`           | Read all three account wallets without creating jobs |
| Implemented | `list_tasks`            | Read one validated page of existing tasks            |
| Implemented | `get_task_status`       | Read existing task status by family and task ID      |
| Implemented | `get_task_report`       | Read one report; one bounded backlink page           |
| Implemented | `create_indexing_task`  | Pure preview; explicitly configured guarded indexing |
| Implemented | `create_index_check`    | Reservation preview; explicitly opted-in index check |
| Implemented | `create_backlink_check` | Reservation preview; guarded donor/target check      |
| Later       | `plan_retry`            | Prepare a retry proposal without submitting it       |
| Later       | `submit_retry`          | Submit an explicitly approved retry                  |
| Later       | `compare_reports`       | Compare task reports                                 |
| Later       | `summarize_campaigns`   | Summarize related task outcomes                      |
| Later       | `get_retry_history`     | Inspect recorded retry activity                      |

The current runtime exposes all seven implemented tools. Writes are disabled by default. Operators explicitly choose private policy/state paths, expected key binding and finite independent token/indexer/checker caps; no active configuration is selected here. Startup/preview never open state, and only explicit local new-only V1/V2 init commands create it; explicit offline migration never runs at startup. See [README.md](../README.md) for setup and [architecture](architecture.md) for validation, cancellation and persistence boundaries. Synthetic HTTP, real SQLite/process tests and SDK source/built journeys exercise these contracts without live provider calls.

Index checks additionally require explicit permission and a private per-engine three-unit reservation profile. Missing profiles produce unpriced previews and block submission. Operator reservations are not provider fees; no actual prices, caps or activation values are selected here. All three create tools share the same host guard and versioned V1/V2 store.

Backlink checks require enabled configuration plus their own opt-in and complete private profile. Target lists preserve 1 to 50 safe strings, including duplicates and order; exact body identity includes the targets while V1 unresolved holds remain donor-wide across families. The dated local token floor is 2 per donor from the [official API](https://en.speedyindex.com/api.php#backlink-create); other unit fees and target-count pricing effects remain unknown. Invalid optional policy fields block all three create tools until corrected and all hosts restart. No activation values are selected here.

Standalone create uses immutable policy snapshots, UTC reservation periods, local request replay and retained uncertain holds. It does not supply provider idempotency, human authentication or campaign/parent lineage. Later tools need their own action boundaries and source/eligibility proof. The internal V2 prerequisite implements strict versioned schema validation, new-only init, explicit guarded offline V1 migration/backup, atomic ordinary contexts and per-handle version/identity guards. Coherent bounded local snapshots, mode-separated atomic retry admission/replay and owner-first V2 duplicate/self-parent ACK association guards are implemented as trusted internal APIs. Admission requires a current selected-key revision and an exact unambiguous accepted local same-engine indexer parent/manifest/subset; unacknowledged dispatching/unknown retry children block new admission. These checks do not establish provider finality, external adoption or paid authority. Explicit V2 CLI maintenance and shared source/built three-create persistence, restart replay, unknown-hold and cross-family overlap journeys cover the complete local foundation. Ordinary public creates retain their identity/policy/body/quote/ACK contracts and add standalone contexts atomically in V2. Legacy ancestry stays unknown. No public retry/planner tool or deterministic one-shot workflow is supplied by these internal APIs. See [local state maintenance](state-maintenance.md) for offline/recovery constraints; never reset or restore stale V1 over new V2 activity.

## Planned retry workflow

This workflow is unimplemented and not activated. The current `get_task_report` tool returns validated provider fields but does not establish report completeness or fresh indexing truth; defining how a final report is selected remains separate work. The intended behavior is:

- Select only the latest completed Pay-Per-Result indexing source. Take candidates only from its final unindexed report; `processed == size` alone does not establish completion or a final report.
- Deduplicate exact URL strings, preserving query strings and trailing-slash semantics. Exclude any URL already present in any active regular or drip task, and never treat the workflow's own retry child as a new source.
- Preview the selected source, candidate URLs, skipped URLs with reasons, and estimated token cost before any provider write. Keep source selection, approval, submission, and observation as separate states.
- Require configured finite retry and token allowances before submission. No numeric retry or token budget is approved here.
- Build a one-shot deterministic core for MCP and later explicit scheduler invocation. This workflow has no runtime LLM or browser dependency. Neither that core nor scheduling is implemented or activated here.
- Reuse the local SQLite submission ledger for durable request identity, reservations and dispatch state, with separately accepted lineage and retry eligibility. Provider idempotency is not documented; current unknown/dispatching/prepared holds permit no automatic resend, expiry or release. A future retry tool must establish eligibility without bypassing those holds.
- Observe provider results separately from submission. A terminal provider result records that provider's outcome and does not establish fresh Google indexing truth.

## Review and delivery

Robin review automation is installed on the default branch. Substantive changes require a real review of their exact head plus CI and delivery verification. The workflow excludes `synchronize`; later pushes need an authorized manual review within the task budget. Fork PR events lack repository secrets and need an authorized maintainer command through the default-branch workflow. Deployment, scheduling, and releases remain outside this foundation.
