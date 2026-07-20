import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
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
    'run.queued',
    'run.skipped',
    'retention.swept',
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

  it('on(event) narrows the entry type to that event (M4 friction fix)', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    // The narrowed handler sees run.finished's own fields (status, exitCode,
    // durationMs) without an `in`/`event !==` guard — the type-level proof.
    let seenStatus: string | undefined
    orchestrator.on('run.finished', (e) => {
      expectTypeOf(e.status).toEqualTypeOf<RunRecord['status'] | 'error'>()
      expectTypeOf(e.exitCode).toEqualTypeOf<number | null>()
      seenStatus = e.status
    })
    // signal.received narrows to its own fields; touching a run.finished-only
    // field here would not compile.
    orchestrator.on('signal.received', (e) => {
      expectTypeOf(e.signalType).toEqualTypeOf<string>()
    })
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    await vi.waitFor(() => expect(seenStatus).toBe('succeeded'))
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

describe('prompt rendering (SPEC §4, M2)', () => {
  it('renders prompt.md per spawn and hands it to the executor', async () => {
    const { orchestrator, executor } = await setup({
      echo: {
        manifest: ECHO.manifest,
        files: { 'prompt.md': 'Tick {{payload.n}} via {{type}} from {{source.name}}' },
      },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 7 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    expect(executor.calls[0]!.renderedPrompt).toBe('Tick 7 via demo.tick from ticker')
    await orchestrator.stop()
  })

  it('passes no renderedPrompt for promptless agents', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    expect(executor.calls[0]!.renderedPrompt).toBeUndefined()
    await orchestrator.stop()
  })

  it('a missing template path fails the run — journaled, executor never invoked', async () => {
    const { orchestrator, executor, entries } = await setup({
      echo: {
        manifest: ECHO.manifest,
        files: { 'prompt.md': 'wants {{payload.missing.key}}' },
      },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => {
      const finished = entries.find((e) => e.event === 'run.finished')
      expect(finished).toBeDefined()
      expect(finished).toMatchObject({ status: 'error' })
      expect(String((finished as { error?: string }).error)).toContain('{{payload.missing.key}}')
    })
    expect(executor.calls).toHaveLength(0)
    await orchestrator.stop()
  })

  it('a failed render releases the concurrency slot for the next queued signal', async () => {
    const { orchestrator, executor, entries } = await setup({
      echo: {
        manifest: ECHO.manifest,
        files: { 'prompt.md': '{{payload.word}}' },
      },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 }) // no `word` — render fails
    monitor.emit({ n: 2, word: 'ok' } as never)
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    expect(executor.calls[0]!.renderedPrompt).toBe('ok')
    expect(entries.filter((e) => e.event === 'run.finished')).toHaveLength(2)
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

  it('enforces the default depth limit of 5 when maxChainDepth is not configured', async () => {
    const { orchestrator, executor, entries } = await setup({
      looper: {
        manifest: 'name: looper\nallowSelfTrigger: true\non:\n  - type: loop.go\n',
      },
    })
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
    // Monitor signal (depth 0) + emissions at depth 1..5 run; depth 6 is dropped.
    expect(executor.calls).toHaveLength(6)
    expect(
      (entries.find((e) => e.event === 'signal.dropped') as { reason: string }).reason,
    ).toMatch(/depth 6 exceeds max chain depth 5/)
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

  it('plumbs manifest timeout to the executor: schema default 900, explicit value, explicit null', async () => {
    const { orchestrator, executor } = await setup({
      'default-timeout': { manifest: 'name: default-timeout\non:\n  - type: demo.tick\n' },
      'short-timeout': { manifest: 'name: short-timeout\ntimeout: 30\non:\n  - type: demo.tick\n' },
      forever: { manifest: 'name: forever\ntimeout: null\non:\n  - type: demo.tick\n' },
    })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(3))
    const byAgent = new Map(executor.calls.map((c) => [c.agent.name, c.timeoutSeconds]))
    expect(byAgent.get('default-timeout')).toBe(900)
    expect(byAgent.get('short-timeout')).toBe(30)
    expect(byAgent.get('forever')).toBeNull()
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

describe('safeguards: per-agent concurrency cap + queue (SPEC §6)', () => {
  /** Executor whose runs block until released one by one, in call order. */
  function gate(executor: FakeExecutor) {
    const releases: Array<() => void> = []
    executor.behavior = () =>
      new Promise<Partial<RunRecord>>((resolve) => {
        releases.push(() => resolve({}))
      })
    return {
      release: () => releases.shift()?.(),
      pending: () => releases.length,
    }
  }

  it('default cap 1 serializes runs: the second matched signal queues, journaled', async () => {
    const { orchestrator, executor, entries } = await setup({ echo: ECHO })
    const gated = gate(executor)
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    monitor.emit({ n: 2 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    expect(entries.find((e) => e.event === 'run.queued')).toMatchObject({
      agent: 'echo',
      queueDepth: 1,
    })
    gated.release()
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    expect(executor.calls.map((c) => c.signal.payload)).toEqual([{ n: 1 }, { n: 2 }])
    gated.release()
    await orchestrator.stop()
  })

  it('concurrency: 2 runs two signals simultaneously', async () => {
    const { orchestrator, executor, entries } = await setup({
      wide: { manifest: 'name: wide\nconcurrency: 2\non:\n  - type: demo.tick\n' },
    })
    const gated = gate(executor)
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    monitor.emit({ n: 2 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    expect(entries.some((e) => e.event === 'run.queued')).toBe(false)
    gated.release()
    gated.release()
    await orchestrator.stop()
  })

  it('drains the queue in FIFO order across several signals', async () => {
    const { orchestrator, executor } = await setup({ echo: ECHO })
    const gated = gate(executor)
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    for (const n of [1, 2, 3]) monitor.emit({ n })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    gated.release()
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    gated.release()
    await vi.waitFor(() => expect(executor.calls).toHaveLength(3))
    expect(executor.calls.map((c) => c.signal.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    gated.release()
    await orchestrator.stop()
  })

  it('stop() drops queued entries with a journal line each, but drains the in-flight run', async () => {
    const { orchestrator, executor, entries } = await setup({ echo: ECHO })
    const gated = gate(executor)
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    monitor.emit({ n: 2 })
    monitor.emit({ n: 3 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    const stopping = orchestrator.stop()
    setTimeout(() => gated.release(), 20)
    await stopping
    expect(executor.calls).toHaveLength(1)
    const skipped = entries.filter((e) => e.event === 'run.skipped')
    expect(skipped).toHaveLength(2)
    expect(skipped.every((e) => (e as { reason: string }).reason === 'shutdown')).toBe(true)
    expect(entries.filter((e) => e.event === 'run.finished')).toHaveLength(1)
  })

  it('a failed run still releases its slot for the queued signal', async () => {
    const { orchestrator, executor, entries } = await setup({ echo: ECHO })
    executor.behavior = () => {
      throw new Error('boom')
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    monitor.emit({ n: 2 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    await vi.waitFor(() =>
      expect(entries.filter((e) => e.event === 'run.finished')).toHaveLength(2),
    )
    await orchestrator.stop()
  })
})

describe('safeguards: secrets (SPEC §8)', () => {
  const fakeSecrets = (values: Record<string, string>) => ({
    resolve: async (name: string) => values[name],
  })

  it('fails start() loudly when a declared secret is unresolvable, naming it', async () => {
    const { orchestrator } = await setup(
      {
        needy: { manifest: 'name: needy\nsecrets: [PRESENT, ABSENT]\non:\n  - type: demo.tick\n' },
      },
      { secrets: fakeSecrets({ PRESENT: 'ok' }) },
    )
    orchestrator.register(tickerMonitor())
    await expect(orchestrator.start()).rejects.toThrow(/ABSENT \(agent "needy"\)/)
  })

  it('injects only the declared secrets, per agent', async () => {
    const { orchestrator, executor } = await setup(
      {
        'needs-a': { manifest: 'name: needs-a\nsecrets: [TOKEN_A]\non:\n  - type: demo.tick\n' },
        'needs-none': { manifest: 'name: needs-none\non:\n  - type: demo.tick\n' },
      },
      { secrets: fakeSecrets({ TOKEN_A: 'value-a', TOKEN_B: 'value-b' }) },
    )
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(2))
    const byAgent = new Map(executor.calls.map((c) => [c.agent.name, c.env]))
    expect(byAgent.get('needs-a')).toEqual({ TOKEN_A: 'value-a' })
    expect(byAgent.get('needs-none')).toEqual({})
    await orchestrator.stop()
  })

  it('a secret that vanishes between boot and spawn fails that run, journaled', async () => {
    const values: Record<string, string> = { TOKEN: 'here' }
    const { orchestrator, executor, entries } = await setup(
      {
        needy: { manifest: 'name: needy\nsecrets: [TOKEN]\non:\n  - type: demo.tick\n' },
      },
      { secrets: fakeSecrets(values) },
    )
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    delete values.TOKEN
    monitor.emit({ n: 1 })
    await vi.waitFor(() => {
      const finished = entries.find((e) => e.event === 'run.finished')
      expect(finished).toMatchObject({ status: 'error' })
      expect((finished as { error?: string }).error).toMatch(/TOKEN/)
    })
    expect(executor.calls).toHaveLength(0)
    await orchestrator.stop()
  })
})

describe('safeguards: redaction (SPEC §8)', () => {
  const fakeSecrets = (values: Record<string, string>) => ({
    resolve: async (name: string) => values[name],
  })

  it('redacts secret values in emitted payloads and journal entries, but injects them raw', async () => {
    const { root, orchestrator, executor } = await setup(
      {
        needy: { manifest: 'name: needy\nsecrets: [TOKEN]\non:\n  - type: demo.tick\n' },
      },
      { secrets: fakeSecrets({ TOKEN: 'super-sekret-value' }) },
    )
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1, note: 'leaking super-sekret-value here' })
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1))
    // The signal on the bus is scrubbed…
    expect(executor.calls[0]!.signal.payload).toEqual({
      n: 1,
      note: 'leaking [REDACTED:TOKEN] here',
    })
    // …while the container env gets the real value (that's the whole point).
    expect(executor.calls[0]!.env).toEqual({ TOKEN: 'super-sekret-value' })
    await orchestrator.stop()
    const journal = await readFile(path.join(root, 'runs', 'journal.jsonl'), 'utf8')
    expect(journal).not.toContain('super-sekret-value')
  })

  it('warns loudly (once) about a secret too short to redact, and still boots', async () => {
    const warnings: string[] = []
    const { orchestrator, entries } = await setup(
      {
        needy: { manifest: 'name: needy\nsecrets: [PIN]\non:\n  - type: demo.tick\n' },
      },
      {
        secrets: fakeSecrets({ PIN: '123' }),
        logger: { ...silentLogger, warn: (m: string) => warnings.push(m) },
      },
    )
    orchestrator.register(tickerMonitor())
    await orchestrator.start()
    expect(warnings.filter((w) => w.includes('"PIN"'))).toHaveLength(1)
    expect(entries.some((e) => e.event === 'note' && e.message.includes('"PIN"'))).toBe(true)
    await orchestrator.stop()
  })
})

describe('safeguards: retention (SPEC §12)', () => {
  it('warns loudly at startup when retention is unset, and journals the note', async () => {
    const warnings: string[] = []
    const { orchestrator, entries } = await setup(
      { echo: ECHO },
      { logger: { ...silentLogger, warn: (m: string) => warnings.push(m) } },
    )
    orchestrator.register(tickerMonitor())
    await orchestrator.start()
    expect(warnings.some((w) => w.includes('retention is unset'))).toBe(true)
    expect(
      entries.some((e) => e.event === 'note' && e.message.includes('retention is unset')),
    ).toBe(true)
    await orchestrator.stop()
  })

  it('sweeps at boot and after each run, journaling what was pruned', async () => {
    const { root, orchestrator, entries } = await setup(
      { echo: ECHO },
      { retention: { maxRunsPerAgent: 2 } },
    )
    const runsDir = path.join(root, 'runs')
    // Fabricate three stale run dirs for this agent; cap 2 → boot prunes one.
    const stale: string[] = []
    for (const [i, hour] of ['01', '02', '03'].entries()) {
      const id = `2026-07-19T${hour}-00-00.000Z--echo--aaaaaaa${i}`
      await mkdir(path.join(runsDir, id), { recursive: true })
      stale.push(id)
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    const bootSwept = entries.find((e) => e.event === 'retention.swept')
    expect(bootSwept).toMatchObject({ removed: [stale[0]] })

    // A finished run triggers another sweep; the two remaining dirs are within
    // the cap, so it must prune nothing further.
    monitor.emit({ n: 1 })
    await vi.waitFor(() =>
      expect(entries.filter((e) => e.event === 'run.finished')).toHaveLength(1),
    )
    await orchestrator.stop()
    // No new prune expected (2 dirs ≤ cap 2), but the boot prune must be the
    // only retention.swept — proving sweeps don't over-delete.
    expect(entries.filter((e) => e.event === 'retention.swept')).toHaveLength(1)
    const left = await readdir(runsDir)
    expect(left).toContain(stale[1]!)
    expect(left).toContain(stale[2]!)
    expect(left).toContain('journal.jsonl')
  })

  it('after-run sweep prunes dirs that fell out of policy during the run', async () => {
    const { root, orchestrator, executor, entries } = await setup(
      { echo: ECHO },
      { retention: { maxRunsPerAgent: 1 } },
    )
    const runsDir = path.join(root, 'runs')
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    // Appears mid-flight (after boot), pruned only by the after-run sweep.
    const stale = ['2026-07-19T01-00-00.000Z--echo--aaaaaaaa', '2026-07-19T02-00-00.000Z--echo--bbbbbbbb']
    for (const id of stale) await mkdir(path.join(runsDir, id), { recursive: true })
    executor.behavior = () => ({})
    monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(entries.some((e) => e.event === 'retention.swept')).toBe(true))
    const swept = entries.find((e) => e.event === 'retention.swept')!
    expect((swept as { removed: string[] }).removed).toEqual([stale[0]])
    await orchestrator.stop()
  })

  it('rejects invalid retention config at construction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-orch-'))
    const base = { agentsDir: path.join(root, 'agents'), runsDir: path.join(root, 'runs') }
    expect(() => new Orchestrator({ ...base, retention: { maxAgeDays: -1 } })).toThrow(/maxAgeDays/)
    expect(() => new Orchestrator({ ...base, retention: { maxRunsPerAgent: 0 } })).toThrow(
      /maxRunsPerAgent/,
    )
  })
})

describe('journal and lifecycle', () => {
  it('journals the complete story in order and mirrors it on the emitter', async () => {
    const { root, orchestrator, entries } = await setup({ echo: ECHO })
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    await orchestrator.start()
    monitor.emit({ n: 1 })
    // The retention-unset boot warning is journaled as a note (SPEC §12); the
    // run story follows it in order.
    const story = (list: Array<{ event: string }>) =>
      list.map((e) => e.event).filter((e) => e !== 'note')
    await vi.waitFor(() =>
      expect(story(entries)).toEqual(['signal.received', 'run.started', 'run.finished']),
    )
    await orchestrator.stop()

    const journal = (await readFile(path.join(root, 'runs', 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; status?: string })
    expect(story(journal)).toEqual(['signal.received', 'run.started', 'run.finished'])
    expect(journal.find((e) => e.event === 'run.finished')?.status).toBe('succeeded')
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
