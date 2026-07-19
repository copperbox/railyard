---
type: decision
title: M0 design decisions (walking skeleton)
tags:
  - milestone-m0
  - contracts
  - docker
timestamp: 2026-07-19T22:52:16.705Z
---

Decisions made implementing M0 that are not in SPEC.md and should hold (or be
consciously revisited) in later milestones and the Python/Rust ports:

- **Schema compatibility (SPEC §3) = deep structural equality** of the emitter's
  and agent's schema documents. True JSON Schema subsumption is undecidable;
  equality is strict-but-honest. Replace inside `src/agents/compat.ts` without
  changing the boot step. Subscriptions requiring a schema for a type no monitor
  declares (agent-emitted types) are journaled as unchecked, not fatal.
- **`payloadSchema` is optional per subscription** — omitted means "accepts any
  payload, no boot compat check". The SPEC's example shows it present but never
  says required.
- **Docker via the CLI** (`spawn('docker', ...)`), not dockerode: debuggable,
  no socket-protocol dependency, matches "no magic". Runner uses
  create → start → `logs --follow` → `wait` → `rm -f` (in `finally`), never
  `--rm`, so logs are captured before removal.
- **Events file tailed host-side** by polling the bind mount (100 ms), buffering
  partial lines; works for any in-container writer. Malformed lines are
  journaled notes, never fatal.
- **Orphan containers** are labeled `railyard.runsRoot=<abs runsDir>` and swept
  at boot — scoping by runs root keeps concurrent orchestrators (different runs
  dirs) from killing each other's containers.
- **Provenance entry shape**: `{ source, signalId, signalType }` of each
  *ancestor* signal, oldest first; the emitting agent itself is the envelope's
  `source`, not a chain entry.
- **Filter semantics**: `==` is true when *any* JSONPath match structurally
  equals the literal; `!=` is its exact negation (missing path satisfies `!=`).
  Ops are only `==`/`!=`; JSONPath script/filter expressions are disabled
  (`eval: false`).
- **An agent fires at most once per signal**, via its first matching `on:` entry.
- **M1 manifest fields** (secrets, concurrency, timeout, network,
  allowSelfTrigger) are already in the manifest schema with defaults so the disk
  contract doesn't churn; M0 only enforces `network`.
- Tooling: pnpm workspaces, ESM-only, tsup, vitest;
  [docker-gated tests](/testing/docker-gated-tests.md) behind
  `RAILYARD_DOCKER_TESTS=1` (`pnpm test:docker`).
