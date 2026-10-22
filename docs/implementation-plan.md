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

The optional private retry policy is an internal prerequisite field only. It records trusted workflow settings in immutable policy identity, but alone supplies no source verification or `plan_retry`/`submit_retry` tool; the public runtime remains at seven tools.

Index checks additionally require explicit permission and a private per-engine three-unit reservation profile. Missing profiles produce unpriced previews and block submission. Operator reservations are not provider fees; no actual prices, caps or activation values are selected here. All three create tools share the same host guard and versioned V1/V2 store.

Backlink checks require enabled configuration plus their own opt-in and complete private profile. Target lists preserve 1 to 50 safe strings, including duplicates and order; exact body identity includes the targets while V1 unresolved holds remain donor-wide across families. The dated local token floor is 2 per donor from the [official API](https://en.speedyindex.com/api.php#backlink-create); other unit fees and target-count pricing effects remain unknown. Invalid optional policy fields block all three create tools until corrected and all hosts restart. No activation values are selected here.

Standalone create uses immutable policy snapshots, UTC reservation periods, local request replay and retained uncertain holds. It does not supply provider idempotency, human authentication or campaign/parent lineage. The optional private retry policy can record a future attempt ceiling and external/legacy-adoption permission, but that permission is not evidence or admission. Later tools need their own action boundaries and source/eligibility proof. The internal V2 prerequisite implements strict versioned schema validation, new-only init, explicit guarded offline V1 migration/backup, atomic ordinary contexts and per-handle version/identity guards. Coherent bounded local snapshots, mode-separated atomic retry admission/replay and owner-first V2 duplicate/self-parent ACK association guards are implemented as trusted internal APIs. The original local-only admission entry requires a current selected-key revision and an exact unambiguous accepted local same-engine indexer parent/manifest/subset; unacknowledged dispatching/unknown retry children block new admission. These checks do not establish provider finality, external adoption or paid authority. Explicit V2 CLI maintenance and shared source/built three-create persistence, restart replay, unknown-hold and cross-family overlap journeys cover the complete local foundation. Ordinary public creates retain their identity/policy/body/quote/ACK contracts and add standalone contexts atomically in V2. Legacy ancestry stays unknown. No public retry/planner tool or deterministic one-shot workflow is supplied by these internal APIs. See [local state maintenance](state-maintenance.md) for offline/recovery constraints; never reset or restore stale V1 over new V2 activity.

## Planned retry workflow

The internal observation and comparison slice below is implemented. The public workflow and production proof composition remain unimplemented and inactive. The current `get_task_report` tool returns validated provider fields but does not establish report completeness or fresh indexing truth; the internal core adds finality and completeness checks above that public read contract. The intended behavior is:

- Select only the latest completed Pay-Per-Result indexing source. Take candidates only from its final unindexed report; `processed == size` alone does not establish completion or a final report.
- Deduplicate exact URL strings, preserving query strings and trailing-slash semantics. Exclude any URL already present in any active regular or drip task, and never treat the workflow's own retry child as a new source.
- Preview the selected source, candidate URLs, skipped URLs with reasons, and estimated token cost before any provider write. Keep source selection, approval, submission, and observation as separate states.
- Require configured finite retry and token allowances before submission. No numeric retry or token budget is approved here.
- Build a one-shot deterministic core for MCP and later explicit scheduler invocation. This workflow has no runtime LLM or browser dependency. Neither that core nor scheduling is implemented or activated here.
- Reuse the local SQLite submission ledger for durable request identity, reservations and dispatch state, with separately accepted lineage and retry eligibility. Provider idempotency is not documented; current unknown/dispatching/prepared holds permit no automatic resend, expiry or release. A future retry tool must establish eligibility without bypassing those holds.
- Observe provider results separately from submission. A terminal provider result records that provider's outcome and does not establish fresh Google indexing truth.

## Review and delivery

Robin review automation is installed on the default branch. Substantive changes require a real review of their exact head plus CI and delivery verification. The workflow excludes `synchronize`; later pushes need an authorized manual review within the task budget. Fork PR events lack repository secrets and need an authorized maintainer command through the default-branch workflow. Deployment, scheduling, and releases remain outside this foundation.

The separate internal verified-storage prerequisite now composes immutable trusted configuration, verifier and clocks with opaque per-composition proofs. Synthetic verifier fixtures prove real external child insertion without a parent row, replay-first behavior, locked freshness/count/cap/overlap gates and representative native races. The same boundary still needs its production same-key latest-source/two-pass HTTP verifier before public planning or submission. Pure public-safe identity is available independently of proof collection; public semantic replay validation remains a later feature gate. The storage prerequisite and internal collector do not supply their production proof/reader/guard assembly, shared paid host guard or one-shot integration. See [architecture](architecture.md).

## Internal read-budget foundation (P1A)

The three internal task-read methods accept one optional trusted budget for shared entered-fetch attempts, decoded body bytes and a monotonic horizon. It retains charges across failures/repeats, bounds each request by remaining time, rejects overlap and awaits actual transport/body cleanup through an idempotent close receipt. Unexpected cleanup failure permanently poisons the budget. The seven public tools keep their existing schemas and wiring; `get_balance` uses its existing path. Native synthetic HTTP cases exercise the boundaries without provider access. Exact-head review, pinned-runtime CI and delivery verification remain required before acceptance.

## Internal observation and comparison core (P1B)

The internal collector and pure core now cover complete same-key three-stream/two-pass observations, exact source/corpus/exclusion rules, regular quotes and comparison preimages. Native synthetic HTTP tests cover inclusive pagination, reference/status/raw/request/retained limits, fixed failure mapping and actual collect/cancel/close settlement. Real private configuration and V2 query-only readers produce local and permitted external internal proposals; complete logical projections verify no planning writes or invented external parent. Pure identities use the existing fingerprint and final revision/period/lifetime/three-unit decisions. Seven public tools remain registered; five tools remain unfinished.

The remaining planner gates stay open:

- P1C/PR10/PR11: configured production ownership with the same initial/final readers, one original horizon, actual collection/writer exclusion through awaited close, fresh SQL/CPU/UTC checks and sealed proof assembly. Require genuine production-composed local and external ready/proof/no-write journeys.
- P2/PR01/PR08/PR09/PR12: strict public error/no_source/blocked/ready and identity variants, application validation including `isError`, the entire text-plus-structured 2 MiB bound and eighth-tool source/built journeys with existing seven-tool regressions.
- SR-D01..03: later public identity tamper/replay-before-read validation, shared paid guard, one owner dispatch/outcome and deterministic one-shot execution.

The internal proposal and comparison are not production ready or proof authority. P1B does not close these later gates, register a tool or activate a workflow.
