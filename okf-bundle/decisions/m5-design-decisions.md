---
type: decision
title: M5 design decisions (hardening for strangers)
tags:
  - milestone-m5
  - contracts
  - docs
  - versioning
timestamp: 2026-07-21T00:51:37.897Z
---

Decisions for M5 (docs, error-message polish, npm publish, versioned signal contract),
confirmed with Dan 2026-07-20 and shipped the same day. M5 made SPEC §15's last milestone
true: the framework M0–M4 built is now legible and installable by a stranger, and the
cross-port contract surface is versioned. Almost no new framework surface — the exceptions
(the `contractVersion` wire field and a pack test) were each confirmed with Dan.

## What shipped

- **Signal Contract v1 on the wire** — see
  [signal-envelope contractVersion](/contracts/signal-envelope-contractversion.md) for the
  decision and why it doesn't break M0–M4. Every envelope now carries a framework-stamped
  `contractVersion: "v1"`, `const`-validated; SPEC §2 updated additively.
- **Versioned contract docs** (`docs/contracts/`) — the language-neutral spec the
  Python/Rust ports must hit (invariant 1): the envelope, the four
  [github.issue.* payloads](/contracts/github-issue-signals.md), the
  [prompt template grammar](/contracts/prompt-template-grammar.md), and the filter grammar,
  under an umbrella "Signal Contract v1" with an additive-vs-breaking bump rule.
- **Five stranger docs** (`docs/`) — getting-started, authoring-monitors, authoring-agents,
  container-contract, credential-scoping — each grounded in a runnable example or the
  scaffold. Plus the **first-ever core package README** (a publish blocker: core had none),
  a demo README, and `/docs` cross-links from the root/monitor/scaffold READMEs.
- **Error-message polish** (`docs/m5-error-audit.md`) — most throw sites were already
  stranger-legible (cite SPEC + paths + fix). Two reworded with locking tests: the
  malformed-`{{` parse error now names the v1 limitation + points at the grammar doc
  (issue #3, error side only), and the unresolvable-secret boot error now says *where*
  secrets resolve (process env → cwd-relative `.env`), fixing the #1 M4 friction.
- **Publish prep** — both packages at **1.0.0**, `publishConfig.access: public`, MIT
  `LICENSE` in each tarball, a `pack.test.ts` asserting the tarball ships only
  dist + schemas + README + LICENSE + package.json (no src/tests/tsconfig), `RELEASING.md`,
  and a `.github/workflows/release.yml` (OIDC `--provenance`, wired for post-1.0.0 updates;
  the repo's first CI surface).

## Confirmed decisions (the ★ design calls)

- **contractVersion is wire-stamped, string tag `"v1"`, framework-set, `const`-validated.**
  Dan chose to realize the version on the wire rather than docs-only, so a future
  multi-version runtime has a real marker. Forward-compat *policy* (unknown-version handling,
  an agent-declared required version) is **deferred to v2** — v1 has no foreign-signal ingest
  path, so no non-`"v1"` value can arise; building warn/drop machinery or a
  `requiredContractVersion` manifest field now would guard an impossible case.
- **Packages publish at 1.0.0** (peer range `^1.0.0`), not 0.1.0 — a coherent pairing:
  1.0.0 artifacts that emit Signal Contract v1.
- **First publish is local/manual, no provenance**; the release workflow carries provenance
  for every update after. npm provenance needs a CI OIDC publish and can't be produced
  locally, so `publishConfig` deliberately does **not** set `provenance: true` (it would
  break the first local publish).
- **`$id` URLs are stable identifiers, not hosted URLs**; authoritative schema copies ship
  in the npm packages. No schema registry operated (SPEC §14).
- **Issue #3 (literal `{{`)**: documented as a v1 limitation + error polished; the grammar
  is **unchanged** (adding an escape is an additive cross-port disk-contract change — a
  future contract minor bump, designed on its own merits). **Issue #2 (comment posting)
  stays banked.**

## Evidence

- Pack dry-run, both clean: core = LICENSE, README, package.json, dist/index.{js,d.ts},
  5 schemas (10 files); monitor = same + 4 schemas (9 files). No src, no tests.
- Tests green throughout: **210 core / 58 monitor** unit (+2 pack each, +new contract and
  error tests); **223 / 59** with Docker; typecheck clean. `test:github`/`test:llm` untouched
  by the changes (monitors emit drafts; the container reads the payload) — the docker e2e
  covers the full envelope→container→result round-trip with the new field.

## Process notes

- The `PLAN-M0…M5.md` working files were **removed** at Dan's request once M5 shipped —
  the durable record is here in the brain (the m0–m5 decision concepts), not in-repo plans.
- Invariant 9 held: docs document only public exports; the pack test and github monitor use
  the public API. No wire/disk contract changed except the confirmed additive
  `contractVersion` field.

Related: [M0](/decisions/m0-design-decisions.md), [M1](/decisions/m1-design-decisions.md),
[M2](/decisions/m2-design-decisions.md), [M3](/decisions/m3-design-decisions.md),
[M4](/decisions/m4-design-decisions.md),
[signal-envelope contractVersion](/contracts/signal-envelope-contractversion.md),
[docker-gated tests](/testing/docker-gated-tests.md),
[non-root agents](/docker/non-root-agents.md).
