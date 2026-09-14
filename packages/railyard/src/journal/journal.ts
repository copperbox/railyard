import { createReadStream } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { SignalEnvelope } from '../contracts/types.js'
import type { RunRecord } from '../run/runner.js'

/** One line in runs/journal.jsonl (SPEC §12). `at` is stamped by the journal. */
export type JournalEntry =
  | {
      event: 'signal.received'
      signalId: string
      signalType: string
      source: SignalEnvelope['source']
      provenanceDepth: number
    }
  | { event: 'signal.dropped'; reason: string; signalType?: string; source?: SignalEnvelope['source'] }
  | { event: 'run.started'; runId: string; agent: string; signalId: string }
  | {
      /**
       * Terminal, exactly once per run. `interrupted` = the container went
       * missing with no exit observed (SPEC §6.5); `error` = the framework
       * could not complete the run.
       */
      event: 'run.finished'
      runId: string
      agent: string
      signalId: string
      status: RunRecord['status'] | 'error'
      exitCode: number | null
      durationMs: number | null
      /** Present when the framework killed the run: a timeout (SPEC §6) or `cancelled`. */
      killReason?: string
      error?: string
    }
  | {
      /** Supervision detached for a restart; the container keeps running (SPEC §6.5). */
      event: 'run.detached'
      runId: string
      agent: string
      signalId: string
    }
  | {
      /**
       * A restarted orchestrator reconciled a persisted run: `reattached` (still
       * running, or created and now started), `finalized` (exited while
       * unsupervised; run.finished follows), `interrupted` (container missing;
       * run.finished follows), `requeued` (never started; delivery re-queued).
       * Never a second run.started for the same run.
       */
      event: 'run.recovered'
      runId: string
      agent: string
      signalId: string
      outcome: 'reattached' | 'finalized' | 'interrupted' | 'requeued'
    }
  | {
      /** A matched signal waiting because its agent is at the concurrency cap (SPEC §6). */
      event: 'run.queued'
      agent: string
      signalId: string
      signalType: string
      queueDepth: number
    }
  | {
      /**
       * A matched signal that will never run: self-trigger refusal (SPEC §7),
       * `duplicate` (its work identity is already queued/active/done, SPEC §6.6),
       * `cancelled` (dropped by a cancel stop), `agent-removed` (queued for an
       * agent that no longer exists). `shutdown` is retained for pre-2.0 journals.
       */
      event: 'run.skipped'
      agent: string
      signalId: string
      signalType: string
      reason: 'self-trigger' | 'shutdown' | 'duplicate' | 'cancelled' | 'agent-removed'
      /** e.g. the run/signal the duplicate collided with, or a payload-conflict note. */
      detail?: string
    }
  | {
      /** A retention sweep pruned run directories (SPEC §12); silent sweeps are not journaled. */
      event: 'retention.swept'
      removed: string[]
    }
  | { event: 'note'; message: string }

export type JournaledEntry = JournalEntry & { at: string }

/**
 * Append-only index of everything that happened: every signal received, every
 * run started/finished. Never pruned by retention (SPEC §12). Appends are
 * serialized through one queue so concurrent runs can't interleave lines.
 */
export class Journal {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(runsDir: string) {
    this.path = path.join(runsDir, 'journal.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true })
  }

  /** Returns the stamped entry; the disk write is ordered but not awaited by callers. */
  append(entry: JournalEntry): JournaledEntry {
    const stamped: JournaledEntry = { ...entry, at: new Date().toISOString() }
    this.queue = this.queue.then(() => appendFile(this.path, JSON.stringify(stamped) + '\n'))
    return stamped
  }

  /** Await all pending writes (used by stop() and tests). */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Read the journal back, line by line, collecting entries that satisfy the
   * predicate. Used at boot to learn which recovered runs already have their
   * terminal entry, so a completion is never journaled twice. Corrupt lines
   * (a torn append) are skipped.
   */
  async scan<T extends JournaledEntry>(predicate: (entry: JournaledEntry) => entry is T): Promise<T[]>
  async scan(predicate: (entry: JournaledEntry) => boolean): Promise<JournaledEntry[]>
  async scan(predicate: (entry: JournaledEntry) => boolean): Promise<JournaledEntry[]> {
    await this.flush()
    try {
      await stat(this.path)
    } catch {
      return []
    }
    const found: JournaledEntry[] = []
    const lines = createInterface({ input: createReadStream(this.path, 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.trim() === '') continue
      let entry: JournaledEntry
      try {
        entry = JSON.parse(line) as JournaledEntry
      } catch {
        continue
      }
      if (predicate(entry)) found.push(entry)
    }
    return found
  }
}
