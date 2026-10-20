# SpeedyIndex MCP — agent contract

## Purpose

Build an unofficial MCP integration for SpeedyIndex. The repository contains documentation and Robin review configuration; all 12 proposed tools are unimplemented.

## Ownership

This root owns project scope, public status, licensing, and the DOX hierarchy. `docs/` owns the roadmap and provenance; `.github/` owns review automation. There is no source tree, package manifest, runtime, or test runner yet.

## Local Contracts

- Follow the shared workflow at `~/.agents/instructions/WORKFLOW.md`, with the [canonical remote fallback](https://github.com/antongulin/baseline/blob/main/baseline/02-agents.md). Current explicit task instructions and higher-priority platform rules control.
- Read this root and every applicable child `AGENTS.md` before editing. The nearest contract controls local details without weakening the shared DOX discipline.
- Keep roadmap features separate from implemented behavior. Implement `get_balance` first; other tools require later scoped work.
- Keep public documentation free of credentials, account data, private task records, and machine-specific paths. Provider calls and paid submissions require task-specific authority.
- Adapted DOX guidance is credited in [provenance](docs/provenance.md); preserve the [upstream MIT notice](docs/dox-LICENSE.txt).

## Work Guidance

After meaningful changes, reconcile affected contracts, public documentation, and parent/child indexes. Put stable rules here and run evidence in task records. Add child contracts when real ownership boundaries emerge. Preserve unrelated work.

## Verification

There is no application verification suite yet. For documentation, inspect the diff, check relative links and factual status, and run `git diff --check`. Future runtime checks must be documented when introduced.

## Child DOX Index

| Contract | Scope |
| --- | --- |
| [docs/AGENTS.md](docs/AGENTS.md) | Roadmap, provenance, and third-party documentation notice |
| [.github/AGENTS.md](.github/AGENTS.md) | Robin workflow and repository review configuration |
