# @copperbox/railyard

> Part of **[railyard](https://github.com/copperbox/railyard)** — stylized *rAIlyard*.

The core framework for pub/sub-style, multi-provider AI agent orchestration. User-authored
**monitors** watch the outside world and emit **signals**; the **orchestrator** routes each
signal to matching **agents** — declarative folders — and runs every invocation as an
ephemeral, sandboxed Docker container.

railyard owns the *contracts* (signal shape, routing, container I/O, lifecycle safeguards)
and stays out of the *content* (which provider, which prompts, what the agent does). There
is no provider API abstraction and no universal guardrail schema — ever.

## Install

```sh
npm install @copperbox/railyard
```

Requires **Node ≥ 20** and a running **Docker** daemon. For the first-party GitHub monitor,
also install [`@copperbox/railyard-monitor-github`](https://www.npmjs.com/package/@copperbox/railyard-monitor-github).

## Quick start

```ts
import { Orchestrator } from '@copperbox/railyard'

const orchestrator = new Orchestrator({
  agentsDir: './agents',   // folders of manifest.yaml + prompt.md + Dockerfile
  runsDir: './runs',       // append-only journal + per-run records
  stateDir: './state',     // per-monitor cursors
  retention: { maxRunsPerAgent: 50 },
})

orchestrator.register(myMonitor)     // any object implementing Monitor
orchestrator.on('run.finished', (e) => console.log(e.agent, e.status))

await orchestrator.start()           // fail-fast boot: validates, checks, resolves, builds
```

`start()` loads and validates every agent manifest, checks each subscription's schema
against its emitter, resolves every declared secret, and builds/pulls every image **before
it resolves** — misconfiguration surfaces at boot, not at 2 a.m.

## What's in the box

- `Orchestrator` — validates, routes, spawns, journals.
- Signal bus behind a `SignalTransport` seam (in-memory default).
- Agent-folder loading + manifest validation; the declarative JSONPath filter + prompt
  template engines.
- The Docker runner honoring the full container contract (input mount, events-file
  tailing, result collection, guaranteed teardown).
- Safeguards: concurrency caps, timeouts, provenance depth limit, self-trigger guard.
- `SecretsProvider` (env/`.env` default) with a redaction guarantee; the file-based run
  journal + retention sweep.

Extension points are **seams, not features**: `SignalTransport`, `SecretsProvider`,
`AgentExecutor`, and the KV-store backend are all swappable.

## Documentation

- [Getting started](https://github.com/copperbox/railyard/blob/main/docs/getting-started.md)
- [Authoring monitors](https://github.com/copperbox/railyard/blob/main/docs/authoring-monitors.md)
  · [Authoring agents](https://github.com/copperbox/railyard/blob/main/docs/authoring-agents.md)
- [Container contract](https://github.com/copperbox/railyard/blob/main/docs/container-contract.md)
  · [Credential scoping](https://github.com/copperbox/railyard/blob/main/docs/credential-scoping.md)
- [Signal Contract v1](https://github.com/copperbox/railyard/blob/main/docs/contracts/README.md)
  — the versioned, language-neutral wire/disk contracts.

## License

MIT
