---
type: pattern
title: github.issue.* signal contract (payloads, dedup, consumption)
tags:
  - milestone-m3
  - contracts
  - github
timestamp: 2026-07-20T06:07:26.481Z
---

The cross-port contract surface `@copperbox/railyard-monitor-github` publishes —
Python/Rust ports must reproduce these byte-for-byte semantics. Source of truth: the
four JSON Schema files in the package's `schemas/` dir; rationale in
[M3 design decisions](/decisions/m3-design-decisions.md).

## The four types and two shapes

`github.issue.labeled` / `.unlabeled` (shape A, carries `label: {name, color}`) and
`github.issue.closed` / `.reopened` (shape B, no `label`). One self-contained schema
file per type (`$id`/`title`/`description` differ; A- and B-pair contents are
otherwise identical — a unit test enforces this).

Both shapes: `repo` (owner, name, fullName, url, private — taken from the boot
preflight's `GET /repos/{o}/{r}` response, so `private` and urls are true and
GHE-correct), `issue` (poll-time snapshot: number, title, body, state, author, label
*names*, assignee logins, url, apiUrl, createdAt, updatedAt), `actor`, `eventId`
(GitHub's issue-event id — the dedup key), `occurredAt` (the event's created_at).

- Users are **login strings**, not objects. `labels` are **name strings**
  (filter-friendly: `$.label.name == "needs-review"` and `$.issue.labels[*]` work in
  the core filter grammar).
- Nullable: `issue.body`, `label.color`, `actor`, `issue.author` (ghost users).
- Everything required, `additionalProperties: false` at every level — under
  deep-equality compat any change is a new contract, so strictness only makes drift
  visible.

## Consumption story

Core compat = deep structural equality ⇒ agents **copy the schema file verbatim**
into the agent folder and point `payloadSchema` at the copy. Identical bytes are
compatible by construction; a mutated copy fails boot (both directions are tested
against core's real `checkSubscriptionCompatibility`). Files are also exported as
`@copperbox/railyard-monitor-github/schemas/*` and as TS constants.

## Dedup, cursor, state (monitor-owned semantics)

- Rule: **each GitHub issue-event id is emitted at most once**; cursor = highest
  processed event id per repo.
- `ctx.state` keys per repo: `cursor:<owner>/<repo>` (number),
  `etag:<owner>/<repo>` (string — conditional requests make quiet polls 304s, which
  cost zero rate limit).
- First start **baselines** (cursor := newest event id, no emissions); delete the
  state file to re-baseline. History is never replayed.
- **At-least-once across a crash**: emit, then persist cursor per event (batch-end
  write covers filtered ids). Re-emission after a crash is recovery — the triggered
  run died in the same crash.
- Poll shape: page-1-newest-first with Link pagination back to the cursor
  (empirically verified against the real API, and re-verified by the
  `RAILYARD_GITHUB_TESTS` suite: descending ids on page 1, ids monotonic with
  created_at). A `pageLimit` cap that stops before reaching the cursor logs a **loud
  gap error** naming the missed id range — never silent (invariant 10).
- Non-allowlisted event kinds advance the cursor without emitting; PR events are
  skipped unless `includePullRequests`. Comments are not issue events — a future
  `github.issue.commented` is an additive second poll.

Related: [docker-gated tests](/testing/docker-gated-tests.md),
[prompt template grammar](/contracts/prompt-template-grammar.md) (the sibling
cross-port contract from M2).
