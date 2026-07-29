# Container contract reference

The complete interface between the orchestrator and whatever runs inside an agent
container (SPEC §5). It is **language-neutral** — the container can be any image that reads
some files and writes some files; railyard never assumes JavaScript inside. This is also
the reference a Python/Rust port implements on the host side.

## Inputs (what the container is given)

**Mounts and paths**, exposed as environment variables:

| Env var | Path inside container | Mode | Contents |
|---|---|---|---|
| `AGENT_INPUT_DIR` | `/railyard/input` | read-only | the invocation input directory |
| `AGENT_INPUT_FILE` | `/railyard/input/signal.json` | read-only | the full matched **signal envelope** (envelope + payload) |
| `AGENT_PROMPT_FILE` | `/railyard/input/prompt.md` | read-only | the rendered prompt — **set only if the agent has a `prompt.md`** |
| `AGENT_OUTPUT_DIR` | `/railyard/output` | writable | where the agent writes `result.json` |
| `AGENT_EVENTS_FILE` | `/railyard/events.jsonl` | writable (append) | the backchannel (below) |

Always read paths from the env vars, not hard-coded literals — they are the contract, the
literal paths are an implementation detail.

**Secrets**: each secret **named in the manifest** is injected as an environment variable
of that name, resolved per container at spawn. Nothing else is injected — least privilege
by construction. The reserved env var names above may not be used as secret names.

**Guarantees to the agent:** a **fresh container every invocation** — statelessness is
contractual, so persistence is the agent's job via its outputs — and **teardown always
happens** (on success, failure, or timeout), with logs captured before removal.

## Outputs (what the container must produce)

- **`result.json`** in `$AGENT_OUTPUT_DIR` — **any JSON value**. The framework wraps it in
  the run record and **never interprets it** (no cross-provider result schema, ever —
  SPEC §14). Absent or unparsable `result.json` is not itself a failure; it is recorded
  with a `resultError`.
- **Process exit code** determines success vs. failure: `0` succeeds, non-zero fails. This
  is the source of truth, not the contents of `result.json`.

## The events file (the only backchannel)

`$AGENT_EVENTS_FILE` is an **append-only JSONL** file the orchestrator **tails during the
run**, so agent-emitted signals dispatch while the agent is still running. It is the
*only* backchannel — no HTTP callback, no sockets (SPEC invariant 6). Two line kinds:

```json
{ "kind": "signal", "type": "review.completed", "payload": { "issue": 42 } }
{ "kind": "log", "level": "info", "message": "starting review" }
```

- A **`signal`** line re-enters the same bus and can trigger other agents (agents
  triggering agents is a first-class goal). The framework stamps the envelope — including
  `contractVersion` and the extended [provenance](./contracts/signal-envelope.md) chain —
  so the agent writes only `type` + `payload`. `type` matches
  `^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`.
- A **`log`** line is captured into the run record; `level` defaults to `info`.
- It is writable from any language: `echo '{"kind":"log","message":"hi"}' >> "$AGENT_EVENTS_FILE"`.

### Writing safely: append only, one line at a time

The framework takes no lock on this file and cannot: the writer is your container, in
whatever language, and the reader is the host polling the other side of a bind mount.
Two rules keep that safe, and both are on you.

**1. Append — never rewrite.** `$AGENT_EVENTS_FILE` is a bind mount of a *single file*, so
the host is watching one specific inode. Anything that replaces the file rather than
appending to it — `>` instead of `>>`, an editor's save, a write-temp-then-`mv`, Python's
`open(path, "w")`, `sed -i` — leaves the host tailing the old inode. Every event you write
after that is silently lost: no error, no malformed-line record, just silence. Always open
with `O_APPEND` (`>>`, `open(path, "a")`, `fs.appendFile`).

**2. One writer, or serialize them.** If your agent fans out — parallel subprocesses,
worker threads, a tool that logs from a callback — every one of them appending to the same
file is the one place a real interleaving hazard lives:

| Line size | What happens |
|---|---|
| Under ~4 KiB, appending on Linux | The kernel makes each `write(2)` atomic; lines stay whole |
| Over ~4 KiB | The write can be split, and a concurrent writer can land in the middle |
| Any size, on a Docker Desktop (macOS/Windows) file share | The guarantee is weaker — don't rely on size |

A torn line is not fatal — the tailer buffers to the last newline and reports the wreckage
through `onMalformedEvent`, which is journaled — but the event it contained is **gone**,
and if it was a `signal` line, the agent it would have triggered never runs. Payloads make
this easy to hit: a diff, a file listing, or a captured log in a payload clears 4 KiB fast.

So, in order of preference:

- **Emit from one place.** Have workers return their results and let the main process write
  the events. This is free and always correct.
- **If you must write concurrently, keep lines small** — put the bulk in `result.json` (or
  somewhere the payload can point at) and emit a short signal line.
- **Or serialize the writes yourself** with a mutex, a queue, or a single `flock`-guarded
  writer (`flock "$AGENT_EVENTS_FILE" -c '…'`), remembering that this only coordinates
  writers *inside your container* — nothing else is contending for the file.

Lines are newline-delimited JSON, so a line must not contain a raw newline; every JSON
serializer already escapes them. Write the trailing `\n` — a last line without one is
recovered at teardown, but only then, so it won't dispatch mid-run.

**Runaway guards** (SPEC §7): every signal carries a provenance chain; emissions beyond the
configured **max depth** (default 5) are dropped and journaled (never silent). An agent's
own emission does **not** re-trigger it unless its manifest sets `allowSelfTrigger: true`.

## Lifecycle & safeguards (framework guarantees, never silently absent)

- **Concurrency cap** — per-agent, default 1; excess matched signals queue in memory.
- **Hard timeout** — framework-enforced kill; default 900 s; `timeout: null` opts into an
  indefinite run. The kill reason is recorded.
- **Guaranteed teardown** — container and resources removed on any outcome; logs captured
  first.
- **Network** — on by default (agents call provider APIs); `network: none` cuts it off.
  There is no egress allowlisting (a stated v1 non-goal) — the sandbox is exactly as tight
  as documented, no tighter.
- **Exclusive directories** — one orchestrator per `runsDir` and per `stateDir`, enforced
  at boot by a `.railyard.lock` file in each. See [directories an orchestrator
  owns](#directories-an-orchestrator-owns).

## What the framework writes per run

Under `runs/<ts>--<agent>--<id>/` (SPEC §12):

```
invocation.json   # the signal envelope (incl. provenance), matched agent, resolved params, image hash
agent.log         # captured stdout/stderr, secrets redacted
events.jsonl      # the events file, preserved
output/result.json  # your result.json + the framework's exit/timing/kill metadata around it
```

Secret **values never appear** in signals, run records, journals, or captured logs
(redaction guarantee, SPEC §8). See [credential scoping](./credential-scoping.md).

## Directories an orchestrator owns

An orchestrator owns two directories outright — its `runsDir` and its `stateDir` — and
each belongs to exactly one *running* orchestrator. `start()` claims both by creating a
`.railyard.lock` file in each; a second orchestrator pointed at either one fails to boot
with an error naming the holder's pid and host, and saying which directory clashed. Both
are released by `stop()`. A lock left behind by a crashed process on the same host is
detected (its pid is gone) and taken over automatically on the next boot.

This is a guard against data loss, not against interleaved writes. Two orchestrators
sharing a `runsDir` destroy each other's work:

- **Retention sweeps** (SPEC §12) exempt *currently active* runs, but each orchestrator
  only knows its own. The other's sweep will `rm -rf` your in-flight run directory —
  deleting the bind-mounted events file and output directory out from under a live
  container.
- **The boot-time orphan sweep** force-removes every container labeled with that runs
  root. A second orchestrator starting up kills the first one's running agents.

Sharing a `stateDir` is quieter but just as wrong: **monitor cursors** are loaded once and
cached in memory, so concurrent owners overwrite each other's progress and the monitor
re-processes or skips whatever it tracks. This one is easy to hit by accident — `stateDir`
defaults to a `state/` directory *beside* `runsDir`, so two orchestrators with different
runs directories under one parent (`/var/railyard/runs-a`, `/var/railyard/runs-b`) share
`/var/railyard/state` unless you set `stateDir` explicitly. Since the lock now catches
that at boot, you will get an error rather than a corrupted cursor.

Running several orchestrators on one machine is fine — give each its own `runsDir` and
`stateDir`. Pointing both config keys at a single directory is also fine; one lock covers
it. If you are certain no orchestrator is running and a stale lock is blocking boot (a
crash on a different host, or a corrupt lock file, neither of which can be
liveness-checked), delete `.railyard.lock` by hand.

Related: [authoring agents](./authoring-agents.md), [signal
envelope](./contracts/signal-envelope.md), [prompt template
grammar](./contracts/prompt-template-grammar.md).
