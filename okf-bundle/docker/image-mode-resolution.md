---
type: pattern
title: "image: refs resolve local-first — any (user-owned) registry works,
  mutable tags go stale"
tags:
  - docker
  - milestone-m2
  - gotcha
timestamp: 2026-07-20T18:34:48.133Z
---

How `image:` (bring-your-own-image) manifests are verified at boot
(`src/docker/build.ts`, `ensureAgentImage`): **local `docker image inspect`
first; `docker pull` only on a local miss.** Established in M0, consequences
articulated post-M2 (2026-07-20):

- **Local-only images are first-class.** `docker build -t whatever:local
  scaffolds/claude-code` + `image: whatever:local` needs no registry at all.
  One local image can serve any number of prompt-only agent folders
  (`manifest.yaml` + `prompt.md`, no Dockerfile) — cheaper than N copy-mode
  folders when many agents share one runtime.
- **Any registry works — and it's the *user's* registry.** The ref goes
  straight to the host daemon, so Docker Hub, ghcr, ECR, private Harbor,
  `localhost:5000` are all equally supported. railyard itself publishes **no**
  images (SPEC §14, decided 2026-07-20) — a user who wants cross-machine
  distribution builds the scaffold Dockerfile and pushes to a registry they
  own. Private-registry auth is `docker login` on the orchestrator host —
  daemon config, deliberately outside the `SecretsProvider` seam (that seam
  injects secrets *into* containers).
- **Gotcha — mutable tags go stale silently.** Because local wins, a re-pushed
  `:latest` is never re-pulled on a machine that already has the old bytes
  under that tag. Users should pin version tags or digests
  (`image: reg/img@sha256:…`). Belongs in the M5 authoring-agents docs.
- **Trust posture** (SPEC §4): an `image:` agent is verified to *exist*, and
  trusted — not verified — to honor the container contract.

Two consumption modes for scaffolds fall out, both user-built: copy mode
(Dockerfile in folder, content-hash rebuilds, freshness automatic) and image
mode (build the tag once — locally or pushed to your own registry — freshness
manual). Cross-machine distribution is the only thing a registry uniquely adds,
and it's the user's registry, never a railyard-operated one.

Related: [M2 design decisions](/decisions/m2-design-decisions.md),
[M0 design decisions](/decisions/m0-design-decisions.md),
[non-root agents](/docker/non-root-agents.md).
