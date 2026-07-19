import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
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
      event: 'run.finished'
      runId: string
      agent: string
      signalId: string
      status: RunRecord['status'] | 'error'
      exitCode: number | null
      durationMs: number | null
      error?: string
    }
  | {
      /** A matched signal that will never run (SPEC §7 self-trigger refusal; queue drop at stop()). */
      event: 'run.skipped'
      agent: string
      signalId: string
      signalType: string
      reason: 'self-trigger' | 'shutdown'
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
}
