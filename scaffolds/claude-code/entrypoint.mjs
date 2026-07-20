// Adapts Claude Code headless mode to the railyard container contract (SPEC §5):
// rendered prompt in from $AGENT_PROMPT_FILE, Claude's --output-format json
// result out verbatim as $AGENT_OUTPUT_DIR/result.json, progress as `log` lines
// on $AGENT_EVENTS_FILE, success/failure as the process exit code. The provider
// shape stays inside the container — the framework never learns it (SPEC §14).
//
// Zero dependencies; Node is in the image for Claude Code anyway.

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const eventsFile = process.env.AGENT_EVENTS_FILE

function logEvent(level, message) {
  if (!eventsFile) return
  appendFileSync(eventsFile, JSON.stringify({ kind: 'log', level, message }) + '\n')
}

function fail(message) {
  logEvent('error', message)
  console.error(message)
  process.exit(1)
}

const outputDir = process.env.AGENT_OUTPUT_DIR
if (!outputDir) fail('AGENT_OUTPUT_DIR is not set — not running under the railyard container contract?')
if (!process.env.ANTHROPIC_API_KEY) {
  fail('ANTHROPIC_API_KEY is not set — declare it under `secrets:` in manifest.yaml')
}
const promptFile = process.env.AGENT_PROMPT_FILE
if (!promptFile) {
  fail('AGENT_PROMPT_FILE is not set — this scaffold requires a prompt.md in the agent folder')
}
let prompt
try {
  prompt = readFileSync(promptFile, 'utf8')
} catch (err) {
  fail(`rendered prompt unreadable at ${promptFile}: ${err.message}`)
}
if (prompt.trim() === '') fail('rendered prompt is empty')

const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5'
const maxTurns = process.env.CLAUDE_MAX_TURNS || '16'
const extraArgs = (process.env.CLAUDE_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
// The container is the sandbox (its only powers are its mounts and declared
// secrets) — an interactive permission prompt in headless mode is a hang, not
// a safeguard. Requires the non-root user this image sets up.
const args = [
  '-p',
  '--output-format', 'json',
  '--dangerously-skip-permissions',
  '--model', model,
  '--max-turns', maxTurns,
  ...extraArgs,
]

logEvent('info', `claude starting: model=${model} maxTurns=${maxTurns}`)

// Prompt via stdin — no argv size limits. stderr passes through to the
// container's stderr, which the framework captures (redacted) into agent.log.
const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', (err) => fail(`could not start claude: ${err.message}`))
child.stdin.write(prompt)
child.stdin.end()

let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
const exitCode = await new Promise((resolve) => child.on('close', resolve))

let result = null
try {
  result = JSON.parse(stdout)
} catch {
  // handled below
}
const resultPath = path.join(outputDir, 'result.json')
if (result === null || typeof result !== 'object') {
  writeFileSync(
    resultPath,
    JSON.stringify(
      { error: 'claude produced no parsable JSON result', exitCode, stdoutTail: stdout.slice(-2000) },
      null,
      2,
    ),
  )
  fail(`claude produced no parsable JSON result (exit ${exitCode})`)
}

// Claude's result object, written verbatim — no invented cross-provider schema.
writeFileSync(resultPath, JSON.stringify(result, null, 2))
logEvent(
  'info',
  `claude finished: exit=${exitCode} is_error=${result.is_error} turns=${result.num_turns} cost_usd=${result.total_cost_usd}`,
)
process.exit(exitCode === 0 && result.is_error === false ? 0 : 1)
