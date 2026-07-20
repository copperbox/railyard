# M4 friction log

The milestone's true deliverable (SPEC §15): every point where the framework was
awkward, unclear, or in the way while building and running the user-zero workflow.
Rule (PLAN-M4 decision 9): every line ends **fixed-in-core's-public-API-with-a-test**
or **explicitly-deferred-with-reason**. Nothing silent.

Format: `[status]` is one of `OPEN`, `FIXED`, `DEFERRED`, `NOT-FRAMEWORK` (example/repo
hygiene, fixed in place but no core change needed).

---

- **[NOT-FRAMEWORK] Root `.gitignore` had no `.env` entry.** The documented secrets
  story (scaffold README, monitor README, EnvSecretsProvider default) tells users to
  keep tokens in a `.env`, but nothing in the repo skeleton prevented committing one.
  Found: first command of step 1, checking where Claude auth would resolve from.
  Fixed in place (step-1 commit): `.env` added to the root `.gitignore` and to the
  example's own `.gitignore`. No core change — user repos own their ignore files;
  M5's getting-started docs should tell them to (noted in issue backlog candidate).
- **[FIXED] `EnvSecretsProvider`'s default `.env` path is `<cwd>/.env`, and "cwd" is
  whatever directory the app was started from.** `pnpm start` inside
  `examples/github-review` reads `examples/github-review/.env`; the same app started
  from the repo root reads `<root>/.env`. The M2/M3 gated tests' "repo-root `.env`"
  wording is really "package-dir when run via pnpm". Resolved in the example by
  passing an explicit `envFile`.
  **Disposition: docs fix, not a behavior change.** cwd-relative is the correct,
  intentional default (SPEC §8; changing it would silently move where M2/M3 resolve
  secrets from) — so the fix is the `EnvSecretsProviderOptions.envFile` docstring,
  now warning the default is cwd-relative and recommending an explicit absolute path
  for workspace apps. No behavior test applies to a docstring; the example's explicit
  `envFile` is the worked demonstration, and the underlying behavior is already
  covered by `secrets.test.ts`'s explicit-`envFile` cases.
- **[FIXED] `orchestrator.on(event, handler)` didn't narrow the entry type by event
  name.** The handler always received the full `JournaledEntry` union, so every
  console-wiring handler needed a redundant `if (e.event !== 'run.finished') return`
  guard (or the demo's `'runId' in e` dance) purely to satisfy the compiler. Found:
  writing the example's three-line narration.
  **Fix (public API, step-4 commit):** `on`/`off` are now generic over the event
  literal —
  `on<E extends JournaledEntry['event']>(event, handler: (entry: Extract<JournaledEntry, {event: E}>) => void)`
  — so the handler sees exactly that event's fields. Type-level only: no new export,
  no runtime change, backward-compatible (a handler typed for the full union still
  assigns). Test: `orchestrator.test.ts` "on(event) narrows the entry type to that
  event" uses `expectTypeOf` on `run.finished`/`signal.received` handlers, and the
  example's narration dropped its three guards to prove it compiles clean.
- **[NOT-FRAMEWORK] Reading the review takes a dig through the run dir.** The
  human-facing deliverable lives at `runs/<ts>--issue-reviewer--<id>/output/result.json`,
  inside Claude's result object's `result` field — so "read the review" is
  `jq -r .result <run>/output/result.json`. The layout itself is right (SPEC §12,
  provider shape stays verbatim); this is documentation, not an API gap. Found:
  step 3, reading the first real review. **Fixed** by adding the `jq -r .result …`
  and `.total_cost_usd` one-liners to the example README's "Run it" section. No core
  change: the run-dir layout is contractual and correct; a framework-invented
  "extract the text" helper would mean parsing the provider's result shape, which
  SPEC §14 forbids.
- **Step-3 run itself: no framework friction found.** Label→signal latency was one
  poll tick as documented; concurrency cap queued the second signal
  (`run.queued`, depth 1) and drained in order; journal narrated the whole story;
  events.jsonl carried per-run cost; teardown clean; SIGINT stop clean mid-loop;
  ETag cursor state advanced correctly (0 → 28198247642). Three issues of varied
  quality (well-formed / medium / vague one-liner) each produced a genuinely useful
  triage review at $0.079 / $0.042 / $0.045 (total $0.166), 1 turn each, well under
  the $0.50 cap and 8-turn limit.
