# Implementation plan

The Bun/TypeScript stdio server implements `get_balance`, `list_tasks`, `get_task_status`, `get_task_report`, `create_indexing_task`, guarded `create_index_check`, guarded `create_backlink_check`, read-only `plan_retry`, and local `get_retry_history`. Three further public tools remain planned and unimplemented. No package or release is published.

| Order       | Planned tool            | Intended scope                                       |
| ----------- | ----------------------- | ---------------------------------------------------- |
| Implemented | `get_balance`           | Read all three account wallets without creating jobs |
| Implemented | `list_tasks`            | Read one validated page of existing tasks            |
| Implemented | `get_task_status`       | Read existing task status by family and task ID      |
| Implemented | `get_task_report`       | Read one report; one bounded backlink page           |
| Implemented | `create_indexing_task`  | Pure preview; explicitly configured guarded indexing |
| Implemented | `create_index_check`    | Reservation preview; explicitly opted-in index check |
| Implemented | `create_backlink_check` | Reservation preview; guarded donor/target check      |
| Implemented | `plan_retry`            | Prepare a retry proposal without submitting it       |
| Later       | `submit_retry`          | Submit an explicitly approved retry                  |
| Later       | `compare_reports`       | Compare task reports                                 |
| Later       | `summarize_campaigns`   | Summarize related task outcomes                      |
| Implemented | `get_retry_history`     | Read recorded local V2 retry attempts                |

The current source tree exposes all nine implemented tools. Branch implementation and synthetic checks are not release or delivery evidence. Writes are disabled by default. Operators explicitly choose private policy/state paths, expected key binding and finite independent token/indexer/checker caps; no active configuration is selected here. Startup/create previews never open state; configured retry planning and history read existing complete V2 state, and only explicit local new-only V1/V2 init commands create it; explicit offline migration never runs at startup. See [README.md](../README.md) for setup and [architecture](architecture.md) for validation, cancellation and persistence boundaries. Synthetic HTTP, real SQLite/process tests and SDK source/built journeys exercise these contracts without live provider calls.

The optional private retry policy records trusted settings in immutable policy identity. `plan_retry` additionally requires matching enabled configuration and existing complete V2 state; the field alone supplies no verified observations or paid authority. External/legacy corpora need explicit private permission and retain unknown original ancestry. Planning adds no adopted parents, retry rows or reservations.

Index checks additionally require explicit permission and a private per-engine three-unit reservation profile. Missing profiles produce unpriced previews and block submission. Operator reservations are not provider fees; no actual prices, caps or activation values are selected here. All three create tools share the same host guard and versioned V1/V2 store.

Backlink checks require enabled configuration plus their own opt-in and complete private profile. Target lists preserve 1 to 50 safe strings, including duplicates and order; exact body identity includes the targets while V1 unresolved holds remain donor-wide across families. The dated local token floor is 2 per donor from the [official API](https://en.speedyindex.com/api.php#backlink-create); other unit fees and target-count pricing effects remain unknown. Invalid optional policy fields block all three create tools until corrected and all hosts restart. No activation values are selected here.

Standalone create uses immutable policy snapshots, UTC reservation periods, local request replay and retained uncertain holds. It does not supply provider idempotency, human authentication or campaign/parent lineage. The optional private retry policy records an attempt ceiling and external/legacy-adoption permission, but that permission is not evidence or admission. Later tools need their own action boundaries and source/eligibility proof. The internal V2 prerequisite implements strict versioned schema validation, new-only init, explicit guarded offline V1 migration/backup, atomic ordinary contexts and per-handle version/identity guards. Coherent bounded local snapshots, mode-separated atomic retry admission/replay and owner-first V2 duplicate/self-parent ACK association guards are implemented as trusted internal APIs. The original local-only admission entry requires a current selected-key revision and an exact unambiguous accepted local same-engine indexer parent/manifest/subset; unacknowledged dispatching/unknown retry children block new admission. These checks do not establish provider finality, external adoption or paid authority. Explicit V2 CLI maintenance and shared source/built three-create persistence, restart replay, unknown-hold and cross-family overlap journeys cover the complete local foundation. Ordinary public creates retain their identity/policy/body/quote/ACK contracts and add standalone contexts atomically in V2. Legacy ancestry stays unknown. Public planning uses these internal foundations; they supply no public retry submission or deterministic one-shot workflow. See [local state maintenance](state-maintenance.md) for offline/recovery constraints; never reset or restore stale V1 over new V2 activity.

## Retry planning and future execution

The internal observation/comparison core, production owner composition and public read-only `plan_retry` are implemented. Public `submit_retry` and one-shot execution remain unimplemented. The current `get_task_report` tool returns validated provider fields but does not establish report completeness or fresh indexing truth; the internal core adds finality and completeness checks above that public read contract. Implemented planning and remaining execution boundaries are:

- Select only the latest proven-final original indexing source for the selected engine, requiring Pay-Per-Result evidence for Google. Take candidates only from its final unindexed report; `processed == size` alone does not establish completion or a final report.
- Deduplicate exact URL strings, preserving query strings and trailing-slash semantics. Exclude any URL already present in any active regular or drip task, and never treat the workflow's own retry child as a new source.
- Preview the selected source, candidate URLs, skipped URLs with reasons, and estimated token cost before any provider write. Keep source selection, approval, submission, and observation as separate states.
- Require configured finite retry and token allowances before submission. No numeric retry or token budget is approved here.
- Build a one-shot deterministic core for MCP and later explicit scheduler invocation. This workflow has no runtime LLM or browser dependency. Neither that core nor scheduling is implemented or activated here.
- Reuse the local SQLite submission ledger for durable request identity, reservations and dispatch state, with separately accepted lineage and retry eligibility. Provider idempotency is not documented; current unknown/dispatching/prepared holds permit no automatic resend, expiry or release. A future retry tool must establish eligibility without bypassing those holds.
- Observe provider results separately from submission. A terminal provider result records that provider's outcome and does not establish fresh Google indexing truth.

## Local retry history

`get_retry_history` is implemented on this source branch through a pure projection, native query-only owner and ninth adapter on the configured host. The strict optional selectors choose both engines and 25 entries by default; parent requires an exact engine/ID, and cursors bind the query, limit and revision. Each call validates the complete selected-key V2 snapshot across scopes/families/policies/periods before returning recorded indexer retry contexts. The [public contract](../README.md#read-only-local-retry-history) preserves all six local states, counts, nullable terminal details, unknown ancestry/inception/provider-wide history and comparison-only refs. History does no provider observation, paid admission or logical write; the existing CLI loader still requires matching enabled configuration. Absent/disabled retry permission does not block it.

The owner captures one original pre-SQL budget, native closure, actual I/O cancellation delivery and awaited budget settlement before final publication/reuse. Opaque read failure conservatively disables only history until restart. The inclusive 2,097,152-byte application bound counts escaped text and duplicate structured content; logical read-only permits physical WAL/SHM bookkeeping. Missing/V1/empty and cursor refusals preserve their distinct outcomes without automatic init/migration or page recomputation.

Pure/native cases cover projection identity, metadata gaps, complete-audit/filter boundaries, cursor/revision semantics, exact escaped-byte limits, real SQLite close and owner settlement. Two saved protocol/entry preparation cases precede new helper use. Thirteen source/built SDK cases cover the strict nine-tool inventory, genuine six-state history/SQL oracles, finite states and continuation, source-only lower-limit error surfacing and actual queued cancellation/recovery. Built CLI cases retain real framing/EOF/reap/SQL evidence without injected owner phases. These tests do not establish a release or provider activation. Mandatory full candidate checks, exact-head review, pinned-runtime CI and delivery remain separate gates. Public retry dispatch, deterministic one-shot execution and scheduling remain unimplemented.

## Review and delivery

Robin review automation is installed on the default branch. Substantive changes require a real review of their exact head plus CI and delivery verification. The workflow excludes `synchronize`; later pushes need an authorized manual review within the task budget. Fork PR events lack repository secrets and need an authorized maintainer command through the default-branch workflow. Deployment, scheduling, and releases remain outside this foundation.

The internal verified-storage composition retains its parent-first controlled verifier constructor and now also supports production same-key latest-source/two-pass HTTP collection. The actual host guard covers planning and all three create strategies. One original pre-SQL horizon and initial UTC day enclose final readers, identity/serialization, private proof sealing and awaited native settlement/close. Real SQLite/native cases cover local/external proof consumption after measured no-write collection, revision/count/cap refusals, original-context contention and cleanup poison with preview/replay retained. Pure comparison identity grants no authority; public semantic replay validation and retry dispatch remain separate feature gates. See [architecture](architecture.md).

## Internal read-budget foundation (P1A)

The three internal task-read methods accept one optional trusted budget for shared entered-fetch attempts, decoded body bytes and a monotonic horizon. It retains charges across failures/repeats, bounds each request by remaining time, rejects overlap and awaits actual transport/body cleanup through an idempotent close receipt. Unexpected cleanup failure permanently poisons the budget. The original seven tools keep their existing schemas and wiring; `get_balance` uses its existing path. Native synthetic HTTP cases exercise the boundaries without provider access. Exact-head review, pinned-runtime CI and delivery verification remain required before acceptance.

## Internal observation and comparison core (P1B)

The internal collector and pure core now cover complete same-key three-stream/two-pass observations, exact source/corpus/exclusion rules, regular quotes and comparison preimages. Native synthetic HTTP tests cover inclusive pagination, reference/status/raw/request/retained limits, fixed failure mapping and actual collect/cancel/close settlement. Real private configuration and V2 query-only readers produce local and permitted external internal proposals; complete logical projections verify no planning writes or invented external parent. Pure identities use the existing fingerprint and final revision/period/lifetime/three-unit decisions. These internal cases retain their coverage alongside public planning and local history; three public tools remain unfinished.

Planner implementation and remaining acceptance gates:

- P1C/PR10/PR11: production ownership and native cases are implemented internally. Exact-head review, pinned-runtime CI and delivery acceptance remain required before closing the composed verifier/deadline gate.
- P2/PR01/PR08/PR09/PR12: implemented strict public error/no_source/blocked/ready and identity variants, application validation including `isError`, the inclusive complete-envelope 2,097,152-byte bound, shared eighth-tool source/built ready/finite journeys and source-fixture cancellation/recovery. Existing seven-tool regressions remain required. Full Stage1 acceptance, exact-head review, pinned-runtime CI and delivery gates are separate from implementation.
- SR-D01..03: later public identity tamper/replay-before-read validation, retry submission through the shared paid guard, one owner dispatch/outcome and deterministic one-shot execution.

Proposal/comparison data alone supplies no proof authority. The shared production owner keeps private evidence inside public planning. A ready result remains comparison data; public dispatch, one-shot execution and exact-head delivery require their own acceptance gates.
