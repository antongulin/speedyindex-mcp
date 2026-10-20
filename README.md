# SpeedyIndex MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that reads your [SpeedyIndex](https://speedyindex.com/) account balances and existing tasks.

[![CI](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Bun/TypeScript foundation exposes the read-only **`get_balance`** and **`list_tasks`** tools over stdio. `get_balance` returns the token, indexer, and checker wallets separately, with an observation timestamp. This project is independently maintained and is not affiliated with or endorsed by SpeedyIndex. No npm package or release is published.

## Run from source

Requires Bun 1.4.2 or later. CI uses Bun 1.4.3; Node LTS supports development tooling. Use Bun for dependency installation; `bun.lock` is the sole lockfile.

```sh
git clone https://github.com/antongulin/speedyindex-mcp.git
cd speedyindex-mcp
bun install --frozen-lockfile
bun run build
bun dist/cli.js --help
```

Sign in to the [official SpeedyIndex API page](https://app.speedyindex.com/cabinet/api) to obtain your own API key. See the [public API reference](https://en.speedyindex.com/api.php) for provider documentation.

Provide `SPEEDYINDEX_API_KEY` through your process manager's secret environment, then launch `bun dist/cli.js` from the repository directory. It waits for an MCP client on stdin/stdout; it is not an interactive shell command. `bun run start` runs the source entrypoint during development. `.env.example` documents the variable without containing a real credential.

For hosted use, register an upstream through your existing MCP proxy infrastructure. This repository does not provision hosting or register a proxy upstream. The committed `.mcp.json` configures optional **CodeGraph source navigation only**.

## Tool contracts

Call `get_balance` with `{}`. A synthetic structured response looks like:

```json
{
  "balance": { "tokens": 0, "indexer": 27, "checker": 8 },
  "observedAt": "2026-01-01T00:00:00.000Z"
}
```

The server makes one authenticated `GET https://api.speedyindex.com/v2/account`, using the API key as the raw `Authorization` header. All three balances must be finite, nonnegative numbers; zero is valid. Additional provider fields are ignored. The timestamp records when the validated response was observed, not a provider update time.

Call `list_tasks` with a required `searchEngine` (`google`, `yandex`, or `bing`), `taskType` (`indexer` or `checker`), and zero-based nonnegative integer `page`. Bing supports checker tasks only. One call requests exactly one page; the provider documents up to 1,000 tasks per page, newest first. The response echoes the requested family and page, includes `lastPage`, and returns task summaries. For example:

```json
{
  "searchEngine": "google",
  "taskType": "indexer",
  "page": 0,
  "lastPage": 0,
  "tasks": [
    {
      "id": "65f8c7315752853b9171860a",
      "size": 690,
      "processedCount": 690,
      "indexedCount": 279,
      "title": "my_urls.txt",
      "isCompleted": true,
      "type": "google/indexer",
      "createdAt": "2024-03-18T22:58:56.901Z"
    }
  ]
}
```

For Google indexer tasks, optional `filter` values are `standard`, `pay_per_indexed`, and `drip_feed`. Omitting `filter` includes standard and pay-per-indexed tasks and excludes drip-feed tasks. Optional `payPerIndexed` is valid only with `filter: "drip_feed"` and selects drip-feed tasks by that flag. Filters are not accepted for other task families. Documented summary fields are returned in camelCase when present; optional fields remain omitted when the provider does not return them, and unknown fields are discarded. The list response does not guarantee status, token charges/refunds, or a check-after time.

Both tools make one authenticated GET to a fixed `https://api.speedyindex.com/v2` route, using the API key as the raw `Authorization` header. Requests have a 10-second deadline, support MCP cancellation, reject redirects, and never retry automatically. Missing keys fail without network access. Tool failures return `isError: true` with a sanitized message and no structured result. Provider bodies and exception details are never reflected in those errors. Normal stdout contains MCP messages only; diagnostics use stderr. Closing stdin ends the process.

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

## Documentation

See [architecture](docs/architecture.md), [dependency decisions](docs/dependencies.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), [agent guidance](AGENTS.md), and the [LLM documentation index](llms.txt).

The other 10 tools remain in the [roadmap](docs/implementation-plan.md); task creation/submission, status and report retrieval, invoices, retries, storage, and scheduling are not implemented.

Licensed under [MIT](LICENSE). Documentation framework attribution is in [provenance](docs/provenance.md).

Built by [Anton Gulin](https://github.com/antongulin) · [Anton.QA](https://www.anton.qa).
