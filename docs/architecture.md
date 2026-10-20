# Architecture

The single package is a Bun stdio executable. `src/cli.ts` handles explicit help/version arguments and starts the SDK transport. `src/server.ts` creates the MCP server and registers `get_balance` and `list_tasks` through their tool modules.

`src/client.ts` sends one GET per call to either the fixed SpeedyIndex account endpoint or a task-list route built only from validated family, page, and filter values. `list_tasks` reads one explicit zero-based page and never traverses pages automatically. Its injectable fetch function supports isolated tests; the production CLI provides no endpoint override. The raw API key goes only in the Authorization header. Redirects and automatic retries are disabled. A per-call abort controller enforces the 10-second deadline, combined with the SDK request cancellation signal. Timers are cleared after settlement.

The account envelope has numeric `code: 0` and all three required balance fields. Zod validates finite nonnegative numbers, strips unknown fields, and validates the public output with its observation timestamp. A task-list envelope must have `code: 0`, safe nonnegative integer page fields, and at most 1,000 task rows; its echoed page must match the request. Every task has a nonblank opaque ID. Other documented summary fields are optional, validated when present, mapped to camelCase, and unknown fields are stripped. The public list output omits unavailable optional values. Both tools return structured content and equivalent JSON text. Errors use fixed messages without provider bodies or thrown error details.

The SDK stdio transport handles stdin EOF, closes the connection, and aborts in-flight requests. No web listener, database, scheduler, task submission, or deployment service is part of this package. CodeGraph is an optional developer tool, independent of the runtime and build.

The provider contract comes from the [official account API reference](https://app.speedyindex.com/cabinet/api). This integration is unofficial. Future tools need their own scope, action boundaries, documentation, and verification; see the [roadmap](implementation-plan.md).
