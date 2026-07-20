import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LoadedAgent } from '../agents/loader.js'
import { newRunId } from '../contracts/id.js'
import type { EventsLine, SignalEnvelope } from '../contracts/types.js'
import { docker, dockerOk } from '../docker/cli.js'
import { LineSplitter, type Redactor } from '../secrets/redactor.js'
import { EventsTailer } from './events-tailer.js'

/** Paths inside the container; exposed to the agent via env vars (SPEC §5). */
export const CONTAINER_PATHS = {
  inputDir: '/railyard/input',
  inputFile: '/railyard/input/signal.json',
  promptFile: '/railyard/input/prompt.md',
  outputDir: '/railyard/output',
  eventsFile: '/railyard/events.jsonl',
} as const

/** The framework-written result.json in the run directory (SPEC §12). */
export interface RunRecord {
  runId: string
  agent: string
  signalId: string
  imageRef: string
  startedAt: string
  finishedAt: string
  durationMs: number
  /** Container exit code; null when the container could not be started at all. */
  exitCode: number | null
  status: 'succeeded' | 'failed'
  /** Parsed contents of the agent's $AGENT_OUTPUT_DIR/result.json, if any. */
  result: unknown
  /** Why result is null despite success, e.g. unparsable result.json. */
  resultError: string | null
  /** Why the framework killed the run (e.g. "timeout: exceeded 900s"); null otherwise. */
  killReason: string | null
}

export interface RunAgentParams {
  agent: LoadedAgent
  imageRef: string
  signal: SignalEnvelope
  runsDir: string
  /** Caller-assigned id (see makeRunId) so run.started can be journaled before the container exists. */
  runId?: string
  /**
   * Hard-kill deadline in seconds, counted from container start (SPEC §6).
   * `null` = the user explicitly opted into an indefinite run. Omitted = the
   * manifest-schema default (900) — the safeguard is never silently absent.
   */
  timeoutSeconds?: number | null
  /**
   * Extra env vars for the container — the agent's resolved secrets (SPEC §8).
   * Injected via value-less `-e NAME` flags + the docker CLI's process env, so
   * values never appear on a command line.
   */
  env?: Record<string, string>
  /**
   * Redaction guarantee (SPEC §8): applied to agent.log lines as they are
   * captured, to invocation.json / result.json at serialization, and as a
   * post-run rewrite of the preserved events.jsonl and the agent's own
   * output/result.json. Other agent-written output files are NOT rewritten.
   */
  redactor?: Redactor
  /**
   * The agent's prompt.md rendered against this signal (SPEC §4). Written to
   * input/prompt.md and exposed as $AGENT_PROMPT_FILE; omitted for promptless
   * agents — no file, no var.
   */
  renderedPrompt?: string
  /** Valid events-file lines, dispatched while the container is still running. */
  onEvent: (line: EventsLine) => void
  onMalformedEvent?: (raw: string, reason: string) => void
}

/**
 * One matched signal → one container → run → exit → removal (SPEC §6).
 * Teardown is guaranteed: `docker rm -f` runs on every path out of here, and a
 * boot-time sweep (sweepOrphanContainers) catches containers a crashed process
 * left behind.
 */
export function makeRunId(agentName: string): string {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  return `${stamp}--${agentName}--${newRunId()}`
}

export async function runAgent(params: RunAgentParams): Promise<RunRecord> {
  const { agent, imageRef, signal, runsDir } = params
  const runId = params.runId ?? makeRunId(agent.name)
  const runDir = path.join(runsDir, runId)
  const inputDir = path.join(runDir, 'input')
  const outputDir = path.join(runDir, 'output')
  const eventsFile = path.join(runDir, 'events.jsonl')
  const containerName = `railyard--${runId}`

  await mkdir(inputDir, { recursive: true })
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(inputDir, 'signal.json'), JSON.stringify(signal, null, 2))
  await writeFile(eventsFile, '')
  // Non-root container users must still be able to write their side of the contract.
  await chmod(outputDir, 0o777)
  await chmod(eventsFile, 0o666)
  const redactor = params.redactor
  const redactJson = <T,>(value: T): T => (redactor ? redactor.redactJson(value) : value)
  if (params.renderedPrompt !== undefined) {
    // Belt-and-braces redaction: payloads are already redacted at emission.
    await writeFile(
      path.join(inputDir, 'prompt.md'),
      redactor ? redactor.redactString(params.renderedPrompt) : params.renderedPrompt,
    )
  }
  await writeFile(
    path.join(runDir, 'invocation.json'),
    JSON.stringify(
      redactJson({ runId, agent: agent.name, agentDir: agent.dir, imageRef, signal }),
      null,
      2,
    ),
  )

  const createArgs = [
    'create',
    '--name', containerName,
    '--label', `railyard.runsRoot=${path.resolve(runsDir)}`,
    '--label', `railyard.run=${runId}`,
    '-v', `${inputDir}:${CONTAINER_PATHS.inputDir}:ro`,
    '-v', `${outputDir}:${CONTAINER_PATHS.outputDir}`,
    '-v', `${eventsFile}:${CONTAINER_PATHS.eventsFile}`,
    '-e', `AGENT_INPUT_DIR=${CONTAINER_PATHS.inputDir}`,
    '-e', `AGENT_INPUT_FILE=${CONTAINER_PATHS.inputFile}`,
    '-e', `AGENT_OUTPUT_DIR=${CONTAINER_PATHS.outputDir}`,
    '-e', `AGENT_EVENTS_FILE=${CONTAINER_PATHS.eventsFile}`,
  ]
  if (params.renderedPrompt !== undefined) {
    createArgs.push('-e', `AGENT_PROMPT_FILE=${CONTAINER_PATHS.promptFile}`)
  }
  if (agent.manifest.network === 'none') createArgs.push('--network', 'none')
  for (const name of Object.keys(params.env ?? {})) createArgs.push('-e', name)
  createArgs.push(imageRef)

  const tailer = new EventsTailer(eventsFile, {
    onLine: params.onEvent,
    onMalformed: params.onMalformedEvent ?? (() => {}),
  })
  const logStream = createWriteStream(path.join(runDir, 'agent.log'))
  // Line-buffered so redaction always sees whole lines — a secret split across
  // stream chunks must not slip through (SPEC §8).
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() }
  const writeLogChunk = (which: 'stdout' | 'stderr', chunk: string): void => {
    for (const line of splitters[which].push(chunk)) {
      logStream.write((redactor ? redactor.redactString(line) : line) + '\n')
    }
  }
  const timeoutSeconds = params.timeoutSeconds === undefined ? 900 : params.timeoutSeconds
  const startedAt = new Date()
  let exitCode: number | null = null
  let killReason: string | null = null
  let killTimer: NodeJS.Timeout | undefined
  let killDone: Promise<void> | undefined

  try {
    await dockerOk(createArgs, `run ${runId}`, params.env ? { env: params.env } : undefined)
    await tailer.start()
    await dockerOk(['start', containerName], `run ${runId}`)

    // Hard timeout (SPEC §6): SIGKILL the container so the wait/logs path below
    // completes normally and teardown stays on the one guaranteed route.
    if (timeoutSeconds !== null) {
      killTimer = setTimeout(() => {
        killDone = docker(['kill', containerName]).then((res) => {
          // A failed kill means the container had already exited — not a timeout.
          if (res.code === 0) killReason = `timeout: exceeded ${timeoutSeconds}s`
        })
      }, timeoutSeconds * 1000)
    }

    // `docker logs --follow` replays from the beginning, so nothing between
    // start and attach is lost; it ends when the container exits.
    const logsDone = docker(['logs', '--follow', containerName], {
      onStdoutChunk: (chunk) => writeLogChunk('stdout', chunk),
      onStderrChunk: (chunk) => writeLogChunk('stderr', chunk),
    })
    const waited = await dockerOk(['wait', containerName], `run ${runId}`)
    exitCode = Number.parseInt(waited.stdout.trim(), 10)
    if (Number.isNaN(exitCode)) exitCode = -1
    await logsDone
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    // If the timer already fired, learn whether it actually killed before we record.
    await killDone?.catch(() => {})
    await tailer.stop().catch(() => {})
    for (const splitter of [splitters.stdout, splitters.stderr]) {
      const rest = splitter.flush()
      if (rest !== null) logStream.write((redactor ? redactor.redactString(rest) : rest) + '\n')
    }
    logStream.end()
    // Guaranteed teardown (SPEC §6): remove the container on every path.
    await docker(['rm', '-f', containerName])
  }

  const finishedAt = new Date()
  let result: unknown = null
  let resultError: string | null = null
  try {
    result = JSON.parse(await readFile(path.join(outputDir, 'result.json'), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      resultError = 'agent wrote no result.json'
    } else {
      resultError = `result.json unreadable: ${(err as Error).message}`
    }
  }

  if (redactor) {
    // The agent wrote these two directly; scrub them now that the run is over.
    // Arbitrary other output files are the agent's own business (documented).
    await rewriteRedacted(eventsFile, redactor)
    await rewriteRedacted(path.join(outputDir, 'result.json'), redactor)
  }

  const record: RunRecord = {
    runId,
    agent: agent.name,
    signalId: signal.id,
    imageRef,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    result: redactJson(result),
    resultError,
    killReason,
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2))
  return record
}

/**
 * Rewrite a text file through the redactor; a missing file is fine. Replaces
 * via write-temp-then-rename: container-written files are often root-owned and
 * not writable in place, but the run dir itself is ours.
 */
async function rewriteRedacted(filePath: string, redactor: Redactor): Promise<void> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return
  }
  const redacted = redactor.redactString(raw)
  if (redacted === raw) return
  const tmp = `${filePath}.redacting`
  await writeFile(tmp, redacted)
  await rename(tmp, filePath)
}

/**
 * Boot-time sweep: force-remove containers labeled with this runs root that a
 * crashed orchestrator left behind. Scoped by absolute runsDir so concurrent
 * orchestrators with separate runs directories never touch each other.
 */
export async function sweepOrphanContainers(runsDir: string): Promise<string[]> {
  const listed = await docker([
    'ps', '-aq', '--filter', `label=railyard.runsRoot=${path.resolve(runsDir)}`,
  ])
  const ids = listed.stdout.trim().split('\n').filter(Boolean)
  if (ids.length > 0) await docker(['rm', '-f', ...ids])
  return ids
}
