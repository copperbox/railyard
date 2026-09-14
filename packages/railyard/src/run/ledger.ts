import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SignalEnvelope, WorkIdentity } from '../contracts/types.js'
import { UnsupportedRecordError } from './lifecycle.js'

/**
 * The durable delivery ledger: `runs/ledger.json` (SPEC §6.6). Three indexes:
 *
 * - `signals` — every signal id routed, so a replayed events line (whose id is
 *   deterministic) or a re-published envelope is routed at most once.
 * - `deliveries` — every accepted (agent, signalId) with its queued/active/done
 *   status and run id.
 * - `work` — every accepted (agent, key, attempt) logical work identity, so a
 *   monitor that re-emits equivalent work under a fresh signal id (cursor
 *   replay after a crash) does not create a second attempt.
 *
 * Mutations are in-memory and `flush()` persists the whole document
 * atomically; callers flush *before* the step whose duplicate they are guarding
 * against (see Orchestrator.route). Done entries expire after the retention
 * window; queued/active entries never expire on their own.
 */
export const LEDGER_VERSION = 1 as const
export const LEDGER_FILE_NAME = 'ledger.json'

export type DeliveryStatus = 'queued' | 'active' | 'done'

export interface DeliveryEntry {
  agent: string
  signalId: string
  signalType: string
  status: DeliveryStatus
  runId: string | null
  at: string
  doneAt: string | null
}

export interface WorkEntry {
  agent: string
  key: string
  attempt: number
  signalId: string
  /** Canonical hash of the payload that claimed this identity; a differing payload is a conflict. */
  payloadHash: string
  status: DeliveryStatus
  runId: string | null
  at: string
  doneAt: string | null
}

interface LedgerData {
  ledgerVersion: typeof LEDGER_VERSION
  signals: Record<string, { at: string }>
  deliveries: Record<string, DeliveryEntry>
  work: Record<string, WorkEntry>
}

/** Key separator: the ASCII unit separator, which no agent name, work key, or signal id contains. */
const SEP = String.fromCharCode(31)

export function normalizeWork(work: WorkIdentity): { key: string; attempt: number } {
  return { key: work.key, attempt: work.attempt ?? 1 }
}

/** Stable JSON (sorted keys) → sha256, so key order can't fake a payload conflict. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

export class WorkLedger {
  readonly path: string
  private data: LedgerData = emptyLedger()
  private dirty = false
  private writing: Promise<void> = Promise.resolve()

  constructor(runsDir: string) {
    this.path = path.join(runsDir, LEDGER_FILE_NAME)
  }

  /** Load from disk. Missing = empty. Unsupported version throws (boot must fail). */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = emptyLedger()
        return
      }
      throw err
    }
    const parsed = JSON.parse(raw) as Partial<LedgerData>
    if (parsed.ledgerVersion !== LEDGER_VERSION) {
      throw new UnsupportedRecordError('delivery ledger', parsed.ledgerVersion, LEDGER_VERSION)
    }
    this.data = {
      ledgerVersion: LEDGER_VERSION,
      signals: parsed.signals ?? {},
      deliveries: parsed.deliveries ?? {},
      work: parsed.work ?? {},
    }
  }

  hasSignal(signalId: string): boolean {
    return signalId in this.data.signals
  }

  noteSignal(signalId: string, now = new Date()): void {
    if (this.hasSignal(signalId)) return
    this.data.signals[signalId] = { at: now.toISOString() }
    this.dirty = true
  }

  delivery(agent: string, signalId: string): DeliveryEntry | undefined {
    return this.data.deliveries[`${agent}${SEP}${signalId}`]
  }

  /** Every delivery, in acceptance order. */
  deliveries(): DeliveryEntry[] {
    return Object.values(this.data.deliveries).sort((a, b) => a.at.localeCompare(b.at))
  }

  findWork(agent: string, work: WorkIdentity): WorkEntry | undefined {
    const { key, attempt } = normalizeWork(work)
    return this.data.work[`${agent}${SEP}${key}${SEP}${attempt}`]
  }

  /**
   * Record one accepted delivery (and its work identity, if any). Idempotent
   * on (agent, signalId): re-accepting after a crash keeps the original entry.
   */
  accept(agent: string, signal: SignalEnvelope, now = new Date()): DeliveryEntry {
    const key = `${agent}${SEP}${signal.id}`
    const existing = this.data.deliveries[key]
    if (existing) return existing
    const entry: DeliveryEntry = {
      agent,
      signalId: signal.id,
      signalType: signal.type,
      status: 'queued',
      runId: null,
      at: now.toISOString(),
      doneAt: null,
    }
    this.data.deliveries[key] = entry
    if (signal.work !== undefined) {
      const { key: workKey, attempt } = normalizeWork(signal.work)
      const wk = `${agent}${SEP}${workKey}${SEP}${attempt}`
      if (!this.data.work[wk]) {
        this.data.work[wk] = {
          agent,
          key: workKey,
          attempt,
          signalId: signal.id,
          payloadHash: payloadHash(signal.payload),
          status: 'queued',
          runId: null,
          at: entry.at,
          doneAt: null,
        }
      }
    }
    this.dirty = true
    return entry
  }

  /** Advance a delivery (and its work identity) to active/done. Unknown deliveries are ignored. */
  setStatus(
    agent: string,
    signalId: string,
    status: DeliveryStatus,
    runId: string | null,
    now = new Date(),
  ): void {
    const entry = this.data.deliveries[`${agent}${SEP}${signalId}`]
    if (!entry) return
    entry.status = status
    if (runId !== null) entry.runId = runId
    entry.doneAt = status === 'done' ? now.toISOString() : null
    for (const work of Object.values(this.data.work)) {
      if (work.agent === agent && work.signalId === signalId) {
        work.status = status
        if (runId !== null) work.runId = runId
        work.doneAt = entry.doneAt
      }
    }
    this.dirty = true
  }

  /** Forget a delivery that will never run (cancelled, agent removed). */
  drop(agent: string, signalId: string): void {
    const key = `${agent}${SEP}${signalId}`
    if (!(key in this.data.deliveries)) return
    delete this.data.deliveries[key]
    for (const [wk, work] of Object.entries(this.data.work)) {
      if (work.agent === agent && work.signalId === signalId) delete this.data.work[wk]
    }
    this.dirty = true
  }

  /** Expire done entries (and signal ids) older than the window. Returns how many went. */
  prune(retentionMs: number, now = new Date()): number {
    const cutoff = now.getTime() - retentionMs
    let removed = 0
    for (const [id, { at }] of Object.entries(this.data.signals)) {
      if (Date.parse(at) < cutoff) {
        delete this.data.signals[id]
        removed += 1
      }
    }
    for (const [key, entry] of Object.entries(this.data.deliveries)) {
      if (entry.status === 'done' && entry.doneAt !== null && Date.parse(entry.doneAt) < cutoff) {
        delete this.data.deliveries[key]
        removed += 1
      }
    }
    for (const [key, entry] of Object.entries(this.data.work)) {
      if (entry.status === 'done' && entry.doneAt !== null && Date.parse(entry.doneAt) < cutoff) {
        delete this.data.work[key]
        removed += 1
      }
    }
    if (removed > 0) this.dirty = true
    return removed
  }

  /** Persist the current snapshot atomically. Coalesces: a flush with nothing new is free. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing
    this.dirty = false
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, snapshot)
      await rename(tmp, this.path)
    })
    return this.writing
  }
}

function emptyLedger(): LedgerData {
  return { ledgerVersion: LEDGER_VERSION, signals: {}, deliveries: {}, work: {} }
}
