# Getting started

railyard routes **signals** (events emitted by *monitors*) to **agents** (declarative
folders that run as ephemeral Docker containers). This walkthrough gets a running
orchestrator two ways: a zero-dependency local demo, and the real GitHub-issue reviewer.

## Prerequisites

- **Node ≥ 20** and a package manager (the repo uses `pnpm`).
- **Docker**, with a running daemon — agents run as containers, built or pulled at boot.

## Install

```sh
npm install @copperbox/railyard
# add the first-party GitHub monitor if you want it:
npm install @copperbox/railyard-monitor-github
```

The monitor declares `@copperbox/railyard` as a **peer dependency** — install both; the
monitor imports only types from core and ships zero runtime dependencies.

## The mental model

1. You construct an `Orchestrator` pointed at an **agents directory**, a **runs
   directory**, and a **state directory**.
2. You `register()` one or more **monitors** (code you write, or a first-party one).
3. You call `await orchestrator.start()`. Boot is **fail-fast** (SPEC §10): it loads and
   validates every agent manifest, checks that each subscription's schema is compatible
   with its emitter, resolves every declared secret, builds/pulls every agent image, and
   only then starts the monitors. **By the time `start()` resolves, the system is fully
   spawnable** — misconfiguration surfaces at boot, not at 2 a.m.
4. A monitor emits a signal → the orchestrator matches it against agent subscriptions →
   each matching agent runs in a fresh container → the run is journaled under `runs/`.

## Track A — the local demo (no API keys, no GitHub)

`examples/demo` is the SPEC §15 M0 skeleton: an interval monitor emits `demo.tick`; a
no-op shell agent reads its input, appends an event, writes a result.

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '@copperbox/railyard'
import { IntervalMonitor } from './interval-monitor.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const orchestrator = new Orchestrator({
  agentsDir: path.join(here, '../agents'),
  runsDir: path.join(here, '../runs'),
  stateDir: path.join(here, '../state'),
  retention: { maxRunsPerAgent: 20 }, // else boot warns that retention is unlimited
})

orchestrator.register(new IntervalMonitor(5000))
orchestrator.on('run.finished', (e) => console.log(`run ${e.runId} finished: ${e.status}`))

await orchestrator.start()
process.on('SIGINT', () => void orchestrator.stop().then(() => process.exit(0)))
```

Run it and watch `examples/demo/runs/` fill with run directories. This exercises the
**entire container contract** — input mount, events-file tailing, result collection,
teardown, journal — before any AI or GitHub specifics exist.

## Track B — the GitHub issue reviewer (real work)

`examples/github-review` is the user-zero workflow (SPEC §15 M4): label an issue
`needs-review` → a Claude Code agent writes a triage review into the run record. It wires
the [GitHub monitor](./authoring-monitors.md) to an agent copied from
[`scaffolds/claude-code`](./authoring-agents.md):

```ts
import { EnvSecretsProvider, Orchestrator } from '@copperbox/railyard'
import { GitHubIssuesMonitor } from '@copperbox/railyard-monitor-github'

const secrets = new EnvSecretsProvider({ envFile: '/abs/path/to/.env' })

const orchestrator = new Orchestrator({
  agentsDir, runsDir, stateDir, secrets,
  retention: { maxRunsPerAgent: 50 },
})

orchestrator.register(new GitHubIssuesMonitor({
  repos: ['your-org/your-repo'],
  token: await secrets.resolve('GITHUB_TOKEN'),  // a value, not a secret name (§9)
  pollIntervalMs: 60_000,
}))

await orchestrator.start()
```

Two secrets, one `.env`: `GITHUB_TOKEN` for the **monitor** (host-side, read-only:
`GITHUB_TOKEN=$(gh auth token)` locally), and Claude auth for the **agent container**.
The container declares *no* GitHub token — the signal payload is the whole input. See
[credential scoping](./credential-scoping.md).

> **`.env` and cwd:** `EnvSecretsProvider` defaults to `<cwd>/.env`, and cwd is wherever
> the process started (for a workspace app under `pnpm start`, the package dir — not the
> repo root). Pass an explicit `envFile` to remove the cwd dependence. Process env always
> wins over the file.

## Where things land

Every received signal and every run is journaled under `runs/` (SPEC §12):

```
runs/
  journal.jsonl                         # append-only index (exempt from retention)
  <ts>--<agent>--<id>/
    invocation.json                     # the signal envelope, matched agent, image hash
    agent.log                           # captured stdout/stderr (secrets redacted)
    events.jsonl                        # the agent's events file, preserved
    output/result.json                  # the agent's result + exit status
```

Observability is data you keep, not a stack you run. Subscribe to the same facts live via
`orchestrator.on('run.finished', …)` (see [authoring monitors](./authoring-monitors.md)
for the typed events).

## Next

- [Authoring monitors](./authoring-monitors.md) — write something that emits signals.
- [Authoring agents](./authoring-agents.md) — write the folder that runs.
- [Container contract](./container-contract.md) — what the container sees and must produce.
- [Credential scoping](./credential-scoping.md) — least-privilege secrets.
- [Signal Contract v1](./contracts/README.md) — the versioned wire/disk contracts.
