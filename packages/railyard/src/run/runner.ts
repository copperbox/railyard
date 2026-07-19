import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LoadedAgent } from '../agents/loader.js'
import { newRunId } from '../contracts/id.js'
import type { EventsLine, SignalEnvelope } from '../contracts/types.js'
import { docker, dockerOk } from '../docker/cli.js'
import { EventsTailer } from './events-tailer.js'

/** Paths inside the container; exposed to the agent via env vars (SPEC §5). */
export const CONTAINER_PATHS = {
  inputDir: '/railyard/input',
  inputFile: '/railyard/input/signal.json',
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
  await writeFile(
    path.join(runDir, 'invocation.json'),
    JSON.stringify({ runId, agent: agent.name, agentDir: agent.dir, imageRef, signal }, null, 2),
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
  if (agent.manifest.network === 'none') createArgs.push('--network', 'none')
  createArgs.push(imageRef)

  const tailer = new EventsTailer(eventsFile, {
    onLine: params.onEvent,
    onMalformed: params.onMalformedEvent ?? (() => {}),
  })
  const logStream = createWriteStream(path.join(runDir, 'agent.log'))
  const timeoutSeconds = params.timeoutSeconds === undefined ? 900 : params.timeoutSeconds
  const startedAt = new Date()
  let exitCode: number | null = null
  let killReason: string | null = null
  let killTimer: NodeJS.Timeout | undefined
  let killDone: Promise<void> | undefined

  try {
    await dockerOk(createArgs, `run ${runId}`)
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
      onStdoutLine: (line) => logStream.write(line + '\n'),
      onStderrLine: (line) => logStream.write(line + '\n'),
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
    result,
    resultError,
    killReason,
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2))
  return record
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
