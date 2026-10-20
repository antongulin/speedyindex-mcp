# Implementation plan

The Bun/TypeScript stdio foundation implements `get_balance`, `list_tasks`, `get_task_status`, and `get_task_report`. The other 8 tools remain planned and unimplemented. No package or release is published.

| Order       | Planned tool            | Intended scope                                       |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Implemented | `get_balance`           | Read all three account wallets without creating jobs |
| Implemented | `list_tasks`            | Read one validated page of existing tasks            |
| Implemented | `get_task_status`       | Read existing task status by family and task ID      |
| Implemented | `get_task_report`       | Read one report; one bounded backlink page           |
| Later       | `create_indexing_task`  | Submit URLs for indexing                             |
| Later       | `create_index_check`    | Submit an index-status check                         |
| Later       | `create_backlink_check` | Submit a backlink check                              |
| Later       | `plan_retry`            | Prepare a retry proposal without submitting it       |
| Later       | `submit_retry`          | Submit an explicitly approved retry                  |
| Later       | `compare_reports`       | Compare task reports                                 |
| Later       | `summarize_campaigns`   | Summarize related task outcomes                      |
| Later       | `get_retry_history`     | Inspect recorded retry activity                      |

The current runtime exposes all four implemented tools. See [README.md](../README.md) for build/run commands and [architecture](architecture.md) for validation, cancellation, and error boundaries. Synthetic HTTP and real stdio tests exercise the provider contract and built CLI without live provider calls.

Later submissions and retries need explicit action boundaries, input validation, cost visibility, and protection against accidental duplicate jobs. The internal ledger establishes local request and reservation state; tool-specific policy, quote, lineage, and campaign-reporting contracts still need scoped work.

## Planned retry workflow

This workflow is unimplemented and not activated. The current `get_task_report` tool returns validated provider fields but does not establish report completeness or fresh indexing truth; defining how a final report is selected remains separate work. The intended behavior is:

- Select only the latest completed Pay-Per-Result indexing source. Take candidates only from its final unindexed report; `processed == size` alone does not establish completion or a final report.
- Deduplicate exact URL strings, preserving query strings and trailing-slash semantics. Exclude any URL already present in any active regular or drip task, and never treat the workflow's own retry child as a new source.
- Preview the selected source, candidate URLs, skipped URLs with reasons, and estimated token cost before any provider write. Keep source selection, approval, submission, and observation as separate states.
- Require configured finite retry and token allowances before submission. No numeric retry or token budget is approved here.
- Use a one-shot deterministic core shared by MCP and the existing scheduler. No LLM, browser, or extra service is required at runtime; this foundation adds no scheduler or activated schedule.
- Use the internal local SQLite submission-ledger prerequisite for durable request identity, reservations, and dispatch state. The current runtime does not open or initialize it. Provider idempotency is not documented, so a later tool contract must resolve unknown outcomes before retrying a submission.
- Observe provider results separately from submission. A terminal provider result records that provider's outcome and does not establish fresh Google indexing truth.

## Review and delivery

Robin review automation is installed on the default branch. Substantive changes require a real review of their exact head plus CI and delivery verification. The workflow excludes `synchronize`; later pushes need an authorized manual review within the task budget. Fork PR events lack repository secrets and need an authorized maintainer command through the default-branch workflow. Deployment, scheduling, and releases remain outside this foundation.
