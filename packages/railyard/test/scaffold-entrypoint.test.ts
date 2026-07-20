import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The scaffold's entrypoint helper, tested on the host against a stub `claude`
 * on PATH — no Docker, no API key, no network. Proves the contract adaptation
 * (result.json verbatim, log events, exit codes) separately from real LLM runs.
 * Needs a POSIX shell for the stub; so does the rest of local dev.
 */
const ENTRYPOINT = path.join(import.meta.dirname, '../../../scaffolds/claude-code/entrypoint.mjs')

const HAPPY_RESULT = {
  result: 'stub says hi',
  session_id: 'ses_stub',
  total_cost_usd: 0.001,
  num_turns: 1,
  duration_ms: 5,
  is_error: false,
}

interface StubSpec {
  /** stdout the stub prints; objects are JSON-stringified. */
  stdout?: unknown
  exitCode?: number
}

interface RunResult {
  exitCode: number
  result: unknown
  events: Array<Record<string, unknown>>
  /** What the stub saw. */
  stubArgs: string[]
  stubStdin: string
}

async function runEntrypoint(
  stub: StubSpec,
  envOverrides: Record<string, string | undefined> = {},
  { prompt = 'do the thing' as string | null } = {},
): Promise<RunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'railyard-scaffold-'))
  const binDir = path.join(dir, 'bin')
  const outputDir = path.join(dir, 'output')
  await mkdir(binDir)
  await mkdir(outputDir)
  const eventsFile = path.join(dir, 'events.jsonl')
  await writeFile(eventsFile, '')
  const promptFile = path.join(dir, 'prompt.md')
  if (prompt !== null) await writeFile(promptFile, prompt)

  const stdout = typeof stub.stdout === 'string' ? stub.stdout : JSON.stringify(stub.stdout ?? HAPPY_RESULT)
  const stubPath = path.join(binDir, 'claude')
  await writeFile(
    stubPath,
    `#!/bin/sh
cat > "${dir}/stub-stdin.txt"
printf '%s\\n' "$@" > "${dir}/stub-args.txt"
cat "${dir}/stub-stdout.txt"
exit ${stub.exitCode ?? 0}
`,
  )
  await writeFile(path.join(dir, 'stub-stdout.txt'), stdout)
  await chmod(stubPath, 0o755)

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH}`,
    AGENT_OUTPUT_DIR: outputDir,
    AGENT_EVENTS_FILE: eventsFile,
    AGENT_PROMPT_FILE: promptFile,
    ANTHROPIC_API_KEY: 'test-key-not-real',
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }

  const child = spawn(process.execPath, [ENTRYPOINT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))

  const read = async (p: string) => await readFile(p, 'utf8').catch(() => '')
  let result: unknown = null
  const rawResult = await read(path.join(outputDir, 'result.json'))
  if (rawResult !== '') result = JSON.parse(rawResult)
  const events = (await read(eventsFile))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return {
    exitCode,
    result,
    events,
    stubArgs: (await read(path.join(dir, 'stub-args.txt'))).split('\n').filter(Boolean),
    stubStdin: await read(path.join(dir, 'stub-stdin.txt')),
  }
}

describe('claude-code scaffold entrypoint (stubbed claude)', () => {
  it('happy path: result verbatim, prompt on stdin, log events, exit 0', async () => {
    const run = await runEntrypoint({ stdout: HAPPY_RESULT })
    expect(run.exitCode).toBe(0)
    expect(run.result).toEqual(HAPPY_RESULT)
    expect(run.stubStdin).toBe('do the thing')
    expect(run.events.map((e) => e.kind)).toEqual(['log', 'log'])
    expect(String(run.events[0]!.message)).toContain('claude starting')
    expect(String(run.events[1]!.message)).toContain('cost_usd=0.001')
  })

  it('passes model, max turns, skip-permissions and extra args to the CLI', async () => {
    const run = await runEntrypoint(
      {},
      { CLAUDE_MODEL: 'claude-haiku-4-5', CLAUDE_MAX_TURNS: '3', CLAUDE_EXTRA_ARGS: '--max-budget-usd 0.50' },
    )
    expect(run.stubArgs).toEqual([
      '-p',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'claude-haiku-4-5',
      '--max-turns', '3',
      '--max-budget-usd', '0.50',
    ])
  })

  it('is_error: true still writes the result but exits 1', async () => {
    const run = await runEntrypoint({ stdout: { ...HAPPY_RESULT, is_error: true } })
    expect(run.exitCode).toBe(1)
    expect(run.result).toMatchObject({ is_error: true })
  })

  it('CLI non-zero exit means failure even with parsable output', async () => {
    const run = await runEntrypoint({ stdout: HAPPY_RESULT, exitCode: 3 })
    expect(run.exitCode).toBe(1)
    expect(run.result).toEqual(HAPPY_RESULT)
  })

  it('unparsable stdout: error result.json with the tail, exit 1', async () => {
    const run = await runEntrypoint({ stdout: 'segfault or something' })
    expect(run.exitCode).toBe(1)
    expect(run.result).toMatchObject({
      error: 'claude produced no parsable JSON result',
      stdoutTail: 'segfault or something',
    })
    expect(run.events.some((e) => e.level === 'error')).toBe(true)
  })

  it.each([
    ['CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['ANTHROPIC_AUTH_TOKEN (gateway bearer)', 'ANTHROPIC_AUTH_TOKEN'],
  ])('accepts %s in place of an API key', async (_name, varName) => {
    const run = await runEntrypoint(
      {},
      { ANTHROPIC_API_KEY: undefined, [varName]: 'test-token-not-real' },
    )
    expect(run.exitCode).toBe(0)
    expect(run.result).toEqual(HAPPY_RESULT)
  })

  it.each([
    ['no auth env at all', { ANTHROPIC_API_KEY: undefined }, /no Claude auth found/],
    ['missing AGENT_PROMPT_FILE', { AGENT_PROMPT_FILE: undefined }, /AGENT_PROMPT_FILE/],
  ])('fails fast before spawning claude on %s', async (_name, overrides, pattern) => {
    const run = await runEntrypoint({}, overrides)
    expect(run.exitCode).toBe(1)
    expect(run.stubStdin).toBe('') // stub never ran
    expect(run.events.some((e) => e.level === 'error' && pattern.test(String(e.message)))).toBe(true)
  })

  it('fails fast on an unreadable or empty prompt', async () => {
    const missing = await runEntrypoint({}, {}, { prompt: null })
    expect(missing.exitCode).toBe(1)
    expect(missing.stubStdin).toBe('')

    const empty = await runEntrypoint({}, {}, { prompt: '  \n' })
    expect(empty.exitCode).toBe(1)
    expect(empty.events.some((e) => /empty/.test(String(e.message)))).toBe(true)
  })
})
