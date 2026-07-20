# M5 implementation plan — hardening for strangers

> **Status: DRAFT — design decisions confirmed with Dan (2026-07-20); awaiting explicit
> approval to begin Step 1 implementation.** This is the first milestone with no
> pre-written plan; drafting and confirming this document is M5's first deliverable. The
> four ★ design calls (wire-stamped `contractVersion: "v1"`, packages at 1.0.0, provenance
> approach, issue #3 disposition) are settled and reflected below; the brain records the
> contract decision at `/contracts/signal-envelope-contractversion`.

Goal (from SPEC §15): **"Hardening for strangers. Docs (getting started, authoring
monitors, authoring agents, container contract reference, credential-scoping guidance),
error-message polish, `npm publish` of core + github monitor, versioned signal-contract
documentation."**

M5 adds almost no framework surface. It makes the framework M0–M4 already built
*legible and installable by someone who is not Dan*: writing down the contracts a
stranger (or a Python/Rust port) must honor, tightening the messages a stranger hits
when they get something wrong, and turning the two `version: 0.0.0` workspace packages
into real, publishable npm artifacts. New public API should be **rare and justified**
(SPEC's "only add what's demanded"). The two genuinely-new code artifacts are a pack
verification test and **one wire-contract addition, confirmed with Dan**: a
framework-stamped `contractVersion: "v1"` field on the signal envelope (decision 4) —
so the "versioned signal-contract" of SPEC §15 is realized *on the wire*, not just in
docs. That change touches SPEC §2 (additively) and is scoped in Step 1.

The proof-of-honesty anchor throughout: every doc is grounded in one of the two runnable
examples (`examples/demo` interval→no-op, `examples/github-review` the M4 user-zero
dogfood) or a scaffold. If a doc claims something the examples don't demonstrate, the
doc is wrong.

**Invariants that bind this milestone hardest:** #1 (contracts language-neutral — the
versioned-contract docs stay JSON / JSON Schema / JSONPath / YAML, never "a TS type", so
the ports have a spec to hit), #4 (fail loudly at boot — the error-polish audit targets
exactly these paths), #9 (first-party monitors/scaffolds/examples use only public API —
the docs must not document a deep import), #10 (defaults never destroy information). And
SPEC §14's hard line: **no framework-published images, no registry** — the docs teach
copy-mode / build-your-own-image only.

---

## What already exists (end of M4, HEAD 7b724cd, all pushed on `main`)

- **Tests, all green:** 204 unit (`pnpm test`), 274 with Docker (`pnpm test:docker`),
  +7 real-API (`pnpm test:github`, needs `GITHUB_TOKEN`), LLM proof (`pnpm test:llm`).
  Four gates, `RAILYARD_{DOCKER,LLM,GITHUB}_TESTS`. Keep ALL green throughout M5.
- **Two packages, both `version: 0.0.0`, neither with `publishConfig`:** publish is
  genuinely unstarted. `@copperbox/railyard` (core; `files: [dist, schemas]`, real
  deps) and `@copperbox/railyard-monitor-github` (peer-dep on core, type-only imports,
  zero runtime deps; `files: [dist, schemas]`). Monitor peer range is `>=0.0.0`.
- **Existing docs surface:** root `README.md`, `packages/railyard-monitor-github/README.md`
  (good, 126 lines), `scaffolds/claude-code/README.md` (good, 113 lines),
  `examples/github-review/README.md` (54 lines). **Gaps found while scoping M5:**
  `packages/railyard` (core) has **no README** — a publish blocker; `examples/demo` has
  no README; there is **no `/docs` directory**, no `LICENSE` file (both packages declare
  `"license": "MIT"` with no file present), no `CHANGELOG`, no CI.
- **The contract surfaces to version** already exist as artifacts: the signal envelope
  (SPEC §2, validated by `validateSignalEnvelope`), the four `github.issue.*` JSON
  Schemas (already carry `$id: https://schemas.copperbox.dev/...`, shipped in the
  monitor's `schemas/`), the prompt-template grammar (`parsePromptTemplate`, brain
  concept `/contracts/prompt-template-grammar`), and the JSONPath filter grammar
  (`parseFilter`/`evaluateFilter`). None currently carries an explicit *version label*.
- **Error messages are already decent** — the boot/fail-fast throws cite SPEC sections
  and give context (e.g. loader.ts's `needs either a Dockerfile or 'image:' … (SPEC §4)`).
  The audit is a tightening pass, not a rewrite.
- **Open tracker issues:** #2 (comment-posting second pass — **banked**, not M5 unless
  promoted), #3 (literal `{{` escape in prompt.md — a documented v1 limitation the
  template grammar says can be added additively). #1 (ghcr) is CLOSED won't-do.

---

## Step 1 — Signal Contract v1: wire-stamp + versioned documentation — **DESIGN**

The SPEC §15 item that is genuinely design, and the reason approval gates this plan.
Confirmed with Dan: the contract version is realized **on the wire** (a framework-stamped
envelope field), and the cross-port surface is formalized in `/docs/contracts/` so the
Python/Rust ports have a spec to hit.

**1a — the wire change (code + SPEC §2, additive):**

- **`stampSignal` (`bus/stamp.ts`) sets `contractVersion: "v1"`** on every envelope it
  builds — framework-stamped, never emitter-set (SPEC §2: "set by the framework, never
  by the emitter"). This is the *only* place envelopes are minted, so all monitor and
  agent-emitted signals get it for free (verified: monitors emit `SignalDraft`s; agent
  events-file lines are re-drafted through the same `stampSignal`).
- **`SignalEnvelope` type** gains `contractVersion: string`; **the envelope JSON Schema**
  (`contracts/validate.ts`) requires it with **`const: "v1"`**, so `validateSignalEnvelope`
  asserts every stamped signal carries exactly the contract this runtime speaks (and
  catches a typo'd stamp). String tag `"v1"` (decision 4) — opaque, matches the doc label;
  additive changes (new `github.issue.*` type, a future prompt escape) don't bump it
  because they don't change the *envelope*.
- **SPEC §2** gets the field added to the envelope example (additively) + a one-line note
  that cross-version negotiation (an agent requiring vN; lenient-vs-reject on an unknown
  version) is a **v2 concern** — v1 has no foreign-signal ingest path, so
  `validateSignalEnvelope` only ever runs on framework-stamped `"v1"` signals and the
  unknown-version branch cannot fire. **No warn/drop machinery, no `requiredContractVersion`
  manifest field** in v1 (would guard an impossible case — "only add what's demanded").
- **Does not break M0–M4:** payload schemas are untouched (`contractVersion` is on the
  envelope, not the payload), so the M3 verbatim-copy consumption story and the copied
  schema in `examples/github-review` don't change — no re-copy. The churn is internal:
  the envelope schema property + in-repo tests/fixtures that hand-build envelope literals.
  A test asserts the stamp is present/`"v1"` and that an envelope lacking it fails
  validation. (Brain: `/contracts/signal-envelope-contractversion`.)

**1b — the versioned documentation (`docs/contracts/`, language-neutral):**

- `README.md` — declares **"railyard Signal Contract v1"**: the umbrella version tag,
  the wire marker (`contractVersion`), and the bump rule (any change under deep-equality
  compat is a *new* contract; additive-only changes are minor bumps that don't break
  existing consumers and don't change the wire tag). States these are the artifacts a
  port must reproduce byte-for-byte; the machine-readable source of truth is the JSON
  Schema files shipped in the npm packages' `schemas/` dirs.
- `signal-envelope.md` — SPEC §2 as language-neutral prose + a JSON Schema for the
  envelope (now including `contractVersion`). Grounds each field in a real
  `runs/.../invocation.json`.
- `github-issue-signals.md` — points at the four schema files + their `$id`s, restates
  the two shapes / dedup / nullable set from the brain concept. The `$id` URLs are
  **stable identifiers, not (yet) resolvable URLs** (decision 5); authoritative copies
  ship in npm.
- `prompt-template-grammar.md` — the `{{ dot.path }}` grammar as a versioned disk
  contract. Documents the **v1 limitation: no literal `{{`** (issue #3) and that an
  escape is a reserved additive minor bump — *not* done in M5 (decision 8).
- `filter-grammar.md` — the JSONPath-subset filter grammar (`$.label.name == "…"`,
  `$.issue.labels[*]`), comparators, the declarative-only ceiling (SPEC §3, §14).

**Done when:** `contractVersion: "v1"` is stamped + `const`-validated with a test; SPEC §2
reflects it (additively, with the v2-deferral note); the four sub-contracts are documented
language-neutrally (no TS types as normative content — invariant 1); every schema/grammar
claim is checked against the shipped artifact (schemas diff-clean against the package
`schemas/` files; grammar examples parse); all four test gates green.

## Step 2 — the five stranger docs (`/docs/`) + package READMEs

The named SPEC §15 docs, each grounded in a runnable example or scaffold:

- `docs/getting-started.md` — install both packages from npm, wire an `Orchestrator`,
  point at an agents dir, register a monitor, `start()`. Two tracks: the 90-second
  `examples/demo` (no API keys, no GitHub) and the real `examples/github-review`. The
  boot sequence (SPEC §10) as the mental model: by the time `start()` resolves, the
  system is fully spawnable.
- `docs/authoring-monitors.md` — the `Monitor` interface (SPEC §9), `emits` declarations
  for boot-time compat, `ctx.state` for cursors, **dedup-is-your-job**, `createMonitor
  TestContext` for tests. Grounded in the github monitor + the demo interval monitor.
- `docs/authoring-agents.md` — agents are data (invariant 2): `manifest.yaml` field
  reference, `prompt.md` templating (link to the contract doc), Dockerfile vs `image:`
  sources, **non-root runtime user** best practice (brain `/docker/non-root-agents`),
  copy-mode from `scaffolds/claude-code`. Explicitly: the framework never generates a
  Dockerfile; no framework-published images (SPEC §14) — build-your-own / registry-you-own.
- `docs/container-contract.md` — the full SPEC §5 interface as a **cross-port reference**:
  the exact env vars (`AGENT_INPUT_DIR/FILE`, `AGENT_OUTPUT_DIR`, `AGENT_EVENTS_FILE`,
  `AGENT_PROMPT_FILE`), `CONTAINER_PATHS`, `result.json` shape, the events JSONL
  backchannel (the *only* backchannel — invariant 6), statelessness + guaranteed
  teardown guarantees. Writable-from-any-language (`echo >> $AGENT_EVENTS_FILE`).
- `docs/credential-scoping.md` — the SPEC §8-named doc. Least privilege by construction,
  per-container declared-secrets-only injection, the redaction guarantee + the accepted
  residual risk (anything in the container reads its own env), and the concrete guidance:
  fine-grained tokens, spend-capped keys, `network: none`. **Anchored in the M4 win** —
  the `issue-reviewer` container declares Claude auth as its *only* secret and has zero
  GitHub access because the payload is the whole input.

Wire it up: `docs/README.md` index; root `README.md` links `/docs`; **new
`packages/railyard/README.md`** (publish blocker — a core README self-contained for npm,
linking to `/docs`); add a `examples/demo/README.md`; the monitor and scaffold READMEs
gain `/docs` cross-links.

**Done when:** all five docs exist, each cross-checked against its grounding example/
scaffold (commands actually run; exports actually exist — invariant 9), the core package
has a README, and the docs index + README links resolve.

## Step 3 — error-message polish (boot/fail-fast + runtime audit)

An audit of the ~30 throw sites (heaviest in `orchestrator.ts` and `agents/loader.ts`)
plus runtime run-failure paths, judged for **stranger-legibility**: does the message name
what's wrong, where, and what to do? Input: the M4 friction log and the rough edges from
M0–M4. Produce `docs/m5-error-audit.md` (before/after table, like the friction log) so
the pass is evidence-based, not vibes.

- Fix the weak messages; where a message is part of the contract a stranger relies on,
  add/extend an **asserted-message test** (several already exist — e.g. loader/orchestrator
  boot tests) so the wording can't silently regress.
- Disposition issue #3 here on the error side: the `{{`-with-no-valid-placeholder parse
  error should **name the v1 limitation and point at the grammar doc** (decision 8) —
  document + legible error, *not* a grammar change.
- Scope guard: this is polish. No new error *types*, no behavior changes to what fails
  vs. succeeds — only clearer strings and their tests.

**Done when:** the audit doc lists every message reviewed with a disposition
(improved / already-good), the improved ones have tests, and `pnpm test` / `test:docker`
stay green.

## Step 4 — publish preparation (no actual publish yet)

Turn the two `0.0.0` workspace packages into publishable artifacts. All local; **nothing
is published in this step.**

- **Versions:** set both to the agreed first version (decision 2). **Monitor peer range**
  updated from `>=0.0.0` to the agreed range (decision 3).
- **`publishConfig: { access: public }`** on both (scoped packages default to restricted
  — without this, publish fails or goes private).
- **`LICENSE`** file(s) — MIT is declared but absent; add a repo-root `LICENSE` and
  ensure each package tarball carries one (npm auto-includes a package-dir `LICENSE`;
  decision 6 picks root-symlink vs per-package copy).
- **`files` / pack audit:** confirm `files: [dist, schemas]` + auto-included
  README/LICENSE is exactly right — dist + schemas + README + LICENSE + package.json,
  **never `src/` or tests**.
- **Pack verification test** (the one new code artifact): a test/script that runs
  `npm pack --dry-run --json` per package and asserts the tarball's file list is the
  expected allowlist (present: dist, schemas, README, LICENSE; absent: src, *.test.*,
  tsconfig). Gated like the others if it needs a network/registry touch, but
  `pack --dry-run` is offline. This is legitimate hardening, not invented feature surface.
- **`RELEASING.md`** — the manual release process (decision 10): bump version(s), build,
  `pnpm test:docker` green, `npm pack --dry-run` clean, tag, publish core-then-monitor
  (peer-dep order).
- **`.github/workflows/release.yml`** — a minimal tag-triggered release workflow with
  `id-token: write` OIDC + `npm publish --provenance`, built now so **future** updates
  ship with provenance (decision 7). The **first** publish is still local/manual (Dan's,
  Step 5) — the workflow is wired but the v1.0.0 release doesn't depend on it. This is the
  repo's first `.github/` surface; it is release-only, not a gating CI for tests.

**Done when:** `npm pack --dry-run` on both packages shows the correct file list (captured
as plan evidence), the pack test passes, versions/publishConfig/peer-range/LICENSE are in
place, all suites green — and **not one byte is published**.

## Step 5 — the real publish (**GATED — explicit Dan go required**)

Like M4's paid runs: **no real publish, not even the dry-run→real transition, without
Dan's explicit go.** Prerequisites Dan owns (surfaced now): the `@copperbox` npm org must
exist (or we publish under Dan's user scope), and `npm login`. Then:

- **First publish is local/manual** (decision 7): `npm login`, then publish from Dan's
  machine — no provenance on v1.0.0. The `release.yml` workflow (Step 4) carries
  provenance for every update *after* this one.
- Publish **core first, monitor second** (peer-dep order); verify each installs clean
  from the registry into a scratch project (`npm i @copperbox/railyard` resolves, types
  resolve, the monitor's peer-dep is satisfied).
- Capture published versions + `npm view` output as plan evidence.

**Done when:** both packages are live on npm at the agreed versions and a stranger's
`npm i` of the monitor pulls a working core — OR, if Dan elects to hold publishing, this
step is explicitly banked with the reason and steps 1–4 stand as "publish-ready."

## Step 6 — wrap-up

- Fill this plan's status block with evidence: pack dry-run output, the `/docs` index,
  before/after error-message examples, and (if published) the live versions.
- `docs/m5-friction.md` if M5 itself surfaces friction (a docs milestone may surface
  little); disposition anything found.
- Brain: record `/decisions/m5-design-decisions.md` linked to M0–M4; update
  `/contracts/*` and `/docker/non-root-agents` (its "M5" landing note) as the docs land.
- Root `README.md` final pass: link `/docs`, note the packages are published.

**M5 exit criteria:** the five named docs exist and are honest against the examples; the
signal contract carries an explicit `contractVersion: "v1"` on the wire and is documented
language-neutrally; error messages are audited and the weak ones fixed-with-test; the two
packages are publish-ready (pack dry-run proven) and published if Dan gave the go; all
four test gates green; no framework surface invented beyond the pack test, the
`contractVersion` field, and the release workflow (each confirmed with Dan); SPEC §2's
envelope change is additive; no framework image or registry introduced (SPEC §14).

---

## Decisions taken (veto anytime before the step that locks them in)

Rows marked **✔ CONFIRMED** were decided with Dan on 2026-07-20 (the ★ design calls); the
rest are recommendations following settled M0–M4 posture that you can still veto before
the step that locks them in.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Docs location | A `/docs` markdown directory, root-README-linked; **no docs-site build tool**. Plus a new core package README. | Versioned with the code, no new build surface, honest against the examples. A docs site is ceremony a hardening milestone doesn't need. |
| 2 ✔ | First published versions | **Both `1.0.0`** (was proposed `0.1.0`; Dan chose 1.0.0) | Commits to a stable public API + contract now — coherent with stamping "Contract v1" on the wire (1.0.0 artifacts emitting Signal Contract v1). |
| 3 ✔ | Monitor→core peer range | **`^1.0.0`** | Follows from the 1.0.0 choice; standard caret on a stable major. |
| 4 ✔ | Signal-contract versioning | **Wire-stamped `contractVersion: "v1"` on the envelope** (framework-set, `const`-validated) **+ versioned `/docs/contracts/`.** SPEC §2 updated additively. | Dan chose to realize the version on the wire, not docs-only, so a future multi-version runtime has a real marker to negotiate on. String tag `"v1"`; forward-compat *policy* deferred to v2 (no v1 ingest path can produce a non-`"v1"` value). Brain: `/contracts/signal-envelope-contractversion`. |
| 5 | `$id` URL resolvability | The `schemas.copperbox.dev` `$id`s are **stable identifiers, not hosted URLs**; docs say so; authoritative copies ship in npm. **No registry/hosting surface added.** | Hosting a schema registry is exactly the kind of operated surface SPEC §14 refuses. `$id` need not resolve (standard JSON Schema). You may choose to host later. |
| 6 | LICENSE placement | Repo-root `LICENSE` + each package tarball carries one (per-package copy or symlink) | MIT is declared but no file exists; npm includes a package-dir LICENSE automatically. |
| 7 ✔ | Provenance / CI | **First publish local/manual, no provenance** — *and* build `.github/workflows/release.yml` now so **future** updates ship with provenance. | Dan's call: local publish is required for the first release anyway; wire the OIDC release workflow so provenance is ready for every update after v1.0.0. Repo's first `.github/` surface (release-only). |
| 8 ✔ | Issue #3 (`{{` escape) | **Document the v1 limitation + make the parse error name it** — do NOT add the escape in M5. | Adding an escape is an additive *disk-contract* change (prompt grammar is cross-port). That's a contract-v1.1 design with its own port impact, not a polish item. Stays deferred with reason. |
| 9 | Issue #2 (comment posting) | **Stays banked, not M5.** No code. | Confirmed banked in M4; M5 is docs/publish/polish. The credential-scoping doc may cite it as the worked "next step / write-scoped-token design." |
| 10 | Version-bump tooling | **Manual semver + `RELEASING.md`**; no changesets/automation | Over-engineering for two packages; automation is a v2 concern. |
| 11 | Pack verification | An **automated `npm pack --dry-run` test** asserting tarball contents | The task asks to *prove* the pack is right; a test makes it non-regressable. |
| 12 | Publish gating | **No real publish without explicit Dan go** (incl. dry-run→real); org/login are Dan's prerequisites | Mirrors M4's paid-run gate; publishing is irreversible and outward-facing. |
| 13 | Push cadence | **Push after each committed step** (same as M4) | Keeps `main`/the tracker reflecting running code; docs benefit from being visible. Confirm you still want per-step pushes. |
| 14 | Testing posture | Keep all four gates green; **new code limited to** the pack test + the `contractVersion` stamp/validation — no invented feature tests | M5 is hardening, not features (SPEC: don't invent tests/surface the milestone doesn't demand). |

---

## Step / commit map (each step = its own logical commit(s) once green)

1. `feat(core): Signal Contract v1 — wire-stamp contractVersion + /docs/contracts + SPEC §2`
   *(may split: the wire/SPEC change as one commit, the docs as a second)*
2. `docs: five stranger docs + core package README + docs index`
3. `polish(core): stranger-legible error messages + audit + tests`
4. `chore(release): publishable packages — versions, publishConfig, LICENSE, pack test, release.yml`
5. `release: publish @copperbox/railyard + monitor-github @ 1.0.0` *(gated)*
6. `docs: M5 complete — status, evidence, brain decision, README`
