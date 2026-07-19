import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JsonSchema } from '../src/contracts/types.js'
import type { Monitor } from '../src/monitor/monitor.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import { Orchestrator } from '../src/orchestrator.js'

const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
const AGENTS_DIR = path.join(import.meta.dirname, 'fixtures/agents')

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

describe.skipIf(!DOCKER)('docker: end-to-end walking skeleton (SPEC §15 M0)', () => {
  it('monitor emission → container run → agent events → journaled round-trip', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-e2e-'))
    const runsDir = path.join(root, 'runs')

    // Declare exactly the schema the fixture agent requires — M0 compatibility
    // is structural identity, so read it from the agent folder itself.
    const tickSchema = JSON.parse(
      await readFile(path.join(AGENTS_DIR, 'echo-agent/schemas/tick.json'), 'utf8'),
    ) as JsonSchema

    const monitor: Monitor = {
      name: 'interval',
      emits: [{ type: 'demo.tick', payloadSchema: tickSchema }],
      async start(ctx) {
        const last = ((await ctx.state.get('n')) as number | undefined) ?? 0
        const n = last + 1
        await ctx.state.set('n', n)
        ctx.emit({ type: 'demo.tick', payload: { n } })
      },
      async stop() {},
    }

    const orchestrator = new Orchestrator({
      agentsDir: AGENTS_DIR,
      runsDir,
      stateDir: path.join(root, 'state'),
      logger: silentLogger,
    })
    orchestrator.register(monitor)
    const finished: JournaledEntry[] = []
    orchestrator.on('run.finished', (e) => {
      finished.push(e)
    })

    await orchestrator.start()
    await vi.waitFor(() => expect(finished).toHaveLength(1), { timeout: 90_000, interval: 250 })
    await orchestrator.stop()

    // The run succeeded and the container contract round-tripped.
    expect(finished[0]).toMatchObject({ agent: 'echo-agent', status: 'succeeded', exitCode: 0 })

    // The journal tells the complete story (SPEC §12).
    const journal = (await readFile(path.join(runsDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const events = journal.map((e) => e.event)
    expect(events.slice(0, 2)).toEqual(['signal.received', 'run.started'])
    expect(events).toContain('run.finished')

    // The agent's mid-run emission re-entered the bus with provenance depth 1.
    const echoDone = journal.find((e) => e.signalType === 'echo.done')
    expect(echoDone).toMatchObject({
      event: 'signal.received',
      source: { kind: 'agent', name: 'echo-agent' },
      provenanceDepth: 1,
    })

    // The run directory holds all four files (SPEC §12), and the input round-tripped.
    const runDirs = (await readdir(runsDir)).filter((d) => d.includes('echo-agent'))
    expect(runDirs).toHaveLength(1)
    const runDir = path.join(runsDir, runDirs[0]!)
    expect((await readdir(runDir)).sort()).toEqual([
      'agent.log',
      'events.jsonl',
      'input',
      'invocation.json',
      'output',
      'result.json',
    ])
    const record = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'))
    expect(record.result).toEqual({ echoed: 1 })
    const eventsFile = await readFile(path.join(runDir, 'events.jsonl'), 'utf8')
    expect(eventsFile).toContain('"echo.done"')

    // The monitor's cursor persisted through ctx.state (SPEC §9).
    const state = JSON.parse(await readFile(path.join(root, 'state', 'interval.json'), 'utf8'))
    expect(state).toEqual({ n: 1 })
  })
})
