# railyard

> Stylized **rAIlyard**. A rail yard is where cars are sorted, routed, and dispatched down
> different tracks — this framework does the same with signals and AI agents.

`railyard` is a TypeScript framework library for pub/sub-style, multi-provider AI agent
orchestration. User-authored **monitors** watch the outside world and emit **signals**; the
**orchestrator** routes signals to **agents** — defined declaratively in self-contained
folders — and runs each invocation as an ephemeral, sandboxed Docker container.

It is deliberately non-prescriptive: the framework owns the *contracts* (signal shape,
routing, container I/O, lifecycle safeguards) and stays out of the *content* (which
provider, which prompts, which guardrails, what the agent actually does).

- **Org / scope:** `copperbox` — packages under `@copperbox/*`, repo at `github.com/copperbox/railyard`.
- **User zero:** Dan (dan.essig@gmail.com). First real workflow: a monitor watches GitHub
  issues and, when a configured label is applied, spawns an agent to review the issue.
- **Ports:** Python and Rust ports are planned once the TS library is solid. Every contract
  in this spec must therefore be expressible language-neutrally (JSON / JSON Schema /
  JSONPath / YAML) — nothing on the wire or on disk may require a TS runtime to interpret.

---

## 1. Core concepts

| Concept | What it is | Authored as |
|---|---|---|
| **Signal** | An event: envelope + typed JSON payload | Emitted by monitors (or agents) |
| **Monitor** | Code that watches something and emits signals | TypeScript, implements the `Monitor` interface |
| **Agent** | A declarative definition of a containerized worker | A folder of data files (YAML/MD/Dockerfile) — never code executed on the host |
| **Orchestrator** | Single in-process layer: validates, routes, spawns, journals | Framework-provided (`@copperbox/railyard`) |
| **Scaffold** | A copyable example agent folder + optional helper image for a given provider | Files in this repo + images on ghcr |

Monitors know nothing about agents. Agents know nothing about monitors. The **signal
contract** is the only coupling between them.

## 2. The signal contract

A signal is a JSON document:

```jsonc
{
  // Envelope — set by the framework, never by the emitter
  "id": "sig_...",              // unique per emission; the framework does NOT dedup
  "timestamp": "2026-07-19T...",
  "source": { "kind": "monitor" | "agent", "name": "github-issues" },
  "provenance": [ /* ordered causality chain, see §7 */ ],

  // Set by the emitter
  "type": "github.issue.labeled",   // namespaced string
  "payload": { /* JSON, validated against the emitter's declared JSON Schema */ }
}
```

- **Payload schemas are JSON Schema.** Monitors declare a schema per signal type they emit.
  TS helpers may exist for authoring DX, but JSON Schema is the interchange format and what
  gets validated (via ajv internally).
- Signals must be fully JSON-serializable — this is what makes out-of-process monitors a
  future *transport feature* rather than a redesign.

## 3. Routing

Binding lives in the **agent manifest** (option "agents subscribe"):

- An agent declares: the signal `type`(s) it accepts, an optional **JSONPath-based filter**
  (path + comparator against the payload, e.g. `$.label == "needs-review"`), and the payload
  schema it **requires**.
- At boot, the orchestrator verifies every subscription is satisfiable: emitter schema must
  be compatible with the agent's required schema. Mismatches fail loudly at startup.
- **Implicit fan-out:** if N agents match a signal, all N fire. There is no workflow engine,
  no ordering, no exclusivity.
- Filters are declarative-only, by design. If a filter can't express it, write a smarter
  monitor. There is no escape hatch into code, and that line holds.

A separate routing/rules layer (wiring the same agent differently per deployment) is a
possible later addition layered *on top of* this — not part of v1.

## 4. Agent folders (agents are data)

An agent is a folder:

```
agents/github-reviewer/
  manifest.yaml     # identity + subscriptions + runtime config (required)
  prompt.md         # prompt template, {{...}} interpolation from signal payload
  Dockerfile        # ALWAYS physically present (unless manifest sets image:)
  ...               # anything else the Dockerfile COPYs in
```

`manifest.yaml` (shape, not final schema):

```yaml
name: github-reviewer
on:
  - type: github.issue.labeled
    filter: '$.label == "needs-review"'      # JSONPath filter, optional
    payloadSchema: ./schemas/issue-labeled.json  # JSON Schema the agent requires
secrets: [GITHUB_TOKEN, ANTHROPIC_API_KEY]   # names only, resolved at spawn (§8)
concurrency: 1        # per-agent cap; default 1
timeout: 900          # seconds; default on; explicit `timeout: null` = may run forever
network: default      # or "none"
allowSelfTrigger: false
# image: ghcr.io/...  # alternative to a local Dockerfile (bring-your-own-image)
```

Rules:

- **No codegen, no magic.** What is in the folder is literally what builds. The framework
  never generates a Dockerfile.
- Loading an agent never executes user code on the host. Only the sandbox runs anything.
- Image sources, in order of ceremony: Dockerfile in the folder (copied from a scaffold or
  hand-written) → `image:` reference to a prebuilt image (pull verified at boot; trusted to
  honor the container contract).
- **No universal cross-provider guardrail schema.** "Guardrails" and "tools" are whatever
  the scaffold/provider inside the container understands. The framework does not abstract
  provider APIs, ever — multi-provider means "which CLI/runtime is in the image."
- Because agents are plain data, an agent that *authors new agents* is just an agent that
  writes YAML into a directory.

## 5. The container contract

The full interface between orchestrator and whatever runs inside the container:

**In:**
- Invocation input mounted at a known path: the matched signal (full envelope + payload)
  and the rendered prompt/params. Exact paths exposed via env vars (`$AGENT_INPUT_FILE`, …).
- Declared secrets injected as env vars — only the ones this manifest names (§8).

**Out:**
- `result.json` written to `$AGENT_OUTPUT_DIR`; process exit code determines success/failure.
- `$AGENT_EVENTS_FILE`: an append-only JSONL file on a framework-provided writable mount.
  This is the **only backchannel** — no HTTP callback, no sockets. Each line:

  ```json
  { "kind": "signal", "type": "review.completed", "payload": { } }
  { "kind": "log", "level": "info", "message": "..." }
  ```

  The orchestrator tails this file during the run, so agent-emitted signals dispatch while
  the emitter is still running. Writable from any language (`echo >> $AGENT_EVENTS_FILE`).

**Guarantees given to the agent:** a fresh container every invocation (statelessness is
contractual — persistence is the agent's job via its outputs); teardown always happens.

## 6. Lifecycle & safeguards

One matched signal → one container → run → exit → removal. Strictly ephemeral in v1
(warm pools / resident agents may arrive later behind the same `AgentExecutor` interface).

Non-negotiable framework features (defaults on, tunable, never silently absent):

1. **Per-agent concurrency cap** — default 1; excess matched signals queue in memory.
2. **Hard timeout** — framework-enforced kill; default on; a user may explicitly configure
   `timeout: null` to opt into an indefinite run.
3. **Guaranteed teardown** — container and resources removed on success, failure, or
   timeout; logs captured before removal.

## 7. Agent-emitted signals, provenance, and runaway prevention

Agents may emit signals via the events file; these re-enter the same bus and can trigger
other agents (agents-triggering-agents is a first-class goal). Guards:

- Every signal envelope carries a **provenance chain**: the ordered list of
  (monitor/agent, signal) pairs that caused it.
- **Max chain depth** is framework-enforced and configurable (default **5**); signals beyond
  it are dropped and journaled as such.
- **Self-triggering is refused** unless the agent's manifest sets `allowSelfTrigger: true`.

## 8. Secrets

- Manifests declare secret **names only**. At spawn, the orchestrator resolves each through
  a `SecretsProvider` interface — default implementation reads process env / `.env`; Vault
  etc. can be plugged in later behind the same seam.
- Only the declared secrets are injected, per container. Least privilege by construction.
- **Boot-time check:** any declared-but-unresolvable secret fails startup loudly.
- **Redaction guarantee:** secret values never appear in signals, run records, journals, or
  framework-captured logs (including agent stdout/stderr).
- Known residual risk, accepted: anything inside the container can read its injected env.
  Mitigation is credential scoping (fine-grained tokens, spend-capped keys) — the user's
  responsibility, guided by docs, not framework machinery.

## 9. Monitors

```ts
interface Monitor {
  name: string
  emits: SignalDeclaration[]   // { type, payloadSchema } — used for boot-time compat checks
  start(ctx: MonitorContext): Promise<void>
  stop(): Promise<void>
}

interface MonitorContext {
  emit(signal: { type: string; payload: unknown }): void
  state: KeyValueStore          // per-monitor persistent KV: get/set/delete
  log: Logger
}
```

- **`ctx.state`** is a framework-provided KV store scoped per monitor, for cursors
  ("last seen issue event"). Pluggable backend; default is plain JSON files on disk. This is
  also the persistence seam signal durability will reuse in v2.
- **Dedup is the monitor's job.** The framework cannot know what makes two signals "the
  same"; `signal.id` is unique per emission, full stop.
- **No scheduling sugar.** Monitors are code; `setInterval` exists.

## 10. Runtime topology (v1)

- Single Node process: the user's app imports `@copperbox/railyard`, registers monitor
  instances, points at an agents directory, calls `orchestrator.start()`.
- The signal bus is in-memory, behind a **`SignalTransport` interface** so a Redis/NATS/HTTP
  transport (and with it, out-of-process monitors) can be added without touching monitor or
  agent code.
- **Accepted v1 limitation:** an orchestrator crash takes monitors down with it and loses
  in-flight/queued signals. Durability arrives with a persistent transport, not in v1.
- Boot sequence (fail-fast philosophy — by the time `start()` resolves, the system is
  fully spawnable):
  1. Load and validate agent manifests.
  2. Check schema compatibility for every subscription (§3).
  3. Resolve every declared secret (§8).
  4. Build/pull every agent image (§11).
  5. Start monitors.

## 11. Images

- Built at **orchestrator boot**, tagged by a **content hash** of the agent folder —
  unchanged folders are cache hits; edits rebuild naturally on next boot.
- `image:` manifests are pull-verified at boot instead.
- **Network:** on by default (agents call provider APIs); per-manifest `network: none`
  opt-out. Fine-grained egress allowlisting is a **stated v1 non-goal** — the sandbox is
  exactly as tight as documented, no tighter.

## 12. Observability

File-based run journal, no database, no bundled dashboard:

```
runs/
  journal.jsonl                     # append-only index: every signal received, every run
                                    # started/finished. EXEMPT from retention pruning.
  2026-07-19T.../github-reviewer--a1b2c3/
    invocation.json                 # signal envelope (incl. provenance), matched agent,
                                    # resolved params, image hash
    agent.log                       # captured stdout/stderr (secrets redacted)
    events.jsonl                    # the mounted events file, preserved
    result.json                     # agent result + exit code, timing, kill reason if any
```

- The same facts are emitted as structured events on an in-process emitter
  (`orchestrator.on(...)`) so users can pipe them anywhere. Observability is data we keep,
  not a stack we run.
- **Retention:** `retention: { maxAgeDays?, maxRunsPerAgent? }` in orchestrator config
  (whichever prunes more wins), enforced by a sweep at boot and after each run — no
  background timers. **Default is unlimited, with a startup warning if unset** — a default
  must never silently delete debugging evidence. `journal.jsonl` is always exempt.

## 13. Packaging

Monorepo at `github.com/copperbox/railyard`:

| Package / artifact | Contents |
|---|---|
| `@copperbox/railyard` | Core: orchestrator, signal bus + `SignalTransport`, contracts, docker runner, journal. Zero opinions about providers. |
| `@copperbox/railyard-monitor-github` | First-party GitHub monitor — deliberately built **through the public API only** (if it needs something core doesn't export, real users are blocked too). |
| `scaffolds/` (in-repo) | Copyable example agent folders, starting with `claude-code` (Dockerfile + manifest + prompt.md honoring the container contract). |
| ghcr images | Optional helpers, e.g. an entrypoint that adapts Claude Code headless mode to the events-file/result contract. |

npm forces lowercase; the *rAIlyard* stylization lives in branding (README/logo/docs) only.

## 14. Non-goals (v1, explicit)

- No provider API abstraction, no universal guardrail/tool schema — ever, not just v1.
- No workflow engine: no ordering, retries-with-backoff DAGs, or exclusive delivery.
- No signal durability / delivery guarantees (arrives with persistent transports, v2).
- No out-of-process monitors (v2, via `SignalTransport`).
- No warm pools or resident agents (later, behind `AgentExecutor`).
- No egress allowlisting, no framework-managed secret vault, no scheduling helpers,
  no framework-level signal dedup, no bundled observability stack.
- No programmable (code) filters — the declarative JSONPath ceiling is intentional.

## 15. Milestones

Each milestone ships something runnable; later milestones only build on public surfaces of
earlier ones.

**M0 — Walking skeleton.** Core package: signal bus (in-memory transport behind the
interface), agent-folder loading + manifest validation, boot-time image build, docker
runner honoring the full container contract (input mount, events-file tailing, result
collection, teardown), run journal. Proven by a trivial in-repo monitor (e.g. emits a
signal on an interval) triggering a no-op agent (a shell-script Dockerfile) that reads its
input, appends an event, writes a result. **The full contract round-trips before any AI or
GitHub specifics exist.**

**M1 — Safeguards & secrets.** Concurrency caps + queueing, timeouts (incl. `null`),
provenance chain + depth limit + self-trigger guard, `SecretsProvider` + redaction,
retention sweep. The skeleton agent grows a test that emits a signal triggering a second
agent, proving agent-chaining and its guards.

**M2 — Claude Code scaffold.** `scaffolds/claude-code`: Dockerfile, entrypoint helper
(published to ghcr) adapting Claude Code headless mode to the contract, prompt.md
templating from payload. Proven by a real agent doing real (if small) LLM work end-to-end.

**M3 — GitHub monitor.** `@copperbox/railyard-monitor-github`: polls issues, uses
`ctx.state` for cursors, owns its dedup semantics, emits `github.issue.*` signals with
published JSON Schemas. Built strictly against public core exports.

**M4 — User-zero dogfood.** The actual workflow: label on a GitHub issue → Claude Code
agent reviews it. Whatever friction this surfaces gets fixed *in core's public API* before
anything else is added.

**M5 — Hardening for strangers.** Docs (getting started, authoring monitors, authoring
agents, container contract reference, credential-scoping guidance), error-message polish,
`npm publish` of core + github monitor, versioned signal-contract documentation.

**Beyond (v2 candidates, in no order):** persistent/remote `SignalTransport`
(out-of-process monitors, durability), routing-rules layer, `AgentExecutor` variants (warm
pools), egress allowlisting, additional scaffolds (Codex CLI, Gemini CLI), Python/Rust
ports sharing the wire/disk contracts.

## 16. Design invariants (checklist for every future change)

1. Contracts are language-neutral: JSON, JSON Schema, JSONPath, YAML — never "a TS value".
2. Monitors are code; agents are data. Loading agent definitions never executes user code.
3. The signal contract is the only coupling between monitors and agents.
4. Fail loudly at boot, not at 2am: schemas, secrets, images all verified before `start()` resolves.
5. Safeguards (concurrency, timeout, teardown, depth limit, redaction) are framework
   guarantees — tunable, never silently absent.
6. The sandbox's only powers are its mounts and its declared secrets; the events file is
   the only backchannel.
7. Extension points are seams, not features: `SignalTransport`, `SecretsProvider`,
   `AgentExecutor`, KV-store backend.
8. No magic: what's in the agent folder is literally what builds and runs.
9. First-party monitors/scaffolds use only public API.
10. Defaults never destroy information (no silent retention pruning, no silent signal drops
    without a journal entry).
