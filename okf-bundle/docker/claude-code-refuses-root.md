---
type: pattern
title: Claude Code refuses --dangerously-skip-permissions as root — USER agent
  is load-bearing
tags:
  - docker
  - security
  - gotcha
  - milestone-m2
timestamp: 2026-07-20T03:04:53.947Z
---

Found while designing the M2 `scaffolds/claude-code` image (2026-07-19, verified
against the official docs): the Claude Code CLI **rejects
`--dangerously-skip-permissions` when running as uid 0**. In an interactive session
that's a prompt; in headless mode (`claude -p`) inside a container it's a hard
failure — the run dies before any LLM work happens.

Consequence for railyard: the [non-root runtime user](/docker/non-root-agents.md)
(`USER agent`, uid 10001) in the claude-code scaffold Dockerfile is **functionally
required, not just hygiene**. The scaffold's entrypoint passes
`--dangerously-skip-permissions` by default (the container *is* the sandbox — its
only powers are its mounts and declared secrets, SPEC invariant 6), so a copied
scaffold with the `USER` line removed fails at runtime, loudly.

Practical notes for anyone touching the scaffold image:

- The non-root user needs a writable `HOME` (Claude Code writes `~/.claude`) —
  `useradd -m`, plus an agent-owned `WORKDIR` for the CLI's cwd.
- There is a historical `IS_SANDBOX=1` env escape hatch to allow root anyway; it is
  undocumented in current docs — do not rely on it, keep the non-root user.
- This stacks with the original rationale (blast radius, avoiding
  [root-owned host files](/docker/container-file-ownership.md)); three independent
  reasons now converge on the same `USER agent` pattern.

Related: [non-root agents decision](/docker/non-root-agents.md),
[container file ownership](/docker/container-file-ownership.md).

# Citations

[1] [Claude Code permissions reference](https://code.claude.com/docs/en/permissions.md)
[2] [Claude Code devcontainer guidance (root restriction)](https://code.claude.com/docs/en/devcontainer.md)
