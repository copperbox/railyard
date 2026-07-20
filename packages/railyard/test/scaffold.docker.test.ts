import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Monitor } from '../src/monitor/monitor.js'
import type { JournaledEntry } from '../src/journal/journal.js'
import { Orchestrator } from '../src/orchestrator.js'

const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
const SCAFFOLD = path.join(import.meta.dirname, '../../../scaffolds/claude-code')

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * The REAL scaffold entrypoint in a REAL container, with a stub `claude` on
 * PATH — no network beyond the base image, no API key spent. Proves the helper
 * honors the container contract end-to-end through the orchestrator. Real
 * Claude Code runs live behind the LLM gate (llm.test.ts).
 *
 * Fixture folders are assembled at test time from the scaffold's own
 * entrypoint.mjs so this can never drift from what ships.
 */
const STUB_CLAUDE = `#!/bin/sh
prompt=$(cat)
printf '{"result":"stub saw: %s","session_id":"ses_stub","total_cost_usd":0.001,"num_turns":1,"duration_ms":1,"is_error":%s}\\n' "$prompt" "\${STUB_IS_ERROR:-false}"
`

// node:22-alpine (not the scaffold's bookworm-slim) keeps the gated pull small;
// the glibc requirement is Claude Code's, and the stub doesn't have that problem.
function stubDockerfile(isError: boolean): string {
  return `FROM node:22-alpine
COPY entrypoint.mjs /entrypoint.mjs
COPY claude /usr/local/bin/claude
# Build as root, run as non-root (brain: /docker/non-root-agents.md).
RUN chmod +x /usr/local/bin/claude && adduser -D -u 10001 agent
USER agent
ENV CLAUDE_MODEL=stub-model CLAUDE_MAX_TURNS=2${isError ? ' STUB_IS_ERROR=true' : ''}
ENTRYPOINT ["node", "/entrypoint.mjs"]
`
}

async function assembleAgent(agentsDir: string, name: string, isError: boolean): Promise<void> {
  const dir = path.join(agentsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.yaml'),
    `name: ${name}\nsecrets: [ANTHROPIC_API_KEY]\non:\n  - type: demo.tick\n`,
  )
  await writeFile(path.join(dir, 'prompt.md'), 'Tick {{payload.n}} via {{type}}')
  await writeFile(path.join(dir, 'Dockerfile'), stubDockerfile(isError))
  await writeFile(path.join(dir, 'claude'), STUB_CLAUDE)
  await chmod(path.join(dir, 'claude'), 0o755)
  await copyFile(path.join(SCAFFOLD, 'entrypoint.mjs'), path.join(dir, 'entrypoint.mjs'))
}

describe.skipIf(!DOCKER)('docker: claude-code scaffold entrypoint honors the contract', () => {
  it('rendered prompt → stub claude → verbatim result.json, both exit paths', { timeout: 300_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-scaffold-docker-'))
    const agentsDir = path.join(root, 'agents')
    const runsDir = path.join(root, 'runs')
    await assembleAgent(agentsDir, 'stub-ok', false)
    await assembleAgent(agentsDir, 'stub-err', true)

    const monitor: Monitor = {
      name: 'kickoff',
      emits: [
        {
          type: 'demo.tick',
          payloadSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
        },
      ],
      async start(ctx) {
        ctx.emit({ type: 'demo.tick', payload: { n: 7 } })
      },
      async stop() {},
    }

    const orchestrator = new Orchestrator({
      agentsDir,
      runsDir,
      stateDir: path.join(root, 'state'),
      logger: silentLogger,
      // The manifest declares the secret; resolve it to a dummy — the stub
      // never calls the API, but the helper's fail-fast check must pass.
      secrets: { resolve: async (name) => (name === 'ANTHROPIC_API_KEY' ? 'test-key-not-real' : undefined) },
    })
    orchestrator.register(monitor)
    const finished: JournaledEntry[] = []
    orchestrator.on('run.finished', (e) => {
      finished.push(e)
    })

    await orchestrator.start()
    await vi.waitFor(() => expect(finished).toHaveLength(2), { timeout: 240_000, interval: 250 })
    await orchestrator.stop()

    const byAgent = new Map(finished.map((e) => ['agent' in e ? e.agent : '', e]))
    // is_error: false → success; is_error: true → failure, purely via exit code.
    expect(byAgent.get('stub-ok')).toMatchObject({ status: 'succeeded', exitCode: 0 })
    expect(byAgent.get('stub-err')).toMatchObject({ status: 'failed', exitCode: 1 })

    const okRunId = (byAgent.get('stub-ok') as { runId: string }).runId
    const okDir = path.join(runsDir, okRunId)
    // The stub's JSON landed verbatim as the agent result, and the prompt made
    // the whole trip: template → input mount → helper → claude stdin → result.
    const record = JSON.parse(await readFile(path.join(okDir, 'result.json'), 'utf8'))
    expect(record.result).toEqual({
      result: 'stub saw: Tick 7 via demo.tick',
      session_id: 'ses_stub',
      total_cost_usd: 0.001,
      num_turns: 1,
      duration_ms: 1,
      is_error: false,
    })
    // The helper's log events reached the events file and were preserved.
    const events = (await readFile(path.join(okDir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; message: string })
    expect(events.map((e) => e.kind)).toEqual(['log', 'log'])
    expect(events[0]!.message).toContain('model=stub-model')
    expect(events[1]!.message).toContain('claude finished')
  })
})
