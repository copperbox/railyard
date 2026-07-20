# M5 error-message audit

SPEC §15 M5 calls for error-message polish. This is the audit of every framework throw
site, judged for **stranger-legibility**: does the message name *what* is wrong, *where*,
and *what to do*? Input: the M4 friction log and the boot/fail-fast paths (invariant 4).

Disposition is `IMPROVED` (reworded, with a test) or `OK` (already stranger-legible —
names the culprit, cites paths/SPEC, actionable). Scope guard held: **no new error types,
no change to what fails vs. succeeds** — only clearer strings.

## Improved

| Site | Before → After | Test |
|---|---|---|
| `prompt/template.ts` — malformed `{{` | `…(no escapes for literal "{{" exist yet)` → names it a **Signal Contract v1** limitation and points at `docs/contracts/prompt-template-grammar.md`. Dispositions [issue #3](https://github.com/copperbox/railyard/issues/3) on the error side (grammar unchanged, per M5 decision 8). | `prompt-template.test.ts` "names the v1 literal-`{{` limitation…" |
| `orchestrator.ts` — unresolvable secret at boot | `unresolvable secret(s): …` → additionally states **where** each name is resolved (SecretsProvider default: process env, then a cwd-relative `.env` unless `envFile` is passed) + `docs/credential-scoping.md`. Addresses the #1 M4 friction: a stranger not knowing a `.env` is cwd-relative. | `orchestrator.test.ts` "fails start() loudly…" (asserts the resolution-source hint) |

## Reviewed and left as-is (already stranger-legible)

All name the culprit and, where relevant, cite the SPEC section and the offending path:

- **Agent loading** (`agents/loader.ts`): agents-dir-not-readable; `duplicate agent name
  "x" in <dirA> and <dirB>`; `<path>: not valid YAML: …`; `<path>: invalid manifest: <ajv
  errors>`; secret-name-collides-with-reserved-env-var (SPEC §5); both-Dockerfile-and-image
  / neither (SPEC §4); payloadSchema-must-live-inside-the-folder / not-readable / not-valid-
  JSON — all path-prefixed and actionable.
- **Filters** (`agents/filter.ts`): bad grammar shape (shows the expected form + the input),
  path-must-start-with-`$`, comparand-must-be-JSON, invalid-JSONPath — each prefixed with
  the agent + subscription context.
- **Orchestrator boot/config** (`orchestrator.ts`): `maxChainDepth`/`retention.*` positive-
  integer guards echo the bad value; `register() must be called before start()`; `start()
  may only be called once`; `duplicate monitor name "x"`; `subscription compatibility check
  failed:` with the per-error detail list; spawn-time `agent "x": secret(s) unresolvable at
  spawn: …`.
- **Signal stamping** (`bus/stamp.ts`): `invalid signal from monitor "x": <ajv errors>`.
- **Schema compile** (`contracts/validate.ts`): `invalid JSON Schema for <context>: …`.
- **Docker CLI** (`docker/cli.ts`): `<context>: docker <cmd> exited <code>: <stderr>` —
  carries the real daemon stderr.
- **Monitor emit** (`monitor/declared-emissions.ts`, `monitor/test-context.ts`): duplicate-
  declared-type; emit-validation errors surfaced to the caller.

## Notes

- Every framework log line already passes through the redactor (SPEC §8), so no error
  message can leak a secret value — the two improved messages describe *where* secrets
  resolve, never a value.
- The two reworded messages are the only wire the polish touched; the wider set was strong
  because M0–M4 wrote messages that cite SPEC sections and paths as a matter of habit.
