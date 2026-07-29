---
type: decision
title: An orchestrator locks both directories it owns (runsDir, stateDir) at boot
tags:
  - concurrency
  - safeguards
  - docker
timestamp: 2026-07-27T02:57:46.531Z
---

An orchestrator owns two directories outright — `runsDir` and `stateDir` — and
each belongs to exactly one *running* orchestrator. `Orchestrator.start()`
claims both by creating a `.railyard.lock` in each (`DirectoryLock`,
`src/run/lock.ts`) before anything touches them; `stop()` releases them in
reverse order. A second orchestrator over either **fails to boot**, naming the
holder's pid, host, acquisition time, and which directory clashed.

## Why refusing to boot is the right call

Sharing either directory destroys data, silently:

- **runsDir — retention sweeps.** They exempt active runs, but each orchestrator
  only knows *its own* `activeRuns` set (`src/run/retention.ts`). The other's
  sweep will `rm -rf` your in-flight run directory, deleting the bind-mounted
  events file and output dir out from under a live container.
- **runsDir — the boot orphan sweep.** `sweepOrphanContainers` force-removes
  every container labeled `railyard.runsRoot=<abs runsDir>`. A second
  orchestrator starting up kills the first one's running agents. The code always
  assumed separate runs directories; nothing enforced or documented it.
- **stateDir — monitor cursors.** `JsonFileKvStore` loads once and caches in
  memory, so concurrent owners overwrite each other's progress and the monitor
  re-processes or skips whatever it tracks. They also share a fixed
  `${filePath}.tmp` staging path.

The stateDir case is the easy accident: `stateDir` **defaults to a `state/`
directory beside `runsDir`**, so two orchestrators with different runs
directories under one parent (`/var/railyard/runs-a`, `runs-b`) share
`/var/railyard/state` unless it is set explicitly. Locking runsDir alone would
have left exactly that hole open.

## Design calls inside the lock

- **`open(path, 'wx')`** — `O_CREAT|O_EXCL` is the whole mechanism. No
  `flock`/`fcntl`: those are lost on NFS and awkward across platforms, and the
  lock only needs to guard against another *railyard*, not against `rm`.
- **One generic `DirectoryLock`, two option constants** (`RUNS_DIR_LOCK`,
  `STATE_DIR_LOCK`) carrying the label and the why-sharing-is-unsafe sentence,
  so each conflict error explains the *specific* damage it prevented.
- **Same-directory config is not a deadlock.** A user may point both keys at one
  directory; `lockOwnedDirectories()` compares resolved paths and takes a single
  lock, because asking twice would fail against our own live pid.
- **Stale-lock takeover is same-host only.** A lock whose pid fails
  `process.kill(pid, 0)` with `ESRCH` is provably dead and is cleared
  automatically — a crashed orchestrator must not require manual cleanup.
  `EPERM` (alive, another user) counts as alive; a lock from a *different*
  hostname can't be liveness-checked at all, so it is reported for a human.
- **A corrupt lock file is never auto-cleared** — it's evidence.
- **A random `token` per acquisition**, re-checked in `release()`, so a process
  that was judged stale and superseded can't delete its successor's lock.
- **Released on failed boot.** Boot is fail-fast (invariant 4); `start()`
  releases every held lock before rethrowing, so a config fix can boot at once.
- **No opt-out flag.** Safeguards are "never silently absent" (SPEC §6), and an
  escape hatch here invites the data loss above. Recovery is deleting one file,
  and the error message says so.

Documented in SPEC §6.4 and §12, `docs/container-contract.md` ("Directories an
orchestrator owns"), and `docs/getting-started.md`. Tested in
`test/lock.test.ts` plus four orchestrator-level tests.

Related: [in-process write serialization](/concurrency/in-process-write-serialization.md),
[M1 design decisions](/decisions/m1-design-decisions.md),
[container file ownership](/docker/container-file-ownership.md).
