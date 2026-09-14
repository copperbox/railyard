import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateJournalLine } from '../src/contracts/validate.js'
import type { JsonSchema } from '../src/contracts/types.js'
import { dockerDaemonAvailable } from '../src/docker/build.js'
import { docker } from '../src/docker/cli.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import type { Monitor } from '../src/monitor/monitor.js'
import { Orchestrator, type OrchestratorConfig } from '../src/orchestrator.js'
import { readLifecycleRecord } from '../src/run/lifecycle.js'
import { LOCK_FILE_NAME } from '../src/run/lock.js'
import { readWatchdogKill } from '../src/run/watchdog.js'

const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
const AGENTS_DIR = path.join(import.meta.dirname, 'fixtures/agents')
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function containersFor(runId: string): Promise<string[]> {
  const res = await docker(['ps', '-aq', '--filter', `label=railyard.run=${runId}`])
  return res.stdout.trim().split('\n').filter(Boolean)
}

/** Emits one demo.tick at start with the given payload; nothing else. */
function onceMonitor(payload: unknown, tickSchema: JsonSchema): Monitor {
  return {
    name: 'once',
    emits: [{ type: 'demo.tick', payloadSchema: tickSchema }],
    async start(ctx) {
      ctx.emit({ type: 'demo.tick', payload })
    },
    async stop() {},
  }
}

async function harness(agentsDir = AGENTS_DIR) {
  const root = await mkdtemp(path.join(tmpdir(), 'railyard-recover-'))
  const runsDir = path.join(root, 'runs')
  const stateDir = path.join(root, 'state')
  const tickSchema = JSON.parse(
    await readFile(path.join(AGENTS_DIR, 'echo-agent/schemas/tick.json'), 'utf8'),
  ) as JsonSchema
  const boot = (payload: unknown | null, extra: Partial<OrchestratorConfig> = {}) => {
    const orchestrator = new Orchestrator({ agentsDir, runsDir, stateDir, logger: silentLogger, ...extra })
    if (payload !== null) orchestrator.register(onceMonitor(payload, tickSchema))
    const entries: JournaledEntry[] = []
    for (const event of ['run.started', 'run.finished', 'run.detached', 'run.recovered', 'signal.received'] as const) {
      orchestrator.on(event, (e) => {
        entries.push(e)
      })
    }
    const of = <E extends JournaledEntry['event']>(event: E) =>
      entries.filter((e): e is Extract<JournaledEntry, { event: E }> => e.event === event)
    return { orchestrator, entries, of }
  }
  const journal = async () =>
    (await readFile(path.join(runsDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { root, runsDir, stateDir, boot, journal }
}

describe.skipIf(!DOCKER)('docker: orchestrator restart recovers real containers (SPEC §6.5)', () => {
  it('detach leaves the container running; the next start reattaches to the same run and finishes it', { timeout: 120_000 }, async () => {
    expect(await dockerDaemonAvailable()).toBe(true)
    const h = await harness()
    const a = h.boot({ n: 1, sleep: 8 })
    await a.orchestrator.start()
    await vi.waitFor(() => expect(a.of('run.started')).toHaveLength(1), { timeout: 30_000 })
    const runId = a.of('run.started')[0]!.runId
    await vi.waitFor(async () => expect(await containersFor(runId)).toHaveLength(1), { timeout: 30_000 })

    await a.orchestrator.stop({ mode: 'detach' })
    expect(a.of('run.detached')).toHaveLength(1)
    expect(a.of('run.finished')).toHaveLength(0)
    expect(await containersFor(runId)).toHaveLength(1)
    const detached = (await readLifecycleRecord(h.runsDir, runId))!
    expect(detached.phase).toBe('started')
    expect(detached.detachedAt).not.toBeNull()
    expect(detached.watchdogPid).toEqual(expect.any(Number))

    const b = h.boot(null)
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'reattached' })])
    expect(b.of('run.started')).toHaveLength(0)
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1), { timeout: 60_000, interval: 250 })
    expect(b.of('run.finished')[0]).toMatchObject({ runId, status: 'succeeded', exitCode: 0 })
    await b.orchestrator.stop()

    const record = JSON.parse(await readFile(path.join(h.runsDir, runId, 'result.json'), 'utf8'))
    expect(record.result).toEqual({ echoed: 1 })
    expect(await readFile(path.join(h.runsDir, runId, 'events.jsonl'), 'utf8')).toContain('"echo.done"')
    expect((await readLifecycleRecord(h.runsDir, runId))!.phase).toBe('closed')
    expect(await containersFor(runId)).toEqual([])
    const all = await h.journal()
    for (const line of all) expect(validateJournalLine(line), JSON.stringify(line)).toBe(true)
    expect(all.filter((e) => e.event === 'run.started')).toHaveLength(1)
    expect(all.filter((e) => e.event === 'run.finished')).toHaveLength(1)
    // The agent's echo.done line was routed exactly once across both processes.
    expect(all.filter((e) => e.event === 'signal.received' && e.signalType === 'echo.done')).toHaveLength(1)
  })

  it('a run that finishes while no orchestrator is running is finalized once on the next start, with its output', { timeout: 120_000 }, async () => {
    const h = await harness()
    const a = h.boot({ n: 2, sleep: 2 })
    await a.orchestrator.start()
    await vi.waitFor(() => expect(a.of('run.started')).toHaveLength(1), { timeout: 30_000 })
    const runId = a.of('run.started')[0]!.runId
    await a.orchestrator.stop({ mode: 'detach' })
    // Simulate an unclean death on top: the stale-lock rule would clear these.
    await rm(path.join(h.runsDir, LOCK_FILE_NAME), { force: true })
    await rm(path.join(h.stateDir, LOCK_FILE_NAME), { force: true })
    // Let the agent finish on its own while nobody is watching.
    await vi.waitFor(
      async () => {
        const res = await docker(['inspect', '--format', '{{.State.Status}}', `railyard--${runId}`])
        expect(res.stdout.trim()).toBe('exited')
      },
      { timeout: 30_000, interval: 250 },
    )

    const b = h.boot(null)
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'finalized' })])
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1), { timeout: 30_000 })
    expect(b.of('run.finished')[0]).toMatchObject({ runId, status: 'succeeded', exitCode: 0 })
    await b.orchestrator.stop()
    const record = JSON.parse(await readFile(path.join(h.runsDir, runId, 'result.json'), 'utf8'))
    expect(record.result).toEqual({ echoed: 2 })
    expect(await containersFor(runId)).toEqual([])
    const all = await h.journal()
    expect(all.filter((e) => e.event === 'run.finished')).toHaveLength(1)
    expect(all.filter((e) => e.event === 'signal.received' && e.signalType === 'echo.done')).toHaveLength(1)
  })

  it('the original deadline is enforced by the watchdog while the orchestrator is down, and reported as a timeout on recovery', { timeout: 180_000 }, async () => {
    // Same echo agent with a 3 s timeout.
    const agentsDir = await mkdtemp(path.join(tmpdir(), 'railyard-agents-'))
    await cp(path.join(AGENTS_DIR, 'echo-agent'), path.join(agentsDir, 'echo-agent'), { recursive: true })
    await writeFile(
      path.join(agentsDir, 'echo-agent/manifest.yaml'),
      'name: echo-agent\ntimeout: 3\non:\n  - type: demo.tick\n    payloadSchema: ./schemas/tick.json\n',
    )
    const h = await harness(agentsDir)
    const a = h.boot({ n: 3, sleep: 60 })
    await a.orchestrator.start()
    await vi.waitFor(() => expect(a.of('run.started')).toHaveLength(1), { timeout: 60_000 })
    const runId = a.of('run.started')[0]!.runId
    await vi.waitFor(async () => expect(await containersFor(runId)).toHaveLength(1), { timeout: 30_000 })
    await a.orchestrator.stop({ mode: 'detach' })
    const record = (await readLifecycleRecord(h.runsDir, runId))!
    const deadlineAt = Date.parse(record.deadlineAt!)

    // Nobody is supervising; the watchdog process alone must kill it at the deadline.
    await vi.waitFor(
      async () => {
        const res = await docker(['inspect', '--format', '{{.State.Status}}', record.containerName])
        expect(res.stdout.trim()).toBe('exited')
      },
      { timeout: 30_000, interval: 250 },
    )
    expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt - 50)
    expect(await readWatchdogKill(path.join(h.runsDir, runId))).toMatchObject({ reason: 'timeout: exceeded 3s' })

    const b = h.boot(null)
    await b.orchestrator.start()
    expect(b.of('run.recovered')).toEqual([expect.objectContaining({ runId, outcome: 'finalized' })])
    await vi.waitFor(() => expect(b.of('run.finished')).toHaveLength(1), { timeout: 30_000 })
    expect(b.of('run.finished')[0]).toMatchObject({
      runId,
      status: 'failed',
      exitCode: 137,
      killReason: 'timeout: exceeded 3s',
    })
    await b.orchestrator.stop()
    expect(await containersFor(runId)).toEqual([])
    expect((await stat(path.join(h.runsDir, runId, 'result.json'))).isFile()).toBe(true)
  })

  it('cancel kills the container and records killReason "cancelled"', { timeout: 120_000 }, async () => {
    const h = await harness()
    const a = h.boot({ n: 4, sleep: 60 })
    await a.orchestrator.start()
    await vi.waitFor(() => expect(a.of('run.started')).toHaveLength(1), { timeout: 30_000 })
    const runId = a.of('run.started')[0]!.runId
    await vi.waitFor(async () => expect(await containersFor(runId)).toHaveLength(1), { timeout: 30_000 })
    await a.orchestrator.stop({ mode: 'cancel' })
    expect(a.of('run.finished')).toEqual([
      expect.objectContaining({ runId, status: 'failed', exitCode: 137, killReason: 'cancelled' }),
    ])
    expect(await containersFor(runId)).toEqual([])
    expect((await readLifecycleRecord(h.runsDir, runId))!.phase).toBe('closed')
  })
})
