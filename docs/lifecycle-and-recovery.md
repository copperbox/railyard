# Lifecycle & recovery: restarting the orchestrator without interrupting runs

Since 2.0, an orchestrator can be stopped and a new one started — with new application
code or a new railyard — while agent containers keep running. The new process finds the
same containers, continues the same runs under the same run ids, finishes them without a
second attempt, and picks up every queued delivery. This page is the contract (SPEC §6.5,
§6.6). It applies to a single Docker host with stable, absolute `runsDir`/`stateDir`
paths; multi-host migration is out of scope.

## Shutdown modes

`stop()` takes a mode. Every mode stops admission first: monitors are stopped, and a
signal that still arrives (an active agent emitting a child) is accepted into the durable
queue rather than launched.

| Mode | Active runs | Queued deliveries | Returns |
|---|---|---|---|
| `drain` (default) | waited for; finish normally | kept on disk for the next start | when the last run has finished |
| `detach` | supervision released; **containers keep running** | kept on disk | promptly (no waiting on agents) |
| `cancel` | containers killed; recorded `killReason: "cancelled"` | dropped, journaled `run.skipped` / `cancelled` | when every kill is finalized |

```ts
await orchestrator.stop({ mode: 'detach' })   // deploy / upgrade
await orchestrator.stop()                      // drain: same as 1.x, but the queue survives
await orchestrator.stop({ mode: 'cancel' })    // stop everything now
```

- **Repeated and concurrent calls share one completion.** The first mode wins; later
  callers (any mode) get the same promise and a warning if they asked for a different
  mode. Ownership of the directories is released exactly once, last, after every write has
  landed — including a monitor emission that arrives while stopping — and every supervisor
  has let go. A second `SIGTERM` can never make a detach exit early or release the locks
  twice. An emission made *after* `stop()` has completed is refused with an error to the
  emitter: there is no owner left to make it durable.
- **During boot**, `stop()` waits for `start()` to settle and then shuts down per its mode.
  If boot fails, `start()` rejects, the locks are already released, and `stop()` resolves
  with nothing to do; the same instance can `start()` again.
- **Migration from 1.x.** `stop()` with no argument is `drain`, which is the old behavior
  in every respect but one: queued deliveries are **no longer dropped** (1.x journaled
  each as `run.skipped` / `shutdown`); they are restored at the next start. If your
  application relied on a stop discarding the queue, call `stop({ mode: 'cancel' })`, or
  drain and then remove `runs/queue/` deliberately. Signals matched during shutdown are
  queued rather than skipped.

## What is on disk

```
runs/
  .railyard.lock                # single-owner claim (SPEC §6.4)
  journal.jsonl                 # append-only, exempt from retention
  ledger.json                   # delivery ledger: routed signal ids, deliveries, work identities
  queue/
    <agent>--<signalId>.json    # one accepted, not-yet-launched delivery
  <runId>/
    lifecycle.json              # the run's durable launch intent + phase machine
    invocation.json  agent.log  events.jsonl  result.json  input/  output/
    watchdog-kill.json          # only if the deadline watchdog killed the container
```

**`lifecycle.json`** is written *before* the container is created and advanced through
every transition: `intent → created → started → exited → finalized → closed` (`closed` =
the terminal journal line is on disk). It holds everything a later supervisor needs —
run id, the deterministic container name `railyard--<runId>`, agent name and folder,
image ref, the full triggering signal, timeout and absolute `deadlineAt`, network mode,
prompt presence, the **names** of injected secrets, the events-file checkpoint (byte
offset + line count), the watchdog pid, and, once finalized, the run record. It never
holds a secret value.

**Versions.** `lifecycle.json`, `ledger.json`, and queue entries each carry a version
(`lifecycleVersion`, `ledgerVersion`, `queueVersion`, all `1`). All three are read, and
their versions checked, before anything is swept or removed: a record from a newer
railyard (or an unreadable queue entry) fails boot with a clear error and containers and
artifacts stay exactly as they were.

- **Upgrade (1.x → 2.x):** drain the 1.x orchestrator (its `stop()`), then start 2.x.
  Run directories from 1.x have no `lifecycle.json`; they are treated as before (subject to
  retention, never "recovered"). A 1.x container that survived a crash has no record and
  is removed by the orphan sweep, as 1.x itself would have done.
- **Upgrade (2.x → 2.y, same record versions):** `stop({ mode: 'detach' })`, start the new
  version. This is the routine deploy path.
- **Rollback to a railyard that does not know a record version** fails boot safely. To
  roll back across a record-version bump, drain first, so nothing is left to recover.
- **When draining is required:** any change that a running container cannot survive —
  moving `runsDir`, changing the Docker host, or a record-version bump you intend to roll
  back across. Everything else can detach.

## What happens at the next start

After claiming both directory locks and loading agents and secrets — and before
retention, queue admission, the orphan sweep, or any monitor starts — the orchestrator
reconciles every `lifecycle.json` that is not `closed`, asking the executor to *observe*
each run's container without touching it:

| Record phase | Container | Outcome (journaled as `run.recovered`) |
|---|---|---|
| `started` (or `created`) | running | `reattached` — same run id, same container; events resume from the checkpoint; logs re-captured; the original deadline stays in force |
| `created` | created, never started | `reattached` — started now; its deadline counts from this start |
| `started` / `created` | exited | `finalized` — logs, events, result collected; `run.finished` follows |
| `exited` | missing | `finalized` — the exit was observed and recorded before the crash (between `docker rm` and `result.json`); the run is finalized from the record and the run directory: recorded exit code, the agent's `output/result.json`, the watchdog marker. Nothing is lost and nothing is retried |
| `intent` / `created` | missing | `requeued` — recorded `run.finished` with status `interrupted`, and the **delivery** is queued again as a fresh run (nothing ever ran, so this is safe). Set `recovery.requeueUnstarted: false`, or remove the agent, to record only (`interrupted`, with the reason saying which) |
| `started` | missing | `interrupted` — `run.finished` with status `interrupted`, `exitCode: null`, an explicit reason. **Never retried automatically**: the container ran for some time and its side effects are unknown. Retry deliberately with a new `work.attempt` |
| `finalized` | (any) | no `run.recovered`: the terminal `run.finished` is journaled once if the journal does not already hold it, and the record is closed |

Rules that hold throughout:

- **Never a second attempt of the same run**, and never a second `run.started` for it.
  Concurrency accounting is restored from reattached runs *before* any queued delivery is
  admitted.
- **Unknown is not missing.** If the container backend cannot answer (Docker down,
  unparsable state), boot fails with an actionable error and changes nothing. Only a
  definite "no such container" counts as missing.
- **A failed reattach is not a failed run.** If picking a run back up fails after it was
  observed alive (its events file unreadable, a transient Docker error), the container is
  left exactly as it is, its record stays detached, and the failure is journaled as a
  `note` followed by `run.detached`; the next start tries again. Its concurrency slot is
  released meanwhile.
- **A child signal emitted during boot is admitted once.** A reattached run may write
  events lines while images are still being prepared; those deliveries are accepted
  durably and admitted with the restored queue, never twice.
- **Uncertain evidence is kept.** An unreadable `lifecycle.json` is reported, protected
  from retention, and not recovered.
- **Retention never removes** an active run, a run whose record is not `closed`, or one
  whose record is unreadable — whatever the policy says. `queue/`, `ledger.json`, and
  `journal.jsonl` are structurally exempt.
- **Orphans are still swept**: a container labeled for this `runsDir` with no lifecycle
  record (a pre-2.0 orchestrator's, or one whose run directory was removed by hand) is
  removed at boot and noted in the journal, as before.
- **A second live orchestrator cannot take ownership.** The directory locks are unchanged;
  a successor can wait for a detaching predecessor with `lockWaitMs`. A `SIGKILL`ed
  predecessor's lock is taken over by the existing same-host stale-pid rule, and its runs
  are recovered the same way.

## Deadlines while no orchestrator is running

A persisted deadline is not an enforced one, so each run with a timeout gets a
framework-owned **watchdog**: a small detached process spawned at container start that
sleeps until the run's absolute `deadlineAt`, then `docker kill`s the container and writes
`watchdog-kill.json` (`{ killedAt, reason: "timeout: exceeded Ns" }`) into the run
directory. It is its own process group, so it outlives the orchestrator; normal
finalization stops it. On reattach the orchestrator verifies the watchdog is still alive
and is *ours* (pid + command line), respawns one for the remaining time if not, and if
the deadline has already passed kills the container immediately. A kill by the watchdog
is reported exactly like an in-process timeout: `run.finished` with `exitCode: 137` and
`killReason: "timeout: exceeded Ns"`.

The one gap: if the whole host restarts, both the container and the watchdog are gone; the
run is then recorded `interrupted`, which is the honest answer.

## Configuration changes across a restart

- **Already-running agents keep their original** image, inputs (`signal.json`,
  `prompt.md`), deadline, network mode, and secrets — all read from the record and the
  container, never from the current manifest. New launches use the new definition.
- **Removed or renamed agent** (a rename is a removal plus an addition): its running or
  exited runs are still supervised to completion from the record. Its **queued**
  deliveries are dropped at restore, journaled `run.skipped` / `agent-removed`. Its child
  signals still route — see below.
- **Changed concurrency:** the new cap applies to admission, counting the runs recovery
  reattached. Raising it admits more queued work immediately; lowering it below the
  reattached count admits nothing until enough runs finish.
- **Recovered child signals** (an events line read after the restart) are routed against
  the **current** agent set and subscriptions, with the original agent as `source` and
  the original provenance chain. The self-trigger and depth guards apply as usual.
- **Queued work across configuration changes:** a queued delivery is re-journaled as
  `run.queued` at restore and launched with the agent's current definition (image,
  timeout, prompt template, secrets).

## Deliveries and duplicate suppression

**Transport is at-least-once; the framework makes delivery at-most-once per identity.**
Two identities are tracked in `ledger.json`:

1. **Signal id.** Agent-emitted signals get a *deterministic* id derived from
   `(runId, events-line index)`, so re-reading an events line after a restart yields the
   same id. Every routed id is remembered; a known id is not routed again (journaled as a
   `note`). A crash between consuming an events line and persisting its checkpoint
   therefore re-routes the line harmlessly. The checkpoint itself only advances after the
   line's deliveries are durable, so nothing is lost either. The ids carried by a run are
   kept for as long as that run is active or unclosed, however long that is; they expire
   with the ledger window afterwards. If making a line's deliveries durable fails (disk
   full), the line is retried from the last checkpoint on the next poll and the failure is
   journaled once per streak — later lines are neither skipped nor duplicated.
2. **Work identity** — application-supplied, optional, scoped per target agent:

   ```ts
   ctx.emit({ type: 'github.issue.labeled', payload, work: { key: `o/r#42:event:987`, attempt: 1 } })
   ```

   `work.key` names the logical piece of work; `work.attempt` (default 1) names the
   attempt. The rules, per `(agent, key, attempt)`:

   | Existing entry | New emission with the same identity |
   |---|---|
   | queued or active | skipped — `run.skipped` / `duplicate`, `detail` names the existing signal and run |
   | done, within `recovery.ledgerRetentionDays` (default 7) | skipped — same event, `detail` says `is done` |
   | done, older than the window | admitted (the entry has expired) |
   | same identity, **different payload** | skipped, and `detail` adds `payload differs — a new revision needs a new work key` |

   A **deliberate retry** is the same key with a new `attempt`. A **new revision** is a
   new key (e.g. `…@rev2`). Emissions without `work` are never suppressed by this rule.
   Work identity may also be set by agents on a `signal` events line (`"work": {...}`),
   and it travels on the envelope so agents can see it in `signal.json`.

**What this does not claim.** Execution is not exactly-once. A run that was `started`
and went missing is recorded `interrupted`, not retried; a monitor whose cursor lags may
legitimately re-emit; the ledger window is finite. Agents that perform external side
effects (post a comment, open a PR) must remain idempotent on the work they receive —
`work.key` is there to key that idempotency on.

**First-party monitors.** `@copperbox/railyard-monitor-github` emits each issue event with
`work: { key: "<owner/name>#<eventId>" }`, so its emit-then-persist cursor (at-least-once
across a crash) no longer risks a second run when the previous one survived the restart.
Its cursor semantics are unchanged; the ledger, not the cursor, is what suppresses the
replay. See [authoring monitors](./authoring-monitors.md#dedup-and-work-identity).

## Redaction under recovery

Records hold secret **names**, never values. On reattach the executor reads the values the
container actually holds (from the container's own configuration — the one place they
already are) and registers them with the redactor in memory, alongside the currently
resolved values. Logs re-captured from the container, events read after the restart, the
collected result, and every journal entry are therefore scrubbed of both the value in use
at launch and the value it was rotated to. Nothing writes a secret to
`lifecycle.json`, `ledger.json`, or the queue.

## Observability

Everything above is visible through the journal and `orchestrator.on(...)`
(schema: `schemas/journal-line.schema.json`):

| Event | Meaning |
|---|---|
| `run.detached { runId, agent, signalId }` | supervision released for a restart; the container is still running; not terminal |
| `run.recovered { …, outcome }` | `reattached` / `finalized` / `interrupted` / `requeued`, see the table above |
| `run.finished { …, status: "interrupted", exitCode: null, error }` | terminal for a run whose container went missing unsupervised |
| `run.finished { …, killReason: "cancelled" }` | terminal for a run killed by `stop({ mode: 'cancel' })` |
| `run.skipped { …, reason: "duplicate", detail }` | suppressed by work identity |
| `run.skipped { …, reason: "cancelled" }` | queued delivery dropped by a cancel stop |
| `run.skipped { …, reason: "agent-removed", detail }` | queued delivery for an agent no longer defined |
| `run.queued` (again) | each restored delivery, with its restored depth |
| `note` | replay suppressed; unreadable record kept; recovery summary; orphan sweep |

`run.started` is journaled exactly once per run, when it is launched; `run.finished`
exactly once, when it ends — regardless of how many orchestrator processes supervised it
in between.

## A deploy, step by step

```ts
process.on('SIGTERM', () => {
  void orchestrator.stop({ mode: 'detach' }).then(() => process.exit(0))
})
```

1. Send the old process `SIGTERM`; it detaches (fast) and exits.
2. Start the new process over the **same** `runsDir`/`stateDir` on the **same** Docker
   host. Give it `lockWaitMs` (e.g. `10_000`) if you start it before the old one has
   exited. Docker must be reachable, or boot fails safely.
3. Watch `run.recovered` in the journal. Every run the old process left behind appears
   exactly once, and its `run.finished` follows in due course.

Related: [container contract](./container-contract.md), [signal
envelope](./contracts/signal-envelope.md), [authoring monitors](./authoring-monitors.md).
