import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MonitorContext } from '../src/monitor/monitor.js'
import type { AgentExecutor } from '../src/run/executor.js'
import type { RunAgentParams, RunRecord } from '../src/run/runner.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import { Orchestrator } from '../src/orchestrator.js'

const TICK_SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }

class FakeExecutor implements AgentExecutor {
  calls: RunAgentParams[] = []
  behavior: (params: RunAgentParams) => Partial<RunRecord> | Promise<Partial<RunRecord>> = () => ({})

  async ensureReady(agent: { name: string }): Promise<string> {
    return `fake/${agent.name}:latest`
  }

  async execute(params: RunAgentParams): Promise<RunRecord> {
    this.calls.push(params)
    const now = new Date().toISOString()
    return {
      runId: params.runId ?? 'run',
      agent: params.agent.name,
      signalId: params.signal.id,
      imageRef: params.imageRef,
      startedAt: now,
      finishedAt: now,
      durationMs: 1,
      exitCode: 0,
      status: 'succeeded',
      result: null,
      resultError: null,
      killReason: null,
      ...(await this.behavior(params)),
    }
  }

  async sweep(): Promise<string[]> {
    return []
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

interface AgentSpec {
  manifest: string
  files?: Record<string, string>
}

async function setup(
  agentSpecs: Record<string, AgentSpec>,
  configExtra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'railyard-orch-'))
  const agentsDir = path.join(root, 'agents')
  await mkdir(agentsDir)
  for (const [name, spec] of Object.entries(agentSpecs)) {
    const dir = path.join(agentsDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'manifest.yaml'), spec.manifest)
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n')
    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      const p = path.join(dir, rel)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, content)
    }
  }
  const executor = new FakeExecutor()
  const orchestrator = new Orchestrator({
    agentsDir,
    runsDir: path.join(root, 'runs'),
    stateDir: path.join(root, 'state'),
    executor,
    logger: silentLogger,
    ...configExtra,
  })
  const entries: JournaledEntry[] = []
  const events = [
    'signal.received',
    'signal.dropped',
    'run.started',
    'run.finished',
    'run.skipped',
    'note',
  ] as const
  for (const event of events) {
    orchestrator.on(event, (entry) => {
      entries.push(entry)
    })
  }
  return { root, orchestrator, executor, entries }
}

function tickerMonitor() {
  let ctx: MonitorContext | undefined
  return {
    name: 'ticker',
    emits: [{ type: 'demo.tick', payloadSchema: TICK_SCHEMA }],
    async start(c: MonitorContext) {
      ctx = c
    },
    async stop() {},
    emit(payload: unknown) {
      ctx!.emit({ type: 'demo.tick', payload })
    },
    get ctx() {
      return ctx!
    },
  }
}

const ECHO = {
  manifest: 'name: echo\non:\n  - type: demo.tick\n',
}

describe('Orchestrator boot', () => {
  it('prepares every agent through the executor before monitors start', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    const readySpy = vi.spyOn(executor, 'ensureReady')
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    expect(readySpy).toHaveBeenCalledTimes(1)
    expect(monitor.ctx).toBeDefined()
    await orchestrator.stop()
  })

  it('fails start() on a subscription/emitter schema mismatch (SPEC §3)', async () => {
    const { orchestrator } = await setup({
      echo: {
        manifest: 'name: echo\non:\n  - type: demo.tick\n    payloadSchema: ./tick.json\n',
        files: { 'tick.json': JSON.stringify({ type: 'object' }) },
      },
    })
    orchestrator.register(tickerMonitor())
    await expect(orchestrator.start()).rejects.toThrow(/compatibility/)
  })

  it('rejects registering a monitor with an uncompilable declared schema', async () => {
    const { orchestrator } = await setup({ echo: ECHO })
    expect(() =>
      orchestrator.register({
        name: 'bad',
        emits: [{ type: 't', payloadSchema: { type: 'not-a-type' } }],
        async start() {},
        async stop() {},
      }),
    ).toThrow(/monitor "bad"/)
  })
})

describe('routing', () => {
  it('routes a monitor emission to the matching agent with a stamped envelope', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    const signal = executor.calls[0]!.signal
    expect(signal.type).toBe('demo.tick')
    expect(signal.source).toEqual({ kind: 'monitor', name: 'ticker' })
    expect(signal.provenance).toEqual([])
    await orchestrator.stop()
  })

  it('implicit fan-out: N matching agents all fire (SPEC §3)', async () => {
    const { orchestrator, executor } = await setup({
      'echo-a': { manifest: 'name: echo-a\non:\n  - type: demo.tick\n' },
      'echo-b': { manifest: 'name: echo-b\non:\n  - type: demo.tick\n' },
      other: { manifest: 'name: other\non:\n  - type: unrelated.type\n' },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    expect(executor.calls.map((c) => c.agent.name).sort()).toEqual(['echo-a', 'echo-b'])
    await orchestrator.stop()
  })

  it('applies declarative filters', async () => {
    const { orchestrator, executor } = await setup({
      picky: { manifest: "name: picky\non:\n  - type: demo.tick\n    filter: '$.n == 2'\n" },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    monitor.emit({ n: 2 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    expect(executor.calls[0]!.signal.payload).toEqual({ n: 2 })
    await orchestrator.stop()
  })

  it('rejects an undeclared emission, journaling the drop', async () => {
    const { orchestrator, entries } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    expect(() => monitor.ctx.emit({ type: 'demo.other', payload: {} })).toThrow(/undeclared/)
    expect(entries.some((e) => e.event === 'signal.dropped')).toBe(true)
    await orchestrator.stop()
  })

  it('rejects a schema-invalid payload, journaling the drop', async () => {
    const { orchestrator, entries } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    expect(() => monitor.emit({ wrong: true })).toThrow(/invalid payload/)
    expect(entries.some((e) => e.event === 'signal.dropped')).toBe(true)
    await orchestrator.stop()
  })
})

describe('agent-emitted signals (SPEC §7 chaining, M0 shape)', () => {
  it('re-enters the bus mid-run and triggers other agents with provenance', async () => {
    const { orchestrator, executor } = await setup({
      first: { manifest: 'name: first\non:\n  - type: demo.tick\n' },
      second: { manifest: 'name: second\non:\n  - type: first.done\n' },
    })
    executor.behavior = (params) => {
      if (params.agent.name === 'first') {
        params.onEvent({ kind: 'signal', type: 'first.done', payload: { ok: true } })
      }
      return {}
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() =>
      expect(executor.calls.map((c) => c.agent.name)).toEqual(['first', 'second']),
    )
    const chained = executor.calls[1]!.signal
    expect(chained.source).toEqual({ kind: 'agent', name: 'first' })
    expect(chained.provenance).toEqual([
      {
        source: { kind: 'monitor', name: 'ticker' },
        signalId: executor.calls[0]!.signal.id,
        signalType: 'demo.tick',
      },
    ])
    await orchestrator.stop()
  })
})

describe('safeguards: depth limit + self-trigger guard (SPEC §7)', () => {
  it('lets a self-chaining agent run up to the depth limit, then drops + journals', async () => {
    // looper re-triggers itself: tick (depth 0) → run → emit (depth 1) → run → …
    // With maxChainDepth 3, emissions at depth 1..3 pass (4 runs total); the
    // depth-4 emission is dropped and journaled.
    const { orchestrator, executor, entries } = await setup(
      {
        looper: {
          manifest: 'name: looper\nallowSelfTrigger: true\non:\n  - type: loop.go\n',
        },
      },
      { maxChainDepth: 3 },
    )
    executor.behavior = (params) => {
      params.onEvent({ kind: 'signal', type: 'loop.go', payload: {} })
      return {}
    }
    const monitor = {
      name: 'kickoff',
      emits: [{ type: 'loop.go', payloadSchema: { type: 'object' } as const }],
      ctx: undefined as MonitorContext | undefined,
      async start(c: MonitorContext) {
        this.ctx = c
      },
      async stop() {},
    }
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.ctx!.emit({ type: 'loop.go', payload: {} })
    await vi.waitFor(() => {
      expect(entries.some((e) => e.event === 'signal.dropped')).toBe(true)
    })
    expect(executor.calls).toHaveLength(4)
    const dropped = entries.find((e) => e.event === 'signal.dropped')!
    expect(dropped).toMatchObject({ source: { kind: 'agent', name: 'looper' } })
    expect((dropped as { reason: string }).reason).toMatch(/depth 4 exceeds max chain depth 3/)
    await orchestrator.stop()
  })

  it('refuses a self-trigger by default and journals run.skipped', async () => {
    const { orchestrator, executor, entries } = await setup({
      echo: { manifest: 'name: echo\non:\n  - type: demo.tick\n  - type: echo.done\n' },
    })
    executor.behavior = () => {
      executor.calls[executor.calls.length - 1]!.onEvent({
        kind: 'signal',
        type: 'echo.done',
        payload: {},
      })
      return {}
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => {
      expect(entries.some((e) => e.event === 'run.skipped')).toBe(true)
    })
    expect(executor.calls).toHaveLength(1)
    expect(entries.find((e) => e.event === 'run.skipped')).toMatchObject({
      agent: 'echo',
      signalType: 'echo.done',
      reason: 'self-trigger',
    })
    await orchestrator.stop()
  })

  it('a refused self-trigger still fans out to other matching agents', async () => {
    const { orchestrator, executor, entries } = await setup({
      emitter: { manifest: 'name: emitter\non:\n  - type: demo.tick\n  - type: emitter.done\n' },
      other: { manifest: 'name: other\non:\n  - type: emitter.done\n' },
    })
    executor.behavior = (params) => {
      if (params.agent.name === 'emitter') {
        params.onEvent({ kind: 'signal', type: 'emitter.done', payload: {} })
      }
      return {}
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() =>
      expect(executor.calls.map((c) => c.agent.name)).toEqual(['emitter', 'other']),
    )
    expect(entries.find((e) => e.event === 'run.skipped')).toMatchObject({
      agent: 'emitter',
      reason: 'self-trigger',
    })
    await orchestrator.stop()
  })

  it('rejects a non-positive maxChainDepth at construction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-orch-'))
    expect(
      () =>
        new Orchestrator({
          agentsDir: path.join(root, 'agents'),
          runsDir: path.join(root, 'runs'),
          maxChainDepth: 0,
          logger: silentLogger,
        }),
    ).toThrow(/maxChainDepth/)
  })
})

describe('journal and lifecycle', () => {
  it('journals the complete story in order and mirrors it on the emitter', async () => {
    const { root, orchestrator, entries } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() =>
      expect(entries.map((e) => e.event)).toEqual(['signal.received', 'run.started', 'run.finished']),
    )
    await orchestrator.stop()

    const journal = (await readFile(path.join(root, 'runs', 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(journal.map((e) => e.event)).toEqual(['signal.received', 'run.started', 'run.finished'])
    expect(journal[2].status).toBe('succeeded')
  })

  it('journals an executor crash as run.finished status error, never silently', async () => {
    const { orchestrator, executor, entries } = await setup({ echo: ECHO })
    executor.behavior = () => {
      throw new Error('docker exploded')
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => {
      const finished = entries.find((e) => e.event === 'run.finished')
      expect(finished).toMatchObject({ status: 'error', error: 'docker exploded' })
    })
    await orchestrator.stop()
  })

  it('stop() waits for in-flight runs', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let finished = false
    executor.behavior = async () => {
      await gate
      finished = true
      return {}
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    const stopping = orchestrator.stop()
    setTimeout(release, 50)
    await stopping
    expect(finished).toBe(true)
  })

  it('gives monitors a persistent KV store scoped by name', async () => {
    const { root, orchestrator } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    await monitor.ctx.state.set('cursor', 42)
    expect(await monitor.ctx.state.get('cursor')).toBe(42)
    const onDisk = JSON.parse(await readFile(path.join(root, 'state', 'ticker.json'), 'utf8'))
    expect(onDisk).toEqual({ cursor: 42 })
    await orchestrator.stop()
  })
})
