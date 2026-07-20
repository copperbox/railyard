# M4 implementation plan — user-zero dogfood

> **Status: COMPLETE (2026-07-20).** SPEC §15's M4 sentence is demonstrably true on
> `copperbox/railyard`: three real issues labeled `needs-review` each spawned a Claude
> Code container that wrote a genuinely useful triage review into its run record — no
> GitHub writes, Claude auth the container's only secret. Runs/-only first pass shipped;
> the comment-posting second pass is **banked** (Dan, 2026-07-20) as filed issue
> [#2](https://github.com/copperbox/railyard/issues/2), preserving the container's
> zero-GitHub-access property. Friction log (`docs/m4-friction.md`) fully dispositioned:
> two core public-API fixes with tests (`on()`/`off()` event-narrowing generics; the
> `EnvSecretsProviderOptions.envFile` cwd docstring), two example/docs fixes, no
> framework surface invented that the dogfood didn't demand. 204 unit / 274 docker green.
> Retargeted from `dantheuber/jeeves` to `copperbox/railyard` at approval.
>
> **Evidence — the real run (2026-07-20T06:56Z, `examples/github-review`):**
>
> ```
> signal.received github.issue.labeled  (monitor:github-issues, provenanceDepth 0)
> run.started    issue-reviewer  #1
> signal.received github.issue.labeled                        ← #3, one poll later
> run.queued     issue-reviewer  queueDepth 1                 ← concurrency cap held
> run.finished   issue-reviewer  #1  succeeded exit=0  18.25s
> run.started    issue-reviewer  #3  (drained from queue in order)
> run.finished   issue-reviewer  #3  succeeded exit=0  15.87s
> run.finished   issue-reviewer  #2  succeeded exit=0  14.25s
> ```
>
> Review excerpt (#3, the vague one-liner "no way to put a literal `{{` in prompt.md"):
> the agent correctly flagged the report as incomplete-for-reproduction and asked the
> five concrete unblocking questions (exact snippet, error output, version, existing
> escape syntax, whole-file-vs-line failure), severity hedged to the maintainer.
>
> **Cost:** 3 reviews, 1 turn each, **$0.166 total** ($0.079 / $0.042 / $0.045) — well
> under the `--max-budget-usd 0.50` cap and `CLAUDE_MAX_TURNS 8` limit. Model
> `claude-sonnet-5`. Monitor cursor advanced 0 → 28198247642; clean SIGINT stop.

Goal (from SPEC §15): the actual workflow — a label on a GitHub issue → a Claude Code
agent reviews it. **Whatever friction this surfaces gets fixed in core's public API
before anything else is added.** The friction log is the milestone's true deliverable;
the running workflow is how we earn it.

Shape decisions confirmed with Dan (2026-07-19):

- **Target: `copperbox/railyard`** (private; this repo's own tracker — maximal
  dogfood honesty: the framework reviews issues about itself. Retargeted from
  `dantheuber/jeeves` at plan approval. Dan's `gh` identity has access; local
  `main` must be pushed so the watched repo reflects the running code).
- **First pass is runs/-only**: the review lands in the run record
  (`output/result.json`), read by a human. No comment posting yet — zero write scope
  while the prompt is tuned. Comment-posting is an explicit *candidate second pass*
  inside M4 (Dan's call once the first pass produces reviews worth posting).
- **Issue-text-only grounding**: the review works from the signal payload (title,
  body, labels, author) — no repo clone. Triage-style output: clarity, reproduction
  steps, severity, suggested labels, follow-up questions.
- **Labels untouched**: dedup by event id already prevents duplicate runs; the agent
  performs no GitHub writes of any kind.

The least-privilege consequence worth savoring: **the container declares no
`GITHUB_TOKEN` secret at all** — only Claude auth. The monitor (host-side) needs a
read-only token; the agent needs nothing from GitHub because the signal payload is
already the input. Least privilege fell out of the architecture rather than being
bolted on.

No new automated tests in M4 by design: M2 proved real-Claude, M3 proved
monitor→filter→container; a combined real-GitHub+real-LLM CI test would be flaky and
expensive. The dogfood proof is a real run, and its evidence is captured in this file
when complete.

---

## Step 1 — `examples/github-review/`: the first real user program

Workspace member mirroring `examples/demo`'s layout:

- `src/main.ts`: `Orchestrator` (agentsDir/runsDir/stateDir inside the example,
  gitignored) + `GitHubIssuesMonitor({ repos: ['copperbox/railyard'], token:
  process.env.GITHUB_TOKEN, pollIntervalMs: 60_000 })` + console wiring of
  `signal.received` / `run.started` / `run.finished` so the terminal narrates the
  workflow. Retention set (e.g. `maxRunsPerAgent: 50`) to avoid the unset warning.
- Token guidance in the example README: `GITHUB_TOKEN=$(gh auth token)` for local
  dev, or a fine-grained PAT with read-only Issues + Metadata on
  `copperbox/railyard`.
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` resolves via the M1
  `EnvSecretsProvider` (repo-root `.env` works).
- `.gitignore` entries for `runs/`, `state/`, `.env`.

**Done when:** `pnpm -r typecheck` and root test suites stay green; `pnpm start`
without a token fails loudly at the monitor preflight (the boot doing its job).

## Step 2 — the `issue-reviewer` agent (scaffold copy mode)

`examples/github-review/agents/issue-reviewer/`, copied from
`scaffolds/claude-code/` exactly as the scaffold README instructs (Dockerfile +
`entrypoint.mjs` verbatim — copy mode is the documented starter path and keeps the
folder hackable for the second pass):

- `manifest.yaml`: subscribes to `github.issue.labeled`, filter
  `'$.label.name == "needs-review"'`, `payloadSchema: ./issue-labeled.schema.json`
  (verbatim copy from the monitor package — the M3 consumption story, now for real);
  `secrets:` Claude auth only; `timeout: 900` (scaffold default).
- `prompt.md`: templates `{{payload.repo.fullName}}`, `{{payload.issue.title}}`,
  `{{payload.issue.body}}`, `{{payload.issue.labels}}`, `{{payload.issue.author}}`,
  `{{payload.actor}}`. Asks for a structured triage review (summary, clarity gaps,
  repro assessment, severity guess, suggested labels, questions for the reporter),
  explicitly scoped to the issue text since the agent has no repo access.
- Model/budget: `CLAUDE_MODEL=claude-sonnet-5` (a real review deserves better than
  the test-tier haiku), `CLAUDE_MAX_TURNS` small, `--max-budget-usd` cap via
  `CLAUDE_EXTRA_ARGS` — knobs in the agent's Dockerfile ENV, per the scaffold's
  copy-and-edit design.

**Done when:** `pnpm start` boots clean end-to-end: manifest validated, schema-copy
compat check passes against the registered monitor, image builds, Claude secret
resolves, monitor preflight reaches `copperbox/railyard`, baseline established. (Boot *is* the
validation suite here — invariant 4 working as designed.)

## Step 3 — the real run (the milestone moment)

- Push current `main` to origin first (the running framework should be a committed
  state, so the evidence is reproducible).
- Start the app, apply `needs-review` to a real issue on `copperbox/railyard`,
  watch: signal within one poll interval → container spawn → review in
  `runs/<id>/output/result.json`.
- The tracker is young — filing the first issues is itself dogfood: real ones
  exist in the backlog of consciously deferred work (ghcr publication, comment
  posting, template escape sequences, `github.issue.opened`/`commented`, …).
  Label 2–3 of different quality (a well-formed one, a vague one-liner) to see
  how the prompt behaves across a real distribution.
- **Keep the friction log** (working notes in this repo, `docs/m4-friction.md`):
  every point where the framework was awkward, unclear, or in the way — from setup
  ergonomics through journal readability to API gaps. Nothing is too small; this
  list is the milestone.

**Done when:** at least one genuinely useful review of a real railyard issue exists
in a run record, and the friction log has honest contents (or an honest "none
found").

## Step 4 — fix surfaced friction in core's public API

Contents unknown by design — this step is sized by step 3's log. Process per item:
triage (core API gap vs. docs gap vs. example bug vs. accepted v1 limitation),
fix the core ones behind the public API with tests, each as its own commit.
Anything consciously deferred gets written down with a reason (SPEC §15: friction is
fixed *before anything else is added* — deferral needs justification, not silence).

**Done when:** the friction log's every line is either fixed-with-test or
explicitly-deferred-with-reason, and `pnpm test` / `test:docker` are green.

## Step 5 — wrap-up (+ optional second pass)

- Capture evidence into this plan's status block: journal excerpt of the real run,
  the review (or an excerpt), cost figure from Claude's result.
- Decision point with Dan: promote the second pass now (comment posting via a
  write-scoped token, possibly label lifecycle) or bank it for later. **Decided
  (2026-07-20): banked** as issue #2 — the runs/-only first pass proved the workflow,
  and keeping the container's Claude-auth-only / zero-GitHub-access property is worth
  more than posting reviews publicly today. The second pass is a conscious later
  decision with its own write-scoped-token design, not a silent omission.
- Brain: `/decisions/m4-design-decisions.md` (linked to M0–M3), update any concepts
  the friction fixes touched; root README mentions the example.

**M4 exit criteria:** SPEC §15's M4 sentence demonstrably true on a real repo with a
real issue; the friction log fully dispositioned (fixed in core's public API or
consciously deferred); all suites green; no new framework surface invented that the
dogfood didn't demand.

---

## Decisions taken (veto anytime before the step that locks them in)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Target repo | `copperbox/railyard` (private) — retargeted from `dantheuber/jeeves` at approval | The framework reviews issues about itself: maximal dogfood honesty, and filing the tracker's first real issues (the deferred-work backlog) is itself part of the dogfood. Private is fine: the monitor reads with Dan's token, and issue text flowing to the Claude API is Dan's own data |
| 2 | Review delivery | runs/-only first pass; comment posting is an explicit candidate second pass inside M4 | Zero write scope while prompt-tuning; nothing embarrassing posted publicly; confirmed with Dan |
| 3 | Grounding | Issue text only, stated in the prompt | Cheap, fast, no clone machinery; the payload already carries everything the triage review needs; confirmed with Dan |
| 4 | Label lifecycle | Agent performs no GitHub writes; labels untouched | Event-id dedup already prevents re-runs; re-review = remove + re-add the label, which works today; confirmed with Dan |
| 5 | Agent secrets | Claude auth only — no `GITHUB_TOKEN` in the container | The payload is the input; least privilege by construction (SPEC §8 posture) |
| 6 | Agent form | Copy of `scaffolds/claude-code` (copy mode, not `image:`) | The documented starter path; keeps Dockerfile hackable for the second pass (gh CLI, clone) without touching the scaffold |
| 7 | Model/budget | `claude-sonnet-5`, small `CLAUDE_MAX_TURNS`, `--max-budget-usd` cap | Real reviews deserve a stronger model than the haiku test tier; caps keep a runaway prompt cheap |
| 8 | Testing posture | No new automated tests; boot + the real run are the proof | The combinatorial e2e (real GitHub × real LLM) would be flaky and expensive; M2/M3 already cover each half under their gates |
| 9 | Friction discipline | `docs/m4-friction.md` kept during the run; every line fixed-with-test or deferred-with-reason | SPEC §15 makes friction-fixing the milestone's purpose; a disposition rule keeps it honest |
