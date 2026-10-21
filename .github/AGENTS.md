# GitHub automation contract

## Purpose

Configure CI, Robin review, and community contribution templates for this public repository.

## Ownership

`workflows/code-review.yml` is the sole Robin caller. `robin.yml` owns repository review settings. `workflows/ci.yml` owns frozen installation, typecheck, lint, format, source tests, build, and built tests on ubuntu-latest. Issue and PR templates request reproducible, sanitized evidence. No deployment, scheduling, or release automation is configured.

## Local Contracts

- Call the reusable Robin workflow at `0fad708fadf57a1603b834f5e50162e87a71a79c` (v2.12.1). This pins the caller dependency; that upstream workflow internally uses the Robin action at `main`.
- Use automatic PR events `opened`, `reopened`, and `ready_for_review`, plus `issue_comment` `created` for commands. Exclude `synchronize` and `pull_request_target`.
- Keep `actions: read`, `contents: read`, and `pull-requests: write`. Use the upstream default public GitHub-hosted runner.
- Map only the repository secrets `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` under their matching names. Never store their values in Git. Secret configuration and hosted execution require separate verification.
- Keep `reasoning-effort: max` in `robin.yml` and the caller's `max-diff-size: '360000'` input to bound review diffs at 360,000 characters; other settings use upstream defaults. Config is read from the PR base branch. Report truncation as a coverage limitation and deliberately adjust the bound when needed before accepting a review that omits substantive changes.
- PR-triggered bootstrap reviews can run before the workflow reaches the default branch. `issue_comment` commands require the workflow on the default branch. Because `synchronize` is excluded, substantive follow-up pushes require an authorized manual `/robin` within the task review budget. When a PR changes caller inputs absent from the default branch, an authorized close/reopen of the same PR can trigger `reopened` with the PR workflow; verify the actual inputs and review coverage rather than assuming a default-branch command uses the changed caller.
- Fork `pull_request` runs do not receive the three repository secrets; the referenced Robin action fails when the base URL or model is missing. External PRs need an authorized maintainer `/robin` command through the default-branch `issue_comment` workflow. Do not enable `pull_request_target` or execute fork code to obtain secrets.
- Land the minimal initial bootstrap under the shared bootstrap exception using lead review and available checks. A hosted result proves only the reviewed revision and configuration used; it does not validate a later head or `max` effort from config absent on the base. Substantive code must receive a real Robin review of its exact head. Do not describe static checks as a completed hosted review.

## Work Guidance

Inspect the pinned upstream workflow and supported config before changing this integration. Follow the shared workflow's review budget and lead-approved triage gates for later PRs.

## Verification

Run `actionlint .github/workflows/code-review.yml .github/workflows/ci.yml` when installed, parse maintained YAML files with an available parser, compare the reusable workflow's secrets and defaults, and run `git diff --check`. These static checks do not verify secret values, provider access, or a posted Robin review.

## Child DOX Index

None. This contract also owns `workflows/`.
