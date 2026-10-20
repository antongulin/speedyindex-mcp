# GitHub automation contract

## Purpose

Configure Robin review automation for this public repository.

## Ownership

`workflows/code-review.yml` is the sole Robin caller. `robin.yml` owns repository review settings. No deployment, scheduling, or release automation is configured.

## Local Contracts

- Call the reusable Robin workflow at `0fad708fadf57a1603b834f5e50162e87a71a79c` (v2.12.1). This pins the caller dependency; that upstream workflow internally uses the Robin action at `main`.
- Use automatic PR events `opened`, `reopened`, and `ready_for_review`, plus `issue_comment` `created` for commands. Exclude `synchronize` and `pull_request_target`.
- Keep `actions: read`, `contents: read`, and `pull-requests: write`. Use the upstream default public GitHub-hosted runner.
- Map only the repository secrets `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` under their matching names. Never store their values in Git. Secret configuration and hosted execution require separate verification.
- Keep `reasoning-effort: max` in `robin.yml`; other settings use upstream defaults. Config is read from the PR base branch.
- The initial bootstrap cannot establish its own Robin review because the workflow is absent from its base. Land it under the shared bootstrap exception before substantive code review. Do not describe static checks as a completed hosted review.

## Work Guidance

Inspect the pinned upstream workflow and supported config before changing this integration. Follow the shared workflow's review budget and lead-approved triage gates for later PRs.

## Verification

Run `actionlint .github/workflows/code-review.yml` when installed, parse both YAML files with an available parser, compare the reusable workflow's secrets and defaults, and run `git diff --check`. These static checks do not verify secret values, provider access, or a posted Robin review.

## Child DOX Index

None. This contract also owns `workflows/`.
