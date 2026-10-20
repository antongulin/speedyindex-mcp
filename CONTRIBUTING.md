# Contributing

Read [AGENTS.md](AGENTS.md) and the contract for the directory you change. Keep a contribution focused, discuss new tool scope first, and distinguish roadmap ideas from working behavior.

Install Bun and Node LTS, then run the checks listed in [README.md](README.md#development). Add a deterministic test for a meaningful behavior change at the lowest useful layer. Use synthetic fixtures and dummy keys; never submit live provider jobs from tests. Build before running the built-artifact tests.

Open a pull request with the behavior change, relevant tests, and any remaining limitations. Robin review and CI are required for code changes. Maintainers investigate findings against the repository before accepting fixes. Fork PRs have no review secrets; a maintainer may run the supported review command after inspecting the contribution.

Use respectful, constructive communication under the [community conduct expectations](CODE_OF_CONDUCT.md). Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
