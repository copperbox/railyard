import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { dockerDaemonAvailable } from '../src/docker/build.js'
import type { Monitor } from '../src/monitor/monitor.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import { Orchestrator } from '../src/orchestrator.js'
import { EnvSecretsProvider } from '../src/secrets/provider.js'

/**
 * The M2 exit proof (SPEC §15): a real agent doing real (if small) LLM work
 * end-to-end. Gated separately from the Docker suite because it spends real
 * API money (well under $0.01/run): RAILYARD_LLM_TESTS=1, via `pnpm test:llm`.
 * Once opted in, missing prerequisites FAIL — a silent skip could let CI claim
 * coverage it didn't deliver (same posture as the Docker gate).
 */
const LLM = process.env.RAILYARD_LLM_TESTS === '1'
const SCAFFOLD = path.join(import.meta.dirname, '../../../scaffolds/claude-code')

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

describe.skipIf(!LLM)('llm: claude-code scaffold does real LLM work (SPEC §15 M2)', () => {
  let apiKey: string

  beforeAll(async () => {
    expect(await dockerDaemonAvailable(), 'docker daemon must be reachable for llm tests').toBe(true)
    const resolved = await new EnvSecretsProvider().resolve('ANTHROPIC_API_KEY')
    expect(resolved, 'ANTHROPIC_API_KEY must be set (env or .env) for llm tests').toBeDefined()
    apiKey = resolved!
  })

  it('signal → rendered prompt → real Claude Code run → derived answer in result.json', { timeout: 900_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-llm-'))
    const agentsDir = path.join(root, 'agents')
    const runsDir = path.join(root, 'runs')
    const agentDir = path.join(agentsDir, 'llm-proof')
    await mkdir(agentDir, { recursive: true })

    // The real scaffold image, with test-grade knobs appended (cheap pinned
    // model, tight turn and budget caps). ENV position in a Dockerfile is
    // irrelevant, so appending overrides the scaffold defaults.
    const dockerfile = await readFile(path.join(SCAFFOLD, 'Dockerfile'), 'utf8')
    await writeFile(
      path.join(agentDir, 'Dockerfile'),
      dockerfile +
        '\nENV CLAUDE_MODEL=claude-haiku-4-5 CLAUDE_MAX_TURNS=4 CLAUDE_EXTRA_ARGS="--max-budget-usd 0.25"\n',
    )
    await copyFile(path.join(SCAFFOLD, 'entrypoint.mjs'), path.join(agentDir, 'entrypoint.mjs'))
    await writeFile(
      path.join(agentDir, 'manifest.yaml'),
      'name: llm-proof\nsecrets: [ANTHROPIC_API_KEY]\non:\n  - type: demo.word\n',
    )
    // Answering requires actually reading the interpolated payload — this is
    // the "real (if small) LLM work", asserted semantically below.
    await writeFile(
      path.join(agentDir, 'prompt.md'),
      'The payload of this {{type}} signal contains the word "{{payload.word}}".\n' +
        'Reply with exactly RAILYARD-SAYS: followed by that word in uppercase.\n' +
        'No other text, no punctuation, no tools.\n',
    )

    const monitor: Monitor = {
      name: 'kickoff',
      emits: [
        {
          type: 'demo.word',
          payloadSchema: { type: 'object', required: ['word'], properties: { word: { type: 'string' } } },
        },
      ],
      async start(ctx) {
        ctx.emit({ type: 'demo.word', payload: { word: 'peregrine' } })
      },
      async stop() {},
    }

    const orchestrator = new Orchestrator({
      agentsDir,
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
    await vi.waitFor(() => expect(finished).toHaveLength(1), { timeout: 600_000, interval: 500 })
    await orchestrator.stop()

    expect(finished[0]).toMatchObject({ agent: 'llm-proof', status: 'succeeded', exitCode: 0 })

    const runId = (finished[0] as { runId: string }).runId
    const record = JSON.parse(await readFile(path.join(runsDir, runId, 'result.json'), 'utf8')) as {
      result: { result: string; is_error: boolean; total_cost_usd: number; num_turns: number }
    }
    // Claude's own result object, verbatim: the model read the interpolated
    // word and derived the answer; money moved, so a real API round trip happened.
    expect(record.result.is_error).toBe(false)
    expect(record.result.result).toContain('RAILYARD-SAYS: PEREGRINE')
    expect(record.result.total_cost_usd).toBeGreaterThan(0)

    // Redaction holds on the real provider path: the key appears nowhere under runs/.
    const files = await readdir(runsDir, { recursive: true, withFileTypes: true })
    for (const entry of files) {
      if (!entry.isFile()) continue
      const p = path.join(entry.parentPath, entry.name)
      expect(await readFile(p, 'utf8'), p).not.toContain(apiKey)
    }
  })
})
