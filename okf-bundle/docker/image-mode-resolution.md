---
type: pattern
title: "image: refs resolve local-first — any registry works, mutable tags go stale"
tags:
  - docker
  - milestone-m2
  - gotcha
timestamp: 2026-07-20T04:08:36.943Z
---

How `image:` (bring-your-own-image) manifests are verified at boot
(`src/docker/build.ts`, `ensureAgentImage`): **local `docker image inspect`
first; `docker pull` only on a local miss.** Established in M0, but its
consequences were only articulated post-M2 (2026-07-20) while deciding to
[defer ghcr publication](/decisions/m2-design-decisions.md):

- **Local-only images are first-class.** `docker build -t whatever:local
  scaffolds/claude-code` + `image: whatever:local` needs no registry at all.
  One local image can serve any number of prompt-only agent folders
  (`manifest.yaml` + `prompt.md`, no Dockerfile) — cheaper than N copy-mode
  folders when many agents share one runtime.
- **Any registry works.** The ref goes straight to the host daemon, so Docker
  Hub, ghcr, ECR, private Harbor, `localhost:5000` are all equally supported.
  Private-registry auth is `docker login` on the orchestrator host — daemon
  config, deliberately outside the `SecretsProvider` seam (that seam injects
  secrets *into* containers).
- **Gotcha — mutable tags go stale silently.** Because local wins, a re-pushed
  `:latest` is never re-pulled on a machine that already has the old bytes
  under that tag. Users should pin version tags or digests
  (`image: reg/img@sha256:…`). Belongs in the M5 authoring-agents docs.
- **Trust posture** (SPEC §4): an `image:` agent is verified to *exist*, and
  trusted — not verified — to honor the container contract.

Three consumption modes for scaffolds fall out: copy mode (Dockerfile in
folder, content-hash rebuilds, freshness automatic), local image mode
(build once, freshness manual), published image mode (M5 — same semantics,
adds cross-machine distribution, which is the only thing a registry uniquely
provides).

Related: [M2 design decisions](/decisions/m2-design-decisions.md),
[M0 design decisions](/decisions/m0-design-decisions.md),
[non-root agents](/docker/non-root-agents.md).
