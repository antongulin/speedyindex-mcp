# SpeedyIndex MCP — agent contract

## Purpose

Build an unofficial MCP integration for SpeedyIndex. The Bun/TypeScript stdio foundation exposes the read-only `get_balance`, `list_tasks`, and `get_task_status` tools; the other 9 tools remain roadmap work.

## Ownership

This root owns project scope, public status, licensing, and the DOX hierarchy. `docs/` owns architecture, dependency notes, roadmap, and provenance; `.github/` owns CI, review automation, and contribution templates. `src/` owns runtime code and `tests/` owns deterministic Bun verification. Root also owns package/build/tooling and community documentation.

## Local Contracts

- This root and its child contracts provide the repository guidance for contributors; access to maintainer-only references is not required. Maintainer agents also follow `~/.agents/instructions/WORKFLOW.md` when installed or provided. The [private baseline workflow](https://github.com/antongulin/baseline/blob/main/baseline/02-agents.md) is a restricted maintainer reference requiring access. Current explicit task instructions and higher-priority platform rules control.
- Read this root and every applicable child `AGENTS.md` before editing. The nearest contract controls local details without weakening the shared DOX discipline.
- Keep roadmap features separate from implemented behavior. `get_balance`, `list_tasks`, and `get_task_status` are implemented; other tools require later scoped work.
- Keep public documentation free of credentials, account data, private task records, and machine-specific paths. Provider calls and paid submissions require task-specific authority.
- Adapted DOX guidance is credited in [provenance](docs/provenance.md); preserve the [upstream MIT notice](docs/dox-LICENSE.txt).

CodeGraph initialization is authorized here after source exists: inspect installed help, then run `CODEGRAPH_TELEMETRY=0 codegraph init .` and `sync` after source changes. Keep `.codegraph/` ignored; exclude dependencies/build output. Use actual call/impact and affected-test queries, verifying findings in source. Do not install or upgrade CodeGraph. Its committed MCP configuration is for source navigation only.

## Work Guidance

After meaningful changes, reconcile affected contracts, public documentation, and parent/child indexes. Put stable rules here and run evidence in task records. Add child contracts when real ownership boundaries emerge. Preserve unrelated work.

## Verification

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`, `bun run build`, and `bun run test:built`. Tests use synthetic local fixtures only. Check workflows with actionlint, documentation links, and `git diff --check`. Preserve `docs/dox-LICENSE.txt` verbatim, including its upstream final blank line.

## Child DOX Index

| Contract                               | Scope                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| [src/AGENTS.md](src/AGENTS.md)         | Runtime and provider contracts                                      |
| [tests/AGENTS.md](tests/AGENTS.md)     | Synthetic HTTP and stdio verification                               |
| [docs/AGENTS.md](docs/AGENTS.md)       | Architecture, dependencies, roadmap, provenance, and license notice |
| [.github/AGENTS.md](.github/AGENTS.md) | CI, review configuration, and contribution templates                |
