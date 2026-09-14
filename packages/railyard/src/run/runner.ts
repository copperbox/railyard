import { createWriteStream, type WriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LoadedAgent } from '../agents/loader.js'
import { newRunId } from '../contracts/id.js'
import type { EventsLine } from '../contracts/types.js'
import { docker, dockerOk } from '../docker/cli.js'
import { LineSplitter, type Redactor } from '../secrets/redactor.js'
import { EventsTailer } from './events-tailer.js'
import {
  updateLifecycleRecord,
  type RunLifecycleRecord,
} from './lifecycle.js'
import { readWatchdogKill, spawnWatchdog, stopWatchdog, watchdogAlive } from './watchdog.js'

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
  /**
   * `interrupted` = the container went missing while no orchestrator was
   * supervising it, so no exit was ever observed (SPEC §6.5).
   */
  status: 'succeeded' | 'failed' | 'interrupted'
  /** Parsed contents of the agent's $AGENT_OUTPUT_DIR/result.json, if any. */
  result: unknown
  /** Why result is null despite success, e.g. unparsable result.json. */
  resultError: string | null
  /** Why the framework killed the run ("timeout: exceeded 900s", "cancelled"); null otherwise. */
  killReason: string | null
}

/**
 * How the orchestrator steers a supervised run. Both are one-shot: abort
 * `detach` to stop supervising while the container keeps running (restart),
 * abort `cancel` to kill the container and finalize it as cancelled.
 */
export interface RunControl {
  detach?: AbortSignal
  cancel?: AbortSignal
}

export type RunOutcome =
  | { kind: 'finished'; record: RunRecord }
  /** Supervision ended by detach; the container is still the run's. */
  | { kind: 'detached'; lifecycle: RunLifecycleRecord }

export interface RunSupervisionHandlers {
  /**
   * Valid events-file lines, dispatched while the container is still running,
   * with the line's index (child signal identity). A returned promise is
   * awaited before the events checkpoint advances past the line.
   */
  onEvent: (line: EventsLine, index: number) => void | Promise<void>
  onMalformedEvent?: (raw: string, reason: string) => void
}

export interface RunAgentParams extends RunSupervisionHandlers {
  /** The persisted launch intent (phase `intent`); the runner advances it from here. */
  lifecycle: RunLifecycleRecord
  agent: LoadedAgent
  runsDir: string
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
  control?: RunControl
}

export interface ResumeRunParams extends RunSupervisionHandlers {
  /** A persisted record whose container was observed as created, running, or exited. */
  lifecycle: RunLifecycleRecord
  runsDir: string
  redactor?: Redactor
  control?: RunControl
}

/** What the backend can say about a persisted run's container, without touching it. */
export interface RunObservation {
  state: 'missing' | 'created' | 'running' | 'exited'
  exitCode: number | null
  finishedAt: string | null
  /**
   * The declared secrets exactly as the container holds them, so a resumed
   * supervisor can redact values that were rotated away since launch. Kept in
   * memory only — never written by the framework (SPEC §8).
   */
  secrets: Record<string, string>
}

/** The backend could not answer — distinct from "the container is gone". */
export class BackendUnavailableError extends Error {
  constructor(detail: string) {
    super(`container backend unavailable: ${detail}`)
    this.name = 'BackendUnavailableError'
  }
}

export function makeRunId(agentName: string): string {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  return `${stamp}--${agentName}--${newRunId()}`
}

/** Everything a supervising or finalizing step needs about one run. */
interface RunContext {
  lifecycle: RunLifecycleRecord
  runsDir: string
  runDir: string
  outputDir: string
  eventsFile: string
  redactor: Redactor | undefined
  control: RunControl
  handlers: RunSupervisionHandlers
  tailer: EventsTailer
  logStream: WriteStream
  splitters: { stdout: LineSplitter; stderr: LineSplitter }
}

/**
 * One matched signal → one container → run → exit → removal (SPEC §6), with
 * every transition persisted to the run's lifecycle record so a restarted
 * orchestrator can pick up exactly where this one left off (SPEC §6.5).
 */
export async function runAgent(params: RunAgentParams): Promise<RunOutcome> {
  const { runsDir } = params
  const ctx = openRunContext(params.lifecycle, runsDir, params.redactor, params.control ?? {}, params)
  const { runDir, outputDir, eventsFile } = ctx
  const inputDir = path.join(runDir, 'input')
  const lc = params.lifecycle
  const { containerName, imageRef, runId } = lc
  const redactor = params.redactor

  await mkdir(inputDir, { recursive: true })
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(inputDir, 'signal.json'), JSON.stringify(lc.signal, null, 2))
  await writeFile(eventsFile, '')
  // Non-root container users must still be able to write their side of the contract.
  await chmod(outputDir, 0o777)
  await chmod(eventsFile, 0o666)
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
      redactJson({ runId, agent: lc.agent, agentDir: lc.agentDir, imageRef, signal: lc.signal }),
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
  if (lc.network === 'none') createArgs.push('--network', 'none')
  for (const name of Object.keys(params.env ?? {})) createArgs.push('-e', name)
  createArgs.push(imageRef)

  try {
    await dockerOk(createArgs, `run ${runId}`, params.env ? { env: params.env } : undefined)
    ctx.lifecycle = await updateLifecycleRecord(runsDir, ctx.lifecycle, {
      phase: 'created',
      createdAt: new Date().toISOString(),
    })
    await ctx.tailer.start()
    await startContainer(ctx)
  } catch (err) {
    await abandon(ctx, err)
    throw err
  }
  return supervise(ctx)
}

/**
 * Pick a persisted run back up. `created` containers are started now (their
 * deadline counts from this start); `running` ones are reattached with the
 * original deadline (and a watchdog respawned if the old one is gone);
 * `exited` ones are finalized from what the backend and the run dir hold.
 */
export async function resumeRun(params: ResumeRunParams): Promise<RunOutcome> {
  const observation = await observeRun(params.lifecycle)
  if (observation.state === 'missing') {
    throw new Error(`run ${params.lifecycle.runId}: container ${params.lifecycle.containerName} is missing`)
  }
  const ctx = openRunContext(params.lifecycle, params.runsDir, params.redactor, params.control ?? {}, params, {
    resume: true,
  })
  ctx.lifecycle = await updateLifecycleRecord(params.runsDir, ctx.lifecycle, { detachedAt: null })
  try {
    await ctx.tailer.start()
    if (observation.state === 'created') {
      await startContainer(ctx)
    } else if (observation.state === 'running') {
      await ensureWatchdog(ctx)
    } else {
      // Exited during downtime: no supervision left to do, only collection.
      await docker(['logs', ctx.lifecycle.containerName], {
        onStdoutChunk: (chunk) => writeLogChunk(ctx, 'stdout', chunk),
        onStderrChunk: (chunk) => writeLogChunk(ctx, 'stderr', chunk),
      })
      const exitCode = observation.exitCode ?? -1
      ctx.lifecycle = await updateLifecycleRecord(params.runsDir, ctx.lifecycle, {
        phase: 'exited',
        exitCode,
        exitedAt: observation.finishedAt ?? new Date().toISOString(),
      })
      const watchdogKill = await readWatchdogKill(ctx.runDir)
      return { kind: 'finished', record: await finalize(ctx, exitCode, watchdogKill?.reason ?? null) }
    }
  } catch (err) {
    await abandon(ctx, err)
    throw err
  }
  return supervise(ctx)
}

/**
 * Inspect a persisted run's container without changing anything. "Missing" is
 * only ever concluded from a definite not-found answer; any other failure is
 * reported as the backend being unavailable, so an unreachable daemon can't be
 * mistaken for a lost run.
 */
export async function observeRun(lifecycle: RunLifecycleRecord): Promise<RunObservation> {
  const res = await docker(['inspect', '--format', '{{json .}}', lifecycle.containerName])
  if (res.code !== 0) {
    if (/no such (object|container)/i.test(res.stderr)) {
      return { state: 'missing', exitCode: null, finishedAt: null, secrets: {} }
    }
    throw new BackendUnavailableError(res.stderr.trim() || `docker inspect exited ${res.code}`)
  }
  let parsed: {
    State?: { Status?: string; ExitCode?: number; FinishedAt?: string }
    Config?: { Env?: string[] }
  }
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed
  } catch (err) {
    throw new BackendUnavailableError(`unparsable inspect output: ${(err as Error).message}`)
  }
  const state = observedState(parsed.State?.Status ?? '')
  const secrets: Record<string, string> = {}
  const wanted = new Set(lifecycle.secretNames)
  for (const entry of parsed.Config?.Env ?? []) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    if (wanted.has(name)) secrets[name] = entry.slice(eq + 1)
  }
  const finishedAt = parsed.State?.FinishedAt ?? null
  return {
    state,
    exitCode: state === 'exited' ? (parsed.State?.ExitCode ?? -1) : null,
    finishedAt: finishedAt !== null && !finishedAt.startsWith('0001-') ? finishedAt : null,
    secrets,
  }
}

/** Map Docker's container status onto the three states recovery distinguishes. */
function observedState(status: string): RunObservation['state'] {
  switch (status) {
    case 'created':
      return 'created'
    case 'running':
    case 'paused':
    case 'restarting':
      return 'running'
    default:
      return 'exited'
  }
}

/**
 * Finalize a run whose exit *was* observed and recorded but whose container is
 * already gone — the crash came between `docker rm` and result.json. Pure
 * bookkeeping from the record and the run directory: the recorded exit code,
 * the agent's output/result.json, and the watchdog marker. No backend calls.
 */
export async function recordExitedRun(
  runsDir: string,
  lifecycle: RunLifecycleRecord,
  redactor?: Redactor,
): Promise<RunRecord> {
  const runDir = path.join(runsDir, lifecycle.runId)
  const outputDir = path.join(runDir, 'output')
  const exitCode = lifecycle.exitCode ?? -1
  if (redactor) {
    await rewriteRedacted(path.join(runDir, 'events.jsonl'), redactor)
    await rewriteRedacted(path.join(outputDir, 'result.json'), redactor)
  }
  const { result, resultError } = await readAgentResult(outputDir)
  const startedAt = lifecycle.startedAt ?? lifecycle.createdAt ?? lifecycle.intentAt
  const finishedAt = lifecycle.exitedAt ?? new Date().toISOString()
  const record: RunRecord = {
    runId: lifecycle.runId,
    agent: lifecycle.agent,
    signalId: lifecycle.signal.id,
    imageRef: lifecycle.imageRef,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exitCode,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    result: redactor ? redactor.redactJson(result) : result,
    resultError,
    killReason: (await readWatchdogKill(runDir))?.reason ?? null,
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2))
  await updateLifecycleRecord(runsDir, lifecycle, {
    phase: 'finalized',
    finalizedAt: record.finishedAt,
    outcome: record,
  })
  return record
}

/**
 * Record a run whose container is gone with no exit ever observed. Pure
 * bookkeeping: writes result.json (status `interrupted`) and closes out the
 * lifecycle record. No backend calls.
 */
export async function recordInterruptedRun(
  runsDir: string,
  lifecycle: RunLifecycleRecord,
  reason: string,
): Promise<RunRecord> {
  const now = new Date()
  const startedAt = lifecycle.startedAt ?? lifecycle.intentAt
  const record: RunRecord = {
    runId: lifecycle.runId,
    agent: lifecycle.agent,
    signalId: lifecycle.signal.id,
    imageRef: lifecycle.imageRef,
    startedAt,
    finishedAt: now.toISOString(),
    durationMs: Math.max(0, now.getTime() - Date.parse(startedAt)),
    exitCode: null,
    status: 'interrupted',
    result: null,
    resultError: reason,
    killReason: null,
  }
  await mkdir(path.join(runsDir, lifecycle.runId), { recursive: true })
  await writeFile(path.join(runsDir, lifecycle.runId, 'result.json'), JSON.stringify(record, null, 2))
  await updateLifecycleRecord(runsDir, lifecycle, {
    phase: 'finalized',
    finalizedAt: record.finishedAt,
    outcome: record,
    error: reason,
  })
  return record
}

function openRunContext(
  lifecycle: RunLifecycleRecord,
  runsDir: string,
  redactor: Redactor | undefined,
  control: RunControl,
  handlers: RunSupervisionHandlers,
  options: { resume?: boolean } = {},
): RunContext {
  const runDir = path.join(runsDir, lifecycle.runId)
  const eventsFile = path.join(runDir, 'events.jsonl')
  const tailer = new EventsTailer(
    eventsFile,
    {
      onLine: handlers.onEvent,
      onMalformed: handlers.onMalformedEvent ?? (() => {}),
      onCheckpoint: async (offset, consumed) => {
        ctx.lifecycle = await updateLifecycleRecord(runsDir, ctx.lifecycle, {
          eventsOffset: offset,
          eventsConsumed: consumed,
        })
      },
    },
    options.resume
      ? { startOffset: lifecycle.eventsOffset, startIndex: lifecycle.eventsConsumed }
      : {},
  )
  // `docker logs` replays from the beginning on every attach, so a resumed
  // capture rewrites agent.log whole — complete, and redacted with the
  // current redactor.
  const ctx: RunContext = {
    lifecycle,
    runsDir,
    runDir,
    outputDir: path.join(runDir, 'output'),
    eventsFile,
    redactor,
    control,
    handlers,
    tailer,
    logStream: createWriteStream(path.join(runDir, 'agent.log')),
    // Line-buffered so redaction always sees whole lines — a secret split across
    // stream chunks must not slip through (SPEC §8).
    splitters: { stdout: new LineSplitter(), stderr: new LineSplitter() },
  }
  return ctx
}

function writeLogChunk(ctx: RunContext, which: 'stdout' | 'stderr', chunk: string): void {
  for (const line of ctx.splitters[which].push(chunk)) {
    ctx.logStream.write((ctx.redactor ? ctx.redactor.redactString(line) : line) + '\n')
  }
}

async function startContainer(ctx: RunContext): Promise<void> {
  const { runId, containerName } = ctx.lifecycle
  await dockerOk(['start', containerName], `run ${runId}`)
  const startedAt = new Date()
  const timeoutSeconds = ctx.lifecycle.timeoutSeconds
  const deadlineAt =
    timeoutSeconds === null ? null : new Date(startedAt.getTime() + timeoutSeconds * 1000)
  ctx.lifecycle = await updateLifecycleRecord(ctx.runsDir, ctx.lifecycle, {
    phase: 'started',
    startedAt: startedAt.toISOString(),
    deadlineAt: deadlineAt?.toISOString() ?? null,
  })
  if (deadlineAt !== null) await ensureWatchdog(ctx)
}

/** Spawn the deadline watchdog unless one of ours is already alive for this container. */
async function ensureWatchdog(ctx: RunContext): Promise<void> {
  const lc = ctx.lifecycle
  if (lc.deadlineAt === null || lc.timeoutSeconds === null) return
  if (lc.watchdogPid !== null && (await watchdogAlive(lc.watchdogPid, lc.containerName))) return
  const deadline = new Date(lc.deadlineAt)
  if (deadline.getTime() <= Date.now()) return // supervise()'s timer fires immediately
  const pid = spawnWatchdog({
    containerName: lc.containerName,
    runDir: ctx.runDir,
    deadlineAt: deadline,
    timeoutSeconds: lc.timeoutSeconds,
  })
  ctx.lifecycle = await updateLifecycleRecord(ctx.runsDir, lc, { watchdogPid: pid })
}

/**
 * Watch a started container until it exits, is cancelled, or we are told to
 * detach. Hard timeout (SPEC §6): SIGKILL at the absolute deadline so the
 * wait/logs path completes normally and teardown stays on the one route.
 */
async function supervise(ctx: RunContext): Promise<RunOutcome> {
  const { containerName, runId } = ctx.lifecycle
  let killReason: string | null = null
  let killTimer: NodeJS.Timeout | undefined
  let killDone: Promise<void> | undefined
  const kill = (reason: string): Promise<void> =>
    docker(['kill', containerName]).then((res) => {
      // A failed kill means the container had already exited — not our doing.
      if (res.code === 0 && killReason === null) killReason = reason
    })
  if (ctx.lifecycle.deadlineAt !== null) {
    const remaining = Date.parse(ctx.lifecycle.deadlineAt) - Date.now()
    const reason = `timeout: exceeded ${String(ctx.lifecycle.timeoutSeconds)}s`
    killTimer = setTimeout(
      () => {
        killDone = kill(reason)
      },
      Math.max(0, remaining),
    )
  }
  const onCancel = (): void => {
    killDone = kill('cancelled')
  }
  if (ctx.control.cancel?.aborted) onCancel()
  else ctx.control.cancel?.addEventListener('abort', onCancel, { once: true })

  const attach = new AbortController()
  const onDetach = (): void => attach.abort()
  if (ctx.control.detach?.aborted) onDetach()
  else ctx.control.detach?.addEventListener('abort', onDetach, { once: true })

  let exitCode: number | null = null
  try {
    const logsDone = docker(['logs', '--follow', containerName], {
      onStdoutChunk: (chunk) => writeLogChunk(ctx, 'stdout', chunk),
      onStderrChunk: (chunk) => writeLogChunk(ctx, 'stderr', chunk),
      signal: attach.signal,
    })
    const waited = await docker(['wait', containerName], { signal: attach.signal })
    if (attach.signal.aborted) {
      await logsDone
      return { kind: 'detached', lifecycle: await detach(ctx, killTimer) }
    }
    if (waited.code !== 0) {
      throw new Error(`run ${runId}: docker wait exited ${waited.code}: ${waited.stderr.trim()}`)
    }
    exitCode = Number.parseInt(waited.stdout.trim(), 10)
    if (Number.isNaN(exitCode)) exitCode = -1
    await logsDone
  } catch (err) {
    if (killTimer !== undefined) clearTimeout(killTimer)
    await abandon(ctx, err)
    throw err
  } finally {
    ctx.control.cancel?.removeEventListener('abort', onCancel)
    ctx.control.detach?.removeEventListener('abort', onDetach)
  }
  if (killTimer !== undefined) clearTimeout(killTimer)
  // If a kill is in flight, learn whether it actually landed before we record.
  await killDone?.catch(() => {})
  ctx.lifecycle = await updateLifecycleRecord(ctx.runsDir, ctx.lifecycle, {
    phase: 'exited',
    exitCode,
    exitedAt: new Date().toISOString(),
  })
  if (killReason === null) killReason = (await readWatchdogKill(ctx.runDir))?.reason ?? null
  return { kind: 'finished', record: await finalize(ctx, exitCode, killReason) }
}

/** Stop supervising without touching the container; leave a resumable record. */
async function detach(ctx: RunContext, killTimer: NodeJS.Timeout | undefined): Promise<RunLifecycleRecord> {
  if (killTimer !== undefined) clearTimeout(killTimer)
  // Not final: an unterminated last line may still be mid-write.
  await ctx.tailer.stop({ final: false }).catch(() => {})
  const { offset, consumed } = ctx.tailer.checkpoint
  await endLog(ctx)
  ctx.lifecycle = await updateLifecycleRecord(ctx.runsDir, ctx.lifecycle, {
    eventsOffset: offset,
    eventsConsumed: consumed,
    detachedAt: new Date().toISOString(),
  })
  return ctx.lifecycle
}

async function endLog(ctx: RunContext): Promise<void> {
  for (const splitter of [ctx.splitters.stdout, ctx.splitters.stderr]) {
    const rest = splitter.flush()
    if (rest !== null) ctx.logStream.write((ctx.redactor ? ctx.redactor.redactString(rest) : rest) + '\n')
  }
  await new Promise<void>((resolve) => ctx.logStream.end(resolve))
}

/**
 * Collect results, scrub, write result.json, remove the container, and mark
 * the record finalized. Guaranteed teardown (SPEC §6): the container is
 * removed on every path through here.
 */
async function finalize(ctx: RunContext, exitCode: number, killReason: string | null): Promise<RunRecord> {
  const lc = ctx.lifecycle
  await ctx.tailer.stop().catch(() => {})
  await endLog(ctx)
  await stopWatchdog(lc.watchdogPid, lc.containerName)
  await docker(['rm', '-f', lc.containerName])

  const finishedAt = new Date()
  const { result, resultError } = await readAgentResult(ctx.outputDir)
  if (ctx.redactor) {
    // The agent wrote these two directly; scrub them now that the run is over.
    // Arbitrary other output files are the agent's own business (documented).
    await rewriteRedacted(ctx.eventsFile, ctx.redactor)
    await rewriteRedacted(path.join(ctx.outputDir, 'result.json'), ctx.redactor)
  }
  const startedAt = lc.startedAt ?? lc.createdAt ?? lc.intentAt
  const record: RunRecord = {
    runId: lc.runId,
    agent: lc.agent,
    signalId: lc.signal.id,
    imageRef: lc.imageRef,
    startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - Date.parse(startedAt),
    exitCode,
    status: exitCode === 0 ? 'succeeded' : 'failed',
    result: ctx.redactor ? ctx.redactor.redactJson(result) : result,
    resultError,
    killReason,
  }
  await writeFile(path.join(ctx.runDir, 'result.json'), JSON.stringify(record, null, 2))
  ctx.lifecycle = await updateLifecycleRecord(ctx.runsDir, lc, {
    phase: 'finalized',
    finalizedAt: record.finishedAt,
    outcome: record,
  })
  return record
}

/** The agent's own $AGENT_OUTPUT_DIR/result.json, parsed; why not, if not. */
async function readAgentResult(outputDir: string): Promise<{ result: unknown; resultError: string | null }> {
  try {
    return { result: JSON.parse(await readFile(path.join(outputDir, 'result.json'), 'utf8')), resultError: null }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { result: null, resultError: 'agent wrote no result.json' }
    }
    return { result: null, resultError: `result.json unreadable: ${(err as Error).message}` }
  }
}

/** A launch/supervision step failed: tear down what exists and record the error. */
async function abandon(ctx: RunContext, err: unknown): Promise<void> {
  const lc = ctx.lifecycle
  await ctx.tailer.stop().catch(() => {})
  await endLog(ctx).catch(() => {})
  await stopWatchdog(lc.watchdogPid, lc.containerName).catch(() => {})
  await docker(['rm', '-f', lc.containerName]).catch(() => {})
  await updateLifecycleRecord(ctx.runsDir, lc, {
    phase: 'finalized',
    finalizedAt: new Date().toISOString(),
    error: String((err as Error).message ?? err),
  }).catch(() => {})
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
 * Remove containers labeled with this runs root whose run id is not in `keep`
 * — true orphans with no lifecycle record to recover from. Scoped by absolute
 * runsDir so orchestrators with separate runs directories never touch each
 * other. Returns the removed run ids.
 */
export async function sweepOrphanContainers(
  runsDir: string,
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const listed = await dockerOk(
    [
      'ps', '-a',
      '--filter', `label=railyard.runsRoot=${path.resolve(runsDir)}`,
      '--format', '{{.ID}} {{.Label "railyard.run"}}',
    ],
    'orphan sweep',
  )
  const doomed: Array<{ id: string; runId: string }> = []
  for (const line of listed.stdout.split('\n')) {
    const [id, runId = ''] = line.trim().split(/\s+/, 2)
    if (!id) continue
    if (keep.has(runId)) continue
    doomed.push({ id, runId })
  }
  if (doomed.length > 0) await docker(['rm', '-f', ...doomed.map((d) => d.id)])
  return doomed.map((d) => d.runId || d.id)
}
