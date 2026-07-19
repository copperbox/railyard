---
type: decision
title: M1 design decisions (safeguards & secrets)
tags:
  - milestone-m1
  - contracts
  - secrets
  - safeguards
timestamp: 2026-07-19T23:37:47.334Z
---

Decisions made implementing M1 (safeguards & secrets) that are not in SPEC.md and
should hold — or be consciously revisited — in later milestones and the Python/Rust
ports. Full rationale in PLAN-M1.md's decisions table; redaction has
[its own concept](/decisions/redaction-literal-matching-min-length.md).

## New journal events (disk contract)

- `run.queued` `{agent, signalId, signalType, queueDepth}` — matched signal waiting at
  the concurrency cap.
- `run.skipped` `{agent, signalId, signalType, reason}` — reason is `self-trigger`
  (refused, SPEC §7) or `shutdown` (queued-then-dropped at stop, or matched during
  shutdown). One event with a reason enum, not two near-identical events.
- `retention.swept` `{removed: [runIds]}` — only journaled when something was pruned.
- `run.finished` gained optional `killReason` (present on timeout kills).
- Beyond-depth-limit emissions reuse the existing `signal.dropped`.

## Guards

- **Depth semantics**: a signal is dropped *at emission* when its provenance length
  would exceed `maxChainDepth` (default 5, `OrchestratorConfig`, not the manifest).
  Chain of N agent hops = last emission has depth N; with limit 5, monitor + 5 agent
  runs happen and the 6th emission drops.
- **Self-trigger is direct-source only**: refused when `signal.source` names the same
  agent (unless `allowSelfTrigger`). A→B→A cycles are legal until the depth limit
  bites — transitive self-trigger detection would just re-implement the depth limit.
  Refusal is per-agent; other matching agents still fire.
- **Queue at stop()**: queued entries are dropped and journaled; in-flight runs drain.
  Dispatches arriving during shutdown are also skipped+journaled. A `timeout: null`
  agent can block `stop()` indefinitely — accepted, the user opted in.

## Timeout

- Timer counts from `docker start`; expiry runs `docker kill` (SIGKILL, exit 137) so
  the normal wait/logs/teardown path completes and captured output survives.
- A kill that loses the race to natural exit is *not* reported as a timeout (kill exit
  code checked).
- `RunRecord.status` stays two-valued (`succeeded`/`failed`); non-null `killReason`
  (e.g. `timeout: exceeded 900s`) is the discriminator.
- `RunAgentParams.timeoutSeconds` omitted = 900 (never silently absent); `null` = the
  explicit indefinite opt-in.

## Secrets

- `SecretsProvider.resolve(name) → Promise<string | undefined>` is the whole seam.
- Default `EnvSecretsProvider`: process env first, then a minimal hand-rolled `.env`
  parser (`KEY=value`, `#` comments, quotes, `\n` expansion inside double quotes
  only; no interpolation). The file is re-read per resolve, so rotation needs no
  restart.
- Boot resolves every declared name (fail loudly, names never values); each spawn
  re-resolves; only manifest-declared names are injected.
- Injection uses value-less `-e NAME` docker flags with values in the docker CLI
  child-process env — secret values never appear on an argv (`/proc` readable).
- Secret names colliding with reserved `AGENT_*` container-contract vars fail the
  loader (`RESERVED_AGENT_ENV_VARS` exported).

## Retention

- Rules combine as the **union** of what each selects ("whichever prunes more wins").
- Only run-shaped directories (`<stamp>--<agent>--<8hex>`) are ever touched —
  `journal.jsonl` is structurally exempt, not denylisted.
- Active run ids are never pruned, whatever their age.
- Sweeps at boot and after each run, inside the tracked run promise (so `stop()`
  waits); unset policy = loud startup warning + journal note.

Related: [M0 design decisions](/decisions/m0-design-decisions.md),
[docker-gated tests](/testing/docker-gated-tests.md).
