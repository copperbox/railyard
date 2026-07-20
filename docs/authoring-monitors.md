# Authoring monitors

A **monitor** watches something in the outside world and emits **signals**. Monitors are
*code* (unlike agents, which are data); they run in the orchestrator's Node process. The
signal contract is the only coupling between a monitor and the agents that consume its
signals — a monitor knows nothing about which agents (if any) will fire.

## The interface

```ts
import type { Monitor, MonitorContext, SignalDeclaration } from '@copperbox/railyard'

interface Monitor {
  name: string
  emits: SignalDeclaration[]              // { type, payloadSchema } — boot-time compat
  start(ctx: MonitorContext): Promise<void>
  stop(): Promise<void>
}

interface MonitorContext {
  emit(signal: { type: string; payload: unknown }): void  // throws on undeclared type / bad payload
  state: KeyValueStore                    // per-monitor persistent KV (cursors)
  log: Logger
}
```

## A minimal monitor

The demo interval monitor (SPEC §15 M0), emitting `demo.tick` on a timer and surviving
restarts via `ctx.state`:

```ts
export const TICK_SCHEMA = {
  type: 'object', required: ['n'], properties: { n: { type: 'number' } },
} as const

export class IntervalMonitor implements Monitor {
  readonly name = 'interval'
  readonly emits: SignalDeclaration[] = [{ type: 'demo.tick', payloadSchema: TICK_SCHEMA as never }]
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly everyMs = 5000) {}

  async start(ctx: MonitorContext): Promise<void> {
    const tick = async () => {
      const n = (((await ctx.state.get('n')) as number | undefined) ?? 0) + 1
      await ctx.state.set('n', n)
      ctx.emit({ type: 'demo.tick', payload: { n } })
    }
    await tick()
    this.timer = setInterval(() => void tick(), this.everyMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
```

## Rules that matter

- **Declare what you emit.** Each entry in `emits` is `{ type, payloadSchema }` where the
  schema is **JSON Schema** (the interchange format, validated with ajv). At boot the
  orchestrator checks every agent subscription's required schema against the declared
  emitter schema and **fails loudly on a mismatch** — so a broken wiring can't reach
  production. `ctx.emit()` also validates each payload against its declared schema at
  emit time and throws on a violation.
- **Dedup is your job.** The framework does not dedup — `signal.id` is unique per
  emission, full stop. It cannot know what makes two of *your* events "the same." Use
  `ctx.state` to remember what you've already emitted (the GitHub monitor keys off
  GitHub's event id).
- **`ctx.state` is your persistence seam.** A per-monitor key/value store (JSON files on
  disk by default, pluggable backend) for cursors like "last seen event." It survives
  restarts. Keep keys scoped and small.
- **No scheduling sugar.** Monitors are code; `setInterval` exists (SPEC §9). railyard
  does not ship a cron layer.
- **Emit fully JSON-serializable payloads.** No dates-as-objects, no cycles — this is what
  lets a future transport carry your signals between processes unchanged.

## Consuming your signals

The framework mirrors every journaled fact on an in-process emitter, typed per event —
`on(event, handler)` narrows the entry to that event's fields, so no per-handler guard:

```ts
orchestrator.on('signal.received', (e) => console.log(e.signalType, e.source.name))
orchestrator.on('run.started',    (e) => console.log(e.agent, e.signalId))
orchestrator.on('run.finished',   (e) => console.log(e.status, e.exitCode, e.durationMs))
```

## Testing a monitor without an orchestrator

Core exports a test seam so you can unit-test emissions (including the same emit-time
schema validation the orchestrator applies) without spinning up Docker:

```ts
import { createMonitorTestContext } from '@copperbox/railyard'

const { ctx, emitted, logs, kv } = createMonitorTestContext(myMonitor.emits)
await myMonitor.start(ctx)
// assert on `emitted` (the validated signals), `logs`, and `kv` (the state store)
```

## First-party example

`@copperbox/railyard-monitor-github` is the reference monitor: it polls a repo's
issue-events API, keeps a per-repo cursor + ETag in `ctx.state`, owns its dedup, and emits
the four `github.issue.*` types with published JSON Schemas. It is built **strictly through
core's public API** (SPEC invariant 9) — if it needed something core didn't export, so
would you. See its [payload contract](./contracts/github-issue-signals.md).

Related: [signal envelope](./contracts/signal-envelope.md), [getting
started](./getting-started.md), [authoring agents](./authoring-agents.md).
