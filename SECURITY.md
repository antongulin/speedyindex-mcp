# Security

This project is an unpublished foundation. Security fixes target the current default branch; no older release support is promised.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/antongulin/speedyindex-mcp/security/advisories/new). Include a minimal reproduction with synthetic data and remove credentials. Do not post API keys or account responses in public issues.

The server reads `SPEEDYINDEX_API_KEY` from its environment. Keep local environment files and logs out of Git. Do not enable request/header logging around real credentials. The runtime uses only the fixed official HTTPS account endpoint, rejects redirects, and returns sanitized tool errors.
