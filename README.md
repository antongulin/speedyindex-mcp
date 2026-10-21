# SpeedyIndex MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server for [SpeedyIndex](https://app.speedyindex.com/r/zqgax9) account reads and guarded indexing submissions. This referral link may support project maintenance.

[![CI](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Bun/TypeScript server exposes six tools over stdio: **`get_balance`**, **`list_tasks`**, **`get_task_status`**, **`get_task_report`**, **`create_indexing_task`**, and **`create_index_check`**. Submissions are disabled by default; previews work without a key or database. Index-check reservations require an operator-selected policy profile. `get_balance` returns the token, indexer, and checker wallets separately, with an observation timestamp. This project is independently maintained and is not affiliated with or endorsed by SpeedyIndex. No npm package or release is published.

## Run from source

Requires Bun 1.4.2 or later. CI uses Bun 1.4.3; Node LTS supports development tooling. Use Bun for dependency installation; `bun.lock` is the sole lockfile.

```sh
git clone https://github.com/antongulin/speedyindex-mcp.git
cd speedyindex-mcp
bun install --frozen-lockfile
bun run build
bun --no-env-file dist/cli.js --help
```

Sign in to the [official SpeedyIndex API page](https://app.speedyindex.com/cabinet/api) to obtain your own API key. See the [public API reference](https://en.speedyindex.com/api.php) for provider documentation.

Provide `SPEEDYINDEX_API_KEY` through your process manager's secret environment, then launch `bun --no-env-file dist/cli.js` from the repository directory. It waits for an MCP client on stdin/stdout; it is not an interactive shell command. For development, use `bun --no-env-file src/cli.ts`. Put Bun's `--no-env-file` before the entrypoint to prevent Bun's automatic environment-file loading. The server adds no environment-file loader; your launcher controls its process environment. `.env.example` documents the key variable. A key alone permits reads, with submissions still disabled. Missing keys leave startup and previews usable; read calls fail without network access.

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

The four read tools make one authenticated request to a fixed `https://api.speedyindex.com/v2` route, using the API key as the raw `Authorization` header. Requests have a 10-second deadline, support MCP cancellation, reject redirects, and never retry automatically. Read-tool failures return `isError: true` with a sanitized message and no structured result. Provider bodies and exception details are never reflected in those errors. Normal stdout contains MCP messages only; diagnostics use stderr. Closing stdin ends the process.

Read responses over this MCP's 16 MiB decoded-body safety bound are rejected; this is not a SpeedyIndex maximum.

## Indexing preview and submission

Call `create_indexing_task` with an explicit `mode` of `preview` or `submit`; there is no submit default. A preview needs no operator setup:

```json
{
  "mode": "preview",
  "searchEngine": "google",
  "urls": ["https://example.com/page"]
}
```

Choose `google` or `yandex` and supply 1 to 10,000 unique absolute HTTP(S) URL strings. The server preserves their order and spelling; it rejects duplicates, credentials in URLs, ASCII whitespace, C0/DEL controls, outer whitespace and invalid Unicode. Local bounds are 8,192 UTF-8 bytes per URL, 1,024 per optional title, and 2,097,152 for the serialized provider body. Accepted titles retain spaces; omitted and empty titles differ. Google always uses Pay-Per-Result. Optional Google `dripFeedDays` must be an integer from 2 to 30 and cannot exceed the URL count. Yandex accepts no drip option.

Preview computes the exact payload digest and a quote without opening state, reserving allowance, fetching URLs or calling the provider. For N URLs, the documented-rate estimate reserves Google `{tokens: 100*N, indexer: 0, checker: 0}` or Yandex `{tokens: 20*N, indexer: N, checker: 0}`. Yandex uses indexing credits first; reserving both maxima protects against outside credit consumption and does not predict that both will be charged together. The three units have independent ceilings. These estimates do not enforce a provider wallet cap or account for final charges, refunds or balance observations. See the [official API reference](https://en.speedyindex.com/api.php).

Submit adds a stable caller-selected `requestId` of 1 to 128 visible ASCII characters. In caller acknowledgement mode, also copy `quote.fingerprint` and `authorization.fingerprint` from a fresh configured preview into `acknowledgement.quoteFingerprint` and `acknowledgement.authorizationFingerprint`. These digests detect changed context; an agent can compute them. They do not authenticate a human, consume a one-use approval or bind a distinct request ID. Operators must restrict access to the local host. MCP inputs cannot choose authoritative policy, policy mode, caps, scope, period, clock or paths; unknown fields fail SDK input validation.

Application results contain the request summary, quote and authorization state as structured content and identical JSON text. Preview reports `authorization.stateChecked: false`, even with configuration: it does not prove that state exists or that a later submit will fit. Durable accepted results and previews use `isError: false`; blocked, rejected, unknown, cancelled and unresolved results use `isError: true` with safe structured details. SDK input rejection can happen before the handler and need not include application structured content.

After valid policy/key/operation admission, an exact replay of a request ID returns durable state without another POST or a fresh acknowledgement, including across a UTC day change. It retains its original reservation period. Exact replay precedes the busy guard and current-acknowledgement checks. Current digests are required for new work in caller acknowledgement mode; any supplied digests must match in either mode. Changed payload or policy identity conflicts. A valid provider ACK alone is insufficient if local outcome recording fails: the result separates its unrecorded observation from the held durable state. Prepared, dispatching and unknown intents retain reservations; unresolved exact URLs block another ID. Restart, cancellation, elapsed time and a new UTC day do not release those holds. Inspect unresolved state manually; this tool offers no release, reset, resend or reconciliation command. After an accepted intent, a deliberate new ID can create another job. Local request IDs do not supply provider idempotency or exactly-once creation.

## Index-check preview and submission

Call `create_index_check` with explicit `mode`, `searchEngine` (`google`, `yandex` or `bing`), 1 to 10,000 unique `urls`, and optional `title`. It uses the same URL/title/body limits and preserves exact strings and order. It accepts no PPR, drip, policy, cap or path overrides. A preview works without key or state and sends no request. Submit additionally requires a stable `requestId`, enabled trusted configuration, explicit `allowIndexChecks: true`, and a reservation profile for the selected engine.

The quote has basis `operator_configured_reservation`, `providerEnforced: false` and `providerFeesKnown: false`. With a profile, `availability: "available"` includes `perUrlReservation`, its three-unit `reservation` multiplied by URL count, and `fingerprint`. These are operator declarations for local admission, not vendor prices, maxima or actual fees. Checker-credit conversion, credit priority and token fallback remain unknown. No wallet balance, refund or provider debit is inferred. Without a valid policy/profile, or if multiplication exceeds safe integers, `availability: "unavailable"` gives a reason and omits vectors and fingerprint; submit is blocked before opening state.

Both create tools share one host, busy guard and V1 ledger, including independent token/indexer/checker caps, exact request-ID replay and unresolved URL holds across families. Checker submission sends only optional title and URLs in one fixed engine `/checker/create` POST. A valid root ACK must match that checker family; true/mistyped PPR or drip echoes, any `days`, malformed ACKs and post-invocation cancellation leave an unknown held outcome. The acknowledgement, durable-state/error and cancellation limits above also apply. No follow-up status polling or report-based freshness inference occurs.

## Optional operator setup

Use only canonical absolute POSIX paths you explicitly select. The state parent must already exist and be trusted. Initialize a new private state directory with this local command, which requires no key, policy, network or MCP session:

```sh
bun --no-env-file dist/cli.js --init-submission-state '<canonical-absolute-new-directory>'
```

The command creates version-one `ledger.sqlite` state and prints `{"initialized":true,"schemaVersion":1}`. It refuses existing paths, including broken or partial state, and does not create parents. A failed init may leave files for inspection. Do not replace an existing store to bypass reservations. Normal submit opens existing state only; startup and preview do not open it. Normal open verifies complete V1 state before configuring persistent WAL. SQLite opening and reads can touch sidecar bookkeeping even when an unsupported version is rejected. It performs no repair, bootstrap or reset.

With your key already supplied in the process environment, obtain its expected policy binding locally:

```sh
bun --no-env-file dist/cli.js --submission-credential-fingerprint
```

This prints only the domain-separated SHA-256 fingerprint of the trimmed key. It identifies a key, not a verified provider account. Key rotation needs an intentional policy change and does not merge allowance history across keys.

Create a private JSON policy file yourself, with exactly these required fields. No path, policy labels, mode or cap values are selected by this repository:

| Field                           | Operator choice                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                       | Integer `1`                                                                                                                                                                                                                          |
| `enabled`                       | Explicit boolean; only `true` permits submissions                                                                                                                                                                                    |
| `mode`                          | `caller_acknowledgement` requires both preview digests for each new intent; `operator_policy` permits submission under the configured finite policy without an acknowledgement. If supplied, both digests must match in either mode. |
| `policyRevision`, `budgetScope` | Nonsensitive visible ASCII labels, 1 to 128 characters; cooperating hosts use a common budget scope                                                                                                                                  |
| `credentialFingerprint`         | The expected 64-character lowercase hex output of the local fingerprint command; never the key                                                                                                                                       |
| `period`                        | Exactly `{"kind":"utc_day"}`                                                                                                                                                                                                         |
| `caps`                          | Exactly `{"tokens":…, "indexer":…, "checker":…}`; choose each finite nonnegative safe integer explicitly, including zero where intended                                                                                              |

Two optional fields extend that policy without enabling checks implicitly:

| Field                    | Operator choice                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowIndexChecks`       | Explicit boolean; only `true` permits checker submissions, independently of `enabled` and profiles. Absence or `false` leaves checks disabled.                                                                                                                              |
| `indexCheckReservations` | Optional strict partial map of `google`, `yandex`, `bing`. Each selected engine has a per-URL `{tokens: …, indexer: …, checker: …}` vector; choose all three nonnegative safe integers explicitly, including zero where intended. Empty or absent maps provide no profiles. |

Compiled local token admission floors dated 2026-10-21 are 3 per URL for Google and 2 for Yandex/Bing, based on the [technical service-cost FAQ](https://en.speedyindex.com/faq/#service-cost). They are minimum local admission values, not a complete fee model; operators may reserve more and must select the other units themselves. Unknown fields, missing units, nulls, fractions and unsafe values invalidate the entire policy.

A valid private policy can supply reservation previews even with writes disabled, no state path or no key; this grants no write authority. Profiles are read once and frozen. The active policy's selected profile controls submissions. Optional flag/profile presence and every profile bind the whole policy digest, including unselected engines; changing them can conflict with existing request IDs. Legacy policies with both fields absent retain their original canonical identity. Restart all cooperating hosts after changes, and preserve existing reservations and holds.

The file must be at most 16,384 bytes, owned by the effective UID, mode `0600`, regular, non-symlink and single-link. State requires an effective-UID `0700` directory and `0600` regular single-link database/sidecars. Ancestors must be non-symlink directories owned by root or the effective UID, without group/other write access; root-owned sticky temporary directories are allowed. Resolve OS path aliases before supplying paths. The server does not chmod or repair them.

Start the configured host using your chosen paths:

```sh
bun --no-env-file dist/cli.js \
  --submission-policy '<canonical-absolute-policy-file>' \
  --submission-state '<canonical-absolute-existing-state-directory>'
```

Incomplete or invalid configuration disables submissions while stdio and the read tools remain available. The host loads one immutable policy snapshot. Restart **all cooperating hosts** after any policy change; no reload loop runs. Local fingerprint/init modes are exclusive with each other and with server flags. Unknown, duplicate or missing-value arguments produce a fixed syntax error.

The host derives the reservation day from its own UTC clock. Policy digests bind all three caps and the expected key, excluding the current day. Accepted reservations count for their original reservation day; prepared, dispatching and unknown reservations count across days. Policy revisions do not reset exposure. Only cooperating processes sharing the same canonical local store, key fingerprint and budget scope share this allowance. Other keys, copied databases, machines and external clients can spend outside it.

SQLite calls are synchronous. Contention can block stdio parsing, reads, pings and cancellation until the call returns; the 2,000 ms busy timeout is not a whole-tool latency limit. The host yields to actual I/O turns after prepare and after winning the claim, then checks cancellation before dispatch. These boundaries do not interrupt running SQL or guarantee atomic remote cancellation. The HTTP 10-second deadline covers the attempted request and response body, not the full tool call. A cancellation after invocation may leave an unknown held outcome; a fully parsed valid ACK remains recordable despite later cancellation. See [architecture](docs/architecture.md) for the state and persistence boundaries.

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

The other six tools remain in the [roadmap](docs/implementation-plan.md). Retry planning/submission, backlink checks, campaign reporting, invoices, and one-shot automation or scheduling remain unimplemented. The current version-one ledger records standalone submissions without campaign/parent lineage; a future additive version-two migration needs separate design and verification and must preserve existing holds.

Licensed under [MIT](LICENSE). Documentation framework attribution is in [provenance](docs/provenance.md).

Built by [Anton Gulin](https://github.com/antongulin) · [Anton.QA](https://www.anton.qa).
