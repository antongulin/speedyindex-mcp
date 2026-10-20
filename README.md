# SpeedyIndex MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that reads your SpeedyIndex account balances.

The Bun/TypeScript foundation exposes **`get_balance` only** over stdio. It returns the token, indexer, and checker wallets separately, with an observation timestamp. This project is independently maintained and is not affiliated with or endorsed by SpeedyIndex. No npm package or release is published.

## Run from source

Requires Bun 1.4.2 or later. CI uses Bun 1.4.3; Node LTS supports development tooling. Use Bun for dependency installation; `bun.lock` is the sole lockfile.

```sh
git clone https://github.com/antongulin/speedyindex-mcp.git
cd speedyindex-mcp
bun install --frozen-lockfile
bun run build
bun dist/cli.js --help
```

Provide `SPEEDYINDEX_API_KEY` through your process manager's secret environment, then launch `bun dist/cli.js` from the repository directory. It waits for an MCP client on stdin/stdout; it is not an interactive shell command. `bun run start` runs the source entrypoint during development. `.env.example` documents the variable without containing a real credential.

For hosted use, register an upstream through your existing MCP proxy infrastructure. This repository does not provision hosting or register a proxy upstream. The committed `.mcp.json` configures optional **CodeGraph source navigation only**.

## Tool contract

Call `get_balance` with `{}`. A synthetic structured response looks like:

```json
{
  "balance": { "tokens": 0, "indexer": 27, "checker": 8 },
  "observedAt": "2026-01-01T00:00:00.000Z"
}
```

The server makes one authenticated `GET https://api.speedyindex.com/v2/account`, using the API key as the raw `Authorization` header. All three balances must be finite, nonnegative numbers; zero is valid. Additional provider fields are ignored. The timestamp records when the validated response was observed, not a provider update time.

Requests have a 10-second deadline, support MCP cancellation, reject redirects, and never retry automatically. Missing keys fail without network access. Tool failures return `isError: true` with a sanitized message and no structured balance. Provider bodies and exception details are never reflected in those errors. Normal stdout contains MCP messages only; diagnostics use stderr. Closing stdin ends the process.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
bun run test:built
```

The tests use dummy credentials, loopback HTTP fixtures, the official MCP client, and actual source/built CLI subprocesses. They do not contact SpeedyIndex. `bun run format` formats maintained files while preserving the upstream DOX notice.

See [architecture](docs/architecture.md), [dependency decisions](docs/dependencies.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and [agent guidance](AGENTS.md). The other 11 tools remain in the [roadmap](docs/implementation-plan.md); no task submission, checking, invoices, retries, storage, or scheduling is implemented.

Licensed under [MIT](LICENSE). Documentation framework attribution is in [provenance](docs/provenance.md).

Built by [Anton Gulin](https://github.com/antongulin) · [Anton.QA](https://www.anton.qa).
