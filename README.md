# SpeedyIndex MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server for [SpeedyIndex](https://app.speedyindex.com/r/zqgax9) account reads and guarded task submissions. This referral link may support project maintenance.

[![CI](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/antongulin/speedyindex-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

This Bun/TypeScript source branch exposes ten tools over stdio: **`get_balance`**, **`list_tasks`**, **`get_task_status`**, **`get_task_report`**, **`create_indexing_task`**, **`create_index_check`**, **`create_backlink_check`**, **`plan_retry`**, **`get_retry_history`**, and **`compare_reports`**. Submissions are disabled by default; create previews work without a key or database. Retry planning and local retry history require existing private configuration and V2 state. Index-check and backlink-check reservations require operator-selected policy profiles. `get_balance` returns the token, indexer, and checker wallets separately, with an observation timestamp. This project is independently maintained and is not affiliated with or endorsed by SpeedyIndex. No npm package or release is published; branch implementation is not delivery evidence.

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

Provide `SPEEDYINDEX_API_KEY` through your process manager's secret environment, then launch `bun --no-env-file dist/cli.js` from the repository directory. It waits for an MCP client on stdin/stdout; it is not an interactive shell command. For development, use `bun --no-env-file src/cli.ts`. Put Bun's `--no-env-file` before the entrypoint to prevent Bun's automatic environment-file loading. The server adds no environment-file loader; your launcher controls its process environment. `.env.example` documents the key variable. A key alone permits account/task reads, with submissions still disabled; planning and history need the configured host described below. Missing keys leave startup and previews usable; account/task reads fail without network access.

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

The four single-request read tools make one authenticated request to a fixed `https://api.speedyindex.com/v2` route, using the API key as the raw `Authorization` header. Requests have a 10-second deadline, support MCP cancellation, reject redirects, and never retry automatically. Read-tool failures return `isError: true` with a sanitized message and no structured result. Provider bodies and exception details are never reflected in those errors. Normal stdout contains MCP messages only; diagnostics use stderr. Closing stdin ends the process.

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

All three create tools share one host, busy guard and V1/V2 ledger, including independent token/indexer/checker caps, exact request-ID replay and unresolved URL holds across families. Checker submission sends only optional title and URLs in one fixed engine `/checker/create` POST. A valid root ACK must match that checker family. PPR and drip echoes must be absent or boolean false; any `drip_feed_days` field or a malformed ACK leaves an unknown held outcome. Cancellation after a POST attempt leaves the outcome unknown when no definite provider outcome was parsed. A fully parsed valid ACK can still be recorded as accepted despite later cancellation. The acknowledgement, durable-state/error and cancellation limits above also apply. No follow-up status polling or report-based freshness inference occurs.

## Backlink-check preview and submission

Call `create_backlink_check` with explicit `mode`, 1 to 10,000 unique donor `urls`, a `targetDomains` array of 1 to 50 strings, and optional `title`. For example:

```json
{
  "mode": "preview",
  "urls": ["https://donor.example/page"],
  "targetDomains": ["example.org"]
}
```

Each target string must be nonblank, valid Unicode without C0/DEL controls, and at most 8,192 UTF-8 bytes. The server preserves target spelling, spaces, case, order and exact duplicates. These are local safe-text bounds, not a provider domain grammar: the server does not parse or canonicalize DNS names. Donor URL/title limits match indexing, and the entire serialized body, including targets, must fit 2 MiB. The fixed `https://api.speedyindex.com/v2/task/backlink/checker/create` POST contains optional `title`, then `urls`, then `target_domains`. The request summary includes donor and target counts. Changing targets changes the full-body digest and request identity.

Preview needs no key or state and makes no provider request. Submit requires a stable `requestId`, enabled trusted configuration, additional `allowBacklinkChecks: true`, and an explicit private `backlinkCheckReservations` profile with all three units. Index-check permission grants no backlink permission. Missing profiles produce unpriced previews and block submission before state opens. The profile reserves each selected unit times the donor count, without multiplying by the target count. The quote binds both counts and reports `providerFeesKnown: false` and `providerEnforced: false`; target-count effects on fees, indexer/checker credit use and conversions remain unknown.

The [official English API backlink section](https://en.speedyindex.com/api.php#backlink-create) documents 2 tokens per donor URL. This integration uses that rate as a dated 2026-10-21 minimum local token reservation, not a complete fee model or maximum. Operators choose all three safe nonnegative integer units; indexer/checker zero is allowed only as an explicit local reservation choice and does not establish a zero provider fee. This repository selects no operator profile or active values.

All three create tools share one host guard, shared unit caps and unresolved exact donor-URL holds across target lists and families. V1 stores the ordered donor URLs and full-body digest, not raw target lists, URL/target pairs or new target columns. Exact replay retains its original intent without another POST or fresh ACK after admission; changed targets under the same ID conflict. A valid root ACK must identify `backlink/checker`; conservative optional PPR/drip checks and the common recording/cancellation rules apply. Accepted means durable acknowledgement of job creation, not completed backlink analysis. Use status/report tools for later provider observations; no polling, retry or automation runs here.

## Read-only retry planning

Call `plan_retry` with `{}` for Google or `{"searchEngine":"yandex"}` for Yandex. The only optional input is `searchEngine`, limited to `google` or `yandex`; other fields are rejected by the SDK before the handler. There is no caller-selected policy, key, state path, request ID, proof or resource limit.

Planning uses the same configured host as the three create tools. It requires a matching key, valid enabled private policy with `retry.enabled`, and complete existing V2 state supplied through the existing policy/state options below. It never initializes or migrates state. External or legacy sources additionally require captured `retry.allowUnattributedParents` permission; that flag establishes no original ancestry. No active paths, caps or policy values are supplied here.

| Application status | Meaning                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`            | A regular retry proposal with source/provenance, exact ordered eligible URLs and exclusions, counts, request/body digest, quote/exposure, authorization summary and canonical comparison identity.       |
| `no_source`        | Complete observations found no source for the selected engine; no parent or quote is invented.                                                                                                           |
| `blocked`          | Fixed blockers explain why a proposal is unsafe or unavailable. An incomplete external report can give an unknown URL count with `knownMissingLocalUrls: null`; missing URL identities are not invented. |
| `error`            | A fixed sanitized application failure, with bounded phase/cause enums where applicable and no raw provider body or exception text.                                                                       |

Each application result has identical JSON text and structured content. `isError` is true exactly for `error`; `blocked` and `no_source` are ordinary outcomes. SDK input rejection is a separate boundary and need not contain the application's structured result. The complete application envelope, including `isError`, escaped JSON text and the duplicated `structuredContent`, must fit **2,097,152 UTF-8 bytes inclusively**. Oversize results use a fixed `ResourceLimitExceeded` error rather than a truncated proposal. This bound excludes SDK JSON-RPC framing and does not bound process memory or guarantee hard latency.

The planner observes all Google regular/drip and Yandex regular streams, required statuses and selected reports twice under one original read budget. It selects the latest original indexer source only with proven finality; Google additionally requires Pay-Per-Result evidence. It refuses newer uncertainty or tied creation times rather than falling back to an older task. Exact URL strings are deduplicated without merging trailing slashes or query strings. Local report unions must equal the durable accepted manifest. Permitted external count-complete corpora retain `originalManifestKnown: false` and unknown ancestry. All-family local holds, complete active manifests, scheduled drip coverage and final direct-child indexed evidence constrain exclusions. Matching provider passes are non-atomic observations and do not prove fresh indexing truth or provider-wide history.

Planning creates no jobs, reservations, retry/adoption rows or parent history, and makes no account or create request. Local snapshots cover the selected key's history across scopes/families; logical rows/schema stay unchanged, while SQLite may update physical WAL/SHM bookkeeping. Ready data and opaque policy/revision/authorization/body/quote commitments support comparison only. They grant no proof, admission, human approval or paid dispatch authority; historical hashes cannot reconstruct discarded observations. Credentials, raw credential bindings, private paths/proofs and raw observations remain private.

The shared owner keeps its guard through final local/time/day checks, awaited native settlement and close, then a final freshness check. Clean settled failure permits reuse; unverified cleanup blocks new work in that host until restart while pure previews and exact durable replay remain available. Synchronous SQL/CPU can delay cancellation, and queued JavaScript cancellation needs an I/O opportunity. SDK cancellation may suppress the application reply, so client rejection alone does not establish owner completion. Public `submit_retry` and deterministic one-shot execution remain unimplemented.

## Read-only local retry history

Call `get_retry_history` with `{}` for both Google and Yandex, up to 25 entries. To filter an exact recorded parent and state:

```json
{
  "searchEngine": "yandex",
  "parentTaskId": "parent-task-id",
  "state": "unknown",
  "limit": 2
}
```

The closed input accepts only these optional fields:

| Field          | Contract                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `searchEngine` | `google` or `yandex`; omission selects both.                                                                                         |
| `parentTaskId` | Requires `searchEngine`. Exact, nonblank safe Unicode ID, at most 4,096 UTF-8 bytes; preserve spaces, case and spelling.             |
| `state`        | One of `prepared`, `dispatching`, `accepted`, `rejected`, `unknown`, `cancelled`.                                                    |
| `limit`        | Integer 1 through 25; omission uses 25.                                                                                              |
| `cursor`       | Canonical unpadded base64url text, at most 512 ASCII characters. Pass the returned cursor unchanged with the same filters and limit. |

Extra fields and null selectors are invalid. There is no caller-selected key, policy, path, proof, clock, byte limit or write authority. The CLI uses the existing `--submission-policy` and `--submission-state` setup with a matching key and valid enabled policy to construct a configured host. History does not require `retry.enabled` or adoption permission and does not apply paid-work eligibility or reserve units. It opens only existing complete V2 state, without HTTP, automatic initialization, migration or repair.

| Application status | Contract                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`               | `snapshot` revision/capture time, `coverage`, `counts`, `page` and ordered `entries`. A valid empty store or empty selection returns zero matching entries and `nextCursor: null`.                            |
| `blocked`          | Fixed `reason.code`: `ReadConfigurationUnavailable`, `StateMissing`, or `V2Required`. No entries.                                                                                                             |
| `error`            | Fixed `error.code`: `InvalidInput`, `CursorMismatch`, `SnapshotChanged`, `StateUnavailable`, `HistoryBusy`, `ResourceLimitExceeded`, `Cancelled`, `DeadlineExceeded`, or `InternalError`. No partial entries. |

For example, a configured missing store returns this structured result with `isError: false`:

```json
{
  "status": "blocked",
  "reason": {
    "code": "StateMissing",
    "message": "The configured local state does not exist."
  }
}
```

The snapshot validates the selected key's complete local V2 history across families, scopes, policies and periods before filtering. Entries cover recorded Google/Yandex indexer retry contexts. `counts` separates all local retry attempts, matching attempts before pagination, legacy unattributed records and ambiguous local provider references. Legacy records are not asserted to be retries. `source.recordedAttempts` counts all recorded states for the exact parent family and ID. Coverage inception, earlier discarded history, original ancestry and provider-wide coverage remain unknown, including for an empty result. This is a coherent local observation, not the planner's two-pass provider evidence or a guarantee of response-time freshness.

Each entry includes a comparison-only `attemptRef`, family, state/version, nullable provider ID, ambiguity flag, recorded source attribution, nullable timestamps/reservation/URL count, and unresolved-hold flag. Prepared, dispatching and unknown attempts retain available hold details. Unambiguous accepted attempts retain their submitted URL count but have null timestamps and reservation; rejected/cancelled attempts also have null URL counts. Ambiguous accepted references retain available detail. Timestamp and reservation integers use decimal strings. Unknown metadata stays null rather than zero or a reconstructed value. Source attribution distinguishes local standalone, legacy or retry manifests, ambiguous references and unattributed manifests; original ancestry stays unknown. Credentials, raw request IDs, paths, URLs, ledger identity and proof/ownership preimages stay private.

Entries sort by ordinal `attemptRef`, not chronology. `page.nextCursor` binds the exact query, effective limit and snapshot revision. A changed query returns `CursorMismatch` before revision comparison; a changed revision returns `SnapshotChanged`. Start a new query after either refusal. Each call reads a fresh coherent snapshot; continuation never silently recomputes a page on a new revision. A small page cannot bypass whole-store validation or resource limits, and opaque refs/cursors grant no submission authority.

Every application branch has identical JSON text and structured content, with `isError` true exactly for `error`. SDK input rejection is separate and may have no application structured result. The complete application envelope, including `isError`, escaped JSON text and duplicate structured data, fits **2,097,152 UTF-8 bytes inclusively**. Overflow returns fixed `ResourceLimitExceeded` without truncation. SDK JSON-RPC framing/metadata, RSS and hard latency are outside this bound.

History preserves logical SQL rows/schema/versions but can change physical WAL/SHM bookkeeping and needs writable private storage. The owner keeps one pre-SQL monotonic budget and its independent history guard through native close, an actual I/O cancellation opportunity, awaited budget settlement and a final signal/clock check. Synchronous SQL/CPU can delay cancellation; SDK cancellation may suppress the reply. Client rejection alone proves no owner completion. Reuse follows settled owner cleanup; clean refusals/cancellation permit the next call on the same host. An opaque snapshot `ReadFailure` conservatively disables only that host's history reader until restart. History leaves create/planner authority unchanged. See [maintenance](docs/state-maintenance.md#read-only-local-history) for existing-state and recovery boundaries.

## Read-only report comparison

Call `compare_reports` with exactly one supported `family` and two distinct opaque task IDs:

```json
{
  "family": "google/indexer",
  "beforeTaskId": "before-report",
  "afterTaskId": "after-report"
}
```

Families are `google/indexer`, `google/checker`, `yandex/indexer`, `yandex/checker`, `bing/checker` and `backlink/checker`. IDs must be safe nonblank strings; their exact text and the caller's before/after direction are preserved. The tool uses the existing read client's key and needs no submission policy or local ledger. It creates no jobs, reservations or retry authority.

The result is compared links/backlink evidence, blocked, or a fixed sanitized error. Application `isError` is true exactly for error; SDK input rejection is separate. Generic comparisons retain reported membership changes and unknown omissions. Backlink comparisons retain the matching current target scope and unknown missing donor evidence. Status and generic-report `providerCreatedAt` are separate nullable fields with exact provider strings; backlink report metadata has no date field. Dates do not reorder the caller's IDs. Observations are non-atomic and establish no original corpus equality, original history or live indexing truth.

The owner keeps collection, validation, serialization and awaited native settlement/close within its original budget and final signal/clock fences. The complete escaped application envelope counts both JSON text and duplicated structured content and is bounded inclusively to 2,097,152 UTF-8 bytes. SDK framing, process RSS and hard whole-tool latency are outside that bound. See [architecture](docs/architecture.md#report-comparison) for all read, raw-entry and retention limits.

Backlink fences index donors by exact URL and compare canonical JSON tuples of target links, so duplicate rows keep their multiplicity and the target set stays exact. Index and scratch structures remain charged to retained work. Dense projection accounting can still reach the unchanged 60-second horizon within admitted cardinality and then returns a fixed `DeadlineExceeded` result instead of partial evidence; the matching regression is not a maximum-density, RSS or latency guarantee, and that cost remains an open follow-up. Hosted CI passed the complete source and built suites on the accepted head, and merged-artifact QA repeated the frozen install, build and complete built suite. No live provider call, release or deployment is included.

## Optional operator setup

Use only canonical absolute POSIX paths you explicitly select. The state parent must already exist and be trusted. Initialize a new private state directory with this local command, which requires no key, policy, network or MCP session:

```sh
bun --no-env-file dist/cli.js --init-submission-state '<canonical-absolute-new-directory>'
```

The command creates version-one `ledger.sqlite` state and prints `{"initialized":true,"schemaVersion":1}`. It refuses existing paths, including broken or partial state, and does not create parents. A failed init may leave files for inspection. Do not replace an existing store to bypass reservations. Normal submit opens existing state only; startup and preview do not open it. Normal open verifies complete V1 or V2 state before configuring persistent WAL; it never upgrades a store. SQLite opening and reads can touch sidecar bookkeeping even when an unsupported version is rejected. It performs no repair, bootstrap or reset.

For explicit V2 state, use `--init-submission-state-v2` with a new private directory. Offline migration uses `--migrate-submission-state-v2` with an existing V1 directory and `--backup-directory` with a new private directory. These commands select no operator policy or paid authority; the existing command above still creates V1 only. Drain in-flight calls and stop **all** cooperating hosts first; restart all on the V2 binary afterward. A SQL lock does not prove hosts stopped, and a missing receipt may follow a successful commit. Never restore stale V1 over new V2 activity or holds. See [local state maintenance](docs/state-maintenance.md) for the exact commands, backup verification, recovery prohibitions and internal snapshot limits.

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

Optional fields extend the private policy:

| Field                       | Operator choice                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allowIndexChecks`          | Additional checker opt-in: submissions require both `enabled: true` and `allowIndexChecks: true`, plus a matching profile. Absence or `false` leaves checks disabled.                                                                                                                |
| `indexCheckReservations`    | Optional strict partial map of `google`, `yandex`, `bing`. Each selected engine has a per-URL `{tokens: …, indexer: …, checker: …}` vector; choose all three nonnegative safe integers explicitly, including zero where intended. Empty or absent maps provide no profiles.          |
| `allowBacklinkChecks`       | Additional backlink opt-in: submissions require `enabled: true`, `allowBacklinkChecks: true` and a backlink profile. Absence or `false` disables backlink submission.                                                                                                                |
| `backlinkCheckReservations` | Optional strict per-donor `{tokens: …, indexer: …, checker: …}` vector. Choose every safe nonnegative integer; tokens must be at least 2. An explicit zero for another unit is a local operator choice, not a provider-fee claim.                                                    |
| `retry`                     | Optional strict object with exactly `enabled`, `allowUnattributedParents`, and positive safe-integer `maxAttemptsPerSource`. The adoption flag permits planning from an unattributed corpus without proving parent ancestry; the field alone supplies no evidence or paid authority. |

Compiled local token admission floors dated 2026-10-21 are 3 per URL for Google and 2 for Yandex/Bing, based on the [technical service-cost FAQ](https://en.speedyindex.com/faq/#service-cost). They are minimum local admission values, not a complete fee model; operators may reserve more and must select the other units themselves. Unknown fields, missing units, nulls, fractions, unsafe values, or token amounts below the engine floor in any profile invalidate the entire policy, even if that engine is unselected. This blocks submissions through all three create tools until the policy is corrected and all cooperating hosts restart. Valid previews remain available; the index-check reservation quote is unavailable for an invalid policy.

The backlink token floor comes from the [official English API](https://en.speedyindex.com/api.php#backlink-create), dated 2026-10-21. Missing units, unknown fields, nulls, fractions, unsafe values or a token reservation below 2 in `backlinkCheckReservations` invalidate the whole policy even when `allowBacklinkChecks` is false. An invalid optional flag also invalidates the policy. All three create tools remain blocked until the operator corrects the policy and restarts all cooperating hosts. Indexer/checker unit fees and target-count fee effects remain unknown; the server supplies no default profile values.

The optional `retry` object requires both boolean flags and a positive safe-integer attempt bound, with no additional fields. Missing fields, unknown fields or invalid values invalidate the whole policy and block all three create tools until corrected and all cooperating hosts restart. The object is a private prerequisite for `plan_retry`, alongside matching configuration and existing V2 state. The field alone supplies no verified observations, adoption or retry-submission authority.

A valid private policy can supply reservation previews even with writes disabled, no state path or no key; this grants no write authority. Profiles and the optional retry object are read once and frozen. The active policy's selected profile controls submissions. Optional flag/profile presence and every profile bind the whole policy digest, including unselected engines; changing them can conflict with existing request IDs. Legacy policies with the index-check fields absent retain their original canonical identity. Omitting both backlink fields preserves existing policy bytes and V1 identity; explicitly present `false` or a profile binds a different whole-policy digest. An absent `retry` object also preserves the exact existing canonical digest, while every present retry value, including `false`, binds policy identity. Restart all cooperating hosts after changes, and preserve existing reservations and holds.

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

Two public tools remain in the [roadmap](docs/implementation-plan.md): `submit_retry` and `summarize_campaigns`. Deterministic one-shot execution and scheduling also remain unimplemented. This source branch implements read-only `plan_retry`, `get_retry_history` and `compare_reports`; implementation and synthetic verification do not establish a release, provider activation or delivery of the remaining workflow.

The V2 foundation preserves explicit new-state initialization, offline V1 migration, coherent bounded local snapshots, mode-separated exact replay and internal atomic retry admission. Planning inspection reads period/cap/lifetime decisions without creating reservations or periods. The production owner composes same-key two-pass HTTP observations with final coherent readers under the shared host guard. Local accepted manifests and permitted external observed corpora keep distinct provenance, without invented parents. Internal proofs stay private; public comparison data cannot authorize a paid retry. See the [architecture](docs/architecture.md) for bounds, replay and historical-evidence limits, and [state maintenance](docs/state-maintenance.md) for migration and recovery constraints.

Licensed under [MIT](LICENSE). Documentation framework attribution is in [provenance](docs/provenance.md).

Built by [Anton Gulin](https://github.com/antongulin) · [Anton.QA](https://www.anton.qa).
