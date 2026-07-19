# M0 implementation plan — walking skeleton

> **Status: COMPLETE (2026-07-19).** All steps implemented; 91 tests green
> (`pnpm test` without Docker, `pnpm test:docker` with). Decisions table at the
> bottom reflects what shipped. Next: M1 (safeguards & secrets).

Goal (from SPEC §15): the full contract round-trips — a trivial in-repo monitor emits a
signal on an interval, the orchestrator routes it to a no-op shell-script agent in a
Docker container, the agent reads its input, appends an event, writes a result, and the
run is journaled — before any AI or GitHub specifics exist.

Steps are ordered so each is independently testable and later steps only consume the
public surface of earlier ones. Steps 1–4 need no Docker; 5 onward do.

---

## Step 0 — Repo & tooling

- pnpm workspaces; `packages/railyard` (published name `@copperbox/railyard`).
- TypeScript strict, ESM, Node ≥ 20 pinned in `engines` + `.nvmrc`.
- vitest for tests; tsup for build (dual emit not needed — ESM only until someone asks).
- Minimal lint (eslint flat config + prettier defaults). No CI yet (M5).
- `examples/` workspace member for the proof monitor; `agents-fixtures/` under the core
  package's test dir for fixture agent folders.

**Done when:** `pnpm build && pnpm test` runs green on an empty test.

## Step 1 — Contracts as data (the language-neutral core)

Everything a future Python/Rust port must share, authored as JSON Schema files under
`packages/railyard/schemas/` and shipped in the npm package:

- `signal-envelope.schema.json` — id, timestamp, source, provenance (array, empty in M0),
  type, payload.
- `agent-manifest.schema.json` — name, `on[]` (type / filter / payloadSchema), plus the
  M1 fields (secrets, concurrency, timeout, network, allowSelfTrigger, image) declared
  now with defaults, even though M0 ignores most of them — the manifest shape is a disk
  contract and shouldn't churn.
- `events-line.schema.json` — the two JSONL line kinds (`signal`, `log`).
- `result.schema.json` — what `result.json` may contain (loose: any JSON object).

TS side: hand-written interfaces mirroring the schemas, ajv compiled validators, and a
tiny `newSignalId()` (`"sig_" + crypto.randomUUID()`, zero deps). Timestamps are ISO
8601 UTC.

**Done when:** unit tests validate good/bad fixtures against every schema.

## Step 2 — Signal bus behind `SignalTransport`

```ts
interface SignalTransport {
  publish(signal: SignalEnvelope): void
  subscribe(handler: (signal: SignalEnvelope) => void): () => void
  start(): Promise<void>
  stop(): Promise<void>
}
```

- `InMemoryTransport`: synchronous fan-out over subscribers, errors in one handler
  isolated from others.
- Envelope stamping lives in the orchestrator (emitters hand over `{type, payload}`
  only; framework sets id/timestamp/source/provenance — SPEC §2).
- Payload validated against the emitter's declared schema *before* publish; invalid
  emission is an error surfaced to the emitter and journaled, never silently dropped
  (invariant 10).

**Done when:** unit tests cover stamping, validation rejection, multi-subscriber fan-out,
handler-error isolation.

## Step 3 — Agent folder loading + boot validation

- Scan `agentsDir` for subfolders containing `manifest.yaml`; parse with `yaml`,
  validate against the manifest schema. Any invalid folder fails boot with a message
  naming the folder and the violation (invariant 4).
- Resolve each subscription's `payloadSchema` path relative to the agent folder; compile
  with ajv (compile failure = boot failure).
- Enforce: `Dockerfile` present XOR `image:` set.
- **Filter grammar** (decision, see below): a filter is `<jsonpath> <op> <literal>` with
  ops `==`/`!=` and JSON literals. Parsed and validated at boot; bad syntax fails boot.
  Evaluation = resolve path with `jsonpath-plus`, compare strictly.
- **Schema compatibility check** (SPEC §3, decision below): M0 rule is *deep structural
  equality after ref-resolution* between emitter schema and agent-required schema, with
  an error message that says exactly which subscription failed and why. A real
  subset-check can replace the rule later without changing the boot step's shape.
  Note: monitors register at `start()` time, so this check runs against registered
  monitors' declared emissions; agent-emitted types (no declared emitter in M0) skip the
  check with a journal note rather than failing.

**Done when:** unit tests over fixture folders — valid, malformed YAML, schema-violating
manifest, missing Dockerfile, bad filter syntax, incompatible subscription.

## Step 4 — Content hash + image build

- Deterministic folder hash: walk the agent folder, sort relative paths, sha256 over
  `(path, file bytes)` pairs; tag `railyard/<agent-name>:<first 12 hex>`.
- Build by shelling out to the `docker` CLI (decision below): skip build when
  `docker image inspect` says the tag exists (cache hit per SPEC §11); otherwise
  `docker build` with the agent folder as context, streaming build output to the boot
  log. Build failure = boot failure.
- `image:` manifests: `docker pull` + inspect instead.

**Done when:** hash unit tests (order-independence, content sensitivity, stability
across runs) pass without Docker; a Docker-gated integration test builds a fixture
agent and hits the cache on the second boot.

## Step 5 — Docker runner (the container contract)

The riskiest step; everything here is SPEC §5/§6 verbatim.

Per invocation:

1. Create run dir `runs/<ISO-timestamp>--<agent>--<shortid>/`; write `invocation.json`
   (full signal envelope, agent name, image tag+hash).
2. Prepare mounts: read-only input dir containing `signal.json`; writable output dir;
   pre-created empty `events.jsonl` on a writable mount.
3. `docker create` (not `--rm` — we must collect logs before removal) with env vars
   `AGENT_INPUT_FILE`, `AGENT_OUTPUT_DIR`, `AGENT_EVENTS_FILE`, a label
   `railyard.run=<run-id>`, then `docker start`.
4. While running: stream stdout/stderr to `agent.log`; **tail the events file from the
   host side** (it's a bind mount — poll for appended bytes, parse complete lines,
   tolerate partial writes). `signal` lines are re-emitted onto the bus immediately
   (mid-run dispatch per SPEC §5); `log` lines go to `agent.log` interleaved with a
   marker. Malformed lines are journaled, not fatal.
5. On exit: read `result.json` if present, record exit code + timing into
   `result.json` (run-record form per SPEC §12), preserve `events.jsonl`.
6. **Teardown in `finally`:** `docker rm -f`. Additionally, boot runs an orphan sweep:
   `docker rm -f` anything labeled `railyard.run` left over from a crashed process.

Out of scope here (M1): timeout kill, concurrency caps, provenance guards, secret env
injection — but the runner's function signature leaves room for them.

**Done when:** Docker-gated integration tests cover: happy path (input readable, events
dispatched mid-run, result collected), non-zero exit recorded as failure, container
always removed (assert via `docker ps -a`) including when the runner is interrupted.

## Step 6 — Run journal + event emitter

- `runs/journal.jsonl` append-only: `signal.received`, `run.started`, `run.finished`
  (+ `signal.dropped` for invalid emissions). Appends are serialized through one write
  queue so concurrent runs can't interleave partial lines.
- The same facts fire on `orchestrator.on(event, handler)` (plain Node `EventEmitter`
  semantics, typed wrapper).
- No retention logic (M1) — but journal exemption is already structural: pruning code
  won't exist until M1 and will take the per-run dirs only.

**Done when:** integration test asserts the journal tells the complete story of one
round-trip in order.

## Step 7 — Monitor interface + orchestrator assembly

- `Monitor` / `MonitorContext` interfaces exactly as SPEC §9; `ctx.state` backed by a
  per-monitor JSON file under a configurable `stateDir` (get/set/delete, write-through).
- `Orchestrator` public API (the whole M0 public surface):

  ```ts
  const yard = new Orchestrator({ agentsDir, runsDir, stateDir, transport? })
  yard.register(monitor)
  await yard.start()   // boot sequence: load+validate agents → compat check →
                       // build images → start monitors  (secrets step arrives in M1)
  await yard.stop()    // stop monitors → wait for in-flight runs → stop transport
  yard.on('run.finished', ...)
  ```

- Routing on each bus signal: match agents by `type`, apply filter, spawn one container
  per match (implicit fan-out, SPEC §3). M0 runs matches with naive unbounded
  concurrency; the M1 cap/queue slots into this dispatch point.

**Done when:** unit tests for routing/filter matching with a stubbed runner; `stop()`
provably waits for in-flight runs.

## Step 8 — End-to-end proof

- `examples/interval-monitor/`: emits `demo.tick` `{ n: number }` every 2s, cursor `n`
  kept in `ctx.state` (exercises the KV store).
- `packages/railyard/test/fixtures/agents/echo-agent/`: `alpine` Dockerfile + sh
  entrypoint — `cat "$AGENT_INPUT_FILE"`, append one `signal` line and one `log` line to
  `$AGENT_EVENTS_FILE`, write `result.json`, exit 0.
- Integration test: boot with temp dirs, wait for ≥1 completed run, assert: input
  round-tripped, agent-emitted signal appeared on the bus, run dir has all four files
  per SPEC §12, journal is coherent. Also a `examples/` runnable script for eyeballing.
- Docker-gated tests: `pnpm test` runs unit tests; `pnpm test:docker` (or auto-skip
  with a loud warning when the daemon is unreachable) runs integration.

**M0 exit criteria:** the SPEC §15 sentence is demonstrably true, `pnpm test` green
without Docker, `pnpm test:docker` green with it, and no M0 code imports anything
provider- or GitHub-specific.

---

## Decisions taken (veto anytime before Step N locks them in)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Workspace/build/test | pnpm + tsup + vitest, ESM-only | Boring defaults; spec is silent |
| 2 | Docker integration | Shell out to `docker` CLI | No socket-protocol dep (dockerode), matches "no magic", trivially debuggable; revisit behind `AgentExecutor` if needed |
| 3 | Signal IDs | `sig_` + `crypto.randomUUID()` | Zero deps; uniqueness is the only requirement (§9: no dedup semantics) |
| 4 | Filter grammar | `<jsonpath> <op> <json-literal>`, ops `==`/`!=` only | Smallest thing satisfying §3's example; growing ops later is additive |
| 5 | Schema compatibility | Deep structural equality (M0) | True subset-checking is a research problem; equality is strict-but-honest and fails loudly; replaceable in place |
| 6 | Events-file tailing | Host-side polling of the bind mount | Works on every platform, no in-container helper needed, tolerates any writer language |
| 7 | Prompt templating | Deferred to M2 | SPEC M2 owns `prompt.md` templating; M0 input = signal only, with the input-dir layout leaving room |
