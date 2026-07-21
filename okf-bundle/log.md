# Update Log

## 2026-07-21
* Fix typo (coherue -> coherent).
* Record M5 design decisions (hardening for strangers): Signal Contract v1 on the wire + versioned docs, five stranger docs + core README, error polish, packages at 1.0.0 publish-ready; PLAN files retired to the brain.

## 2026-07-20
* Fix mis-targeted stampSignal link in "The decision" section.
* Record M5-planning decision: wire-stamped envelope contractVersion "v1", framework-set, const-validated, forward-compat policy deferred to v2; packages at 1.0.0.
* Updated M2 scaffold decision: ghcr publication dropped entirely (SPEC §14), not deferred; publish.sh removed; images are the user's to build.
* Reframed image-mode: railyard publishes no images (SPEC §14, 2026-07-20) — the registry is always the user's own; dropped the "published image mode (M5)" framing.
* M4 complete: user-zero dogfood shipped — github-review example, 3 real sonnet reviews ($0.166), two core public-API friction fixes, comment-posting second pass banked as issue #2.
* M3 complete: decisions updated with shipped implementation notes (preflight repo identity, nullable author, core test seam, verified API assumptions)
* M3: recorded the github.issue.* payload contract, dedup/state semantics, and the schema-copy consumption story
* M3: documented the fourth test gate (RAILYARD_GITHUB_TESTS) and multi-package fan-out behavior
* M3 plan approved: recorded confirmed GitHub-monitor contract decisions (events-API dedup, four-type allowlist, comments out of scope, at-least-once)
* **Update**: Updated [M2 design decisions (Claude Code scaffold)](/decisions/m2-design-decisions.md).
* **Creation**: Created [image: refs resolve local-first — any registry works, mutable tags go stale](/docker/image-mode-resolution.md).
* **Update**: Updated [M2 design decisions (Claude Code scaffold)](/decisions/m2-design-decisions.md).
* **Update**: Updated [M2 design decisions (Claude Code scaffold)](/decisions/m2-design-decisions.md).
* **Update**: Updated [Docker-gated tests (RAILYARD_DOCKER_TESTS)](/testing/docker-gated-tests.md).
* **Update**: Updated [Agents should run as non-root — modeled in scaffolds, never enforced](/docker/non-root-agents.md).
* **Creation**: Created [M2 design decisions (Claude Code scaffold)](/decisions/m2-design-decisions.md).
* **Creation**: Created [prompt.md template grammar ({{ dot.path }}) — a cross-port disk contract](/contracts/prompt-template-grammar.md).
* **Creation**: Created [Claude Code refuses --dangerously-skip-permissions as root — USER agent is load-bearing](/docker/claude-code-refuses-root.md).
* Non-root fixtures/demo agents shipped in M1; concept updated with the uid-10001 pattern
* Recorded direction: non-root agent containers — modeled in M2 scaffold + M5 docs, never framework-enforced
* Recorded docker gotcha: container-written files are root-owned; temp+rename rewrite pattern

## 2026-07-19
* Linked redaction decision to the M1 design-decisions concept
* M1 complete: recorded safeguards & secrets design decisions (journal events, guards, timeout, secrets, retention)
* M1: recorded redaction design — literal substring matching, 6-char minimum with loud warning, rejected alternatives
* **Update**: Updated [M0 design decisions (walking skeleton)](/decisions/m0-design-decisions.md).
* **Creation**: Created [Docker-gated tests (RAILYARD_DOCKER_TESTS)](/testing/docker-gated-tests.md).
* **Creation**: Created [M0 design decisions (walking skeleton)](/decisions/m0-design-decisions.md).
