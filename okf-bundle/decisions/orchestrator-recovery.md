---
type: decision
title: Orchestrator restarts recover running containers instead of killing them (detach / drain / cancel, lifecycle records, ledger, watchdog)
tags:
  - safeguards
  - concurrency
  - docker
  - contracts
timestamp: 2026-09-14T00:00:00.000Z
---

Shipped in railyard 2.0.0 for issue #7 (downstream: Dispatch needs to deploy itself and
upgrade railyard while long agent runs continue). Before: `stop()` drained active runs and
*dropped* the queue; a restart's boot sweep `docker rm -f`'d every labeled container,
live ones included. After: the process is disposable and the runs directory is the unit
of ownership. User-facing contract: `docs/lifecycle-and-recovery.md`; SPEC §6.5/§6.6,
§10, §12, invariant 11.

## The decisions

- **Three explicit shutdown modes, `drain` is the default.** `drain` keeps 1.x's
  wait-for-active behavior but *keeps* the queue (the one behavioral change to a bare
  `stop()`); `detach` releases supervision without touching containers and returns
  promptly; `cancel` kills and drops, journaled. Repeated/concurrent stops share one
  promise (first mode wins) — `stop()` is deliberately not `async` so the same promise
  object is returned. During boot a stop waits for boot to settle; a failed boot leaves
  the instance `idle` and restartable and makes the pending stop a no-op.
- **Files, not a database.** `runs/<runId>/lifecycle.json` (versioned launch intent +
  phase machine, written *before* `docker create`), `runs/queue/<agent>--<signalId>.json`
  (accepted deliveries; deterministic name so re-acceptance overwrites), and
  `runs/ledger.json` (routed signal ids, deliveries, work identities; whole-document
  atomic rewrite, expiring done entries). All write-temp-then-rename. Consistent with
  "observability is data we keep" and the existing promise-queue write model.
- **The container name is the identity.** `railyard--<runId>` is deterministic, so the
  record alone is enough to find the container again; `docker inspect` by name is the
  observe primitive. "Missing" is concluded only from a definite not-found; any other
  failure is `BackendUnavailableError` and fails boot without changing anything.
- **Recovery runs after locks and before anything destructive** — before retention, the
  orphan sweep, queue admission, and monitor start. The transport is subscribed *before*
  recovery so reattached runs can emit; launches wait for images (`canLaunch` requires
  `imagesReady`), so early emissions queue durably instead of racing the build. The queue
  directory is read *in* reconcile (so its version check precedes every sweep) and
  admission dedupes against in-memory pending work, so an emission accepted during boot
  is not admitted a second time when the restored queue is replayed.
- **Retry policy is asymmetric and explicit.** A record whose container never started
  (`intent`/`created` + missing) is requeued as a fresh run — nothing ran, so it is safe.
  A `started` record with a missing container is `interrupted` and never auto-retried:
  side effects are unknown; the application retries with a new `work.attempt`. An
  `exited` record with a missing container (crash between `docker rm` and result.json)
  is finalized from the record — the exit code and output are already on disk.
- **A failed reattach never destroys.** `resumeRun` used to route errors through the
  launch path's `abandon()` (`docker rm -f`); a resume failure now suspends (record left
  detached) and the orchestrator journals a `note` + `run.detached`, so the next start
  tries again. Rationale: the container was just observed alive; a supervisor's own
  failure is not evidence about the run.
- **One writer per run record.** `LifecycleWriter` serializes every lifecycle.json write
  for a run (phase transitions and events checkpoints come from different timers), and
  temp names are unique per write, so no stale snapshot or torn file can ever drop
  `deadlineAt`/`watchdogPid` from a record that recovery will read.
- **Terminal entries are journaled exactly once, by asking the journal.** A
  finalized-but-not-closed record makes boot scan `journal.jsonl` for its `run.finished`;
  the record's `closed` phase means "the terminal line is on disk". No second
  `run.started` is ever written for a recovered run — `run.recovered {outcome}` is the
  event for that.
- **Deterministic ids for agent emissions** — `sha256(runId + "\n" + lineIndex)` as a UUID.
  This is what makes an events-line replay idempotent without cross-file atomicity: the
  tailer awaits durable acceptance of each line's deliveries before advancing the
  checkpoint, and the ledger refuses an id it has seen. Routes are serialized in publish
  order (acceptance became async; FIFO admission must not depend on I/O luck) and tracked
  as in-flight work, so a stop waits for a late monitor emission to land before releasing
  the locks. Signal ids are tagged with the run that carried them and survive pruning
  while that run is active. A rejected acceptance rewinds the tailer to the failing line
  rather than poisoning its poll chain.
- **Work identity is emitter-supplied, framework-scoped per agent.** `work: { key,
  attempt? }` on drafts/envelopes/events lines (additive schema change). Rules:
  queued/active/done-within-window ⇒ skipped with detail; payload conflict ⇒ still
  skipped, detail says so; retry = new attempt; revision = new key. The GitHub monitor
  attaches `"<owner/name>#<eventId>"`. We do not claim exactly-once execution.
- **Deadline enforcement survives the process via a per-run watchdog process** (`node
  -e`, detached, sleeps to the absolute deadline, `docker kill`, writes
  `watchdog-kill.json`). Rejected: a docker-socket sidecar (privileged, heavy), a single
  shared daemon (IPC and a new component), and "just persist the deadline" (the issue
  explicitly rules it out — nothing enforces it while down). Pid reuse is guarded by
  verifying the command line mentions the container before signalling. Host reboot is the
  accepted gap (container is gone too ⇒ `interrupted`).
- **Rotated credentials are redacted by re-reading the container's own env** on
  reattach (`docker inspect` → `Config.Env`, filtered to declared names) and registering
  those values in memory. Records hold names only. The value already lives in Docker's
  store by construction of `-e NAME` injection; we add no second copy.
- **Retention protects by record state, inside `sweepRetention` itself**: any run with a
  non-`closed` or unreadable `lifecycle.json` is skipped regardless of caller-supplied
  active ids, so the safeguard does not depend on the orchestrator's memory.
- **Orphan sweep stays, narrowed**: containers labeled for the runs root with *no* record
  are still removed (1.x behavior for pre-2.0 leftovers); recorded ones are kept.
- **Unsupported record versions fail boot** before any sweep, naming the version and
  stating nothing was removed. Rollback across a record-version bump requires a drain.
- **`AgentExecutor` grew `observe`/`resume`, `execute` returns `RunOutcome`
  (`finished` | `detached`), `sweep` takes a keep-set.** Major bump (2.0.0). The
  monitor package bumps to 1.1.0 with peer `^2.0.0`.
- **`lockWaitMs`** lets a successor started before its predecessor finished detaching
  wait on the directory locks instead of failing. Default 0 keeps 1.x semantics.

## Why not a separate supervisor daemon

The issue left it open. A resident supervisor would own containers across orchestrator
restarts, but it is a new long-lived component with its own upgrade story — exactly the
problem being solved. The per-run watchdog is the smallest thing that must outlive the
process (deadlines), and everything else is state on disk plus Docker's own container
store. Multi-host and a scheduler remain non-goals.

## Testing

`test/recovery.test.ts` runs the acceptance list against a simulated backend whose
containers outlive orchestrator instances (detach/reattach, absent-time completion and
child emission with checkpoint rewind, work-identity replay, every crash window,
deadlines during downtime, unavailable backend, unsupported versions, aggressive
retention, removed/changed agents, changed concurrency, credential rotation, journal
schema validity). `test/recovery.docker.test.ts` (gated) proves it against real Docker.
