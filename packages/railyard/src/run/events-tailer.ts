import { open, type FileHandle } from 'node:fs/promises'
import type { EventsLine } from '../contracts/types.js'
import { formatAjvErrors, validateEventsLine } from '../contracts/validate.js'

export interface EventsTailerHandlers {
  /** A complete, schema-valid JSONL line. Signal lines must dispatch mid-run (SPEC §5). */
  onLine: (line: EventsLine) => void
  /** A line that isn't valid JSON or doesn't match the events-line schema. Never fatal. */
  onMalformed: (raw: string, reason: string) => void
}

/**
 * Tails $AGENT_EVENTS_FILE from the host side of the bind mount by polling for
 * appended bytes. Polling (vs fs.watch) is deliberate: it works identically on
 * every platform and with any in-container writer (`echo >> $AGENT_EVENTS_FILE`).
 * Tolerates partial writes by buffering up to the last newline.
 */
export class EventsTailer {
  private handle: FileHandle | null = null
  private position = 0
  private remainder = ''
  private timer: NodeJS.Timeout | null = null
  private draining: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly handlers: EventsTailerHandlers,
    private readonly pollMs = 100,
  ) {}

  async start(): Promise<void> {
    this.handle = await open(this.filePath, 'r')
    this.timer = setInterval(() => {
      // Serialize drains so a slow read can't interleave with the next poll.
      this.draining = this.draining.then(() => this.drain())
    }, this.pollMs)
  }

  /** Final drain (including a trailing line without a newline), then release the file. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.draining
    await this.drain()
    if (this.remainder.trim() !== '') this.emit(this.remainder)
    this.remainder = ''
    await this.handle?.close()
    this.handle = null
  }

  private async drain(): Promise<void> {
    if (!this.handle) return
    const { size } = await this.handle.stat()
    while (this.position < size) {
      const length = Math.min(size - this.position, 64 * 1024)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await this.handle.read(buffer, 0, length, this.position)
      if (bytesRead === 0) break
      this.position += bytesRead
      this.remainder += buffer.subarray(0, bytesRead).toString('utf8')
      const lines = this.remainder.split('\n')
      this.remainder = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') this.emit(line)
      }
    }
  }

  private emit(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.handlers.onMalformed(raw, 'not valid JSON')
      return
    }
    if (!validateEventsLine(parsed)) {
      this.handlers.onMalformed(raw, formatAjvErrors(validateEventsLine.errors))
      return
    }
    this.handlers.onLine(parsed)
  }
}
