import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SignalEnvelope } from '../contracts/types.js'
import { UnsupportedRecordError } from './lifecycle.js'

/**
 * The durable pending-delivery queue: one file per accepted delivery under
 * `runs/queue/`, named `<agent>--<signalId>.json` so a re-accepted delivery
 * overwrites rather than duplicates. A delivery lives here from acceptance
 * until its run's intent record exists, so queued work survives any stop and
 * any crash (SPEC §6.5). Retention never touches this directory — it isn't
 * shaped like a run id.
 */
export const QUEUE_VERSION = 1 as const
export const QUEUE_DIR_NAME = 'queue'

export interface QueuedDelivery {
  queueVersion: typeof QUEUE_VERSION
  agent: string
  signal: SignalEnvelope
  acceptedAt: string
}

export class DurableQueue {
  readonly dir: string

  constructor(runsDir: string) {
    this.dir = path.join(runsDir, QUEUE_DIR_NAME)
  }

  private fileFor(agent: string, signalId: string): string {
    return path.join(this.dir, `${agent}--${signalId}.json`)
  }

  /** Persist an accepted delivery. Idempotent on (agent, signalId). */
  async accept(agent: string, signal: SignalEnvelope, now = new Date()): Promise<QueuedDelivery> {
    const entry: QueuedDelivery = {
      queueVersion: QUEUE_VERSION,
      agent,
      signal,
      acceptedAt: now.toISOString(),
    }
    await mkdir(this.dir, { recursive: true })
    const target = this.fileFor(agent, signal.id)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(entry, null, 2))
    await rename(tmp, target)
    return entry
  }

  /** Remove a delivery (launched, cancelled, or dropped). Missing is fine. */
  async remove(agent: string, signalId: string): Promise<void> {
    await unlink(this.fileFor(agent, signalId)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }

  /** Every pending delivery, oldest first. Unsupported versions throw (boot must fail). */
  async load(): Promise<QueuedDelivery[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const entries: QueuedDelivery[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let parsed: Partial<QueuedDelivery>
      try {
        parsed = JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as Partial<QueuedDelivery>
      } catch (err) {
        throw new Error(
          `queued delivery ${name} is unreadable: ${(err as Error).message}. Nothing has been removed; ` +
            `inspect or remove the file deliberately and start again.`,
        )
      }
      if (parsed.queueVersion !== QUEUE_VERSION) {
        throw new UnsupportedRecordError('queued delivery', parsed.queueVersion, QUEUE_VERSION)
      }
      entries.push(parsed as QueuedDelivery)
    }
    return entries.sort(
      (a, b) =>
        a.acceptedAt.localeCompare(b.acceptedAt) ||
        a.agent.localeCompare(b.agent) ||
        a.signal.id.localeCompare(b.signal.id),
    )
  }
}
