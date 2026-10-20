# SpeedyIndex MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that reads your [SpeedyIndex](https://app.speedyindex.com/r/zqgax9) account balances and existing tasks. This referral link may support project maintenance.

[![CI](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Bun/TypeScript foundation exposes four read-only tools over stdio: **`get_balance`**, **`list_tasks`**, **`get_task_status`**, and **`get_task_report`**. `get_balance` returns the token, indexer, and checker wallets separately, with an observation timestamp. This project is independently maintained and is not affiliated with or endorsed by SpeedyIndex. No npm package or release is published.

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

Call `list_tasks` with a required `searchEngine` (`google`, `yandex`, or `bing`), `taskType` (`indexer` or `checker`), and zero-based nonnegative integer `page`. Bing supports checker tasks only. One call requests exactly one page; the provider documents up to 1,000 tasks per page, newest first. The response echoes the requested family and page, includes `lastPage`, and returns task summaries. Empty pages beyond `lastPage` are allowed; non-empty pages beyond it are rejected as contradictory pagination metadata. For example:

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

Call `get_task_status` with a `family` and exactly one of `taskId` or `taskIds`. Supported families are `google/indexer`, `google/checker`, `yandex/indexer`, `yandex/checker`, `bing/checker`, and `backlink/checker`. IDs are opaque, nonblank strings. `taskIds` accepts 1 to 1,000 unique IDs; uniqueness lets the tool correlate results without ambiguity. For example:

```json
{ "family": "google/indexer", "taskIds": ["opaque-task-a", "opaque-task-b"] }
```

Each call makes one authenticated `POST` to that family's fixed `/status` route, with either `task_id` or `task_ids` in the JSON body. The provider may return one task or an array. The tool matches returned records by exact ID and orders `tasks` and `unreturnedIds` by the submitted IDs. `unreturnedIds` means the provider omitted those records from this response; it does not mean those tasks do not exist. Duplicate, malformed, or unrequested returned IDs invalidate the response. A wrong-typed known field on any returned task or direct child invalidates the entire call, so no partial tasks are returned. `unreturnedIds` reports IDs omitted from an otherwise valid response.

Known status fields map to camelCase when present; unknown fields are discarded. A task can include `size`, `processedCount`, `indexedCount`, `isCompleted`, `title`, `type`, `createdAt`, `status`, `payPerIndexed`, `tokensCharged`, `tokensRefunded`, `checkAfter`, `days`, `daysPassed`, `isStopped`, `dripFeed`, `awaitingResult`, `childTaskIds`, `children`, and `targetDomains`. Counts and day values are safe nonnegative integers. Token values are finite nonnegative numbers and may be fractional. Missing optional fields stay omitted. Status strings and completion booleans pass through as returned, and the tool does not infer completion from counts or status text. The optional `dripFeed` and `awaitingResult` flags are observed provider fields, not universal guarantees; the tool returns them only when the provider sends booleans. Direct child summaries include common task and PPI metadata plus an optional `day`; the tool does not return nested children.

Call `get_task_report` with one supported `family` and one nonblank opaque `taskId`. The five generic families are `google/indexer`, `google/checker`, `yandex/indexer`, `yandex/checker`, and `bing/checker`; each makes one `POST` to its fixed `/report` route with only `task_id` in the JSON body. The flat `reportKind: "links"` result contains `family`, `taskId`, `size`, `processedCount`, `indexedLinks`, `unindexedLinks`, `type`, `title`, and `createdAt`. Optional fields are `indexedCount`, `isCompleted`, `status`, `checkAfter`, `payPerIndexed`, `tokensCharged`, `tokensRefunded`, `dripFeed`, `days`, `daysPassed`, `isStopped`, `awaitingResult`, and `childTaskIds`; missing values stay omitted and unknown report-result fields are discarded. Counts and day values are safe nonnegative integers, token values are finite nonnegative numbers, and optional booleans, strings, and child IDs keep their declared types. URL strings, their order, duplicates, and overlaps are preserved without parsing or fetching.

For `backlink/checker`, optional `page` and `limit` default to `0` and `100`; `limit` is bounded from 1 to 100. The request sends `task_id`, `page`, and `limit` in one fixed `/v2/task/backlink/checker/report` POST. The flat `reportKind: "backlink"` result contains `family`, `taskId`, `size`, `processedCount`, `page`, `lastPage`, and `donors`, with only `isCompleted` optional. The page and task ID must match the request, and the donor count cannot exceed the requested limit. Donor rows must be JSON objects; donor keys and nested finite JSON values, including `null`, are preserved without assigning meaning to provider-specific fields. Empty pages beyond `lastPage` are allowed; nonempty pages beyond it are rejected. No additional page is fetched. Report counters, arrays, and optional completion metadata do not establish completeness, retry eligibility, or fresh Google indexing truth.

All four tools make one authenticated request to a fixed `https://api.speedyindex.com/v2` route, using the API key as the raw `Authorization` header. Requests have a 10-second deadline, support MCP cancellation, reject redirects, and never retry automatically. Missing keys fail without network access. Tool failures return `isError: true` with a sanitized message and no structured result. Provider bodies and exception details are never reflected in those errors. Normal stdout contains MCP messages only; diagnostics use stderr. Closing stdin ends the process.

Responses over this MCP's 16 MiB decoded-body safety bound are rejected; this is not a SpeedyIndex maximum.

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

The other 8 tools remain in the [roadmap](docs/implementation-plan.md). An internal SQLite ledger is an unexposed prerequisite for later submission work; the runtime does not open or initialize it. Task creation, provider submission, invoices, retries, runtime storage, and scheduling remain unimplemented.

Licensed under [MIT](LICENSE). Documentation framework attribution is in [provenance](docs/provenance.md).

Built by [Anton Gulin](https://github.com/antongulin) · [Anton.QA](https://www.anton.qa).
