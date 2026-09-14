import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SignalEnvelope, WorkIdentity } from '../contracts/types.js'
import type { RunRecord } from './runner.js'

/**
 * The durable launch-intent record: `runs/<runId>/lifecycle.json`. Written
 * *before* the container exists and advanced through every transition, so a
 * restarted (or crashed) orchestrator can reconcile exactly what each run was
 * doing without ever spawning a second attempt (SPEC §6.5).
 *
 * The record is the recovery contract. Everything a resumed supervisor needs
 * is here — image, signal, deadline, network, *names* of injected secrets —
 * and nothing that must not be on disk (secret values, SPEC §8).
 */
export const LIFECYCLE_VERSION = 1 as const
export const LIFECYCLE_FILE_NAME = 'lifecycle.json'

/** Ordered transitions. `closed` = finalized *and* reported in the journal. */
export type RunPhase = 'intent' | 'created' | 'started' | 'exited' | 'finalized' | 'closed'

export interface RunLifecycleRecord {
  lifecycleVersion: typeof LIFECYCLE_VERSION
  runId: string
  /** Deterministic: `railyard--<runId>`. The identity recovery looks for. */
  containerName: string
  agent: string
  agentDir: string
  imageRef: string
  /** The triggering signal, provenance included — the run's original input. */
  signal: SignalEnvelope
  work: WorkIdentity | null
  /** Hard deadline from container start; null = the manifest opted out. */
  timeoutSeconds: number | null
  network: 'default' | 'none'
  /** Declared secret *names* injected at create. Values are never recorded. */
  secretNames: string[]
  hasPrompt: boolean
  phase: RunPhase
  intentAt: string
  createdAt: string | null
  startedAt: string | null
  /** Absolute deadline (ISO) fixed at start; enforced by the watchdog during downtime. */
  deadlineAt: string | null
  exitedAt: string | null
  exitCode: number | null
  finalizedAt: string | null
  closedAt: string | null
  /** Set when a supervisor detached without stopping the container; cleared on reattach. */
  detachedAt: string | null
  /** Byte offset into events.jsonl below which every line has been consumed. */
  eventsOffset: number
  /** Non-empty events lines consumed so far — the next line's index (child signal identity). */
  eventsConsumed: number
  /** Pid of the deadline watchdog spawned at start; null when there is no deadline. */
  watchdogPid: number | null
  /** The finalized run record (mirrors result.json); null until phase >= finalized. */
  outcome: RunRecord | null
  /** Framework error that ended the run without a normal outcome. */
  error: string | null
}

export type RunIntentParams = Pick<
  RunLifecycleRecord,
  | 'runId'
  | 'agent'
  | 'agentDir'
  | 'imageRef'
  | 'signal'
  | 'timeoutSeconds'
  | 'network'
  | 'secretNames'
  | 'hasPrompt'
> & { work?: WorkIdentity | null; now?: Date }

export class UnsupportedRecordError extends Error {
  constructor(what: string, version: unknown, supported: number) {
    super(
      `${what} version ${String(version)} is not supported by this railyard (supports ${supported}). ` +
        `A newer railyard wrote it; upgrade, or drain and clear the runs directory deliberately. ` +
        `Nothing has been removed.`,
    )
    this.name = 'UnsupportedRecordError'
  }
}

export function containerNameFor(runId: string): string {
  return `railyard--${runId}`
}

export function createRunIntent(params: RunIntentParams): RunLifecycleRecord {
  const now = params.now ?? new Date()
  return {
    lifecycleVersion: LIFECYCLE_VERSION,
    runId: params.runId,
    containerName: containerNameFor(params.runId),
    agent: params.agent,
    agentDir: params.agentDir,
    imageRef: params.imageRef,
    signal: params.signal,
    work: params.work ?? null,
    timeoutSeconds: params.timeoutSeconds,
    network: params.network,
    secretNames: [...params.secretNames],
    hasPrompt: params.hasPrompt,
    phase: 'intent',
    intentAt: now.toISOString(),
    createdAt: null,
    startedAt: null,
    deadlineAt: null,
    exitedAt: null,
    exitCode: null,
    finalizedAt: null,
    closedAt: null,
    detachedAt: null,
    eventsOffset: 0,
    eventsConsumed: 0,
    watchdogPid: null,
    outcome: null,
    error: null,
  }
}

function lifecyclePath(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, LIFECYCLE_FILE_NAME)
}

/** Write-temp-then-rename: a crash mid-write can never leave a torn record. */
export async function writeLifecycleRecord(runsDir: string, record: RunLifecycleRecord): Promise<void> {
  const target = lifecyclePath(runsDir, record.runId)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(record, null, 2))
  await rename(tmp, target)
}

/** Apply a partial update and persist; returns the new record. */
export async function updateLifecycleRecord(
  runsDir: string,
  record: RunLifecycleRecord,
  patch: Partial<Omit<RunLifecycleRecord, 'lifecycleVersion' | 'runId'>>,
): Promise<RunLifecycleRecord> {
  const next: RunLifecycleRecord = { ...record, ...patch }
  await writeLifecycleRecord(runsDir, next)
  return next
}

/**
 * Read one run's record. null when the run directory carries none (a pre-2.0
 * layout, or a directory that isn't a run). Throws on an unsupported version
 * and on a corrupt file — both are evidence, never silently ignored.
 */
export async function readLifecycleRecord(
  runsDir: string,
  runId: string,
): Promise<RunLifecycleRecord | null> {
  let raw: string
  try {
    raw = await readFile(lifecyclePath(runsDir, runId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseLifecycleRecord(raw)
}

export function parseLifecycleRecord(raw: string): RunLifecycleRecord {
  const parsed = JSON.parse(raw) as Partial<RunLifecycleRecord>
  if (parsed.lifecycleVersion !== LIFECYCLE_VERSION) {
    throw new UnsupportedRecordError('lifecycle record', parsed.lifecycleVersion, LIFECYCLE_VERSION)
  }
  if (typeof parsed.runId !== 'string' || typeof parsed.phase !== 'string') {
    throw new Error('lifecycle record is missing runId/phase')
  }
  return parsed as RunLifecycleRecord
}

export interface LifecycleListing {
  records: RunLifecycleRecord[]
  /** Run directories whose record exists but cannot be parsed — protected, reported, never removed. */
  unreadable: string[]
}

/**
 * Discover every persisted run under runsDir. An unsupported version aborts
 * the whole listing (and so the boot) — a newer railyard's records must not be
 * half-interpreted by an older one.
 */
export async function listLifecycleRecords(runsDir: string): Promise<LifecycleListing> {
  let entries
  try {
    entries = await readdir(runsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], unreadable: [] }
    throw err
  }
  const records: RunLifecycleRecord[] = []
  const unreadable: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    let raw: string
    try {
      raw = await readFile(lifecyclePath(runsDir, entry.name), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      unreadable.push(entry.name)
      continue
    }
    try {
      records.push(parseLifecycleRecord(raw))
    } catch (err) {
      if (err instanceof UnsupportedRecordError) throw err
      unreadable.push(entry.name)
    }
  }
  return { records, unreadable }
}
