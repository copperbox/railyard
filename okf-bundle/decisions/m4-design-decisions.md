---
type: decision
title: M4 design decisions (user-zero dogfood)
tags:
  - milestone-m4
  - github
  - secrets
  - contracts
timestamp: 2026-07-20T16:36:18.526Z
---

Decisions for M4 (`examples/github-review` — the user-zero workflow), confirmed with
Dan at plan approval (2026-07-19) and shipped 2026-07-20. Full rationale in PLAN-M4.md's
9-entry decisions table. SPEC §15's M4 sentence made demonstrably true: a `needs-review`
label on a `copperbox/railyard` issue → a Claude Code container writes a triage review
into the run record.

## What shipped

The example app: `Orchestrator` + [GitHubIssuesMonitor](/contracts/github-issue-signals.md)
on `copperbox/railyard` + an `issue-reviewer` agent (a copy of `scaffolds/claude-code`).
Real run: three issues of varied quality (well-formed / medium / vague one-liner) each
produced a genuinely useful triage review — 1 turn each, **$0.166 total**, `claude-sonnet-5`
under a `--max-budget-usd 0.50` cap. No new automated tests (boot + the real run are the
proof, per the plan); the two friction fixes below carry their own tests.

## The dogfood shape (confirmed choices)

- **Target `copperbox/railyard` itself** — the framework reviews issues about itself
  (retargeted from `dantheuber/jeeves` at approval). Filing the tracker's first real
  issues from the deferred-work backlog (ghcr publication #1, comment-posting #2,
  template escapes #3) was itself part of the dogfood.
- **Runs/-only first pass**: the review lands in `runs/<id>/output/result.json`; the
  agent performs **no GitHub writes of any kind**. Comment-posting is the candidate
  second pass — **banked** (Dan, 2026-07-20) as issue #2, not promoted.
- **Issue-text-only grounding**: the review works from the signal payload; no repo
  clone. The `prompt.md` scopes Claude to the issue text and forbids tool use.
- **Least privilege fell out of the architecture**: the container declares **Claude
  auth as its only secret — no `GITHUB_TOKEN` inside**. The monitor (host-side) reads
  with Dan's token; the agent needs nothing from GitHub because the payload is already
  the input (SPEC §8 posture, by construction rather than bolted on). This is the
  headline win banking the second pass preserves.
- **Model/budget knobs are Dockerfile ENV** from the scaffold's copy-and-edit design:
  `CLAUDE_MODEL=claude-sonnet-5`, `CLAUDE_MAX_TURNS=8`, `CLAUDE_EXTRA_ARGS=--max-budget-usd 0.50`.
- **Schema consumed by verbatim copy** — the M3 [consumption story](/contracts/github-issue-signals.md)
  for real: `github-issue-labeled.schema.json` copied byte-identical into the agent
  folder (deep-equality compat makes identical bytes compatible; any edit fails boot).

## Friction fixed in core's public API (SPEC §15: friction fixed before anything is added)

The friction log (`docs/m4-friction.md`) is the milestone's true deliverable; every line
ends fixed-with-test, fixed-in-docs, or not-framework. The two core fixes, both additive
and backward-compatible:

- **`Orchestrator.on`/`off` are now generic over the event literal** —
  `on<E extends JournaledEntry['event']>(event: E, handler: (entry: Extract<JournaledEntry, {event: E}>) => void)`.
  Wiring a handler no longer needs a redundant `if (e.event !== 'run.finished') return`
  guard to see that event's own fields. Type-level only, no new export, no runtime
  change. Test: `orchestrator.test.ts` `expectTypeOf` case; the example's three-line
  narration dropped its guards as the worked proof.
- **`EnvSecretsProviderOptions.envFile` docstring** now warns the default is
  **cwd-relative** (the package dir under `pnpm start`, not the repo root) and
  recommends an explicit absolute path for workspace apps. Behavior unchanged (correct
  and intentional — changing it would silently move where M2/M3 resolve secrets); the
  example resolves one repo-root `.env` via an explicit `envFile` from `import.meta.url`.

The run itself surfaced **no framework friction** — label→signal latency was one poll
tick, the concurrency cap queued and drained in order (`run.queued` depth 1), the
journal narrated coherently, teardown and SIGINT stop were clean, the ETag cursor
advanced correctly.

## Invariant 9 held

The example imports only `@copperbox/railyard` and `@copperbox/railyard-monitor-github`
public exports — no deep imports into either package's `src/`. The example is a real
external consumer, same as the M3 monitor is.

Related: [M0](/decisions/m0-design-decisions.md), [M1](/decisions/m1-design-decisions.md),
[M2](/decisions/m2-design-decisions.md), [M3](/decisions/m3-design-decisions.md),
[github.issue.* signal contract](/contracts/github-issue-signals.md),
[prompt template grammar](/contracts/prompt-template-grammar.md).
