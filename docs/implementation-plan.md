# Implementation plan

The Bun/TypeScript stdio server implements `get_balance`, `list_tasks`, `get_task_status`, `get_task_report`, `create_indexing_task`, and guarded `create_index_check`. The other six tools remain planned and unimplemented. No package or release is published.

| Order       | Planned tool            | Intended scope                                       |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Implemented | `get_balance`           | Read all three account wallets without creating jobs |
| Implemented | `list_tasks`            | Read one validated page of existing tasks            |
| Implemented | `get_task_status`       | Read existing task status by family and task ID      |
| Implemented | `get_task_report`       | Read one report; one bounded backlink page           |
| Implemented | `create_indexing_task`  | Pure preview; explicitly configured guarded indexing |
| Implemented | `create_index_check`    | Reservation preview; explicitly opted-in index check |
| Later       | `create_backlink_check` | Submit a backlink check                              |
| Later       | `plan_retry`            | Prepare a retry proposal without submitting it       |
| Later       | `submit_retry`          | Submit an explicitly approved retry                  |
| Later       | `compare_reports`       | Compare task reports                                 |
| Later       | `summarize_campaigns`   | Summarize related task outcomes                      |
| Later       | `get_retry_history`     | Inspect recorded retry activity                      |

The current runtime exposes all six implemented tools. Writes are disabled by default. Operators explicitly choose private policy/state paths, expected key binding and finite independent token/indexer/checker caps; no active configuration is selected here. Startup/preview never open state, and only the local new-only init command creates it. See [README.md](../README.md) for setup and [architecture](architecture.md) for validation, cancellation and persistence boundaries. Synthetic HTTP, real SQLite/process tests and SDK source/built journeys exercise these contracts without live provider calls.

Index checks additionally require explicit permission and a private per-engine three-unit reservation profile. Missing profiles produce unpriced previews and block submission. Operator reservations are not provider fees; no actual prices, caps or activation values are selected here. Both create tools share the same host guard and V1 store.

Standalone create uses immutable policy snapshots, UTC reservation periods, local request replay and retained uncertain holds. It does not supply provider idempotency, human authentication or campaign/parent lineage. Later tools need their own action boundaries and source/eligibility proof. An additive V2 relation table and explicit offline migration must preserve all V1 records, events, holds and dispatch ownership, leave unattributed legacy rows unknown, and insert new relations with preparation atomically. No V2 schema, migration or retry API is implemented; never reset V1 state to add lineage.

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
