---
type: pattern
title: Container-written files are root-owned on the host
tags:
  - docker
  - gotcha
  - milestone-m1
timestamp: 2026-07-20T01:40:20.225Z
---

Files an agent container writes into bind-mounted run directories (e.g.
`output/result.json`) arrive on the host owned by **root** (or whatever uid the
image runs as). The host process can usually *read* them, but **in-place writes
fail with EACCES** — the file's own mode/owner governs writes, while the
directory's mode governs create/rename/unlink.

Two consequences already baked into the runner (`src/run/runner.ts`):

1. **Pre-create + chmod what the container must write**: the output dir is
   `chmod 0777` and the pre-created `events.jsonl` is `0666`, so non-root
   container users can honor their side of the contract at all.
2. **Rewrite via temp + rename, never in place**: post-run redaction rewrites
   of `output/result.json` go through `write tmp → rename over target`. The
   rename succeeds because the *run dir* is ours (0777), even though the target
   file is root-owned. A plain `writeFile` on the target throws EACCES — this
   failed in CI exactly this way during M1 step 5.

Applies to any future code that touches run artifacts after a container ran —
M2's Claude Code scaffold outputs included. Rootless Docker/Podman shifts the
uid mapping but the temp+rename pattern stays correct everywhere.

Related: [M1 design decisions](/decisions/m1-design-decisions.md),
[redaction decision](/decisions/redaction-literal-matching-min-length.md).
