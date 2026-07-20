/**
 * The M3 exit proof (SPEC §15), Docker-gated: a stub-fetch GitHubIssuesMonitor
 * polls, the real orchestrator routes a needs-review labeled event through the
 * JSONPath filter to a real container built from the fixture agent — whose
 * payloadSchema is a verbatim copy of the published schema — and the run
 * round-trips the payload. This is M4's workflow minus the real GitHub API and
 * the real Claude agent; both swap in without touching the monitor.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dockerDaemonAvailable, Orchestrator } from '@copperbox/railyard'
import { beforeAll, describe, expect, it } from 'vitest'
import { GitHubIssuesMonitor } from '../src/index.js'
import { stubFetch } from './helpers/fetch-stub.js'

const DOCKER = process.env.RAILYARD_DOCKER_TESTS === '1'
const here = path.dirname(fileURLToPath(import.meta.url))

function issueEvent(id: number, label: string) {
  return {
    id,
    event: 'labeled',
    actor: { login: 'dan' },
    label: { name: label, color: 'd73a4a' },
    created_at: '2026-07-19T12:00:00Z',
    issue: {
      number: 7,
      title: 'A bug worth reviewing',
      body: 'Steps to reproduce…',
      state: 'open',
      user: { login: 'reporter' },
      labels: ['bug', label],
      assignees: [],
      html_url: 'https://github.com/o/r/issues/7',
      url: 'https://api.github.test/repos/o/r/issues/7',
      created_at: '2026-07-18T00:00:00Z',
      updated_at: '2026-07-19T00:00:00Z',
    },
  }
}

describe.skipIf(!DOCKER)('docker: M3 exit proof — monitor → filter → container', () => {
  beforeAll(async () => {
    if (!(await dockerDaemonAvailable())) {
      throw new Error(
        'RAILYARD_DOCKER_TESTS=1 is set but the Docker daemon is unreachable. Refusing to skip silently.',
      )
    }
  })

  it('a needs-review label triggers the agent; a decoy label does not', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-gh-e2e-'))
    const agentsDir = path.join(root, 'agents')
    const runsDir = path.join(root, 'runs')
    const stateDir = path.join(root, 'state')
    await mkdir(agentsDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await cp(
      path.join(here, 'fixtures/agents/labeled-review-agent'),
      path.join(agentsDir, 'labeled-review-agent'),
      { recursive: true },
    )
    // Seed past baseline so the single poll emits.
    await writeFile(path.join(stateDir, 'gh.json'), JSON.stringify({ 'cursor:o/r': 1 }))

    const { fetchImpl } = stubFetch((url) => {
      if (url.endsWith('/repos/o/r')) {
        return {
          body: {
            name: 'r',
            full_name: 'o/r',
            owner: { login: 'o' },
            html_url: 'https://github.com/o/r',
            private: false,
          },
        }
      }
      // One matching event and one decoy the filter must reject.
      return { body: [issueEvent(101, 'needs-review'), issueEvent(100, 'wontfix')] }
    })

    const orchestrator = new Orchestrator({
      agentsDir,
      runsDir,
      stateDir,
      retention: { maxRunsPerAgent: 10 },
    })
    orchestrator.register(
      new GitHubIssuesMonitor({
        repos: ['o/r'],
        token: 'tok_test',
        apiBaseUrl: 'https://api.github.test',
        pollIntervalMs: 3_600_000,
        name: 'gh',
        fetchImpl,
      }),
    )

    const finished = new Promise<Record<string, unknown>>((resolve) => {
      orchestrator.on('run.finished', (entry) => resolve(entry as unknown as Record<string, unknown>))
    })
    await orchestrator.start()
    const run = await finished
    await orchestrator.stop()

    expect(run).toMatchObject({ agent: 'labeled-review-agent', status: 'succeeded' })

    // The journal tells the whole story: two signals received, one run, no more.
    const journal = (await readFile(path.join(runsDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const received = journal.filter((e) => e.event === 'signal.received')
    expect(received).toHaveLength(2)
    expect(journal.filter((e) => e.event === 'run.started')).toHaveLength(1)

    // The agent's result is the payload it read back from $AGENT_INPUT_FILE —
    // the full signal envelope round-tripped into the container.
    const runId = run.runId as string
    const result = JSON.parse(
      await readFile(path.join(runsDir, runId, 'output', 'result.json'), 'utf8'),
    ) as { type: string; payload: { label: { name: string }; issue: { number: number }; eventId: number } }
    expect(result.type).toBe('github.issue.labeled')
    expect(result.payload.label.name).toBe('needs-review')
    expect(result.payload.issue.number).toBe(7)
    expect(result.payload.eventId).toBe(101)

    // Cursor advanced past both events in the real on-disk state.
    const state = JSON.parse(await readFile(path.join(stateDir, 'gh.json'), 'utf8')) as Record<string, unknown>
    expect(state['cursor:o/r']).toBe(101)
  }, 180_000)
})
