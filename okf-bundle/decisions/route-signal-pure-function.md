---
type: decision
title: Subscription matching is a pure, exported routeSignal() — the Orchestrator is one caller
tags:
  - routing
  - public-api
  - safeguards
timestamp: 2026-09-06T23:40:00.000Z
---

The matching loop that used to live inline in the private `Orchestrator.route()`
is now `routeSignal(signal, agents) => RouteOutcome[]` in `src/agents/route.ts`,
exported from the package next to `evaluateFilter` and `loadAgents`. It does no
I/O, no journaling, no dispatch: it returns, in check order, one outcome per
agent that reacted to the signal — `matched` (with the index of the `on:` entry
that fired), `skipped` (self-trigger refusal), or `note` (filter error or
required-payload-schema failure). `Orchestrator.route()` is a thin wrapper that
journals `signal.received`, then walks the outcomes: `matched` → `dispatch()`,
`skipped` → `run.skipped/self-trigger`, `note` → `note`. Behaviour and journal
order are unchanged; the orchestrator routing tests pass as they were. (Issue #5.)

## Why

Routing is the one piece of SPEC §3 (and the self-trigger guard of §7) that a
host **without a long-lived orchestrator** still needs, verbatim. The concrete
case is a router running as a short-lived cloud function: it already imports
railyard's pure modules (contracts, `loadAgents`, `evaluateFilter`,
`renderPromptTemplate`, `Redactor`, journal entry types) but had to
re-implement matching because the loop was a private method with side effects.
A downstream copy of "at most once per signal, first matching `on:` wins, filter
errors are not matches, self-trigger refusal is per agent" is exactly the kind
of semantics that drifts. Invariant 3 says the signal contract is the only
coupling between monitors and agents; the routing rule over that contract should
likewise have one home.

## Design calls

- **Pure function over a class or a strategy object.** The inputs are already
  plain data (`SignalEnvelope`, `LoadedAgent[]`); a function is the smallest
  public commitment and is trivially testable without a temp dir or executor.
- **Outcomes, not callbacks.** Returning a list keeps the function synchronous
  and side-effect free, and lets a caller journal *before* it launches anything.
  The list is ordered as the checks ran, so journaling it in order reproduces the
  in-process orchestrator's journal line for line.
- **`note` carries the finished message string**, the same text the orchestrator
  journaled before. The caller does not get to re-word what a filter error looks
  like; the message is part of the semantics a host inherits.
- **`skipped` has exactly one reason, `self-trigger`.** The other `run.skipped`
  reason (`shutdown`) is a lifecycle decision made in `dispatch()`, not a routing
  decision, so it stays with the orchestrator.
- **Max chain depth stays at emission.** SPEC §7 checks depth when a signal is
  *emitted*, not when it is routed, and `emitSignal()` still owns that. The rule
  itself (`provenance.length > maxChainDepth`) is exposed as
  `exceedsMaxChainDepth()` because it costs one line and a host that ingests
  signals from outside the process must apply it at its own ingest edge.
- **Concurrency, queueing, and launching stay in the `Orchestrator`.**
  `routeSignal` says *who* fires; it says nothing about *whether now*.

## What a host does not get for free

Invariant 5 promises that concurrency, timeout, teardown, depth limit, and
redaction are framework guarantees, "never silently absent". A host that takes
only `routeSignal()` inherits the routing semantics and **none of those
safeguards** — it is the host's job to apply `exceedsMaxChainDepth()` at ingest,
cap concurrency in whatever runs its agents, and redact what it journals. That
is the deliberate scope of this export: a routing primitive, not a portable
orchestrator. Anyone building on it should read this section as a checklist.

Tested directly in `test/route.test.ts` (all four outcome shapes, the
at-most-once rule, per-agent self-trigger refusal, purity) and indirectly by the
existing routing and safeguard tests in `test/orchestrator.test.ts`.

Related: [M0 design decisions](/decisions/m0-design-decisions.md) (routing
shape), [M1 design decisions](/decisions/m1-design-decisions.md) (self-trigger
guard and depth limit).
