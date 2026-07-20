import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkSubscriptionCompatibility,
  loadAgentFolder,
  Orchestrator,
  type AgentExecutor,
  type DeclaredEmission,
} from '@copperbox/railyard'
import { describe, expect, it } from 'vitest'
import { GitHubIssuesMonitor, githubIssueEmits } from '../src/index.js'
import { stubFetch } from './helpers/fetch-stub.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureAgentDir = path.join(here, 'fixtures/agents/labeled-review-agent')

const emissions: DeclaredEmission[] = githubIssueEmits.map((declaration) => ({
  monitor: 'github-issues',
  declaration,
}))

/** Never invoked (no agents / no matching runs) — keeps the test Docker-free. */
const stubExecutor: AgentExecutor = {
  ensureReady: async () => 'stub-image',
  execute: async () => {
    throw new Error('unexpected execute() in this test')
  },
  sweep: async () => [],
}

describe('schema-copy consumption story (deep-equality compat, for real)', () => {
  it('a verbatim copy of the published schema is boot-compatible', async () => {
    const agent = await loadAgentFolder(fixtureAgentDir)
    const report = checkSubscriptionCompatibility([agent], emissions)
    expect(report.errors).toEqual([])
    expect(report.unchecked).toEqual([])
  })

  it('a mutated copy is rejected with a message naming the subscription', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'railyard-mutated-'))
    for (const file of await readdir(fixtureAgentDir)) {
      await writeFile(path.join(dir, file), await readFile(path.join(fixtureAgentDir, file)))
    }
    const schemaPath = path.join(dir, 'issue-labeled.schema.json')
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
      properties: Record<string, unknown>
      required: string[]
    }
    schema.properties.tag = schema.properties.label!
    delete schema.properties.label
    schema.required = schema.required.map((r) => (r === 'label' ? 'tag' : r))
    await writeFile(schemaPath, JSON.stringify(schema, null, 2))

    const agent = await loadAgentFolder(dir)
    const report = checkSubscriptionCompatibility([agent], emissions)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toContain('github.issue.labeled')
    expect(report.errors[0]).toContain('github-issues')
  })
})

describe('against the real orchestrator (public API only, no Docker)', () => {
  it('boots, polls, journals monitor emissions, and stops cleanly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'railyard-gh-int-'))
    const agentsDir = path.join(root, 'agents')
    const runsDir = path.join(root, 'runs')
    const stateDir = path.join(root, 'state')
    await mkdir(agentsDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    // Seed the monitor's real on-disk state so the poll emits instead of baselining.
    await writeFile(
      path.join(stateDir, 'gh.json'),
      JSON.stringify({ 'cursor:o/r': 1 }),
    )

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
      return {
        body: [
          {
            id: 100,
            event: 'labeled',
            actor: { login: 'dan' },
            label: { name: 'needs-review', color: 'd73a4a' },
            created_at: '2026-07-19T12:00:00Z',
            issue: {
              number: 7,
              title: 'A bug',
              body: null,
              state: 'open',
              user: { login: 'reporter' },
              labels: ['needs-review'],
              assignees: [],
              html_url: 'https://github.com/o/r/issues/7',
              url: 'https://api.github.test/repos/o/r/issues/7',
              created_at: '2026-07-18T00:00:00Z',
              updated_at: '2026-07-19T00:00:00Z',
            },
          },
        ],
      }
    })

    const orchestrator = new Orchestrator({
      agentsDir,
      runsDir,
      stateDir,
      executor: stubExecutor,
      retention: { maxRunsPerAgent: 10 },
    })
    orchestrator.register(
      new GitHubIssuesMonitor({
        repos: ['o/r'],
        token: 'tok_test',
        apiBaseUrl: 'https://api.github.test',
        pollIntervalMs: 60_000,
        name: 'gh',
        fetchImpl,
      }),
    )
    await orchestrator.start()
    await orchestrator.stop()

    const journal = (await readFile(path.join(runsDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const received = journal.filter((e) => e.event === 'signal.received')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      signalType: 'github.issue.labeled',
      source: { kind: 'monitor', name: 'gh' },
      provenanceDepth: 0,
    })
    // The cursor advanced in the orchestrator's real JsonFileKvStore.
    const state = JSON.parse(await readFile(path.join(stateDir, 'gh.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(state['cursor:o/r']).toBe(100)
  })
})

describe('invariant 9: public exports only', () => {
  it('src imports nothing from core but the public package, type-only', async () => {
    const srcDir = path.join(here, '../src')
    for (const file of await readdir(srcDir)) {
      const content = await readFile(path.join(srcDir, file), 'utf8')
      for (const match of content.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)) {
        const [, typeOnly, specifier] = match
        expect(
          specifier!.startsWith('./') ||
            specifier!.startsWith('../schemas/') ||
            specifier === '@copperbox/railyard',
          `unexpected import "${specifier}" in ${file}`,
        ).toBe(true)
        if (specifier === '@copperbox/railyard') {
          expect(typeOnly, `${file}: core import must be type-only`).toBeTruthy()
        }
        expect(specifier).not.toMatch(/railyard\/(src|dist)/)
      }
    }
  })
})
