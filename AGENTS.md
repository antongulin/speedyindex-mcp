# SpeedyIndex MCP — agent contract

## Purpose

Build an unofficial MCP integration for SpeedyIndex. The Bun/TypeScript stdio server exposes four read tools and guarded `create_indexing_task`/`create_index_check`/`create_backlink_check` tools; five tools remain roadmap work.

## Ownership

This root owns project scope, public status, licensing, and the DOX hierarchy. `docs/` owns architecture, dependency notes, roadmap, and provenance; `.github/` owns CI, review automation, and contribution templates. `src/` owns runtime code and `tests/` owns deterministic Bun verification. Root also owns package/build/tooling and community documentation.

## Local Contracts

- This root and its child contracts provide the repository guidance for contributors; access to maintainer-only references is not required. Maintainer agents also follow `~/.agents/instructions/WORKFLOW.md` when installed or provided. The [private baseline workflow](https://github.com/antongulin/baseline/blob/main/baseline/02-agents.md) is a restricted maintainer reference requiring access. Current explicit task instructions and higher-priority platform rules control.
- Read this root and every applicable child `AGENTS.md` before editing. The nearest contract controls local details without weakening the shared DOX discipline.
- Keep roadmap features separate from implemented behavior. `get_balance`, `list_tasks`, `get_task_status`, `get_task_report`, `create_indexing_task`, `create_index_check`, and `create_backlink_check` are implemented; five other tools require later scoped work. No scheduler or public retry/lineage workflow is activated.
- Submission writes are disabled by default. Preview opens no state and requires no key. Operators explicitly select a private policy, finite independent three-unit caps, expected key binding and canonical state reference; the repository supplies no active values or default paths. Only explicit local new-only init commands create V1 or V2 state. Offline migration requires explicit private paths, a new private backup and draining/stopping all cooperating hosts. Normal submit opens existing state without repair or reset. Policy changes require restarting all cooperating hosts.
- Index checks require explicit private opt-in and selected per-engine three-unit reservation profiles. Missing profiles are unpriced and block submission. Operator reservations are not provider fees. All three create tools share one host coordinator, busy guard and V1 caps/holds; absent policy extensions preserve legacy identity.
- Backlink checks require `enabled: true`, additional explicit private `allowBacklinkChecks: true` and a complete `backlinkCheckReservations` vector. Tokens have a dated local floor of 2 per donor; other-unit fees and target-count pricing effects remain unknown. Explicit zero in another unit is an operator reservation choice, not a zero-fee claim. No active/default values ship. Invalid optional flag/profile fields invalidate the whole policy and block all three create tools until corrected and all cooperating hosts restart. Both new keys absent preserve legacy identity; present false/profile values bind the whole policy digest.
- An optional strict private `retry` object contains exactly `enabled`, `allowUnattributedParents`, and positive safe-integer `maxAttemptsPerSource`. Include it in policy identity only when present; absence preserves the exact legacy digest, and present false/other values bind identity. Malformed retry data invalidates the whole policy and blocks all three create tools. This field alone is only a private prerequisite: it supplies no source verification or public `plan_retry`/`submit_retry` capability.
- Preserve backlink target text (1 to 50 nonblank safe Unicode strings, at most 8,192 UTF-8 bytes each), including case, order and exact duplicates; no DNS normalization. Enforce 10,000 unique donor URLs and a 2 MiB full-body bound. The digest binds targets, while V1 stores ordered donor URLs as unresolved holds across target lists and families, without raw targets, pair rows or schema growth. Durable accepted means acknowledged job creation, not task completion.
- Preserve the V1 ledger and read client boundaries. Local request IDs and acknowledgement hashes provide no provider idempotency, account identity or human authentication. Prepared/dispatching/unknown holds need manual inspection; no automatic release or resend. Explicit offline V1→V2 migration preserves core records/ownership/holds and adds unattributed legacy contexts. Internal V2 snapshots and atomic retry admission are implemented without public tools or automatic retry. Snapshots cover only the selected key’s local history across budget scopes/families; legacy ancestry and provider-wide coverage remain unknown. The original local-only retry entry requires current revision and an exact unambiguous local same-engine indexer parent/manifest/subset. Unacknowledged dispatching/unknown retry children block new retry admission; exact replay grants no replacement capability. These checks supply no source eligibility, adoption or paid authority. Never restore stale V1 over new V2 activity; follow the maintenance guide.
- The separate internal verified-storage composition captures immutable trusted configuration/verifier/clocks and consumes per-composition opaque proofs only after the existing SQL lock and exact replay. Controlled fixtures prove permitted external child/context insertion without parent invention. Current bound valid policies retain original exact replay even with retry permission absent/disabled. New work enforces report bounds, provenance, complete revision/count/period/cap/hold checks and post-lock/pre-insert freshness; collection and an own writer mutually exclude each other. The production same-key latest-source/two-pass HTTP verifier, public planner/submit and one-shot remain absent. Pure public-safe identity must remain callable without minting authority; hashes cannot reconstruct discarded historical evidence.
- Keep public documentation free of credentials, account data, private task records, and machine-specific paths. Provider calls and paid submissions require task-specific authority.
- For public links to SpeedyIndex or its signup flow, use the [SpeedyIndex referral link](https://app.speedyindex.com/r/zqgax9) and disclose that it may support project maintenance. Keep the official [account API page](https://app.speedyindex.com/cabinet/api) and [public API reference](https://en.speedyindex.com/api.php) direct; do not use the referral URL for technical documentation or API endpoints.
- Adapted DOX guidance is credited in [provenance](docs/provenance.md); preserve the [upstream MIT notice](docs/dox-LICENSE.txt).

CodeGraph initialization is authorized here after source exists: inspect installed help, then run `CODEGRAPH_TELEMETRY=0 codegraph init .` and `sync` after source changes. Keep `.codegraph/` ignored; exclude dependencies/build output. Use actual call/impact and affected-test queries, verifying findings in source. Do not install or upgrade CodeGraph. Its committed MCP configuration is for source navigation only.

## Work Guidance

After meaningful changes, reconcile affected contracts, public documentation, and parent/child indexes. Put stable rules here and run evidence in task records. Add child contracts when real ownership boundaries emerge. Preserve unrelated work.

## Verification

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`, `bun run build`, and `bun run test:built`. Tests use synthetic local fixtures only. Check workflows with actionlint, documentation links, and `git diff --check`. Preserve `docs/dox-LICENSE.txt` verbatim, including its upstream final blank line.

## Child DOX Index

| Contract                               | Scope                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| [src/AGENTS.md](src/AGENTS.md)         | Runtime and provider contracts                                                         |
| [tests/AGENTS.md](tests/AGENTS.md)     | Synthetic HTTP and stdio verification                                                  |
| [docs/AGENTS.md](docs/AGENTS.md)       | Architecture, state maintenance, dependencies, roadmap, provenance, and license notice |
| [.github/AGENTS.md](.github/AGENTS.md) | CI, review configuration, and contribution templates                                   |
