import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
import type { EventsLine, SignalEnvelope, WorkIdentity } from '../src/contracts/types.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import type { MonitorContext } from '../src/monitor/monitor.js'
import { Orchestrator, type OrchestratorConfig } from '../src/orchestrator.js'
import type { AgentExecutor } from '../src/run/executor.js'
import {
  LIFECYCLE_FILE_NAME,
  createRunIntent,
  readLifecycleRecord,
  updateLifecycleRecord,
  writeLifecycleRecord,
  type RunLifecycleRecord,
} from '../src/run/lifecycle.js'
import { LOCK_FILE_NAME } from '../src/run/lock.js'
import { DurableQueue } from '../src/run/queue.js'
import {
  BackendUnavailableError,
  makeRunId,
  type ResumeRunParams,
  type RunAgentParams,
  type RunControl,
  type RunObservation,
  type RunOutcome,
  type RunRecord,
  type RunSupervisionHandlers,
} from '../src/run/runner.js'

const TICK_SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const iso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// A simulated container backend. Containers outlive orchestrator instances
// (they live in this object, not in the orchestrator), exit only when the test
// says so, emit events lines on demand, and honor a deadline the way the real
// watchdog would. The executor advances lifecycle records exactly like the
// docker runner, so the orchestrator's recovery logic runs for real.
// ---------------------------------------------------------------------------

interface FakeContainer {
  name: string
  runId: string
  state: 'created' | 'running' | 'exited'
  exitCode: number | null
  killReason: string | null
  env: Record<string, string>
  lines: EventsLine[]
  waiters: Set<() => void>
  deadlineAt: number | null
  timeoutSeconds: number | null
}

class FakeBackend {
  readonly containers = new Map<string, FakeContainer>()
  unavailable = false

  byRun(runId: string): FakeContainer {
    for (const c of this.containers.values()) if (c.runId === runId) return c
    throw new Error(`no container for run ${runId}`)
  }

  runIds(): string[] {
    return [...this.containers.values()].map((c) => c.runId)
  }

  emit(runId: string, line: EventsLine): void {
    const c = this.byRun(runId)
    c.lines.push(line)
    for (const w of c.waiters) w()
  }

  exit(runId: string, exitCode = 0): void {
    const c = this.byRun(runId)
    c.state = 'exited'
    c.exitCode = exitCode
    for (const w of c.waiters) w()
  }

  vanish(runId: string): void {
    this.containers.delete(this.byRun(runId).name)
  }

  /** What the real watchdog does while nobody is supervising. */
  enforceDeadline(c: FakeContainer): void {
    if (c.state === 'running' && c.deadlineAt !== null && Date.now() >= c.deadlineAt) {
      c.state = 'exited'
      c.exitCode = 137
      c.killReason = `timeout: exceeded ${String(c.timeoutSeconds)}s`
    }
  }
}

class SimulatedExecutor implements AgentExecutor {
  calls: RunAgentParams[] = []
  resumed: ResumeRunParams[] = []

  constructor(readonly backend: FakeBackend) {}

  async ensureReady(agent: { name: string }): Promise<string> {
    return `fake/${agent.name}:latest`
  }

  async execute(params: RunAgentParams): Promise<RunOutcome> {
    this.calls.push(params)
    const { runsDir } = params
    let lc = params.lifecycle
    const c: FakeContainer = {
      name: lc.containerName,
      runId: lc.runId,
      state: 'created',
      exitCode: null,
      killReason: null,
      env: params.env ?? {},
      lines: [],
      waiters: new Set(),
      deadlineAt: null,
      timeoutSeconds: lc.timeoutSeconds,
    }
    this.backend.containers.set(c.name, c)
    lc = await updateLifecycleRecord(runsDir, lc, { phase: 'created', createdAt: iso() })
    lc = await this.start(c, lc, runsDir)
    return this.supervise(c, lc, runsDir, params, params.control ?? {})
  }

  async observe(lc: RunLifecycleRecord): Promise<RunObservation> {
    if (this.backend.unavailable) throw new BackendUnavailableError('simulated daemon down')
    const c = this.backend.containers.get(lc.containerName)
    if (!c) return { state: 'missing', exitCode: null, finishedAt: null, secrets: {} }
    this.backend.enforceDeadline(c)
    const secrets: Record<string, string> = {}
    for (const name of lc.secretNames) if (name in c.env) secrets[name] = c.env[name]!
    return {
      state: c.state,
      exitCode: c.exitCode,
      finishedAt: c.state === 'exited' ? iso() : null,
      secrets,
    }
  }

  async resume(params: ResumeRunParams): Promise<RunOutcome> {
    this.resumed.push(params)
    const { runsDir } = params
    let lc = await updateLifecycleRecord(runsDir, params.lifecycle, { detachedAt: null })
    const c = this.backend.containers.get(lc.containerName)
    if (!c) throw new Error(`resume: container ${lc.containerName} missing`)
    if (c.state === 'created') lc = await this.start(c, lc, runsDir)
    return this.supervise(c, lc, runsDir, params, params.control ?? {})
  }

  async sweep(_runsDir: string, keep: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = []
    for (const c of [...this.backend.containers.values()]) {
      if (keep.has(c.runId)) continue
      this.backend.containers.delete(c.name)
      removed.push(c.runId)
    }
    return removed
  }

  private async start(c: FakeContainer, lc: RunLifecycleRecord, runsDir: string): Promise<RunLifecycleRecord> {
    c.state = 'running'
    const startedAt = new Date()
    const deadline = lc.timeoutSeconds === null ? null : new Date(startedAt.getTime() + lc.timeoutSeconds * 1000)
    c.deadlineAt = deadline?.getTime() ?? null
    return updateLifecycleRecord(runsDir, lc, {
      phase: 'started',
      startedAt: startedAt.toISOString(),
      deadlineAt: deadline?.toISOString() ?? null,
      watchdogPid: 4242,
    })
  }

  private async supervise(
    c: FakeContainer,
    lc0: RunLifecycleRecord,
    runsDir: string,
    handlers: RunSupervisionHandlers,
    control: RunControl,
  ): Promise<RunOutcome> {
    let lc = lc0
    let consumed = lc.eventsConsumed
    const deliver = async (): Promise<void> => {
      while (consumed < c.lines.length) {
        const index = consumed
        await handlers.onEvent(c.lines[index]!, index)
        consumed += 1
        lc = await updateLifecycleRecord(runsDir, lc, { eventsConsumed: consumed, eventsOffset: consumed })
      }
    }
    for (;;) {
      await deliver()
      this.backend.enforceDeadline(c)
      if (c.state === 'exited') break
      if (control.detach?.aborted) {
        lc = await updateLifecycleRecord(runsDir, lc, { detachedAt: iso() })
        return { kind: 'detached', lifecycle: lc }
      }
      if (control.cancel?.aborted) {
        c.state = 'exited'
        c.exitCode = 137
        c.killReason = 'cancelled'
        break
      }
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const done = (): void => {
          c.waiters.delete(done)
          if (timer !== undefined) clearTimeout(timer)
          control.detach?.removeEventListener('abort', done)
          control.cancel?.removeEventListener('abort', done)
          resolve()
        }
        c.waiters.add(done)
        control.detach?.addEventListener('abort', done)
        control.cancel?.addEventListener('abort', done)
        if (c.deadlineAt !== null) timer = setTimeout(done, Math.max(0, c.deadlineAt - Date.now()))
      })
    }
    await deliver()
    const exitCode = c.exitCode ?? -1
    lc = await updateLifecycleRecord(runsDir, lc, { phase: 'exited', exitCode, exitedAt: iso() })
    const record: RunRecord = {
      runId: lc.runId,
      agent: lc.agent,
      signalId: lc.signal.id,
      imageRef: lc.imageRef,
      startedAt: lc.startedAt ?? lc.intentAt,
      finishedAt: iso(),
      durationMs: 1,
      exitCode,
      status: exitCode === 0 ? 'succeeded' : 'failed',
      result: null,
      resultError: null,
      killReason: c.killReason,
    }
    this.backend.containers.delete(c.name)
    await updateLifecycleRecord(runsDir, lc, { phase: 'finalized', finalizedAt: record.finishedAt, outcome: record })
    return { kind: 'finished', record }
  }
}

// ---------------------------------------------------------------------------
// Harness: one runs/state/agents tree, any number of orchestrator "processes".
// ---------------------------------------------------------------------------

interface AgentSpec {
  manifest: string
}

const ECHO: AgentSpec = { manifest: 'name: echo\non:\n  - type: demo.tick\n' }

function tickerMonitor() {
  let ctx: MonitorContext | undefined
  return {
    name: 'ticker',
    emits: [{ type: 'demo.tick', payloadSchema: TICK_SCHEMA }],
    async start(c: MonitorContext) {
      ctx = c
    },
    async stop() {},
    emit(payload: unknown, work?: WorkIdentity) {
      ctx!.emit({ type: 'demo.tick', payload, ...(work ? { work } : {}) })
    },
  }
}

const ALL_EVENTS = [
  'signal.received',
  'signal.dropped',
  'run.started',
  'run.finished',
  'run.detached',
  'run.recovered',
  'run.queued',
  'run.skipped',
  'retention.swept',
  'note',
] as const

async function harness(agentSpecs: Record<string, AgentSpec> = { echo: ECHO }) {
  const root = await mkdtemp(path.join(tmpdir(), 'railyard-recovery-'))
  const agentsDir = path.join(root, 'agents')
  const runsDir = path.join(root, 'runs')
  const stateDir = path.join(root, 'state')
  await mkdir(agentsDir)
  const writeAgents = async (specs: Record<string, AgentSpec>): Promise<void> => {
    for (const [name, spec] of Object.entries(specs)) {
      const dir = path.join(agentsDir, name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'manifest.yaml'), spec.manifest)
      await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n')
    }
  }
  await writeAgents(agentSpecs)
  const backend = new FakeBackend()

  /** A new orchestrator "process" over the same directories and backend. */
  const boot = (configExtra: Partial<OrchestratorConfig> = {}) => {
    const executor = (configExtra.executor as SimulatedExecutor | undefined) ?? new SimulatedExecutor(backend)
    const orchestrator = new Orchestrator({
      agentsDir,
      runsDir,
      stateDir,
      executor,
      logger: silentLogger,
      ...configExtra,
    })
    const entries: JournaledEntry[] = []
    for (const event of ALL_EVENTS) {
      orchestrator.on(event, (entry) => {
        entries.push(entry)
      })
    }
    const monitor = tickerMonitor()
    orchestrator.register(monitor)
    const of = <E extends JournaledEntry['event']>(event: E) =>
      entries.filter((e): e is Extract<JournaledEntry, { event: E }> => e.event === event)
    return { orchestrator, executor, entries, monitor, of }
  }

  /** Simulate the previous process dying: its locks would be judged stale and cleared. */
  const clearLocks = async (): Promise<void> => {
    await rm(path.join(runsDir, LOCK_FILE_NAME), { force: true })
    await rm(path.join(stateDir, LOCK_FILE_NAME), { force: true })
  }

  const journal = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(path.join(runsDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  return { root, agentsDir, runsDir, stateDir, backend, boot, clearLocks, journal, writeAgents }
}

type Booted = ReturnType<Awaited<ReturnType<typeof harness>>['boot']>

async function firstRunId(b: Booted): Promise<string> {
  await vi.waitFor(() => expect(b.of('run.started')).toHaveLength(1))
  return b.of('run.started')[0]!.runId
}

// ---------------------------------------------------------------------------

describe('detach and reattach (SPEC §6.5)', () => {
  it('detach returns without waiting; the successor continues the same run id/container, restores concurrency before admission, and keeps queued work', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    a.monitor.emit({ n: 2 })
    const runId = await firstRunId(a)
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(1))
    expect(h.backend.runIds()).toEqual([runId])

    const started = Date.now()
    await a.orchestrator.stop({ mode: 'detach' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(a.of('run.detached')).toEqual([expect.objectContaining({ runId, agent: 'echo' })])
    expect(a.of('run.finished')).toHaveLength(0)
    // The container is still there, the record says detached, the queue is on disk.
    expect(h.backend.runIds()).toEqual([runId])
    const record = (await readLifecycleRecord(h.runsDir, runId))!
    expect(record.phase).toBe('started')
    expect(record.detachedAt).not.toBeNull()
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(1)

    // "Updated code": a fresh process over the same directories.
    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'reattached' })])
    expect(b.of('run.started')).toHaveLength(0) // never a second run.started for the run
    expect(b.executor.resumed.map((r) => r.lifecycle.runId)).toEqual([runId])
    // Cap 1 with the reattached run active: the queued delivery is restored but not launched.
    expect(b.of('run.queued')).toEqual([expect.objectContaining({ queueDepth: 1 })])
    expect(b.executor.calls).toHaveLength(0)

    h.backend.exit(runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    expect(b.of('run.finished')[0]).toMatchObject({ runId, status: 'succeeded' })
    // Now the queued delivery runs — once — as a new run.
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(1))
    const second = b.executor.calls[0]!.lifecycle.runId
    h.backend.exit(second, 0)
    await b.orchestrator.stop()
    expect(b.of('run.finished')).toHaveLength(2)

    // One run.started and one run.finished per run across both processes.
    const all = await h.journal()
    const startedIds = all.filter((e) => e.event === 'run.started').map((e) => e.runId)
    const finishedIds = all.filter((e) => e.event === 'run.finished').map((e) => e.runId)
    expect(startedIds.sort()).toEqual([runId, second].sort())
    expect(finishedIds.sort()).toEqual([runId, second].sort())
    expect((await readLifecycleRecord(h.runsDir, runId))!.phase).toBe('closed')
  })

  it('an agent that finishes and emits child signals while no orchestrator runs: one completion, each child scheduled once, even when the checkpoint replays', async () => {
    const h = await harness({
      first: { manifest: 'name: first\non:\n  - type: demo.tick\n' },
      second: { manifest: 'name: second\nconcurrency: 3\non:\n  - type: first.done\n' },
    })
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    // One child emitted (and checkpointed) under supervision.
    h.backend.emit(runId, { kind: 'signal', type: 'first.done', payload: { step: 0 } })
    await vi.waitFor(() => expect(a.executor.calls.map((c) => c.agent.name)).toEqual(['first', 'second']))
    const child0 = a.executor.calls[1]!.lifecycle.runId
    h.backend.exit(child0, 0)
    await vi.waitFor(() => expect(a.of('run.finished')).toHaveLength(1))
    // Unclean death: rewind the persisted checkpoint as if the crash came
    // between routing line 0 and persisting the checkpoint, and drop the locks.
    await a.orchestrator.stop({ mode: 'detach' })
    const rec = (await readLifecycleRecord(h.runsDir, runId))!
    await updateLifecycleRecord(h.runsDir, rec, { eventsConsumed: 0, eventsOffset: 0, detachedAt: null })
    await h.clearLocks()

    // While absent: two more children, then exit.
    h.backend.emit(runId, { kind: 'signal', type: 'first.done', payload: { step: 1 } })
    h.backend.emit(runId, { kind: 'signal', type: 'first.done', payload: { step: 2 } })
    h.backend.exit(runId, 0)

    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'finalized' })])
    await vi.waitFor(() => expect(b.of('run.finished').map((e) => e.runId)).toContain(runId))
    // Line 0 was replayed from the rewound checkpoint and suppressed by id.
    expect(b.of('note').some((n) => n.message.includes('already routed; replay suppressed'))).toBe(true)
    await vi.waitFor(() => expect(b.executor.calls.map((c) => c.lifecycle.signal.payload)).toEqual([{ step: 1 }, { step: 2 }]))
    for (const c of b.executor.calls) h.backend.exit(c.lifecycle.runId, 0)
    await b.orchestrator.stop()

    const all = await h.journal()
    expect(all.filter((e) => e.event === 'run.finished' && e.runId === runId)).toHaveLength(1)
    // Exactly three child deliveries over the whole story: steps 0, 1, 2.
    const secondStarts = all.filter((e) => e.event === 'run.started' && e.agent === 'second')
    expect(secondStarts).toHaveLength(3)
  })

  it('a successor can wait for the predecessor to finish detaching (lockWaitMs)', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    const b = h.boot({ lockWaitMs: 5_000 })
    // Without waiting, the lock is refused outright.
    const c = h.boot()
    await expect(c.orchestrator.start()).rejects.toThrow(/locked by another/)
    const successor = b.orchestrator.start()
    setTimeout(() => void a.orchestrator.stop({ mode: 'detach' }), 300)
    await successor
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'reattached' })])
    h.backend.exit(runId, 0)
    await b.orchestrator.stop()
  })
})

describe('shutdown modes and repeated requests (SPEC §6.5)', () => {
  it('drain waits for active runs, keeps queued deliveries, and the next start restores and launches them', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    a.monitor.emit({ n: 2 })
    const runId = await firstRunId(a)
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(1))
    const draining = a.orchestrator.stop()
    let drained = false
    void draining.then(() => {
      drained = true
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(drained).toBe(false)
    h.backend.exit(runId, 0)
    await draining
    expect(a.of('run.finished')).toHaveLength(1)
    expect(a.of('run.skipped')).toHaveLength(0)
    expect(h.backend.runIds()).toEqual([])

    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.queued')).toEqual([expect.objectContaining({ queueDepth: 1 })])
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(1))
    expect(b.executor.calls[0]!.lifecycle.signal.payload).toEqual({ n: 2 })
    h.backend.exit(b.executor.calls[0]!.lifecycle.runId, 0)
    await b.orchestrator.stop()
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(0)
  })

  it('cancel kills active runs (killReason "cancelled") and drops queued deliveries, journaled', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    a.monitor.emit({ n: 2 })
    const runId = await firstRunId(a)
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(1))
    await a.orchestrator.stop({ mode: 'cancel' })
    expect(a.of('run.finished')).toEqual([
      expect.objectContaining({ runId, status: 'failed', exitCode: 137, killReason: 'cancelled' }),
    ])
    expect(a.of('run.skipped')).toEqual([expect.objectContaining({ reason: 'cancelled' })])
    expect(h.backend.runIds()).toEqual([])
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(0)
    // A clean slate for the next start.
    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toHaveLength(0)
    expect(b.of('run.queued')).toHaveLength(0)
    await b.orchestrator.stop()
  })

  it('concurrent and repeated stop() calls share one completion; the first mode wins', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    const p1 = a.orchestrator.stop({ mode: 'detach' })
    const p2 = a.orchestrator.stop({ mode: 'cancel' })
    const p3 = a.orchestrator.stop()
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)
    await p1
    // Detach won: the container is still running, nothing was cancelled.
    expect(h.backend.runIds()).toEqual([runId])
    expect(a.of('run.detached')).toHaveLength(1)
    expect(a.of('run.finished')).toHaveLength(0)
    expect(a.orchestrator.stop()).toBe(p1)
    const b = h.boot()
    await b.orchestrator.start()
    h.backend.exit(runId, 0)
    await b.orchestrator.stop()
  })

  it('stop() during boot waits for boot to settle, then shuts down; stop() after a failed boot is a no-op and the instance can start again', async () => {
    const h = await harness()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const a = h.boot({
      executor: Object.assign(new SimulatedExecutor(h.backend), {
        async ensureReady(agent: { name: string }) {
          await gate
          return `fake/${agent.name}:latest`
        },
      }),
    })
    const starting = a.orchestrator.start()
    const stopping = a.orchestrator.stop({ mode: 'detach' })
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(stopped).toBe(false)
    release()
    await starting
    await stopping
    expect(stopped).toBe(true)
    // Locks are released: a new process boots.
    const b = h.boot()
    await b.orchestrator.start()
    await b.orchestrator.stop()

    // Failed boot: the secret is unresolvable.
    await h.writeAgents({ needy: { manifest: 'name: needy\nsecrets: [NOPE]\non:\n  - type: demo.tick\n' } })
    const c = h.boot({ secrets: { async resolve() { return undefined } } })
    const failing = c.orchestrator.start()
    const stopFailing = c.orchestrator.stop()
    await expect(failing).rejects.toThrow(/unresolvable secret/)
    await expect(stopFailing).resolves.toBeUndefined()
    // Nothing is stranded: the same instance boots once the secret resolves.
    const d = h.boot({ secrets: { async resolve() { return 'value-long-enough' } } })
    await d.orchestrator.start()
    await d.orchestrator.stop()
  })

  it('a signal matched while draining is accepted into the durable queue, not dropped', async () => {
    const h = await harness({
      first: { manifest: 'name: first\non:\n  - type: demo.tick\n' },
      second: { manifest: 'name: second\non:\n  - type: first.done\n' },
    })
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    const draining = a.orchestrator.stop()
    h.backend.emit(runId, { kind: 'signal', type: 'first.done', payload: {} })
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(1))
    h.backend.exit(runId, 0)
    await draining
    expect(a.of('run.skipped')).toHaveLength(0)
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(1)
  })
})

describe('duplicate suppression by logical work identity (SPEC §6.6)', () => {
  it('equivalent work re-emitted under a new signal id never runs twice; a new attempt or a new key does', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 }, { key: 'issue-1' })
    const runId = await firstRunId(a)
    // Re-emitted while active: skipped, naming the collision.
    a.monitor.emit({ n: 1 }, { key: 'issue-1' })
    await vi.waitFor(() => expect(a.of('run.skipped')).toHaveLength(1))
    expect(a.of('run.skipped')[0]).toMatchObject({ reason: 'duplicate' })
    expect(a.of('run.skipped')[0]!.detail).toContain(runId)
    // A payload conflict under the same key is still suppressed, and says so.
    a.monitor.emit({ n: 99 }, { key: 'issue-1' })
    await vi.waitFor(() => expect(a.of('run.skipped')).toHaveLength(2))
    expect(a.of('run.skipped')[1]!.detail).toMatch(/payload differs/)

    // Across a restart, while the adopted run is still active.
    await a.orchestrator.stop({ mode: 'detach' })
    const b = h.boot()
    await b.orchestrator.start()
    b.monitor.emit({ n: 1 }, { key: 'issue-1' })
    await vi.waitFor(() => expect(b.of('run.skipped')).toHaveLength(1))
    expect(b.executor.calls).toHaveLength(0)

    // After completion, replay within the retention window is still suppressed…
    h.backend.exit(runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    b.monitor.emit({ n: 1 }, { key: 'issue-1' })
    await vi.waitFor(() => expect(b.of('run.skipped')).toHaveLength(2))
    expect(b.of('run.skipped')[1]!.detail).toMatch(/is done/)
    // …a deliberate retry (new attempt) and a new revision (new key) are admissible.
    b.monitor.emit({ n: 1 }, { key: 'issue-1', attempt: 2 })
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(1))
    b.monitor.emit({ n: 2 }, { key: 'issue-1@rev2' })
    await vi.waitFor(() => expect(b.of('run.queued')).toHaveLength(1))
    for (const c of b.executor.calls) h.backend.exit(c.lifecycle.runId, 0)
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(2))
    h.backend.exit(b.executor.calls[1]!.lifecycle.runId, 0)
    await b.orchestrator.stop()
    expect(b.executor.calls.map((c) => c.lifecycle.signal.work)).toEqual([
      { key: 'issue-1', attempt: 2 },
      { key: 'issue-1@rev2' },
    ])
  })

  it('work identity is scoped per target agent', async () => {
    const h = await harness({
      a: { manifest: 'name: a\non:\n  - type: demo.tick\n' },
      b: { manifest: 'name: b\non:\n  - type: demo.tick\n' },
    })
    const o = h.boot()
    await o.orchestrator.start()
    o.monitor.emit({ n: 1 }, { key: 'k' })
    await vi.waitFor(() => expect(o.executor.calls).toHaveLength(2))
    expect(o.of('run.skipped')).toHaveLength(0)
    for (const c of o.executor.calls) h.backend.exit(c.lifecycle.runId, 0)
    await o.orchestrator.stop()
  })

  it('signals without a work identity are never suppressed', async () => {
    const h = await harness()
    const o = h.boot()
    await o.orchestrator.start()
    o.monitor.emit({ n: 1 })
    o.monitor.emit({ n: 1 })
    await vi.waitFor(() => expect(o.of('run.queued')).toHaveLength(1))
    expect(o.of('run.skipped')).toHaveLength(0)
    await o.orchestrator.stop({ mode: 'cancel' })
  })
})

describe('crash windows at every launch and finalization transition (SPEC §6.5)', () => {
  /** Fabricate a persisted run at a given phase, with or without a container. */
  async function persisted(
    h: Awaited<ReturnType<typeof harness>>,
    phase: RunLifecycleRecord['phase'],
    options: { container?: FakeContainer['state']; timeoutSeconds?: number | null; agent?: string } = {},
  ): Promise<RunLifecycleRecord> {
    const agent = options.agent ?? 'echo'
    const signal = stampSignal({ kind: 'monitor', name: 'ticker' }, { type: 'demo.tick', payload: { n: 7 } })
    let record = createRunIntent({
      runId: makeRunId(agent),
      agent,
      agentDir: path.join(h.agentsDir, agent),
      imageRef: `fake/${agent}:latest`,
      signal,
      timeoutSeconds: options.timeoutSeconds === undefined ? 900 : options.timeoutSeconds,
      network: 'default',
      secretNames: [],
      hasPrompt: false,
    })
    const now = iso()
    if (phase !== 'intent') record = { ...record, phase: 'created', createdAt: now }
    if (phase === 'started' || phase === 'exited' || phase === 'finalized') {
      record = { ...record, phase: 'started', startedAt: now, deadlineAt: null }
    }
    if (phase === 'exited') record = { ...record, phase: 'exited', exitCode: 0, exitedAt: now }
    if (phase === 'finalized') {
      const outcome: RunRecord = {
        runId: record.runId,
        agent,
        signalId: signal.id,
        imageRef: record.imageRef,
        startedAt: now,
        finishedAt: now,
        durationMs: 3,
        exitCode: 0,
        status: 'succeeded',
        result: null,
        resultError: null,
        killReason: null,
      }
      record = { ...record, phase: 'finalized', exitCode: 0, exitedAt: now, finalizedAt: now, outcome }
    }
    await writeLifecycleRecord(h.runsDir, record)
    if (options.container !== undefined) {
      h.backend.containers.set(record.containerName, {
        name: record.containerName,
        runId: record.runId,
        state: options.container,
        exitCode: options.container === 'exited' ? 0 : null,
        killReason: null,
        env: {},
        lines: [],
        waiters: new Set(),
        deadlineAt: null,
        timeoutSeconds: record.timeoutSeconds,
      })
    }
    return record
  }

  it('intent recorded, no container: the delivery is requeued once as a fresh run (never a second attempt of the same run)', async () => {
    const h = await harness()
    const record = await persisted(h, 'intent')
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ runId: record.runId, outcome: 'requeued' })])
    expect(o.of('run.finished')).toEqual([
      expect.objectContaining({ runId: record.runId, status: 'interrupted', exitCode: null }),
    ])
    await vi.waitFor(() => expect(o.executor.calls).toHaveLength(1))
    const fresh = o.executor.calls[0]!.lifecycle
    expect(fresh.runId).not.toBe(record.runId)
    expect(fresh.signal.id).toBe(record.signal.id)
    expect(h.backend.runIds()).toEqual([fresh.runId])
    h.backend.exit(fresh.runId, 0)
    await o.orchestrator.stop()
    expect((await readLifecycleRecord(h.runsDir, record.runId))!.phase).toBe('closed')
    expect(JSON.parse(await readFile(path.join(h.runsDir, record.runId, 'result.json'), 'utf8'))).toMatchObject({
      status: 'interrupted',
    })
  })

  it('created but never started, container present: it is started and adopted', async () => {
    const h = await harness()
    const record = await persisted(h, 'created', { container: 'created' })
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ runId: record.runId, outcome: 'reattached' })])
    await vi.waitFor(() => expect(h.backend.byRun(record.runId).state).toBe('running'))
    expect(o.executor.calls).toHaveLength(0)
    h.backend.exit(record.runId, 0)
    await vi.waitFor(() => expect(o.of('run.finished')).toHaveLength(1))
    await o.orchestrator.stop()
  })

  it('created, container missing, requeue disabled: recorded interrupted and not retried', async () => {
    const h = await harness()
    const record = await persisted(h, 'created')
    const o = h.boot({ recovery: { requeueUnstarted: false } })
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ runId: record.runId, outcome: 'interrupted' })])
    expect(o.of('run.finished')).toEqual([expect.objectContaining({ status: 'interrupted' })])
    await new Promise((r) => setTimeout(r, 50))
    expect(o.executor.calls).toHaveLength(0)
    await o.orchestrator.stop()
  })

  it('started, container missing: interrupted with an explicit reason, never retried', async () => {
    const h = await harness()
    const record = await persisted(h, 'started')
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ runId: record.runId, outcome: 'interrupted' })])
    expect(o.of('run.finished')[0]).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('no exit was observed'),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(o.executor.calls).toHaveLength(0)
    await o.orchestrator.stop()
  })

  it('exited but uncollected: finalized from the backend, one completion', async () => {
    const h = await harness()
    const record = await persisted(h, 'started', { container: 'exited' })
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ runId: record.runId, outcome: 'finalized' })])
    await vi.waitFor(() => expect(o.of('run.finished')).toHaveLength(1))
    expect(o.of('run.finished')[0]).toMatchObject({ runId: record.runId, status: 'succeeded', exitCode: 0 })
    expect(h.backend.runIds()).toEqual([])
    await o.orchestrator.stop()
    expect((await readLifecycleRecord(h.runsDir, record.runId))!.phase).toBe('closed')
  })

  it('finalized but not closed: the terminal entry is journaled exactly once, from the record', async () => {
    const h = await harness()
    const withoutLine = await persisted(h, 'finalized')
    const withLine = await persisted(h, 'finalized')
    // The crash for `withLine` came after the journal append: a line already exists.
    await mkdir(h.runsDir, { recursive: true })
    await writeFile(
      path.join(h.runsDir, 'journal.jsonl'),
      JSON.stringify({
        event: 'run.finished',
        at: iso(),
        runId: withLine.runId,
        agent: 'echo',
        signalId: withLine.signal.id,
        status: 'succeeded',
        exitCode: 0,
        durationMs: 3,
      }) + '\n',
      { flag: 'a' },
    )
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.finished')).toEqual([
      expect.objectContaining({ runId: withoutLine.runId, status: 'succeeded', durationMs: 3 }),
    ])
    expect(o.of('run.recovered')).toHaveLength(0)
    await o.orchestrator.stop()
    const all = await h.journal()
    expect(all.filter((e) => e.event === 'run.finished' && e.runId === withLine.runId)).toHaveLength(1)
    expect(all.filter((e) => e.event === 'run.finished' && e.runId === withoutLine.runId)).toHaveLength(1)
    for (const r of [withLine, withoutLine]) {
      expect((await readLifecycleRecord(h.runsDir, r.runId))!.phase).toBe('closed')
    }
  })

  it('a queue file that outlived its run intent is dropped, not launched again', async () => {
    const h = await harness()
    const record = await persisted(h, 'started', { container: 'running' })
    await new DurableQueue(h.runsDir).accept('echo', record.signal)
    const o = h.boot()
    await o.orchestrator.start()
    expect(o.of('run.recovered')).toEqual([expect.objectContaining({ outcome: 'reattached' })])
    expect(o.of('run.queued')).toHaveLength(0)
    expect(o.executor.calls).toHaveLength(0)
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(0)
    h.backend.exit(record.runId, 0)
    await o.orchestrator.stop()
  })
})

describe('deadlines while no orchestrator is running (SPEC §6.2 under recovery)', () => {
  it('a run whose deadline passed during downtime is killed at the original deadline and reported as a timeout on recovery', async () => {
    const h = await harness({ slow: { manifest: 'name: slow\ntimeout: 1\non:\n  - type: demo.tick\n' } })
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    const deadlineAt = Date.parse((await readLifecycleRecord(h.runsDir, runId))!.deadlineAt!)
    await new Promise((r) => setTimeout(r, Math.max(0, deadlineAt - Date.now()) + 200))
    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'finalized' })])
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    expect(b.of('run.finished')[0]).toMatchObject({
      runId,
      status: 'failed',
      exitCode: 137,
      killReason: 'timeout: exceeded 1s',
    })
    await b.orchestrator.stop()
  })

  it('a reattached run keeps its original deadline rather than restarting from zero', async () => {
    const h = await harness({ slow: { manifest: 'name: slow\ntimeout: 1\non:\n  - type: demo.tick\n' } })
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await new Promise((r) => setTimeout(r, 600))
    await a.orchestrator.stop({ mode: 'detach' })
    const b = h.boot()
    await b.orchestrator.start()
    const before = (await readLifecycleRecord(h.runsDir, runId))!.deadlineAt
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1), { timeout: 3_000 })
    expect(b.of('run.finished')[0]).toMatchObject({ killReason: 'timeout: exceeded 1s' })
    expect(Date.now()).toBeLessThan(Date.parse(before!) + 800)
    await b.orchestrator.stop()
  })
})

describe('safety under uncertainty (SPEC §6.5)', () => {
  it('an unreachable backend fails boot with an actionable error and changes nothing', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    h.backend.unavailable = true
    const b = h.boot()
    await expect(b.orchestrator.start()).rejects.toThrow(/cannot determine the state of run .*Nothing has been changed/)
    expect(b.of('run.finished')).toHaveLength(0)
    expect(h.backend.runIds()).toEqual([runId])
    expect((await readLifecycleRecord(h.runsDir, runId))!.phase).toBe('started')
    h.backend.unavailable = false
    // Same instance, backend back: recovers normally.
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'reattached' })])
    h.backend.exit(runId, 0)
    await b.orchestrator.stop()
  })

  it('an unsupported record version fails boot before any sweep; containers and artifacts stay', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    const file = path.join(h.runsDir, runId, LIFECYCLE_FILE_NAME)
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...raw, lifecycleVersion: 99 }))
    const b = h.boot({ retention: { maxRunsPerAgent: 1 } })
    await expect(b.orchestrator.start()).rejects.toThrow(/lifecycle record version 99.*Nothing has been removed/)
    expect(h.backend.runIds()).toEqual([runId])
    expect(await readdir(path.join(h.runsDir, runId))).toContain(LIFECYCLE_FILE_NAME)
    // Restore the version: recovery proceeds.
    await writeFile(file, JSON.stringify(raw))
    await b.orchestrator.start()
    h.backend.exit(runId, 0)
    await b.orchestrator.stop()
  })

  it('aggressive retention never removes an active, detached, or unreadable run', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    // Older, closed-looking dirs, plus one with a corrupt record, plus the detached run.
    const stale = '2020-01-01T00-00-00.000Z--echo--aaaaaaaa'
    const corrupt = '2020-01-02T00-00-00.000Z--echo--bbbbbbbb'
    await mkdir(path.join(h.runsDir, stale))
    await mkdir(path.join(h.runsDir, corrupt))
    await writeFile(path.join(h.runsDir, corrupt, LIFECYCLE_FILE_NAME), '{corrupt')
    const b = h.boot({ retention: { maxRunsPerAgent: 1, maxAgeDays: 0.0001 } })
    await b.orchestrator.start()
    const left = await readdir(h.runsDir)
    expect(left).not.toContain(stale)
    expect(left).toContain(corrupt)
    expect(left).toContain(runId)
    expect(b.of('note').some((n) => n.message.includes('unreadable'))).toBe(true)
    h.backend.exit(runId, 0)
    await b.orchestrator.stop()
  })

  it('containers with no record at all are still swept as orphans; recorded ones are kept', async () => {
    const h = await harness()
    const record = createRunIntent({
      runId: makeRunId('echo'),
      agent: 'echo',
      agentDir: path.join(h.agentsDir, 'echo'),
      imageRef: 'fake/echo:latest',
      signal: stampSignal({ kind: 'monitor', name: 'ticker' }, { type: 'demo.tick', payload: { n: 1 } }),
      timeoutSeconds: null,
      network: 'default',
      secretNames: [],
      hasPrompt: false,
    })
    await writeLifecycleRecord(h.runsDir, { ...record, phase: 'started', startedAt: iso() })
    const mk = (runId: string, name: string): FakeContainer => ({
      name,
      runId,
      state: 'running',
      exitCode: null,
      killReason: null,
      env: {},
      lines: [],
      waiters: new Set(),
      deadlineAt: null,
      timeoutSeconds: null,
    })
    h.backend.containers.set(record.containerName, mk(record.runId, record.containerName))
    h.backend.containers.set('railyard--stray', mk('stray-run', 'railyard--stray'))
    const o = h.boot()
    await o.orchestrator.start()
    expect(h.backend.runIds()).toEqual([record.runId])
    expect(o.of('note').some((n) => n.message.includes('removed 1 orphaned container'))).toBe(true)
    h.backend.exit(record.runId, 0)
    await o.orchestrator.stop()
  })
})

describe('configuration changes across a restart (SPEC §6.5)', () => {
  it('a recovered run keeps its original image, timeout, and inputs even if the agent changed', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    await h.writeAgents({ echo: { manifest: 'name: echo\ntimeout: 5\non:\n  - type: demo.tick\n' } })
    const b = h.boot({
      executor: Object.assign(new SimulatedExecutor(h.backend), {
        async ensureReady(agent: { name: string }) {
          return `fake/${agent.name}:v2`
        },
      }),
    })
    await b.orchestrator.start()
    const record = (await readLifecycleRecord(h.runsDir, runId))!
    expect(record.imageRef).toBe('fake/echo:latest')
    expect(record.timeoutSeconds).toBe(900)
    expect(record.signal.payload).toEqual({ n: 1 })
    h.backend.exit(runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    // New work uses the new definition.
    b.monitor.emit({ n: 2 })
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(1))
    expect(b.executor.calls[0]!.lifecycle).toMatchObject({ imageRef: 'fake/echo:v2', timeoutSeconds: 5 })
    h.backend.exit(b.executor.calls[0]!.lifecycle.runId, 0)
    await b.orchestrator.stop()
  })

  it('a removed agent: its active run is still finished; its queued work is dropped, journaled; its child signals route by current definitions', async () => {
    const h = await harness({
      first: { manifest: 'name: first\non:\n  - type: demo.tick\n' },
    })
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    a.monitor.emit({ n: 2 })
    const runId = await firstRunId(a)
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(1))
    await a.orchestrator.stop({ mode: 'detach' })
    await rm(path.join(h.agentsDir, 'first'), { recursive: true })
    await h.writeAgents({ second: { manifest: 'name: second\non:\n  - type: first.done\n' } })
    const b = h.boot()
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'reattached' })])
    expect(b.of('run.skipped')).toEqual([expect.objectContaining({ agent: 'first', reason: 'agent-removed' })])
    h.backend.emit(runId, { kind: 'signal', type: 'first.done', payload: {} })
    await vi.waitFor(() => expect(b.executor.calls.map((c) => c.agent.name)).toEqual(['second']))
    expect(b.executor.calls[0]!.lifecycle.signal.source).toEqual({ kind: 'agent', name: 'first' })
    h.backend.exit(runId, 0)
    h.backend.exit(b.executor.calls[0]!.lifecycle.runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(2))
    await b.orchestrator.stop()
    expect(await new DurableQueue(h.runsDir).load()).toHaveLength(0)
  })

  it('changed concurrency counts already-active runs: raising the cap admits more, lowering it admits none', async () => {
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    for (const n of [1, 2, 3]) a.monitor.emit({ n })
    const runId = await firstRunId(a)
    await vi.waitFor(() => expect(a.of('run.queued')).toHaveLength(2))
    await a.orchestrator.stop({ mode: 'detach' })

    await h.writeAgents({ echo: { manifest: 'name: echo\nconcurrency: 2\non:\n  - type: demo.tick\n' } })
    const b = h.boot()
    await b.orchestrator.start()
    // 1 reattached + cap 2 → exactly one queued delivery launches.
    await vi.waitFor(() => expect(b.executor.calls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(b.executor.calls).toHaveLength(1)
    expect(h.backend.runIds()).toHaveLength(2)
    await b.orchestrator.stop({ mode: 'detach' })

    await h.writeAgents({ echo: { manifest: 'name: echo\nconcurrency: 1\non:\n  - type: demo.tick\n' } })
    const c = h.boot()
    await c.orchestrator.start()
    expect(c.of('run.recovered')).toHaveLength(2)
    expect(c.executor.calls).toHaveLength(0)
    for (const id of h.backend.runIds()) h.backend.exit(id, 0)
    await vi.waitFor(() => expect(c.of('run.finished')).toHaveLength(2))
    // Both slots freed; cap 1 → the last queued delivery runs.
    await vi.waitFor(() => expect(c.executor.calls).toHaveLength(1))
    h.backend.exit(c.executor.calls[0]!.lifecycle.runId, 0)
    await c.orchestrator.stop()
    expect(runId).toBeDefined()
  })

  it('credentials rotated between launch and recovery are still redacted from recovered output', async () => {
    const h = await harness({ needy: { manifest: 'name: needy\nsecrets: [TOKEN]\non:\n  - type: demo.tick\n' } })
    const values = { TOKEN: 'old-secret-value-1' }
    const a = h.boot({ secrets: { async resolve(name: string) { return (values as Record<string, string>)[name] } } })
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 })
    const runId = await firstRunId(a)
    expect(h.backend.byRun(runId).env).toEqual({ TOKEN: 'old-secret-value-1' })
    await a.orchestrator.stop({ mode: 'detach' })

    values.TOKEN = 'new-secret-value-2'
    const logs: string[] = []
    const b = h.boot({
      secrets: { async resolve(name: string) { return (values as Record<string, string>)[name] } },
      logger: { ...silentLogger, info: (m: string) => logs.push(m) },
    })
    await b.orchestrator.start()
    h.backend.emit(runId, { kind: 'log', message: 'leaking old-secret-value-1 and new-secret-value-2' })
    h.backend.emit(runId, { kind: 'signal', type: 'needy.done', payload: { note: 'old-secret-value-1' } })
    h.backend.exit(runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    await b.orchestrator.stop()
    const line = logs.find((l) => l.includes('leaking'))
    expect(line).toBe('[needy] leaking [REDACTED:TOKEN] and [REDACTED:TOKEN]')
    const journal = await readFile(path.join(h.runsDir, 'journal.jsonl'), 'utf8')
    expect(journal).not.toContain('old-secret-value-1')
    // The lifecycle record never held the value.
    const record = await readFile(path.join(h.runsDir, runId, LIFECYCLE_FILE_NAME), 'utf8')
    expect(record).not.toContain('old-secret-value-1')
    expect(JSON.parse(record).secretNames).toEqual(['TOKEN'])
  })
})

describe('observability of recovered states (SPEC §12)', () => {
  it('every journal line written across a detach/recover story validates against the disk contract', async () => {
    const { validateJournalLine } = await import('../src/contracts/validate.js')
    const h = await harness()
    const a = h.boot()
    await a.orchestrator.start()
    a.monitor.emit({ n: 1 }, { key: 'k' })
    a.monitor.emit({ n: 1 }, { key: 'k' })
    const runId = await firstRunId(a)
    await a.orchestrator.stop({ mode: 'detach' })
    const b = h.boot()
    await b.orchestrator.start()
    h.backend.exit(runId, 0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1))
    await b.orchestrator.stop({ mode: 'cancel' })
    const all = await h.journal()
    const kinds = new Set(all.map((e) => e.event))
    for (const kind of ['run.detached', 'run.recovered', 'run.skipped', 'run.finished']) expect(kinds).toContain(kind)
    for (const line of all) {
      expect(validateJournalLine(line), JSON.stringify(line)).toBe(true)
    }
  })
})

/** Type-level check that the harness's signal helper matches the envelope shape. */
const _envelope: SignalEnvelope = stampSignal({ kind: 'monitor', name: 'x' }, { type: 'a.b', payload: null })
void _envelope
