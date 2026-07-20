import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSubscriptionCompatibility } from '../src/agents/compat.js'
import { evaluateFilter, parseFilter } from '../src/agents/filter.js'
import { loadAgents } from '../src/agents/loader.js'

async function makeAgentsDir(
  agents: Record<string, { manifest: string; files?: Record<string, string> }>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'railyard-agents-'))
  for (const [name, spec] of Object.entries(agents)) {
    const agentDir = path.join(dir, name)
    await mkdir(agentDir, { recursive: true })
    await writeFile(path.join(agentDir, 'manifest.yaml'), spec.manifest)
    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      const filePath = path.join(agentDir, rel)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
    }
  }
  return dir
}

const TICK_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'number' } },
})

const MINIMAL = {
  manifest: 'name: echo\non:\n  - type: demo.tick\n',
  files: { Dockerfile: 'FROM alpine\n' },
}

describe('filter grammar', () => {
  it('parses the SPEC §3 example', () => {
    const f = parseFilter('$.label == "needs-review"', 'test')
    expect(f).toMatchObject({ path: '$.label', op: '==', literal: 'needs-review' })
  })

  it('evaluates == against the payload', () => {
    const f = parseFilter('$.label == "needs-review"', 'test')
    expect(evaluateFilter(f, { label: 'needs-review' })).toBe(true)
    expect(evaluateFilter(f, { label: 'wontfix' })).toBe(false)
    expect(evaluateFilter(f, {})).toBe(false)
  })

  it('evaluates != as the exact negation, including missing paths', () => {
    const f = parseFilter('$.label != "wontfix"', 'test')
    expect(evaluateFilter(f, { label: 'needs-review' })).toBe(true)
    expect(evaluateFilter(f, { label: 'wontfix' })).toBe(false)
    expect(evaluateFilter(f, {})).toBe(true)
  })

  it('compares non-string JSON literals structurally', () => {
    expect(evaluateFilter(parseFilter('$.n == 3', 'test'), { n: 3 })).toBe(true)
    expect(evaluateFilter(parseFilter('$.ok == true', 'test'), { ok: true })).toBe(true)
    expect(evaluateFilter(parseFilter('$.tags == ["a","b"]', 'test'), { tags: ['a', 'b'] })).toBe(
      true,
    )
  })

  it('resolves nested paths', () => {
    const f = parseFilter('$.issue.labels[*].name == "bug"', 'test')
    expect(evaluateFilter(f, { issue: { labels: [{ name: 'chore' }, { name: 'bug' }] } })).toBe(true)
    expect(evaluateFilter(f, { issue: { labels: [] } })).toBe(false)
  })

  it.each([
    ['no operator', '$.label'],
    ['unsupported operator', '$.n > 3'],
    ['path not starting with $', 'label == "x"'],
    ['unquoted string literal', '$.label == needs-review'],
  ])('rejects %s at parse time', (_name, source) => {
    expect(() => parseFilter(source, 'ctx')).toThrow(/ctx/)
  })
})

describe('agent folder loading', () => {
  it('loads a minimal Dockerfile agent with defaults applied', async () => {
    const dir = await makeAgentsDir({ echo: MINIMAL })
    const { agents, skipped } = await loadAgents(dir)
    expect(skipped).toEqual([])
    expect(agents).toHaveLength(1)
    const agent = agents[0]!
    expect(agent.name).toBe('echo')
    expect(agent.imageSource).toEqual({ kind: 'dockerfile' })
    expect(agent.manifest.concurrency).toBe(1)
    expect(agent.manifest.timeout).toBe(900)
    expect(agent.subscriptions[0]).toMatchObject({ type: 'demo.tick', filter: null })
  })

  it('loads filter and payload schema from the folder', async () => {
    const dir = await makeAgentsDir({
      echo: {
        manifest:
          'name: echo\non:\n  - type: demo.tick\n    filter: \'$.n == 1\'\n    payloadSchema: ./schemas/tick.json\n',
        files: { Dockerfile: 'FROM alpine\n', 'schemas/tick.json': TICK_SCHEMA },
      },
    })
    const { agents } = await loadAgents(dir)
    const sub = agents[0]!.subscriptions[0]!
    expect(sub.filter?.op).toBe('==')
    expect(sub.validatePayload?.({ n: 1 })).toBe(true)
    expect(sub.validatePayload?.({})).toBe(false)
  })

  it('accepts image: instead of a Dockerfile', async () => {
    const dir = await makeAgentsDir({
      echo: { manifest: 'name: echo\non:\n  - type: demo.tick\nimage: ghcr.io/x/y:1\n' },
    })
    const { agents } = await loadAgents(dir)
    expect(agents[0]!.imageSource).toEqual({ kind: 'image', ref: 'ghcr.io/x/y:1' })
  })

  it('skips (but reports) directories without manifest.yaml', async () => {
    const dir = await makeAgentsDir({ echo: MINIMAL })
    await mkdir(path.join(dir, 'shared-stuff'))
    const { agents, skipped } = await loadAgents(dir)
    expect(agents).toHaveLength(1)
    expect(skipped).toEqual([path.join(dir, 'shared-stuff')])
  })

  it.each([
    [
      'both Dockerfile and image',
      {
        manifest: 'name: echo\non:\n  - type: t\nimage: ghcr.io/x/y:1\n',
        files: { Dockerfile: 'FROM alpine\n' },
      },
      /pick one/,
    ],
    ['neither Dockerfile nor image', { manifest: 'name: echo\non:\n  - type: t\n' }, /either a Dockerfile or 'image:'/],
    ['malformed YAML', { manifest: 'name: [\n', files: { Dockerfile: 'FROM alpine\n' } }, /not valid YAML/],
    [
      'manifest violating the schema',
      { manifest: 'name: Echo\non:\n  - type: t\n', files: { Dockerfile: 'FROM alpine\n' } },
      /invalid manifest/,
    ],
    [
      'bad filter syntax',
      {
        manifest: "name: echo\non:\n  - type: t\n    filter: '$.n > 3'\n",
        files: { Dockerfile: 'FROM alpine\n' },
      },
      /filter/,
    ],
    [
      'missing payloadSchema file',
      {
        manifest: 'name: echo\non:\n  - type: t\n    payloadSchema: ./nope.json\n',
        files: { Dockerfile: 'FROM alpine\n' },
      },
      /not readable/,
    ],
    [
      'payloadSchema escaping the folder',
      {
        manifest: 'name: echo\non:\n  - type: t\n    payloadSchema: ../outside.json\n',
        files: { Dockerfile: 'FROM alpine\n' },
      },
      /inside the agent folder/,
    ],
    [
      'payloadSchema that is not a valid schema',
      {
        manifest: 'name: echo\non:\n  - type: t\n    payloadSchema: ./s.json\n',
        files: { Dockerfile: 'FROM alpine\n', 's.json': '{"type": "not-a-type"}' },
      },
      /invalid JSON Schema/,
    ],
    [
      'a secret name colliding with a reserved container env var',
      {
        manifest: 'name: echo\nsecrets: [AGENT_INPUT_FILE]\non:\n  - type: t\n',
        files: { Dockerfile: 'FROM alpine\n' },
      },
      /reserved container-contract env var/,
    ],
  ])('fails loudly on %s', async (_name, spec, message) => {
    const dir = await makeAgentsDir({ echo: spec })
    await expect(loadAgents(dir)).rejects.toThrow(message)
  })

  it('loads and parses prompt.md when present', async () => {
    const dir = await makeAgentsDir({
      echo: {
        manifest: MINIMAL.manifest,
        files: { Dockerfile: 'FROM alpine\n', 'prompt.md': 'Tick {{payload.n}} from {{source.name}}\n' },
      },
    })
    const { agents } = await loadAgents(dir)
    expect(agents[0]!.promptTemplate).not.toBeNull()
    expect(agents[0]!.promptTemplate!.segments).toContainEqual({
      kind: 'placeholder',
      path: ['payload', 'n'],
      raw: '{{payload.n}}',
    })
  })

  it('leaves promptTemplate null when the folder has no prompt.md', async () => {
    const dir = await makeAgentsDir({ echo: MINIMAL })
    const { agents } = await loadAgents(dir)
    expect(agents[0]!.promptTemplate).toBeNull()
  })

  it('accepts image: plus prompt.md (no Dockerfile)', async () => {
    const dir = await makeAgentsDir({
      echo: {
        manifest: 'name: echo\non:\n  - type: demo.tick\nimage: ghcr.io/x/y:1\n',
        files: { 'prompt.md': 'Payload: {{payload}}\n' },
      },
    })
    const { agents } = await loadAgents(dir)
    expect(agents[0]!.imageSource).toEqual({ kind: 'image', ref: 'ghcr.io/x/y:1' })
    expect(agents[0]!.promptTemplate).not.toBeNull()
  })

  it('fails boot on a malformed prompt.md, naming the file', async () => {
    const dir = await makeAgentsDir({
      echo: {
        manifest: MINIMAL.manifest,
        files: { Dockerfile: 'FROM alpine\n', 'prompt.md': 'oops {{payload.n\n' },
      },
    })
    await expect(loadAgents(dir)).rejects.toThrow(/prompt\.md: malformed placeholder/)
  })

  it('rejects a secret named AGENT_PROMPT_FILE (now reserved)', async () => {
    const dir = await makeAgentsDir({
      echo: {
        manifest: 'name: echo\nsecrets: [AGENT_PROMPT_FILE]\non:\n  - type: t\n',
        files: { Dockerfile: 'FROM alpine\n' },
      },
    })
    await expect(loadAgents(dir)).rejects.toThrow(/reserved container-contract env var/)
  })

  it('fails on duplicate agent names across folders', async () => {
    const dir = await makeAgentsDir({
      'echo-a': { manifest: 'name: echo\non:\n  - type: t\n', files: { Dockerfile: 'FROM alpine\n' } },
      'echo-b': { manifest: 'name: echo\non:\n  - type: t\n', files: { Dockerfile: 'FROM alpine\n' } },
    })
    await expect(loadAgents(dir)).rejects.toThrow(/duplicate agent name "echo"/)
  })

  it('fails on a missing agents directory', async () => {
    await expect(loadAgents('/definitely/not/here')).rejects.toThrow(/not readable/)
  })
})

describe('subscription compatibility (SPEC §3)', () => {
  async function loadWithSchema(schema: string) {
    const dir = await makeAgentsDir({
      echo: {
        manifest: 'name: echo\non:\n  - type: demo.tick\n    payloadSchema: ./tick.json\n',
        files: { Dockerfile: 'FROM alpine\n', 'tick.json': schema },
      },
    })
    return (await loadAgents(dir)).agents
  }

  it('passes when emitter and required schemas are structurally identical', async () => {
    const agents = await loadWithSchema(TICK_SCHEMA)
    const report = checkSubscriptionCompatibility(agents, [
      { monitor: 'demo', declaration: { type: 'demo.tick', payloadSchema: JSON.parse(TICK_SCHEMA) } },
    ])
    expect(report.errors).toEqual([])
    expect(report.unchecked).toEqual([])
  })

  it('errors when schemas differ, naming agent, type, and monitor', async () => {
    const agents = await loadWithSchema(TICK_SCHEMA)
    const report = checkSubscriptionCompatibility(agents, [
      {
        monitor: 'demo',
        declaration: { type: 'demo.tick', payloadSchema: { type: 'object' } },
      },
    ])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatch(/agent "echo".*"demo\.tick".*monitor "demo"/s)
  })

  it('reports (not fails) a required schema for a type no monitor declares', async () => {
    const agents = await loadWithSchema(TICK_SCHEMA)
    const report = checkSubscriptionCompatibility(agents, [])
    expect(report.errors).toEqual([])
    expect(report.unchecked).toHaveLength(1)
  })

  it('ignores subscriptions without a required schema', async () => {
    const dir = await makeAgentsDir({ echo: MINIMAL })
    const { agents } = await loadAgents(dir)
    const report = checkSubscriptionCompatibility(agents, [])
    expect(report.errors).toEqual([])
    expect(report.unchecked).toEqual([])
  })
})
