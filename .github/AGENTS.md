# GitHub automation contract

## Purpose

Configure CI, Robin review, and community contribution templates for this public repository.

## Ownership

`workflows/code-review.yml` is the sole Robin caller. `robin.yml` owns repository review settings. `workflows/ci.yml` owns frozen installation, typecheck, lint, format, source tests, build, and built tests on ubuntu-latest. Issue and PR templates request reproducible, sanitized evidence. No deployment, scheduling, or release automation is configured.

## Local Contracts

- Call the reusable Robin workflow at `0fad708fadf57a1603b834f5e50162e87a71a79c` (v2.12.1). This pins the caller dependency; that upstream workflow internally uses the Robin action at `main`.
- Use automatic PR events `opened`, `reopened`, `ready_for_review` and `synchronize`, plus `issue_comment` `created` for commands. Keep `pull_request_target` disabled.
- Keep `actions: read`, `contents: read`, and `pull-requests: write`. Use the upstream default public GitHub-hosted runner.
- Map only the repository secrets `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` under their matching names. Never store their values in Git. Secret configuration and hosted execution require separate verification.
- Keep `reasoning-effort: max` in `robin.yml`. The caller sets `max-diff-size: '1000000'`, `review-on-synchronize: true` and `agent-mode: 'off'`. The active single-shot bound counts the unannotated filtered diff in JavaScript UTF-16 units; annotation enlarges review input and establishes no provider context allowance. Repository config is read from the PR base branch.
- PR events use the PR workflow revision under GitHub merge-ref rules; `issue_comment` commands use the default-branch workflow. Confirm the actual hosted head, workflow inputs and action revision. Substantive follow-up pushes use the synchronize route; inspect pending runs and the persistent budget of five completed usable review results before pushing. Do not assume a default-branch manual command uses changed feature inputs.
- Fork `pull_request` runs do not receive the three repository secrets; the referenced Robin action fails when the base URL or model is missing. External PRs need an authorized maintainer `/robin` command through the default-branch `issue_comment` workflow. Do not enable `pull_request_target` or execute fork code to obtain secrets.
- Substantive code needs a usable review of the current head. Before publication, measure the complete merge-base candidate diff, all changed paths, filtered paths, UTF-8 bytes, UTF-16 units and annotation volume; require raw input at or below 1,000,000 units with no authorized path omitted. Rebind actual committed head/base and the mutable action revision before accepting hosted coverage. Confirm active single-shot mode, complete input and usable output without active truncation/context failure; a configured cap or local projection is not hosted proof. Keep the task review counter across heads/contexts, inspect a full finding disposition batch before actions, and verify individual replies and resolved threads. Partial, failed, empty and obsolete reviews are not READY.

## Work Guidance

Inspect the pinned upstream workflow and supported config before changing this integration. Follow the shared workflow's review budget and lead-approved triage gates for later PRs.

## Verification

Run `actionlint .github/workflows/code-review.yml .github/workflows/ci.yml` when installed, parse maintained YAML files with an available parser, compare the reusable workflow's secrets and defaults, and run `git diff --check`. These static checks do not verify secret values, provider access, or a posted Robin review.

## Child DOX Index

None. This contract also owns `workflows/`.
