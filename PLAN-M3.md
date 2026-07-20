# M3 implementation plan — GitHub monitor

> **Status: IN PROGRESS (approved by Dan, 2026-07-19).**

Goal (from SPEC §15): `@copperbox/railyard-monitor-github` — polls GitHub issues, uses
`ctx.state` for cursors, owns its dedup semantics, emits `github.issue.*` signals with
published JSON Schemas. Built **strictly against public core exports** — invariant 9 is
as much the deliverable as the monitor: any friction found gets fixed in core's public
API, not worked around.

Contract-sensitive decisions confirmed with Dan (2026-07-19) before drafting:
transport is native `fetch` against the **issue-events API** (not octokit, not the `gh`
CLI — `gh` would only replace the HTTP layer while adding an external-binary dependency
and implicit auth state; `gh auth token` is instead documented as the local-dev way to
mint a token); v1 emits **four event kinds** (`labeled`, `unlabeled`, `closed`,
`reopened`); delivery across a crash window is **at-least-once**; the monitor test seam
(`createMonitorTestContext` + `MemoryKvStore`) **goes into core's public API**.

M3 splits in two:

- **Core work** (step 2): the offline monitor-testing seam — the first invariant-9
  friction this milestone surfaces. Monitor authors need to unit-test emit sequences
  without an orchestrator; core grows a harness that shares the orchestrator's real
  emit-validation code path so behavior cannot drift.
- **Monitor work** (steps 1, 3–8): the second workspace package, its published payload
  schemas, a zero-dep GitHub client, the poll/dedup loop, and four test tiers.

Steps 1–6 need no Docker and no network; step 7 adds a new real-API gate
(`RAILYARD_GITHUB_TESTS=1`); step 8 is the Docker-gated exit proof. `pnpm test` and
`pnpm test:docker` stay green after every step.

### New contract surface (review carefully — language-neutral, cross-port)

**Signal types** (v1, all always declared — agents subscribe to what they want;
routing already filters):

| Type | Source event | Payload shape |
|---|---|---|
| `github.issue.labeled` | events-API `labeled` | shape **A** (with `label`) |
| `github.issue.unlabeled` | events-API `unlabeled` | shape **A** |
| `github.issue.closed` | events-API `closed` | shape **B** (no `label`) |
| `github.issue.reopened` | events-API `reopened` | shape **B** |

**Payload shape A** (`github.issue.labeled` / `.unlabeled`) — all fields required,
`additionalProperties: false` throughout (under deep-equality compat, any change is a
new contract anyway; strictness makes drift fail visibly):

```jsonc
{
  "repo":  { "owner": "copperbox", "name": "railyard",
             "fullName": "copperbox/railyard",
             "url": "https://github.com/copperbox/railyard", "private": false },
  "issue": { "number": 42, "title": "…", "body": "… or null",
             "state": "open",              // "open" | "closed"
             "author": "dan-essig",        // login; users are login strings everywhere
             "labels": ["bug", "needs-review"],     // current names, filter-friendly
             "assignees": ["dan-essig"],
             "url": "https://github.com/copperbox/railyard/issues/42",
             "apiUrl": "https://api.github.com/repos/copperbox/railyard/issues/42",
             "createdAt": "2026-07-19T10:00:00Z", "updatedAt": "…" },
  "label": { "name": "needs-review", "color": "d73a4a" },  // color nullable — events-API label carries name+color only
  "actor": "dan-essig",                    // who did it; nullable (ghost users)
  "eventId": 31415926535,                  // GitHub's issue-event id — the dedup key
  "occurredAt": "2026-07-19T12:34:56Z"     // the event's created_at
}
```

**Shape B** (`.closed` / `.reopened`): identical minus `label`.

**Everything else is skipped, not signaled.** The four types above are a fixed
allowlist: all other event kinds the endpoint yields (assigned, renamed, milestoned,
pinned, …) are consumed to advance the cursor but never emit signals; issue body edits
produce no issue event at all. **Comments are out of scope for this endpoint** —
comments are not issue events (only the separate timeline/comments APIs carry them),
so a future `github.issue.commented` would be an additive change: a second poll with
its own cursor, a new type + schema file, nothing existing touched. Every signal type
is permanent cross-port contract surface, so v1 only mints types something consumes.

Notes: `issue` is a snapshot **at poll time**, not at event time (the events API embeds
the current issue object; historical snapshots don't exist). Nullable: `issue.body`,
`label.color`, `actor`, and `issue.author` (deleted "ghost" users make any login null). M4's filter is `$.label.name == "needs-review"` — expressible
in the existing filter grammar.

**Published schema files** — the consumption story: four files in the package's
`schemas/` dir (`github-issue-labeled.schema.json`, `-unlabeled`, `-closed`,
`-reopened`), exported via `"./schemas/*"` exactly like core. Because compat (M0
decision 5) is deep structural equality, **agents copy the schema file into their
folder verbatim** and point `payloadSchema` at the copy — identical bytes are
structurally equal by construction. One file per signal type ($id/title differ; the
A-shape duplication between labeled/unlabeled is accepted — each file must stand alone
for copying). $id: `https://schemas.copperbox.dev/railyard-monitor-github/<file>`.

**Monitor state contents** (per-monitor JSON file under `stateDir`, owned by the
monitor — documented, versioned informally in the README):

- `cursor:<owner>/<repo>` → number — highest fully-processed event id.
- `etag:<owner>/<repo>` → string — page-1 ETag; conditional requests make quiet polls
  free (304s don't count against rate limit).

**Core public API additions** (step 2, all additive):
`MemoryKvStore` (in-memory `KeyValueStore`) and
`createMonitorTestContext(emits: SignalDeclaration[])` →
`{ ctx: MonitorContext, emitted: SignalDraft[], logs: {level, message}[], kv: KeyValueStore }`.

---

## Step 1 — Package scaffold

`packages/railyard-monitor-github` (published name `@copperbox/railyard-monitor-github`):

- Same toolchain as core: ESM-only, tsup, vitest, strict TS, Node ≥ 20.
- **Zero runtime dependencies.** `@copperbox/railyard` is a `peerDependency` (plain
  semver range) + `devDependency` (`workspace:*`) — the monitor imports **types only**
  (`Monitor`, `MonitorContext`, `SignalDeclaration`, `JsonSchema`); runtime core usage
  exists only in tests. An external user's app provides core; no dual-copy risk.
- Scripts: `test`, `test:docker`, `test:github` (the new gate, step 7), mirroring the
  cross-env pattern. Root gains `"test:github": "pnpm -r --workspace-concurrency=1
  test:github"`; existing root scripts pick the package up automatically (`pnpm -r`
  skips packages lacking a script).
- `exports`: `"."` → dist, `"./schemas/*"` → `./schemas/*`; `files`: dist + schemas.

**Done when:** workspace builds, an empty test runs green, root `pnpm test` /
`test:docker` still green.

## Step 2 — Core: the offline monitor-test seam (invariant-9 fix)

The friction: a monitor author cannot unit-test emit sequences without booting an
orchestrator. Fix in core, shared code path so the harness can't lie:

- Factor `register()`'s declaration compilation (duplicate-type check +
  `compilePayloadSchema` per declaration) and `emitSignal`'s draft validation
  (undeclared type / schema failure, same messages) into internal helpers used by
  **both** the orchestrator and the harness.
- `MemoryKvStore`: in-memory `KeyValueStore` — for tests and ephemeral monitors.
- `createMonitorTestContext(emits)`: returns a real `MonitorContext` whose `emit`
  validates exactly like the orchestrator (throws on undeclared type / invalid
  payload), records validated drafts to `emitted` in order, captures `log` calls, and
  wires `state` to a fresh `MemoryKvStore` (also returned as `kv` for seeding cursors
  and asserting them after).

**Done when:** core unit tests cover: valid emissions recorded in order; undeclared
type throws with the orchestrator's message; schema-invalid payload throws naming the
errors; duplicate declaration rejected; kv seeding visible to the monitor and mutations
visible to the test; existing orchestrator tests untouched and green.

## Step 3 — The signal contract: schemas + TS mirrors

- The four schema files (source of truth), authored per the shapes above, matching
  core's schema style (`$schema` 2020-12, `$id`, `title`, `description`, `$defs` for
  `repo`/`issue`/`actor` reused within each file).
- TS side: schema JSON imported (inlined into dist at build — the published package
  stays self-contained), exported as `GITHUB_ISSUE_LABELED_SCHEMA` etc.;
  `GITHUB_ISSUE_SIGNAL_TYPES` constant; payload interfaces
  (`GitHubIssueLabeledPayload`, …) mirroring the schemas for DX (core's pattern:
  schemas are truth, TS mirrors for ergonomics).
- `githubIssueEmits: SignalDeclaration[]` — the monitor's `emits` value, one entry per
  type.

**Done when:** unit tests: every shipped file compiles under core's
`compilePayloadSchema`; the exported constants deep-equal the on-disk files (catches
bundling drift); good fixture payloads validate; fixtures with a missing field, an
extra field, or a wrong type are rejected (proving `additionalProperties: false` and
required-ness); labeled/unlabeled differ only in `$id`/`title`/`description`, ditto
closed/reopened (guards the shared-shape promise).

## Step 4 — GitHub client (internal, zero-dep)

`src/client.ts` — a thin typed wrapper over injected `fetch`, no monitor logic:

- Request builder: `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer <token>` when configured,
  `If-None-Match` when an ETag is supplied; `per_page=100`; Link-header pagination
  (hand-rolled — one regex).
- `listIssueEvents(repo, { sinceId, etag, pageLimit })`: fetches pages until an event
  `id <= sinceId` is seen or `pageLimit` (default 10) exhausts; returns
  `{ events (sorted ascending by id), etag, gap: boolean }` — `gap: true` when the cap
  hit before reaching the cursor. Sorting defensively by id means correctness doesn't
  depend on GitHub's documented ordering (verified against reality in step 7).
- `getRepo(repo)`: the boot preflight probe.
- Response classification: `{ kind: 'ok' | 'notModified' | 'rateLimited' | 'error' }`;
  `rateLimited` = 403/429 with `retry-after` or `x-ratelimit-remaining: 0`, carrying
  the resume time (from `retry-after` seconds or `x-ratelimit-reset` epoch).

**Done when:** unit tests with a canned-response fetch stub: auth header present/absent
by config; api-version and accept headers always sent; pagination follows Link until
cursor; page cap sets `gap`; 304 short-circuits; 403-with-reset and 429-with-retry-after
classify with correct resume times; 401/404/500 classify as `error` with status and
body excerpt; events sorted ascending regardless of response order.

## Step 5 — `GitHubIssuesMonitor`: poll loop, cursor, dedup

The monitor class, `src/monitor.ts`:

```ts
new GitHubIssuesMonitor({
  repos: ['copperbox/railyard'],   // "owner/name"[], required, non-empty
  token: process.env.GITHUB_TOKEN, // optional; absent ⇒ unauthenticated (60 req/h) + loud warn at start
  pollIntervalMs: 60_000,          // default; validated > 0
  includePullRequests: false,      // default; issues API surfaces PR events too
  name: 'github-issues',           // default; override for multiple instances (distinct state files)
  apiBaseUrl: 'https://api.github.com', // default; GHE support for free
  pageLimit: 10,                   // default; per poll per repo
  fetchImpl,                       // test seam; defaults to globalThis.fetch
})
```

- Constructor validates config and throws (fail before boot). `emits` =
  `githubIssueEmits`, always all four.
- **`start(ctx)` preflight** (invariant 4 — fail at boot, not 2am): `getRepo` for each
  configured repo; 401/403/404 fails `start()` (and therefore `orchestrator.start()`)
  with a message naming the repo and the likely cause. Then one immediate poll, then
  `setInterval`. Overlapping ticks are skipped (in-progress flag), `stop()` clears the
  timer and awaits any in-flight poll.
- **Poll, per repo:** load cursor + etag from `ctx.state` → `listIssueEvents` →
  keep events with kind in the four, drop PR events (`issue.pull_request` present)
  unless `includePullRequests` → map to payloads → ascending order: `ctx.emit(...)`
  then `ctx.state.set(cursor, id)` per emitted event (**at-least-once**: a crash
  between emit and persist re-emits on restart — recovery, not duplication, since the
  triggered run died in the same crash) → after the batch, cursor := max id seen
  (including filtered events; skipped ids re-fetched after a mid-batch crash are
  filtered again idempotently) and etag persisted.
- **First poll per repo (no cursor): baseline.** Cursor := newest event id (0 if
  none), nothing emitted, `log.info` "baseline established" — history is never
  replayed. `gap: true` from the client logs a **loud error naming the skipped id
  range** — never silent (invariant 10).
- **Rate limiting:** a monitor-wide pause gate (token is shared across repos). On
  `rateLimited`, skip all polls until the resume time, one `log.warn` with the resume
  timestamp. Other errors: `log.error`, cursor untouched, next tick retries (the
  interval is the backoff).

**Done when:** unit tests via `createMonitorTestContext` + fetch stub — the harness
auto-validates every emission against the published schemas, so payload-shape coverage
is structural: baseline emits nothing and sets cursor; a batch of mixed events emits
only the four kinds, ascending, with correct payloads; PR events skipped by default and
included when opted in; cursor advances so a re-poll of identical data emits nothing
(dedup); a seeded mid-batch cursor emits only the tail (at-least-once semantics
visible); multi-repo cursors independent; 304 emits nothing; rate-limit pause skips
polls until resume, then resumes; poll overlap skipped; `stop()` halts cleanly
mid-interval; preflight failure throws naming the repo; missing token warns loudly.

## Step 6 — Consumption story + orchestrator integration (no Docker)

Prove the schema-copy story and the public-API claim against the real core:

- Fixture agent folder (in the monitor package's tests): `manifest.yaml` subscribing to
  `github.issue.labeled` with filter `$.label.name == "needs-review"`,
  `payloadSchema: ./issue-labeled.schema.json` — a **verbatim copy** of the shipped
  file. Unit test via core's public `loadAgentFolder` + `checkSubscriptionCompatibility`:
  the copy is compatible; a mutated copy (one field renamed) is rejected — deep
  equality is really enforced, and the README's "copy the file" instruction is honest.
- Integration test, real `Orchestrator`, empty `agentsDir`, no Docker: register the
  monitor with a fetch stub, `start()`, assert `signal.received` journal entries with
  `source: { kind: 'monitor', name: 'github-issues' }` and envelope-valid signals;
  `stop()` clean.
- The monitor package's imports are audited: only `@copperbox/railyard` (public
  surface) — no deep imports into core `src/` anywhere (a lint-level grep test keeps
  it that way).

**Done when:** all of the above green under plain `pnpm test`.

## Step 7 — Real-API gate: `RAILYARD_GITHUB_TESTS=1`

Fourth test tier, same never-silently-skip posture as Docker/LLM gates:

- `describe.skipIf` on the var (strict `=== '1'`); skipped suites visibly reported.
- When set, `beforeAll` **fails loudly** if `GITHUB_TOKEN` is unresolvable via core's
  `EnvSecretsProvider` (so a repo-root `.env` works) — opted-in-but-unmet never passes
  silently. Docker not required (monitors are host code).
- Scripts: package `"test:github": "cross-env RAILYARD_GITHUB_TESTS=1 vitest run"`;
  root fans out with `--workspace-concurrency=1`.
- Tests (read-only, a handful of requests against a stable public repo,
  e.g. `octocat/Hello-World`): preflight succeeds; a real events page parses and
  validates our shape assumptions (ids monotonic with creation order, label field =
  name+color, `pull_request` marker present on PR-issues) — **this is where the
  newest-first ordering assumption meets reality**; an ETag round-trip yields 304;
  rate-limit headers present and parseable. Never asserts on volatile content.

**Done when:** `pnpm test:github` green locally with a token; `pnpm test` /
`test:docker` remain green and network-free.

## Step 8 — Docker-gated exit proof

SPEC §15's M3 sentence, demonstrably true end-to-end, in the monitor package behind
the existing Docker gate:

- Fixture agent (alpine + `sh`, echo-agent style) subscribing to
  `github.issue.labeled`, filter `needs-review`, schema copy from step 6.
- Fetch stub scripted to emit one `labeled` event for a `needs-review` label (plus a
  decoy event that must be filtered out). Boot the real orchestrator: monitor polls →
  signal emitted → routed through the filter → container runs → input `signal.json`
  round-trips the full payload → run record `succeeded` → journal coherent; monitor
  cursor advanced in the real `JsonFileKvStore` under `stateDir`.
- This is M4's workflow minus the real GitHub API and the real Claude agent — both
  swap in without touching the monitor.

**Done when:** green under `pnpm test:docker` at the root (workspace-concurrency=1
already serializes the two packages' Docker suites).

## Step 9 — Wrap-up

- Monitor README: config reference; token guidance (`gh auth token` one-liner for
  local dev, fine-grained PAT with Issues:read for real deployments — credential
  scoping per SPEC §8's posture); the four signal types + payload docs; **the
  schema-copy consumption story**; dedup semantics, at-least-once delivery, and the
  state-file contents; rate-limit behavior; unauthenticated caveats.
- Mark PLAN-M3.md complete with final test counts; root README mentions the package.
- Brain: `/decisions/m3-design-decisions.md` (linked to M0–M2); new concept for the
  `github.issue.*` payload contract + dedup semantics (cross-port surface); update
  `/testing/docker-gated-tests.md` (fourth gate); note the core test-seam addition.

**M3 exit criteria:** SPEC §15's M3 sentence demonstrably true; the monitor package
builds and tests exactly as an external consumer (public exports only, peer dep,
type-only imports); four `github.issue.*` schemas published with the copy-consumption
story proven against core's compat check; dedup/cursor semantics documented and
tested including the crash window; all four test tiers green (`test`, `test:docker`,
`test:github`, `test:llm` untouched); M0–M2 public exports unchanged (only added to).

---

## Decisions taken (veto anytime before the step that locks them in)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | HTTP transport | Native `fetch`, zero deps; not octokit, not `gh` CLI | octokit is a heavy dep tree for one endpoint; `gh` inverts the docker-CLI precedent (there the CLI *avoided* a dep; here it would *be* one) and makes auth implicit host state. Confirmed with Dan; `gh auth token` documented as the token source instead |
| 2 | Poll endpoint + dedup | Issue-events API; dedup = "each GitHub event id emitted at most once"; cursor = highest processed id per repo | Discrete events with monotonic ids beat snapshot diffing: crisp dedup, actor attribution, catches reverted label changes, ETag-friendly. Confirmed with Dan |
| 3 | v1 signal set | `labeled`, `unlabeled`, `closed`, `reopened` — all four kinds one events poll yields; no `opened` (needs a second mechanism; M4 doesn't need it; adding later is additive) | Confirmed with Dan |
| 4 | Payload shape | Trimmed snapshot (shapes A/B); users are login strings; `labels` are name strings (filter-friendly); nullable `body`/`color`/`actor`; all fields required, `additionalProperties: false` | Enough for a reviewer agent without mirroring GitHub's full object; under equality-compat any change is a new contract, so strictness just makes that visible |
| 5 | Delivery across crash | At-least-once: emit, then persist cursor per event; batch-end cursor covers filtered ids | The triggered run died in the same crash — re-emitting is recovery; silent drops would violate the spirit of invariant 10. Confirmed with Dan |
| 6 | First-run baseline | Cursor := newest event id, nothing emitted, logged | Replaying history would flood agents on first boot; opt-in backfill can arrive later |
| 7 | Token delivery | Constructor option (`token?`); absent ⇒ unauthenticated + loud start warning | Monitors are host-side user code — `SecretsProvider` is agent-container machinery (SPEC §8) and doesn't apply; explicit config beats implicit env reads |
| 8 | Boot preflight | `start()` probes each repo; auth/404 failures fail `orchestrator.start()` | Invariant 4: a bad token dies at boot with a named cause, not as a 2am 401 loop |
| 9 | Rate limits | Honor `retry-after` / `x-ratelimit-reset` via a monitor-wide pause gate; ETags persisted in `ctx.state` (304s are free); other errors retry next tick | The interval is the backoff for transient errors; hammering a rate-limited token for the rest of the hour is the one behavior that must not happen |
| 10 | PR events | Excluded by default (`includePullRequests: false`) | The issues API surfaces PRs too; the dogfood workflow is issues — opt-in beats surprise |
| 11 | Multi-repo | One instance, `repos: string[]`, per-repo `cursor:`/`etag:` state keys | A loop over repos is cheap; N instances would collide on monitor name and state file |
| 12 | Page cap | `pageLimit` (default 10 × 100 events) per poll; hitting it logs a loud gap error naming the skipped id range | Bounds worst-case poll cost; a silent gap would be an invariant-10 violation |
| 13 | Monitor test seam | `createMonitorTestContext` + `MemoryKvStore` in **core's** public API, sharing the orchestrator's validation code path | The invariant-9 friction M3 exists to surface: every monitor author needs this; a test-local fake would drift. Confirmed with Dan |
| 14 | Core dependency form | `peerDependency` (+ dev for tests); imports are type-only; package has zero runtime deps | The user's app provides core; no dual-copy risk; the strongest possible form of "built against public exports" |
| 15 | GitHub test gate | `RAILYARD_GITHUB_TESTS=1`, `pnpm test:github`, token required via `EnvSecretsProvider` once opted in | Same never-silently-skip posture as the Docker/LLM gates; real-API tests must never burn rate limit silently in CI |
| 16 | Schema packaging | One file per signal type, `"./schemas/*"` export, shape duplication accepted; agents consume by verbatim copy | Deep-equality compat makes the bytes the contract; each file must stand alone to be copied |
