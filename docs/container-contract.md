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

Related: [authoring agents](./authoring-agents.md), [signal
envelope](./contracts/signal-envelope.md), [prompt template
grammar](./contracts/prompt-template-grammar.md).
