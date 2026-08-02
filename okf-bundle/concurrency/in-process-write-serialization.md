---
type: pattern
title: Shared-file writes are serialized in-process by a promise queue — there
  are no OS locks
tags:
  - concurrency
  - safeguards
  - gotcha
timestamp: 2026-07-27T02:58:06.361Z
---

Railyard never takes an OS-level file lock for its own writes. Every file with
more than one potential writer is made safe one of two ways, and both hold only
**inside a single orchestrator process**:

1. **Serialized through a promise queue.** `Journal.append`
   (`src/journal/journal.ts`) chains each `appendFile` onto `this.queue`, so
   concurrent runs journaling at once produce ordered, whole lines rather than
   interleaved ones. `JsonFileKvStore.persist` (`src/state/kv.ts`) does the same
   for monitor cursors, and writes via **temp-file-then-rename** so a crash can't
   leave a torn cursor.
2. **Per-run unique paths.** `agent.log`, `invocation.json`, `events.jsonl` and
   `output/` live under `runs/<runId>/`, where `runId` is an ISO-ms timestamp +
   agent name + 8 random hex (`makeRunId`, `src/run/runner.ts`). Nothing else
   writes there, so there is nothing to contend for.

Two consequences worth remembering:

- **The safety ends at the process boundary.** A promise queue coordinates
  nothing across processes, and neither mechanism above survives a second
  orchestrator: the queue is per-process, and per-run paths only stay unique
  because one process hands them out. This is exactly why both owned
  directories are locked at boot — see
  [owned-directory locks](/decisions/owned-directory-locks.md).
- **Ordered is not durable.** `Journal.append` returns the stamped entry
  *before* the write lands; only `flush()` (called by `stop()`) awaits the
  queue. A `SIGKILL` loses the tail of `journal.jsonl`. That is an accepted
  trade — journaling is on the hot path of every signal — but it means the
  journal is an index, not a write-ahead log.

The one file the framework genuinely cannot protect is the agent's events file:
the writer is an arbitrary container in an arbitrary language. See
[events file: append-only, single writer](/concurrency/events-file-single-writer.md).

Related: [container file ownership](/docker/container-file-ownership.md),
[M1 design decisions](/decisions/m1-design-decisions.md).
