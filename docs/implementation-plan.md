# Implementation plan

The Bun/TypeScript stdio foundation implements `get_balance`. The other 11 tools remain planned and unimplemented. No package or release is published.

| Order       | Planned tool            | Intended scope                                       |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Implemented | `get_balance`           | Read all three account wallets without creating jobs |
| Later       | `list_tasks`            | List existing tasks                                  |
| Later       | `get_task_status`       | Inspect task progress                                |
| Later       | `get_task_report`       | Retrieve task results                                |
| Later       | `create_indexing_task`  | Submit URLs for indexing                             |
| Later       | `create_index_check`    | Submit an index-status check                         |
| Later       | `create_backlink_check` | Submit a backlink check                              |
| Later       | `plan_retry`            | Prepare a retry proposal without submitting it       |
| Later       | `submit_retry`          | Submit an explicitly approved retry                  |
| Later       | `compare_reports`       | Compare task reports                                 |
| Later       | `summarize_campaigns`   | Summarize related task outcomes                      |
| Later       | `get_retry_history`     | Inspect recorded retry activity                      |

The current runtime exposes only `get_balance`. See [README.md](../README.md) for build/run commands and [architecture](architecture.md) for validation, cancellation, and error boundaries. Synthetic HTTP and real stdio tests exercise the provider contract and built CLI without live provider calls.

Later submissions and retries need explicit action boundaries, input validation, cost visibility, and protection against accidental duplicate jobs. Decide storage and reporting contracts in their own scoped work before promising persisted history or campaign behavior.

Robin review automation is installed on the default branch. Substantive changes require a real review of their exact head plus CI and delivery verification. The workflow excludes `synchronize`; later pushes need an authorized manual review within the task budget. Fork PR events lack repository secrets and need an authorized maintainer command through the default-branch workflow. Deployment, scheduling, and releases remain outside this foundation.
