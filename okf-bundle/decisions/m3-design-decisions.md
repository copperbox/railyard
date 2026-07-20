---
type: decision
title: M3 design decisions (GitHub monitor)
tags:
  - milestone-m3
  - contracts
  - github
timestamp: 2026-07-20T06:07:51.332Z
---

Decisions for M3 (`@copperbox/railyard-monitor-github`), confirmed with Dan at plan
review (2026-07-19) and shipped the same day. Full rationale in PLAN-M3.md's decisions
table; the payload/dedup contract has
[its own concept](/contracts/github-issue-signals.md).

## Polling mechanism & dedup (wire-adjacent contract)

- **Issue-events API** (`GET /repos/{o}/{r}/issues/events`) via native `fetch` — not
  octokit (heavy dep tree for one endpoint), not the `gh` CLI (would *add* an
  external-binary dep where fetch is zero-dep, and make auth implicit host state;
  inverts the docker-CLI rationale in [M0 decisions](/decisions/m0-design-decisions.md)).
  `gh auth token` is documented as the local-dev token source instead.
- **Dedup = "each GitHub issue-event id emitted at most once"**; cursor = highest
  processed event id per repo, in `ctx.state` (`cursor:<owner>/<repo>`); ETags also
  persisted (`etag:<owner>/<repo>`) so quiet polls are 304s that cost no rate limit.
- **At-least-once across a crash**: emit first, then persist cursor. A crash in the
  window re-emits on restart — recovery, not duplication, since the triggered agent
  run died in the same crash.
- **First run baselines** (cursor := newest event id, nothing emitted) — history is
  never replayed.

## Signal surface: a fixed four-type allowlist

v1 emits exactly `github.issue.labeled`, `.unlabeled`, `.closed`, `.reopened` — two
payload shapes (labeled/unlabeled carry `label`; closed/reopened don't), one JSON
Schema file per type, consumed by **verbatim copy** into agent folders (deep-equality
compat makes identical bytes compatible by construction).

- **All other event kinds are skipped, not signaled**: assigned, renamed, milestoned,
  pinned, etc. advance the cursor but emit nothing. Body edits produce no issue event
  at all.
- **Comments are out of scope for this endpoint**: comments are not issue events —
  only the separate timeline/comments APIs carry them. A future
  `github.issue.commented` is an additive change (second poll, own cursor, new type +
  schema) touching nothing existing.
- Rationale: every signal type is permanent cross-port contract surface (Python/Rust
  ports must honor the schemas forever), so v1 only mints types something consumes.
  M4 needs only `labeled`.

## Other confirmed choices

- **Token via constructor option** (`token?`), not `SecretsProvider` — that seam is
  agent-container machinery (SPEC §8); monitors are host-side user code. Absent token
  ⇒ unauthenticated (60 req/h) with a loud start warning.
- **Boot preflight**: `start()` probes each configured repo; 401/403/404 fails
  `orchestrator.start()` loudly (invariant 4).
- **Monitor test seam went into core's public API**: `createMonitorTestContext(emits)`
  → `{ctx, emitted, logs, kv}` + `MemoryKvStore`, sharing the orchestrator's emit
  validation via the factored `monitor/declared-emissions.ts` helpers — behavior
  cannot drift. The first invariant-9 friction M3 surfaced; core's only M3 change.
- **Fourth test gate**: `RAILYARD_GITHUB_TESTS=1` (`pnpm test:github`), token required
  via `EnvSecretsProvider` once opted in — same never-silently-skip posture as
  [docker-gated tests](/testing/docker-gated-tests.md).

## Shipped implementation notes (deltas found while building)

- **Payload `repo` identity comes from the preflight response**, not string-splitting
  the configured `owner/name` — true `private` flag and html_url, GHE-correct.
- **`issue.author` joined the nullable set** alongside `actor`, `issue.body`,
  `label.color` (deleted "ghost" users null any login).
- **Package dependency form**: core is a `peerDependency` and every import from it is
  type-only — the published monitor has zero runtime deps; a unit test audits the
  import graph (no `railyard/src` or `railyard/dist` deep imports, core imports must
  be `import type`).
- **API assumptions verified live** (and re-verified on every `test:github` run):
  the events endpoint returns newest-first (descending ids) on page 1 — which the
  baseline depends on — and ids are monotonic with created_at, which makes the id
  cursor sound. Collection order never depends on it anyway (client sorts).
- Rate-limit pause is **monitor-wide** (one token across repos); transient errors just
  wait for the next interval (the interval is the backoff), cursor untouched.

Related: [M0](/decisions/m0-design-decisions.md),
[M1](/decisions/m1-design-decisions.md),
[M2 design decisions](/decisions/m2-design-decisions.md),
[github.issue.* signal contract](/contracts/github-issue-signals.md).
