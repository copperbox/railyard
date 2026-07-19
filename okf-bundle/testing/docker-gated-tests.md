---
type: pattern
title: Docker-gated tests (RAILYARD_DOCKER_TESTS)
tags:
  - testing
  - docker
  - milestone-m0
timestamp: 2026-07-19T22:51:44.987Z
---

Integration tests that need a Docker daemon are gated by a two-layer mechanism
so the default `pnpm test` is fast and dependency-free, while opted-in runs can
never silently under-cover.

## Layer 1 — env var opt-in

Docker test files check the variable once at module load and gate the whole
suite with vitest's `describe.skipIf`:

```ts
const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
describe.skipIf(!DOCKER)('docker: ...', () => { ... })
```

- Strict comparison against the string `'1'` — `=true`/`=yes` do **not** enable.
- Skipped suites are *visibly* reported as skipped (e.g. `86 passed | 5 skipped`),
  never silently absent.

## Layer 2 — daemon reachability check

Opting in doesn't guarantee Docker works, so the first gated suite asserts in
`beforeAll` via `dockerDaemonAvailable()` (runs `docker info`, checks exit code).
If the var is set but the daemon is down, tests **fail loudly** instead of
skipping — once Docker coverage is requested, a silent skip could let CI report
green while covering nothing.

## How the var is set

Never by hand — package scripts own it (`packages/railyard/package.json`):

```json
"test": "vitest run",
"test:docker": "cross-env RAILYARD_DOCKER_TESTS=1 vitest run"
```

- `cross-env` exists only for Windows portability of the `FOO=1 cmd` syntax.
- Root `pnpm test:docker` fans out with `pnpm -r --workspace-concurrency=1` so
  multiple packages never run Docker tests simultaneously (guards against
  container/image races once more packages exist, e.g. the M3 GitHub monitor).

## Behavior summary

- `pnpm test` → var unset → gated suites register as skipped; pure unit tests
  run with zero Docker dependency.
- `pnpm test:docker` → runs the **entire** suite (unit + gated), not just the
  Docker tests — counts are additive (86 vs 91 as of M0).
- Fast path when needed: `RAILYARD_DOCKER_TESTS=1 pnpm exec vitest run runner.docker e2e.docker`.

Related: [M0 design decisions](/decisions/m0-design-decisions.md).
