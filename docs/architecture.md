# Architecture

The single package is a Bun stdio executable. `src/cli.ts` handles explicit help/version arguments and starts the SDK transport. `src/server.ts` creates the MCP server and registers the sole tool through `src/tools/get-balance.ts`.

`src/client.ts` sends one GET to the fixed SpeedyIndex account endpoint. Its injectable fetch function supports isolated tests; the production CLI provides no endpoint override. The raw API key goes only in the Authorization header. Redirects and automatic retries are disabled. A per-call abort controller enforces the 10-second deadline, combined with the SDK request cancellation signal. Timers are cleared after settlement.

A successful provider envelope has numeric `code: 0` and all three required balance fields. Zod validates finite nonnegative numbers, strips unknown fields, and validates the public output with its observation timestamp. The tool returns both structured content and a JSON text representation. Errors use fixed messages without provider bodies or thrown error details.

The SDK stdio transport handles stdin EOF, closes the connection, and aborts in-flight requests. No web listener, database, scheduler, job submission, or deployment service is part of this package. CodeGraph is an optional developer tool, independent of the runtime and build.

The provider contract comes from the [official account API reference](https://app.speedyindex.com/cabinet/api). This integration is unofficial. Future tools need their own scope, action boundaries, documentation, and verification; see the [roadmap](implementation-plan.md).
