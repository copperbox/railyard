# M1 implementation plan — safeguards & secrets

> **Status: COMPLETE (2026-07-19).** All steps implemented; 131 tests green
> without Docker (`pnpm test`), 141 with (`pnpm test:docker`). Decisions table
> at the bottom reflects what shipped. Next: M2 (Claude Code scaffold).

Goal (from SPEC §15): concurrency caps + queueing, hard timeouts (incl. explicit
`timeout: null`), provenance depth limit + self-trigger guard, `SecretsProvider` +
redaction, retention sweep. Exit proof: the skeleton grows agent-chaining — one agent's
emitted signal triggers a second agent — with the guards demonstrably enforced.

M0 already banked the schema work: `agent-manifest.schema.json` declares `secrets`,
`concurrency`, `timeout`, `network`, `allowSelfTrigger` with defaults, so **M1 is
enforcement, not schema churn**. `RunRecord.killReason` exists (always null in M0) for
timeout kills to fill. The queue's insertion point is the marked M1 comment in
`orchestrator.ts` `dispatch()`.

Steps are ordered so each is independently testable and committable. Steps 1, 2, 6 need
no Docker at all; 3–5 and 7 add Docker-gated tests behind `RAILYARD_DOCKER_TESTS=1` but
keep their logic unit-tested without it. `pnpm test` and `pnpm test:docker` stay green
after every step.

### New journal vocabulary (disk contract — review carefully)

All M1 journal additions in one place, since journal shapes are a language-neutral disk
contract for the future ports. Existing event kinds are untouched; M1 adds:

| Event | Fields | When |
|---|---|---|
| `run.queued` | `agent, signalId, signalType, queueDepth` | Matched signal waits because the agent is at its concurrency cap |
| `run.skipped` | `agent, signalId, signalType, reason` | A matched signal that will never run: `reason: "self-trigger"` (refused, §7) or `reason: "shutdown"` (queued-then-dropped at `stop()`) |
| `retention.swept` | `removed: string[]` (run ids) | A sweep actually pruned something (silent when nothing to do) |
| *(extended)* `run.finished` | gains optional `killReason: string` | Present on timeout kills |
| *(reused)* `signal.dropped` | existing shape, new `reason` text | Emission beyond the depth limit |

This satisfies the invariant-10 checklist verbatim: queued-then-dropped, beyond-depth,
refused self-trigger, and timeout kills are all journaled.

---

## Step 1 — Provenance depth limit + self-trigger guard

Pure orchestrator logic; no new deps, no Docker.

- `OrchestratorConfig.maxChainDepth?: number` (default **5**, SPEC §7 — framework
  config, not a manifest field; validated ≥ 1).
- **Depth check at emission** (in `emitSignal`): a would-be signal whose provenance
  chain length exceeds `maxChainDepth` is dropped before it reaches the transport, and
  journaled as `signal.dropped` with a reason naming the depth and the limit. Only
  agent emissions can hit this (monitor provenance is always empty).
- **Self-trigger check at routing** (in `route`): when `signal.source` is agent X and a
  subscription of agent X matches, the dispatch is refused unless
  `allowSelfTrigger: true` — journaled as `run.skipped` with `reason: "self-trigger"`.
  Other matching agents still fire; the refusal is per-agent, not per-signal.
- Direct source only: A→B→A cycles are *not* "self-triggering" — they are bounded by
  the depth limit instead (decision 2).

**Done when:** unit tests (stub executor) cover: chain at exactly the limit runs, one
past the limit is dropped + journaled, self-trigger refused by default + journaled,
`allowSelfTrigger: true` permits it, refusal doesn't block other matching agents,
configurable `maxChainDepth` respected.

## Step 2 — Per-agent concurrency cap + in-memory queue

Slots into the marked M1 point in `dispatch()`.

- Per agent: `{ active: number, queue: SignalEnvelope[] }`. If `active >=
  manifest.concurrency` (default 1), enqueue FIFO and journal `run.queued`; when a run
  settles, dequeue next before anything else.
- Queue is unbounded and in-memory — SPEC §10 explicitly accepts losing queued signals
  on crash in v1; no cap invented here.
- `stop()` ordering: stop monitors → **drop all queued entries**, journaling each as
  `run.skipped (reason: "shutdown")` → drain in-flight runs → stop transport. Draining
  queues at stop could run arbitrarily long chains; dropping-with-journal is the honest
  v1 behavior (decision 3).
- Note: `stop()` still waits for in-flight runs; a `timeout: null` agent can therefore
  block shutdown indefinitely. Accepted and documented — the user opted into "may run
  forever".

**Done when:** unit tests with a stub executor whose completion is externally
controlled: cap 1 serializes two matched signals (second queues, journaled, runs after
first settles); cap 2 runs two concurrently; FIFO order holds; queue drains across
several signals; `stop()` drops queued entries with journal lines and still finishes
in-flight runs; a failed run still releases its slot.

## Step 3 — Hard timeout

Lives in the runner (it is Docker-mechanics), plumbed from the manifest through
`RunAgentParams`.

- `RunAgentParams.timeoutSeconds: number | null` — the orchestrator passes
  `manifest.timeout` (schema default 900; explicit `null` = no timer at all).
- Clock starts at `docker start`. On expiry: `docker kill` the container (SIGKILL →
  exit 137), which unblocks the existing `docker wait`/logs path so captured output is
  preserved, then the existing `finally` teardown runs unchanged — guaranteed teardown
  is untouched.
- `RunRecord.killReason` = `"timeout: exceeded <N>s"`; `status` stays `"failed"` — the
  two-value status enum is unchanged, `killReason` is the discriminator (decision 5).
  `run.finished` journal entry carries `killReason` too.
- Timer is cleared on normal exit; no timer exists when `timeout: null`.

**Done when:** unit tests verify plumbing (stub executor receives the right
`timeoutSeconds` for default / explicit value / explicit null). Docker-gated tests: a
sleep-forever fixture agent with `timeout: 2` is killed (~2s not 60s), its run dir has
all artifacts, `result.json.killReason` set, container removed; a fast agent with
`timeout: null` completes normally with `killReason: null`.

## Step 4 — `SecretsProvider` + boot resolution + injection

The seam (invariant 7), its default implementation, and least-privilege injection.

- ```ts
  interface SecretsProvider {
    /** Resolved value, or undefined if this provider cannot supply the name. */
    resolve(name: string): Promise<string | undefined>
  }
  ```
- `EnvSecretsProvider` (default): `process.env` first, then a `.env` file (path
  configurable, default `<cwd>/.env`, missing file is fine). `.env` parsing is a
  hand-rolled minimal parser — `KEY=value` lines, `#` comments, optional single/double
  quotes, no interpolation — zero new deps (decision 6).
- Boot sequence gains SPEC §10 step 3, between the compat check and image builds:
  resolve every secret name declared by any loaded agent; any unresolvable name fails
  `start()` loudly, listing the missing *names* (never values). Also rejected at boot:
  a declared secret name colliding with the reserved `AGENT_*` container-contract vars.
- Spawn-time: secrets are resolved **again at each spawn** (rotation-friendly;
  decision 8) and injected only for the names that manifest declares. Injection uses
  value-less `-e NAME` flags with the values placed in the docker CLI child process's
  environment — secret values never appear on a command line (visible in `/proc`)
  (decision 7). `docker inspect` on a live container still shows them; that is SPEC
  §8's accepted residual risk.
- `OrchestratorConfig.secrets?: SecretsProvider` (default `EnvSecretsProvider`).

**Done when:** unit tests: `.env` parser fixtures, process-env precedence, boot failure
lists exactly the missing names, reserved-name collision fails boot, only declared
names are passed to the executor (stub inspects `params.env`). Docker-gated test: an
agent that asserts `$MY_SECRET` inside the container matches the expected value
(compares and exits 0/1 — the value itself is never written to output).

## Step 5 — Redaction

The framework guarantee (SPEC §8, invariant 5): secret values never appear in signals,
run records, journal entries, `agent.log`, or framework logs.

- `Redactor`: holds the set of registered secret values; `redactString` replaces every
  literal occurrence with `[REDACTED:<NAME>]` (names are manifest-public, safe to
  show); `redactJson` deep-walks a JSON value redacting string contents. One shared
  instance is created by the orchestrator and accumulates values as they are resolved
  (boot + each spawn), so rotation only ever *adds* patterns.
- Multi-line secret values (PEM keys) additionally register each individual line, so
  line-oriented sinks still catch them (decision 9).
- Values shorter than 6 characters are excluded from literal redaction — replacing
  every `"1"` in every JSON document would destroy the record — with a **loud boot
  warning** naming the secret. Tunable-not-silent (decision 9).
- Wiring, every sink:
  - **journal**: `Journal` gets an optional redact hook applied to the serialized line.
  - **framework logs**: the orchestrator wraps its `Logger` in a redacting wrapper.
  - **agent.log**: the runner's log capture becomes line-buffered (split chunks into
    complete lines, hold partials) so redaction cannot be defeated by a secret split
    across stream chunks; each complete line is redacted before hitting disk.
  - **signals**: emitted payloads are deep-redacted *before* schema validation and
    stamping — what validates is what ships (decision 10).
  - **run records**: `invocation.json` and the framework `result.json` are redacted at
    serialization.
  - **events.jsonl** (preserved copy): rewritten through the redactor after the run —
    not in SPEC §8's list, but leaving raw agent writes on disk would be a hole
    (decision 10).
- Known, documented limitation: literal matching only — base64/URL-encoded exfiltration
  is not caught in v1 (same posture as SPEC §8's residual-risk note).

**Done when:** unit tests: string/JSON redaction, multi-line registration, short-value
warning path, journal and logger wrappers, tailer/log line-buffering across chunk
boundaries, emitted-signal payload redaction. Docker-gated test: an agent that prints
its secret to stdout, writes it into `result.json`, and emits it in a signal payload —
then assert the value appears **nowhere** under `runs/` (grep the whole tree) while
`[REDACTED:...]` markers do.

## Step 6 — Retention sweep

Pure filesystem logic; no Docker needed.

- `OrchestratorConfig.retention?: { maxAgeDays?: number; maxRunsPerAgent?: number }`
  (validated positive). Unset ⇒ unlimited, with a **loud startup warning** plus a
  journal `note` — a default must never silently delete evidence (SPEC §12).
- Sweep: enumerate run *directories* matching the run-id shape under `runsDir`;
  `journal.jsonl` is structurally exempt (the sweep only ever removes matching
  directories, never files). Apply both rules and delete the union — whichever prunes
  more wins. Run-ids embed agent + timestamp, so no parsing of dir contents is needed.
- **Active runs are always excluded**, whatever their age — the orchestrator passes its
  live run-id set (a long-running agent must not have its run dir deleted mid-flight).
- Runs at boot (after journal init) and after each `run.finished` — no background
  timers. Prunes journaled as `retention.swept` with the removed run ids.

**Done when:** unit tests over fabricated run dirs: age rule, count rule (per-agent,
newest kept), union-wins combination, journal.jsonl and non-run files untouched,
active-run exclusion, unset-config warning fires, sweep-after-run triggered via stub
executor, `retention.swept` journaled.

## Step 7 — Exit proof: agent chaining, end-to-end

SPEC §15's M1 sentence, demonstrably true.

- New Docker fixtures (alpine + `sh`, like `echo-agent`): `chain-emitter` (on
  `demo.tick`, appends a `chain.step` signal event, `allowSelfTrigger` absent) and
  `chain-receiver` (on `chain.step`, writes a result proving what it received).
- Docker-gated e2e: one monitor tick → `chain-emitter` runs → its emitted `chain.step`
  triggers `chain-receiver` mid-run-or-after → both runs journaled, receiver's
  triggering signal has provenance depth 1 with the emitter as the chain entry,
  receiver's input `signal.json` round-trips the payload.
- The guard proofs stay in fast unit tests (steps 1–2) — Docker e2e proves the happy
  chain; unit tests prove depth-5 cutoff and self-trigger refusal at the same dispatch
  code path.
- Grow `examples/demo` with the chain pair so the eyeball-able demo shows chaining.
- Docs pass: PLAN-M1 marked complete; brain concepts recorded (M1 decisions, linked to
  `/decisions/m0-design-decisions.md`).

**M1 exit criteria:** chaining proven end-to-end under Docker; depth limit (default 5)
and self-trigger refusal enforced and journaled; every safeguard tunable and none
silently absent; `pnpm test` green without Docker; `pnpm test:docker` green with it;
M0's public exports unchanged (only added to).

---

## Decisions taken (veto anytime before the step that locks them in)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Depth semantics | A signal is dropped at emission when its provenance chain would exceed `maxChainDepth` (default 5); config lives on `OrchestratorConfig`, not the manifest | §7 says framework-enforced + configurable; per-agent depth config would make chain behavior depend on who's last |
| 2 | Self-trigger definition | Direct only: `signal.source` names the same agent. A→B→A is allowed until the depth limit bites | §7 treats self-trigger and depth as two separate guards; making self-trigger transitive would just re-implement the depth limit, stricter and vaguer |
| 3 | Queue at `stop()` | Queued entries are dropped and journaled (`run.skipped`, reason `shutdown`); in-flight runs still drain | Draining queues could chain indefinitely; SPEC §10 already accepts queued-signal loss in v1 — journaling makes it non-silent (invariant 10) |
| 4 | Timeout kill mechanics | Timer from `docker start`; `docker kill` (SIGKILL) on expiry; existing wait/logs/teardown path runs unchanged | Smallest change that preserves log capture + guaranteed teardown; exit 137 is the conventional SIGKILL signature |
| 5 | Run-record status on kill | `status` stays `"succeeded" \| "failed"`; `killReason` (already in the M0 disk shape) is the discriminator | No churn to the run-record contract; M0 reserved the field for exactly this |
| 6 | Default secrets source | `EnvSecretsProvider`: `process.env`, then a minimal hand-rolled `.env` parser (no interpolation) | SPEC §8 names env/.env as the default; zero new deps, "no magic" |
| 7 | Secret injection | Value-less `-e NAME` docker flags; values passed via the docker child process env | Values never appear on an argv (readable in `/proc`); container-side visibility is §8's accepted residual risk |
| 8 | Resolution timing | Boot check resolves all names once (fail fast); each spawn re-resolves | §8 says both "at spawn" and "boot-time check"; re-resolving makes rotation work without restart |
| 9 | Redaction mechanics | Literal replacement with `[REDACTED:<NAME>]`; multi-line values also register per-line; values < 6 chars excluded with a loud boot warning | Literal matching is honest and predictable; redacting `"1"` everywhere destroys records — a loud warning beats silent false confidence |
| 10 | Redaction sinks | Journal (and the mirrored emitter events), framework logger, line-buffered agent.log, emitted payloads (redacted before validation), invocation.json, framework result.json, post-run rewrite of preserved events.jsonl **and the agent's own output/result.json** (via temp+rename — container files may be root-owned). Arbitrary other agent-written output files are documented as not rewritten | Covers every §8-listed sink plus the on-disk files §8 missed; redact-then-validate means the wire format is the validated format; rewriting arbitrary agent output (possibly binary) is out of scope |
| 11 | Retention rule combination | Delete the union of what each rule selects; active run-ids always excluded; only run-shaped directories ever touched | "Whichever prunes more wins" (SPEC §12) = union; structural exemption for journal.jsonl beats a denylist |
| 12 | New journal events | `run.queued`, `run.skipped` (reason: `self-trigger` \| `shutdown`), `retention.swept`; `run.finished` gains optional `killReason`; depth drops reuse `signal.dropped` | One skipped-event with a reason enum instead of two near-identical events; every invariant-10 case journaled; all plain JSON |
| 13 | Reserved env names | A declared secret named like a contract var (`AGENT_INPUT_FILE`, …) fails boot | Silent clobbering of the container contract would be a 2am bug; fail loudly at boot (invariant 4) |
