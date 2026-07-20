# M4 friction log

The milestone's true deliverable (SPEC §15): every point where the framework was
awkward, unclear, or in the way while building and running the user-zero workflow.
Rule (PLAN-M4 decision 9): every line ends **fixed-in-core's-public-API-with-a-test**
or **explicitly-deferred-with-reason**. Nothing silent.

Format: `[status]` is one of `OPEN`, `FIXED`, `DEFERRED`, `NOT-FRAMEWORK` (example/repo
hygiene, fixed in place but no core change needed).

---

- **[OPEN] Root `.gitignore` has no `.env` entry.** The documented secrets story
  (scaffold README, monitor README, EnvSecretsProvider default) tells users to keep
  tokens in a `.env`, but nothing in the repo skeleton prevents committing one.
  Found: first command of step 1, checking where Claude auth would resolve from.
- **[OPEN] `EnvSecretsProvider`'s default `.env` path is `<cwd>/.env`, and "cwd"
  is whatever directory the app was started from.** `pnpm start` inside
  `examples/github-review` reads `examples/github-review/.env`; the same app started
  from the repo root reads `<root>/.env`. The M2/M3 gated tests "repo-root `.env`"
  wording is really "package-dir when run via pnpm". Ambiguity resolved in the
  example by passing an explicit `envFile`; may deserve a docs line in core.
- **[OPEN] `orchestrator.on(event, handler)` doesn't narrow the entry type by event
  name.** The handler always receives the full `JournaledEntry` union, so every
  console-wiring handler needs a redundant `if (e.event !== 'run.finished') return`
  guard (or the demo's `'runId' in e` dance) purely to satisfy the compiler. A
  per-event generic overload (`on<E extends JournaledEntry['event']>(event: E, ...)`)
  would make the obvious wiring code compile as written. Found: writing the
  example's three-line narration.
