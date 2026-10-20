# Implementation plan

The repository is a foundation in development. All 12 tools below are planned and unimplemented; there is no application runtime or published package.

| Order | Planned tool | Intended scope |
| --- | --- | --- |
| First | `get_balance` | Read account balances without creating jobs |
| Later | `list_tasks` | List existing tasks |
| Later | `get_task_status` | Inspect task progress |
| Later | `get_task_report` | Retrieve task results |
| Later | `create_indexing_task` | Submit URLs for indexing |
| Later | `create_index_check` | Submit an index-status check |
| Later | `create_backlink_check` | Submit a backlink check |
| Later | `plan_retry` | Prepare a retry proposal without submitting it |
| Later | `submit_retry` | Submit an explicitly approved retry |
| Later | `compare_reports` | Compare task reports |
| Later | `summarize_campaigns` | Summarize related task outcomes |
| Later | `get_retry_history` | Inspect recorded retry activity |

The first usable implementation should expose only `get_balance`. Verify the official API contract before implementation, keep credentials out of protocol output and logs, and test the real MCP transport against controlled local fixtures. Document validated setup and usage only after they work.

Later submissions and retries need explicit action boundaries, input validation, cost visibility, and protection against accidental duplicate jobs. Decide storage and reporting contracts in their own scoped work before promising persisted history or campaign behavior.

Establish repository review automation in a separate bootstrap PR before substantive code. The minimal bootstrap uses lead review and available checks under the bootstrap exception. PR-triggered reviews can run before the workflow reaches the default branch; command-triggered reviews require it on the default branch. With `synchronize` excluded, substantive follow-up pushes require an authorized manual `/robin` within the task review budget. Fork PR events lack repository secrets and need an authorized maintainer command through that default-branch workflow. Substantive code must subsequently receive a real Robin review of its exact head. Deployment, scheduling, and releases are outside this foundation's scope.
