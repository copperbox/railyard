# M2 implementation plan — Claude Code scaffold

> **Status: IMPLEMENTED (2026-07-19) — exit proof pending one keyed run.** All 8
> steps shipped; 192 tests green without Docker (`pnpm test`), 205 with
> (`pnpm test:docker`). The remaining box to tick is running `pnpm test:llm`
> once with a real `ANTHROPIC_API_KEY` (none is available in the dev sandbox) —
> the LLM suite is written, visibly skipped elsewhere, and fails loudly on
> missing prerequisites. ghcr push: `publish.sh` ready, awaiting go-ahead
> (build-only until then). Decisions table reflects what shipped.

Goal (from SPEC §15): `scaffolds/claude-code` — a Dockerfile, an entrypoint helper
(published to ghcr) adapting Claude Code headless mode to the container contract, and
`prompt.md` templating (`{{...}}` interpolation from the signal payload). Exit proof: a
real agent doing real (if small) LLM work end-to-end.

M2 splits cleanly in two:

- **Framework work** (steps 1–3): `prompt.md` templating. M0 decision 7 deferred this
  here and deliberately left room in the input-dir layout. The loader parses the
  template at boot (fail loudly), the orchestrator renders it per spawn, the runner
  writes it into the input mount. Rendering is pure data transformation — no code
  escape hatches, the same line the JSONPath filters hold.
- **Scaffold work** (steps 4–7): `scaffolds/claude-code` as plain agent-folder data
  plus an in-container helper script. The framework learns nothing about Claude Code
  (SPEC §14: no provider abstraction); the scaffold adapts Claude Code's own CLI to
  the existing container contract, which does not change to accommodate it.

Steps 1–2 and the helper's own tests (step 4) need no Docker; steps 3 and 5 add
Docker-gated tests behind `RAILYARD_DOCKER_TESTS=1`; step 6 introduces a third,
explicit gate for tests that spend real API money. `pnpm test` and `pnpm test:docker`
stay green after every step.

### New contract surface (review carefully — language-neutral disk contracts)

All M2 contract additions in one place. Everything is additive; nothing existing
changes shape.

**Template grammar** (a disk contract: `prompt.md` must mean the same thing to the
Python/Rust ports):

- A placeholder is `{{ <path> }}` (whitespace inside the braces optional).
- `<path>` is dot-separated segments; each segment is an object key matching
  `[A-Za-z0-9_-]+` or a non-negative integer array index. No quoting grammar, no
  expressions, no defaults, no code — declarative only, resolvable with a regex and a
  JSON walk in any language.
- **The data root is the full signal envelope** — the exact JSON the container sees in
  `input/signal.json`. So `{{payload.issue.title}}`, `{{type}}`, `{{source.name}}`,
  `{{payload.items.0}}` all work. (SPEC §15 says "templating from payload"; rooting at
  the envelope is a superset — confirmed with Dan, 2026-07-19.)
- Substitution: string values verbatim; numbers/booleans/null as JSON literals;
  objects/arrays as 2-space-indented JSON. A **missing path is a spawn-time error**
  (the run fails and is journaled) — never a silent empty string.
- Any `{{` that does not open a well-formed placeholder is a **template syntax error
  at boot** (invariant 4). No escape sequence in v1 — a literal `{{` in a prompt is
  not supported yet; adding an escape later is additive.

**Input-dir addition** (container contract, SPEC §5): when an agent folder contains
`prompt.md`, the rendered prompt is written to `input/prompt.md` (read-only mount,
alongside `signal.json`) and `AGENT_PROMPT_FILE` is set. Agents without a `prompt.md`
see no new file and no new var. `AGENT_PROMPT_FILE` joins `RESERVED_AGENT_ENV_VARS`
(a secret with that name now fails the loader — the correct behavior).

**Not framework contract:** the shape the scaffold's helper writes into `result.json`
is Claude Code's own `--output-format json` object, passed through verbatim. That is
provider-specific content inside the container, exactly where SPEC §14 wants it.

**`journal-line.schema.json`** (confirmed in scope, 2026-07-19): the journal is a
language-neutral disk contract but has no schema file in `schemas/` yet (flagged at
end of M1). Ships in step 8: one schema with a `oneOf` per event kind, validated in
tests against real journal output. M2 adds no new journal vocabulary, so the surface
being schematized is stable.

---

## Step 1 — Prompt template: parse + render (pure, no Docker)

`src/prompt/template.ts`, exported from `src/index.ts`:

- `parsePromptTemplate(source, context)` → `ParsedPromptTemplate` — splits the source
  into literal/placeholder segments at parse time; throws (with the offending
  placeholder and offset, prefixed by `context`) on any malformed `{{`.
- `renderPromptTemplate(template, envelope)` → `string` — pure function of parsed
  template × signal envelope, substitution rules as specified above; throws naming
  the placeholder on a missing path.
- No new dependencies; the grammar is a small hand-rolled scanner (same posture as
  the `.env` parser and the filter grammar).

**Done when:** unit tests cover: every substitution type (string, number, boolean,
null, object, array), envelope-root paths (`type`, `source.name`), array indices,
whitespace tolerance, adjacent placeholders, missing-path error naming the path,
malformed-placeholder parse errors (unclosed, empty, bad segment), multi-line
templates round-tripping literal text exactly.

## Step 2 — Loader: `prompt.md` is part of the agent folder

- `LoadedAgent` gains `promptTemplate: ParsedPromptTemplate | null` (+ the raw source
  for tooling). `loadAgentFolder` reads `prompt.md` if present and parses it at boot —
  a syntax error fails the load naming the agent folder (invariant 4).
- Works for both image sources: a folder with `manifest.yaml` + `prompt.md` +
  `image:` (no Dockerfile) is valid and useful — see step 7.
- `AGENT_PROMPT_FILE` added to `RESERVED_AGENT_ENV_VARS`.
- `prompt.md` stays in the folder content hash (no exemption): editing the prompt
  rebuilds the image on next boot. Mildly wasteful (the image doesn't contain
  prompt.md) but "what's in the folder is literally what builds" — no magic, no
  special cases.

**Done when:** unit tests over fixture folders: prompt.md loaded and parsed, absent
prompt.md → null, malformed template fails boot with folder+placeholder in the
message, `image:`+prompt.md folder loads, secret named `AGENT_PROMPT_FILE` rejected.

## Step 3 — Runner + orchestrator: render per spawn

- `RunAgentParams.renderedPrompt?: string`. When present the runner writes it to
  `input/prompt.md` (through `redactString`, belt-and-braces — payloads are already
  redacted at emission) before `docker create`, and adds
  `-e AGENT_PROMPT_FILE=/railyard/input/prompt.md`. Absent → no file, no var.
- Orchestrator `launch()`: rendering happens inside the tracked run promise, before
  secret resolution. A render failure (missing path) therefore lands in the existing
  `run.finished` `status: "error"` path — journaled, slot released, queue advanced,
  no container ever created. **No new journal vocabulary.**
- Rendering at launch (not at enqueue) keeps queued entries plain signal envelopes.

**Done when:** unit tests (stub executor) verify the rendered string reaches the
executor for prompt-bearing agents, is absent otherwise, and a missing-path render
error journals `run.finished` `status: "error"` naming the placeholder without
invoking the executor. Docker-gated test: a fixture agent whose entrypoint `cat`s
`$AGENT_PROMPT_FILE` proves the file arrives rendered, read-only, with the var set;
an existing no-prompt fixture proves the var is absent.

## Step 4 — `scaffolds/claude-code/`: the folder + entrypoint helper

New top-level `scaffolds/` directory (in-repo per SPEC §13, not an npm package —
scaffolds are copied, and use zero core imports, satisfying invariant 9 trivially).

```
scaffolds/claude-code/
  manifest.yaml     # secrets: [ANTHROPIC_API_KEY]; example subscription; timeout: 900
  prompt.md         # starter template showing envelope-root interpolation
  Dockerfile        # node:22-bookworm-slim + pinned @anthropic-ai/claude-code
  entrypoint.mjs    # the helper: Claude Code headless → container contract
  README.md         # copy-me instructions, knobs, template grammar reference
```

**Dockerfile** (modeling, per brain `/docker/non-root-agents.md`):

- `FROM node:22-bookworm-slim`; `npm install -g @anthropic-ai/claude-code@<pinned>`
  (exact version, no ranges); `git` + `ca-certificates` installed (glibc image, so
  Claude Code's bundled ripgrep works — no Alpine musl caveats).
- Build as root, then `RUN useradd -u 10001 -m agent` + `USER agent`, with the
  explanatory comment: least-privilege runtime + host-side file ownership + **Claude
  Code itself refuses `--dangerously-skip-permissions` as uid 0**, so non-root is
  load-bearing here, not just hygiene.
- Writable `HOME=/home/agent` (Claude Code writes `~/.claude`), `WORKDIR /workspace`
  (agent-owned scratch dir).
- Config knobs as image `ENV` with defaults — `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`,
  `CLAUDE_EXTRA_ARGS` — copy-and-edit configuration, no framework env passthrough
  invented.

**entrypoint.mjs** (Node ESM, zero deps — Node is already in the image):

1. Fail fast with a `log` event + exit 1 if `ANTHROPIC_API_KEY` is unset or
   `$AGENT_PROMPT_FILE` is unset/unreadable — the scaffold requires a `prompt.md`.
2. Append `log` events at start (model, max turns) and finish (cost, turns,
   duration) to `$AGENT_EVENTS_FILE`.
3. Run `claude -p --output-format json --dangerously-skip-permissions
   --model $CLAUDE_MODEL --max-turns $CLAUDE_MAX_TURNS $CLAUDE_EXTRA_ARGS`, piping
   the prompt via **stdin** (no argv size limits), cwd `/workspace`.
4. Write Claude's result JSON **verbatim** to `$AGENT_OUTPUT_DIR/result.json`.
   Unparsable output → write `{"error": ...}` + the raw tail, log event, exit 1.
5. Exit 0 iff the CLI exited 0 **and** `is_error === false`; else exit 1. The
   framework's success/failure semantics stay purely exit-code-based.
6. The helper does not auto-emit `signal` events — chaining is the agent author's
   choice (the prompt can instruct Claude to append to `$AGENT_EVENTS_FILE`; the
   README shows the one-liner).

**Done when:** helper unit tests (no Docker, no API key, no network): run
`entrypoint.mjs` under host Node against temp dirs with a stub `claude` executable
prepended to `PATH` (POSIX shell script emitting canned JSON). Cover: happy path
(result.json verbatim, log events appended, exit 0), `is_error: true` → exit 1,
CLI non-zero exit → exit 1, unparsable stdout → error result.json + exit 1, missing
key / missing prompt file → exit 1 before spawning `claude`, prompt actually arrives
on the stub's stdin.

## Step 5 — Docker-gated: the helper honors the contract in-container

Real container, no network beyond the base-image pull, no API key: the test
assembles a temp agent folder from the **real** `scaffolds/claude-code/entrypoint.mjs`
(copied at test setup — no in-repo duplication) plus a stub-`claude` Dockerfile
(`node:22-bookworm-slim`, stub on PATH, same non-root pattern), then boots the real
orchestrator against it.

**Done when:** the run succeeds end-to-end: rendered prompt consumed, stub's JSON
lands verbatim in `output/result.json`, helper `log` events appear in `events.jsonl`
and `agent.log`, run record `succeeded`; a second variant with `is_error: true`
yields `status: "failed"`. This proves contract adaptation separately from (and much
cheaper than) real LLM runs.

## Step 6 — Real-LLM gate + the M2 exit proof

**New test gate** (never silently skipped, mirroring the Docker gate):

- `RAILYARD_LLM_TESTS=1` gates the suite via `describe.skipIf`; skipped suites are
  visibly reported.
- Script `test:llm` = `cross-env RAILYARD_DOCKER_TESTS=1 RAILYARD_LLM_TESTS=1 vitest
  run` (LLM tests imply Docker). Root script fans out like `test:docker`.
- When the var is set, `beforeAll` **fails loudly** if the Docker daemon is down *or*
  `ANTHROPIC_API_KEY` is unresolvable — resolved via `EnvSecretsProvider`, so a
  repo-root `.env` works and CI can never claim coverage it didn't deliver.

**Exit-proof e2e** (SPEC §15 M2 sentence, demonstrably true): boot the real
orchestrator with a test monitor emitting one signal whose payload carries a nonce
word; agent folder = the real scaffold (copied to a temp dir with a test prompt.md);
prompt instructs Claude to answer with a derivation of `{{payload.word}}` that
requires reading it (e.g. uppercase + a fixed prefix). Pinned cheap model
(`claude-haiku-4-5`), `--max-turns` small, `--max-budget-usd` cap via
`CLAUDE_EXTRA_ARGS`. Assert: run `succeeded`; `result.json.result` contains the
derived nonce; `is_error === false`; `total_cost_usd > 0` (money moved = a real API
round-trip); the key appears nowhere under `runs/` (the M1 leak-grep, now against a
real provider flow — redaction covers the scaffold path).

**Done when:** `pnpm test:llm` is green locally with a real key (cost: well under
$0.01/run); `pnpm test` / `pnpm test:docker` remain green and key-free.

## Step 7 — ghcr image: layout + publish (confirm before any push)

The scaffold Dockerfile COPYs only `entrypoint.mjs` — `manifest.yaml`/`prompt.md`
are host-side data. The built image is therefore **generic**: one image serves every
claude-code agent, and SPEC §13's "entrypoint helper published to ghcr" is just this
image. Two consumption modes fall out for free:

- Copy the folder, keep the Dockerfile (hackable, rebuilt at boot).
- `image: ghcr.io/copperbox/railyard-claude-code:<tag>` + `prompt.md` in the folder —
  no Dockerfile, no local build (pull-verified at boot, M0 machinery).

Proposed layout: `ghcr.io/copperbox/railyard-claude-code`, tagged with the pinned
Claude Code version (e.g. `2.1.211`) plus `latest`; built from
`scaffolds/claude-code/Dockerfile` with a small `publish.sh` beside it (manual
`docker build` + `push`; CI automation is M5's problem).

**Done when:** naming/tags confirmed with Dan; `publish.sh` exists and is documented;
**no push and no registry/repo setup happens without explicit go-ahead**. The README
documents both consumption modes either way (the `image:` path is testable locally by
building the tag without pushing).

## Step 8 — Wrap-up

- Mark PLAN-M2.md complete with final test counts.
- `schemas/journal-line.schema.json` (confirmed in scope) + tests validating real
  journal output from existing e2e runs against it.
- Brain: record M2 decisions (`/decisions/m2-design-decisions.md`, linked to M0/M1);
  new concept for the template grammar (it's a cross-port contract); update
  `/docker/non-root-agents.md` "Where it lands" (M2 shipped) and
  `/testing/docker-gated-tests.md` (third gate).
- README: mention `scaffolds/`.

**M2 exit criteria:** SPEC §15's M2 sentence demonstrably true under `pnpm test:llm`;
templating shipped as framework work with the grammar documented; scaffold models
non-root + pinned install + verbatim result pass-through; `pnpm test` green without
Docker; `pnpm test:docker` green without an API key; M0/M1 public exports unchanged
(only added to); the container contract unchanged except the additive
`AGENT_PROMPT_FILE`.

---

## Decisions taken (veto anytime before the step that locks them in)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Template grammar | `{{ dot.path }}`; segments `[A-Za-z0-9_-]+` or integer index; no quoting/expressions/escapes; malformed `{{` fails boot | Declarative-only (the JSONPath-filter line holds); portable with a regex + JSON walk; fail loudly beats silent literal pass-through |
| 2 | Template data root | Full signal envelope (the exact `signal.json` JSON), not payload-only | Prompts legitimately need `type`/`source`; "template sees what the container sees" is one rule, not two; superset of SPEC's "from payload" — confirmed with Dan |
| 3 | Substitution rules | Strings verbatim; other values as JSON (2-space for objects/arrays); missing path = spawn-time run failure, journaled | Never silently render `""`; JSON rendering is language-neutral; null is a value, missing is a bug |
| 4 | Render timing | At `launch()`, inside the tracked run promise; failures use the existing `run.finished` `status: "error"` path | No new journal vocabulary; queue stays plain envelopes; slot/queue bookkeeping untouched |
| 5 | Rendered-prompt location | `input/prompt.md` + `AGENT_PROMPT_FILE` (reserved), only when the agent has a `prompt.md` | M0 layout left exactly this room; additive; absence stays contractually clean for promptless agents |
| 6 | `prompt.md` in folder hash | Included, no exemption | Invariant 8; a needless rebuild is cheaper than a special case |
| 7 | Helper language & deps | Node ESM script, zero deps, lives in the scaffold folder | Node ships in the image anyway; JSON handling in `sh` is how bugs are born |
| 8 | Helper result mapping | Claude's `--output-format json` object verbatim as `result.json`; exit 0 iff CLI exit 0 ∧ `is_error === false`; helper emits `log` events only | Provider shape stays inside the container (SPEC §14); no invented cross-provider result schema; chaining stays author-opt-in |
| 9 | Prompt delivery to CLI | Piped via stdin to `claude -p --output-format json` | Avoids argv length limits; documented headless form |
| 10 | Base image & pinning | `node:22-bookworm-slim`, `@anthropic-ai/claude-code@<exact>`, git + ca-certificates | glibc avoids musl/ripgrep caveats; Claude Code wants Node ≥ 22; unpinned installs make image hashes lie |
| 11 | Non-root scaffold user | `useradd -u 10001 -m agent` + `USER agent`, comment in Dockerfile | Brain decision (deferred to M2); uid matches fixtures, no host uid; **Claude Code refuses `--dangerously-skip-permissions` as root**, so this is functionally required |
| 12 | Permissions inside container | `--dangerously-skip-permissions` by default in the scaffold | The container **is** the sandbox (its only powers are its mounts + declared secrets, invariant 6); an interactive permission prompt in headless mode is a hang, not a safeguard |
| 13 | Scaffold config | Image `ENV` knobs (`CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`, `CLAUDE_EXTRA_ARGS`) | Scaffolds are copy-and-edit; a framework env-passthrough feature is new manifest surface M2 doesn't need |
| 14 | LLM test gate | `RAILYARD_LLM_TESTS=1` (+ Docker gate), `pnpm test:llm`; set-but-unmet prerequisites fail loudly; key via `EnvSecretsProvider` | Same never-silently-skip posture as the Docker gate; `.env` support for local dev |
| 15 | LLM e2e cost control | `claude-haiku-4-5` pinned, small `--max-turns`, `--max-budget-usd` cap, nonce-derivation assertion | Deterministic-enough assertion of real LLM work for well under $0.01/run |
| 16 | ghcr layout | `ghcr.io/copperbox/railyard-claude-code:{<claude-code version>, latest}`, built from the scaffold Dockerfile, manual `publish.sh` | One Dockerfile serves copy-mode and `image:`-mode; version tag = the only thing that varies; CI publishing deferred to M5 — **no push without confirmation** |
