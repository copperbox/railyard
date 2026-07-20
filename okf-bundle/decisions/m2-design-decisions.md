---
type: decision
title: M2 design decisions (Claude Code scaffold)
tags:
  - milestone-m2
  - contracts
  - docker
  - secrets
timestamp: 2026-07-20T04:01:45.987Z
---

Decisions made implementing M2 (Claude Code scaffold) that are not in SPEC.md and
should hold — or be consciously revisited — in later milestones and the Python/Rust
ports. Full rationale in PLAN-M2.md's decisions table. The template grammar has
[its own concept](/contracts/prompt-template-grammar.md); the root-refusal gotcha has
[its own too](/docker/claude-code-refuses-root.md).

## Contract additions (all additive)

- `$AGENT_PROMPT_FILE` → `input/prompt.md`: set only when the agent folder has a
  `prompt.md`; the name joined `RESERVED_AGENT_ENV_VARS`. Promptless agents see no
  new file and no new var. Works for `image:` agents too — a folder of just
  `manifest.yaml` (with `image:`) + `prompt.md` is valid.
- `schemas/journal-line.schema.json`: the journal's disk contract, one `oneOf`
  branch per event kind. Validated in tests against fixtures **and** real journal
  output (stub-executor scenario + the Docker e2e, line by line).
  `validateJournalLine` is exported.

## Scaffold shape (`scaffolds/claude-code/`)

- **In-repo folder, not an npm package**; zero core imports (invariant 9 trivially).
  Contents: `Dockerfile`, `entrypoint.mjs`, `manifest.yaml`, `prompt.md`, `README.md`,
  `publish.sh`.
- **Helper is a zero-dep Node ESM script** (Node ships in the image for Claude Code
  anyway). It pipes the rendered prompt to `claude -p --output-format json` via
  **stdin** (no argv limits) and writes Claude's result object **verbatim** as
  `result.json` — the provider shape stays inside the container, SPEC §14 holds.
  Exit 0 iff CLI exit 0 ∧ `is_error === false`. Helper emits `log` events only;
  signal emission is the prompt author's opt-in (chaining one-liner in the README).
- **Auth is any-of, not API-key-only**: the entrypoint fails fast only when none of
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (subscription token from
  `claude setup-token`), or `ANTHROPIC_AUTH_TOKEN` (gateway bearer) is set — the
  manifest simply declares whichever secret name applies; Claude Code resolves auth
  from env itself, and with several set the CLI's own precedence applies (an invalid
  `ANTHROPIC_API_KEY` shadows a valid OAuth token — unset stale credentials). No
  framework change was needed (secrets are names-only). The M2 exit proof ran green
  via subscription OAuth.
- **Image is generic** (nothing agent-specific COPY'd), so one build serves both
  copy-the-folder mode and `image:` mode. **ghcr publication is deferred to M5**
  (conscious deviation from SPEC §15's "published to ghcr" wording): content-hash
  caching means publishing saves no rebuilds; its real value — zero-build `image:`
  onboarding — is for M5's stranger audience, and an unautomated published image
  goes stale with every claude-code version bump. `publish.sh` (build-only unless
  `--push`) and the dual-mode README stay; target layout remains
  `ghcr.io/copperbox/railyard-claude-code:{<pinned claude-code version>, latest}`.
- Base `node:22-bookworm-slim` (glibc keeps Claude Code's bundled ripgrep happy),
  exact-pinned `@anthropic-ai/claude-code` (unpinned would make content-hash image
  tags lie), `--dangerously-skip-permissions` always on (the container is the
  sandbox), knobs as image ENV (`CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`,
  `CLAUDE_EXTRA_ARGS`) — copy-and-edit, no framework env-passthrough invented.
  Anything without a dedicated knob (e.g. `--effort`) rides `CLAUDE_EXTRA_ARGS`.

## Testing tiers

Three gates, each visibly skipped and loud when opted-in-but-unmet
([docker-gated tests](/testing/docker-gated-tests.md)):

1. `pnpm test` — helper tested on the host against a stub `claude` on PATH.
2. `pnpm test:docker` — the real `entrypoint.mjs` in a real container with a stub
   `claude`, assembled at test time from the shipping scaffold (no drift possible).
3. `pnpm test:llm` (`RAILYARD_LLM_TESTS=1`, implies the Docker gate) — real API
   money: haiku, turn/budget-capped, asserts a payload-derived nonce in the result,
   `total_cost_usd > 0`, and the API key absent from the whole `runs/` tree.

Related: [M1 design decisions](/decisions/m1-design-decisions.md),
[non-root agents](/docker/non-root-agents.md),
[container file ownership](/docker/container-file-ownership.md).
