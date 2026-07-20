import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadAgentFolder, type LoadedAgent } from '../src/agents/loader.js'
import { stampSignal } from '../src/bus/stamp.js'
import type { EventsLine } from '../src/contracts/types.js'
import { dockerDaemonAvailable, ensureAgentImage } from '../src/docker/build.js'
import { docker, dockerOk } from '../src/docker/cli.js'
import { runAgent, sweepOrphanContainers } from '../src/run/runner.js'
import { Redactor } from '../src/secrets/redactor.js'

const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
const FIXTURE = path.join(import.meta.dirname, 'fixtures/agents/echo-agent')

function tickSignal(payload: unknown) {
  return stampSignal({ kind: 'monitor', name: 'test' }, { type: 'demo.tick', payload })
}

describe.skipIf(!DOCKER)('docker: image build', () => {
  let agent: LoadedAgent

  beforeAll(async () => {
    expect(await dockerDaemonAvailable(), 'docker daemon must be reachable for docker tests').toBe(
      true,
    )
    agent = await loadAgentFolder(FIXTURE)
  })

  it('builds from the Dockerfile, then cache-hits on the unchanged folder', async () => {
    const first = await ensureAgentImage(agent)
    expect(first).toMatch(/^railyard\/echo-agent:[0-9a-f]{12}$/)

    const progress: string[] = []
    const second = await ensureAgentImage(agent, { onProgress: (l) => progress.push(l) })
    expect(second).toBe(first)
    expect(progress.join('\n')).toContain('up to date')
  })
})

describe.skipIf(!DOCKER)('docker: runner honors the container contract', () => {
  let agent: LoadedAgent
  let imageRef: string
  let runsDir: string

  beforeAll(async () => {
    agent = await loadAgentFolder(FIXTURE)
    imageRef = await ensureAgentImage(agent)
    runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-runs-'))
  })

  async function containersFor(runId: string): Promise<string[]> {
    const res = await docker(['ps', '-aq', '--filter', `label=railyard.run=${runId}`])
    return res.stdout.trim().split('\n').filter(Boolean)
  }

  it('round-trips the happy path, dispatching events mid-run', async () => {
    const events: Array<{ line: EventsLine; at: number }> = []
    const malformed: string[] = []
    const started = Date.now()
    const record = await runAgent({
      agent,
      imageRef,
      signal: tickSignal({ n: 7, sleep: 2 }),
      runsDir,
      onEvent: (line) => {
        events.push({ line, at: Date.now() - started })
      },
      onMalformedEvent: (raw) => {
        malformed.push(raw)
      },
    })

    expect(record.status).toBe('succeeded')
    expect(record.exitCode).toBe(0)
    expect(record.result).toEqual({ echoed: 7 })
    expect(record.resultError).toBeNull()
    expect(record.durationMs).toBeGreaterThanOrEqual(2000)

    const kinds = events.map((e) => e.line.kind)
    expect(kinds).toEqual(['log', 'signal'])
    expect(events[1]?.line).toMatchObject({ type: 'echo.done', payload: { n: 7 } })
    // The agent slept 2s after emitting; arrival well before exit proves mid-run dispatch.
    expect(events[1]!.at).toBeLessThan(record.durationMs)
    expect(malformed).toEqual(['deliberately not json'])

    const runDir = path.join(runsDir, record.runId)
    for (const file of ['invocation.json', 'agent.log', 'events.jsonl', 'result.json']) {
      expect((await stat(path.join(runDir, file))).isFile(), file).toBe(true)
    }
    const invocation = JSON.parse(await readFile(path.join(runDir, 'invocation.json'), 'utf8'))
    expect(invocation.signal.payload).toEqual({ n: 7, sleep: 2 })

    expect(await containersFor(record.runId)).toEqual([])
  })

  it('records a non-zero exit as failure and still tears down', async () => {
    const record = await runAgent({
      agent,
      imageRef,
      signal: tickSignal({ n: 1, fail: true }),
      runsDir,
      onEvent: () => {},
    })
    expect(record.status).toBe('failed')
    expect(record.exitCode).toBe(3)
    expect(record.result).toBeNull()
    expect(record.resultError).toBe('agent wrote no result.json')
    expect(await containersFor(record.runId)).toEqual([])
  })

  it('hard-kills a run past its timeout, records killReason, still tears down (SPEC §6)', async () => {
    const started = Date.now()
    const record = await runAgent({
      agent,
      imageRef,
      signal: tickSignal({ n: 5, sleep: 60 }),
      runsDir,
      timeoutSeconds: 2,
      onEvent: () => {},
    })
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(record.status).toBe('failed')
    expect(record.exitCode).toBe(137)
    expect(record.killReason).toBe('timeout: exceeded 2s')
    // Output emitted before the kill is preserved.
    const runDir = path.join(runsDir, record.runId)
    for (const file of ['invocation.json', 'agent.log', 'events.jsonl', 'result.json']) {
      expect((await stat(path.join(runDir, file))).isFile(), file).toBe(true)
    }
    expect(await containersFor(record.runId)).toEqual([])
  }, 40_000)

  it('timeout: null means no timer — the run completes on its own', async () => {
    const record = await runAgent({
      agent,
      imageRef,
      signal: tickSignal({ n: 2, sleep: 2 }),
      runsDir,
      timeoutSeconds: null,
      onEvent: () => {},
    })
    expect(record.status).toBe('succeeded')
    expect(record.killReason).toBeNull()
  })

  it('injects declared secrets as env vars — and only via the CLI process env (SPEC §8)', async () => {
    // Lives outside fixtures/agents so the e2e orchestrator boot doesn't load it.
    const secretAgent = await loadAgentFolder(
      path.join(import.meta.dirname, 'fixtures/secret-check-agent'),
    )
    const secretImage = await ensureAgentImage(secretAgent)

    const withSecret = await runAgent({
      agent: secretAgent,
      imageRef: secretImage,
      signal: tickSignal({ n: 1 }),
      runsDir,
      env: { MY_SECRET: 'expected-secret-value' },
      onEvent: () => {},
    })
    expect(withSecret.status).toBe('succeeded')
    expect(withSecret.result).toEqual({ secretSeen: true })

    const withoutSecret = await runAgent({
      agent: secretAgent,
      imageRef: secretImage,
      signal: tickSignal({ n: 1 }),
      runsDir,
      onEvent: () => {},
    })
    expect(withoutSecret.status).toBe('failed')
    expect(withoutSecret.exitCode).toBe(9)
  })

  it('scrubs a leaked secret from every framework-written run artifact (SPEC §8)', async () => {
    const SECRET = 'leak-me-if-you-can-9000'
    const leakAgent = await loadAgentFolder(path.join(import.meta.dirname, 'fixtures/leak-agent'))
    const leakImage = await ensureAgentImage(leakAgent)
    const redactor = new Redactor()
    expect(redactor.register('LEAK_SECRET', SECRET)).toBe(true)

    const record = await runAgent({
      agent: leakAgent,
      imageRef: leakImage,
      signal: tickSignal({ n: 1 }),
      runsDir,
      env: { LEAK_SECRET: SECRET },
      redactor,
      onEvent: () => {},
    })
    expect(record.status).toBe('succeeded')
    expect(record.result).toEqual({ stolen: '[REDACTED:LEAK_SECRET]' })

    const runDir = path.join(runsDir, record.runId)
    const artifacts = [
      'invocation.json',
      'agent.log',
      'events.jsonl',
      'result.json',
      'output/result.json',
    ]
    for (const file of artifacts) {
      const content = await readFile(path.join(runDir, file), 'utf8')
      expect(content, file).not.toContain(SECRET)
    }
    const log = await readFile(path.join(runDir, 'agent.log'), 'utf8')
    expect(log).toContain('the secret is [REDACTED:LEAK_SECRET]')
    expect(log).toContain('split across chunks maybe: [REDACTED:LEAK_SECRET] (no trailing newline)')
  })

  it('mounts the rendered prompt read-only at $AGENT_PROMPT_FILE (M2)', async () => {
    const promptAgent = await loadAgentFolder(path.join(import.meta.dirname, 'fixtures/prompt-agent'))
    const promptImage = await ensureAgentImage(promptAgent)

    const record = await runAgent({
      agent: promptAgent,
      imageRef: promptImage,
      signal: tickSignal({ n: 7 }),
      runsDir,
      renderedPrompt: 'Tick 7 via demo.tick',
      onEvent: () => {},
    })
    expect(record.status).toBe('succeeded')
    // The fixture read the file in-container (and proved input/ is read-only).
    expect(record.result).toEqual({ prompt: 'Tick 7 via demo.tick' })
    const hostCopy = await readFile(
      path.join(runsDir, record.runId, 'input', 'prompt.md'),
      'utf8',
    )
    expect(hostCopy).toBe('Tick 7 via demo.tick')
  })

  it('sets no $AGENT_PROMPT_FILE when no prompt was rendered (M2)', async () => {
    const promptAgent = await loadAgentFolder(path.join(import.meta.dirname, 'fixtures/prompt-agent'))
    const promptImage = await ensureAgentImage(promptAgent)

    const record = await runAgent({
      agent: promptAgent,
      imageRef: promptImage,
      signal: tickSignal({ n: 7 }),
      runsDir,
      onEvent: () => {},
    })
    // The fixture exits 7 exactly when the var is absent.
    expect(record.status).toBe('failed')
    expect(record.exitCode).toBe(7)
  })

  it('sweeps orphaned containers labeled with this runs root', async () => {
    await dockerOk(
      [
        'create',
        '--label', `railyard.runsRoot=${path.resolve(runsDir)}`,
        '--label', 'railyard.run=orphan-test',
        imageRef,
      ],
      'orphan fixture',
    )
    const removed = await sweepOrphanContainers(runsDir)
    expect(removed.length).toBeGreaterThanOrEqual(1)
    expect(await containersFor('orphan-test')).toEqual([])
  })
})
