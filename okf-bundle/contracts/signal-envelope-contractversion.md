---
type: decision
title: Signal envelope carries a wire-stamped contractVersion ("v1")
tags:
  - contracts
  - milestone-m5
  - versioning
timestamp: 2026-07-20T21:14:29.551Z
---

Decided with Dan during M5 planning (2026-07-20); implementation lands in M5 Step 1.
The "versioned signal-contract documentation" of SPEC §15 is realized **on the wire**,
not documentation-only: every signal envelope carries an explicit contract-version tag.

## The decision

- **A new envelope field `contractVersion: "v1"`** (string tag), sitting alongside
  `id`/`timestamp`/`source`/`provenance`/`type`/`payload` in SPEC §2. It is
  **framework-stamped, never emitter-set** — same rule as the rest of the envelope
  ("set by the framework, never by the emitter", §2). Set in `stampSignal`
  (`bus/stamp.ts`), the single place every envelope is built.
- **String tag `"v1"`, not an integer or `major.minor`.** Matches the doc label
  "railyard Signal Contract v1"; opaque, no numeric ordering to reason about across
  ports. Additive changes (a new `github.issue.*` type, a future prompt-grammar escape)
  do **not** bump it — they don't change the envelope; the tag tracks the *envelope*
  contract only.
- **Validation: the envelope JSON Schema requires `contractVersion` with `const: "v1"`.**
  So `validateSignalEnvelope` (ajv, `contracts/validate.ts`) asserts every stamped
  signal carries exactly the contract this runtime speaks — and catches a typo'd stamp.

## Why this doesn't break M0–M4 (checked against the code)

Emitters never build envelopes, so the field is invisible to all existing user code:

- **Monitors** (`GitHubIssuesMonitor`, the demo interval monitor) call
  `ctx.emit({type, payload})` — a `SignalDraft`. It flows through
  `emitSignal → stampSignal`, which is where the envelope (and now `contractVersion`)
  is minted. One line added; every monitor gets it for free.
- **Agents** (the `claude-code` scaffold, demo agents) emit by appending
  `{kind:"signal", type, payload}` to `$AGENT_EVENTS_FILE`; the events-tailer re-drafts
  each line back through the **same `stampSignal`**. Agent-emitted signals are
  re-stamped too — the scaffold writes `type`+`payload`, never the envelope.
- **Payload schemas are untouched** — `contractVersion` is on the *envelope*; the M3
  verbatim-copy schemas (`github-issue-labeled.schema.json`) validate `payload`. The
  [deep-equality consumption story](/contracts/github-issue-signals.md) and the copied
  schema in `examples/github-review` don't change; no re-copy, no compat break.
- Internal-only churn: the envelope schema gains a required property, and in-repo
  tests/fixtures that hand-build envelope literals add the field.

## The forward-compat policy is deliberately deferred to v2

In v1 there is **no path that ingests a foreign signal** — no out-of-process transport
yet (a v2 non-goal in SPEC §14), so `validateSignalEnvelope` only ever runs on signals
the framework *just stamped*, which are always `"v1"`. The "unknown version" branch
cannot fire in v1. Therefore:

- **No warn/journal/drop machinery and no `requiredContractVersion` manifest field in
  v1** — both would guard a scenario that can't occur, violating "only add what's
  demanded". Earlier drafts proposed warn+journal+drop; tracing that
  `validateSignalEnvelope` is only on the stamp path removed the justification.
- **The mismatch *policy* (lenient-warn vs. hard-reject vs. boot-time negotiation) is a
  v2 decision**, made when the transport that can carry foreign signals exists. Dan's
  forward-compat instinct ("don't reject a v1 thing for not being v2; only error on a
  genuine agent-expects-vN mismatch") is honored precisely by *not* pre-committing to a
  reject-on-mismatch rule now — and by choosing a comparable string tag so a future
  multi-version runtime has a clean negotiation key. The natural home for that check is
  **boot**, mirroring the existing schema-compatibility check (SPEC §10 step 2,
  invariant 4), not a per-signal 2am drop.

## Package versioning (paired choice)

Both packages publish at **`1.0.0`** (peer range `^1.0.0`), a coherent pairing: 1.0.0
artifacts that emit Signal Contract v1 on the wire.

Related: [github.issue.* signal contract](/contracts/github-issue-signals.md),
[prompt template grammar](/contracts/prompt-template-grammar.md) (the sibling cross-port
disk contracts the v1 documentation also formalizes),
[M4 design decisions](/decisions/m4-design-decisions.md).
