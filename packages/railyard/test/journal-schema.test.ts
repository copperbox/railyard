import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateJournalLine } from '../src/contracts/validate.js'
import type { MonitorContext } from '../src/monitor/monitor.js'
import type { AgentExecutor } from '../src/run/executor.js'
import type { RunAgentParams, RunRecord } from '../src/run/runner.js'
import { Orchestrator } from '../src/orchestrator.js'

const AT = { at: '2026-07-19T00:00:00.000Z' }
const SRC = { kind: 'monitor', name: 'm' }

describe('journal-line.schema.json fixtures (disk contract, SPEC §12)', () => {
  it.each([
    ['signal.received', { event: 'signal.received', ...AT, signalId: 's', signalType: 't', source: SRC, provenanceDepth: 0 }],
    ['signal.dropped (minimal)', { event: 'signal.dropped', ...AT, reason: 'why' }],
    ['signal.dropped (full)', { event: 'signal.dropped', ...AT, reason: 'why', signalType: 't', source: { kind: 'agent', name: 'a' } }],
    ['run.started', { event: 'run.started', ...AT, runId: 'r', agent: 'a', signalId: 's' }],
    ['run.finished (succeeded)', { event: 'run.finished', ...AT, runId: 'r', agent: 'a', signalId: 's', status: 'succeeded', exitCode: 0, durationMs: 12 }],
    ['run.finished (killed)', { event: 'run.finished', ...AT, runId: 'r', agent: 'a', signalId: 's', status: 'failed', exitCode: 137, durationMs: 12, killReason: 'timeout: exceeded 2s' }],
    ['run.finished (framework error)', { event: 'run.finished', ...AT, runId: 'r', agent: 'a', signalId: 's', status: 'error', exitCode: null, durationMs: null, error: 'boom' }],
    ['run.queued', { event: 'run.queued', ...AT, agent: 'a', signalId: 's', signalType: 't', queueDepth: 1 }],
    ['run.skipped (self-trigger)', { event: 'run.skipped', ...AT, agent: 'a', signalId: 's', signalType: 't', reason: 'self-trigger' }],
    ['run.skipped (shutdown)', { event: 'run.skipped', ...AT, agent: 'a', signalId: 's', signalType: 't', reason: 'shutdown' }],
    ['retention.swept', { event: 'retention.swept', ...AT, removed: ['2026--a--1'] }],
    ['note', { event: 'note', ...AT, message: 'hi' }],
  ])('accepts %s', (_name, line) => {
    expect(validateJournalLine(line), JSON.stringify(validateJournalLine.errors)).toBe(true)
  })

  it.each([
    ['unknown event', { event: 'run.exploded', ...AT }],
    ['missing at', { event: 'note', message: 'hi' }],
    ['bad skip reason', { event: 'run.skipped', ...AT, agent: 'a', signalId: 's', signalType: 't', reason: 'because' }],
    ['bad finished status', { event: 'run.finished', ...AT, runId: 'r', agent: 'a', signalId: 's', status: 'meh', exitCode: 0, durationMs: 1 }],
    ['extra property', { event: 'note', ...AT, message: 'hi', wat: true }],
    ['zero queueDepth', { event: 'run.queued', ...AT, agent: 'a', signalId: 's', signalType: 't', queueDepth: 0 }],
  ])('rejects %s', (_name, line) => {
    expect(validateJournalLine(line)).toBe(false)
  })
})

describe('real journal output validates line by line', () => {
  it('a scenario touching most event kinds produces only schema-valid lines', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-journal-'))
    const agentsDir = path.join(root, 'agents')
    for (const [name, manifest] of [
      // busy: cap 1 → the second tick queues; also self-subscribes to its own
      // emitted type without allowSelfTrigger → run.skipped.
      ['busy', 'name: busy\non:\n  - type: demo.tick\n  - type: busy.done\n'],
    ] as const) {
      const dir = path.join(agentsDir, name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'manifest.yaml'), manifest)
      await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine\n')
    }

    const executor: AgentExecutor = {
      async ensureReady(agent) {
        return `fake/${agent.name}:latest`
      },
      async execute(params: RunAgentParams): Promise<RunRecord> {
        params.onEvent({ kind: 'signal', type: 'busy.done', payload: {} })
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
        }
      },
      async sweep() {
        return []
      },
    }

    let ctx: MonitorContext | undefined
    const orchestrator = new Orchestrator({
      agentsDir,
      runsDir: path.join(root, 'runs'),
      stateDir: path.join(root, 'state'),
      executor,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    orchestrator.register({
      name: 'm',
      emits: [{ type: 'demo.tick', payloadSchema: { type: 'object' } }],
      async start(c) {
        ctx = c
      },
      async stop() {},
    })
    const finished: unknown[] = []
    orchestrator.on('run.finished', (e) => finished.push(e))

    await orchestrator.start()
    ctx!.emit({ type: 'demo.tick', payload: {} })
    ctx!.emit({ type: 'demo.tick', payload: {} })
    expect(() => ctx!.emit({ type: 'not.declared', payload: {} })).toThrow() // → signal.dropped
    await vi.waitFor(() => expect(finished).toHaveLength(2))
    await orchestrator.stop()

    const lines = (await readFile(path.join(root, 'runs', 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const kinds = new Set(lines.map((l) => l.event))
    for (const kind of ['signal.received', 'signal.dropped', 'run.started', 'run.finished', 'run.queued', 'run.skipped', 'note']) {
      expect(kinds, `scenario should produce ${kind}`).toContain(kind)
    }
    for (const line of lines) {
      expect(
        validateJournalLine(line),
        `${JSON.stringify(line)} → ${JSON.stringify(validateJournalLine.errors)}`,
      ).toBe(true)
    }
  })
})
