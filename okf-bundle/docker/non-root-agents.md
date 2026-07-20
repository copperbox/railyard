---
type: decision
title: Agents should run as non-root — modeled in scaffolds, never enforced
tags:
  - docker
  - security
  - milestone-m1
  - milestone-m2
  - milestone-m5
timestamp: 2026-07-20T03:19:15.253Z
---

Direction agreed during M1 (2026-07-19):

**Agent containers should run as a non-root user at runtime** (build-time root is
fine; drop via `USER` in the Dockerfile). Rationale:

- Defense in depth: agents execute LLM-driven work on semi-trusted inputs; a
  container escape from uid 1000 is a smaller blast radius than from uid 0.
- It avoids [root-owned files on the host](/docker/container-file-ownership.md) —
  the M1 gotcha. The container contract is already non-root-friendly (output dir
  0777, events file 0666, pre-created by the host).

**The framework does not enforce this.** No `--user` override, no boot warning on
root images: it would break `image:` (bring-your-own-image) agents, and SPEC §11 is
explicit that the sandbox is exactly as tight as documented, no tighter. Guidance
lives in docs and examples, matching the SPEC §8 posture for credential scoping.

Where it lands:

- **Done (M1)**: every in-repo test fixture and demo agent models the pattern —
  `RUN adduser -D -u 10001 agent` + `USER agent`. uid 10001 deliberately matches no
  host uid, so agent-written files stay host-unwritable and the temp+rename
  redaction rewrite path stays under test.
- **Done (M2, 2026-07-19)**: the `claude-code` scaffold Dockerfile models it
  (`useradd -u 10001 -m agent` + `USER agent`) with the explanatory comment —
  scaffolds are copied, so this becomes de-facto practice. It also turned out to be
  functionally required, not just hygiene:
  [Claude Code refuses `--dangerously-skip-permissions` as root](/docker/claude-code-refuses-root.md).
- **M5**: the authoring-agents guide + container-contract reference get a
  best-practices section (non-root runtime user, alongside credential scoping).

Because third-party images can never be controlled, the host-side defenses
(chmod'd mounts, temp+rename rewrites) stay in place regardless.

Related: [M1 design decisions](/decisions/m1-design-decisions.md),
[M2 design decisions](/decisions/m2-design-decisions.md).
