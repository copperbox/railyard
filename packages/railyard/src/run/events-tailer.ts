import { open, type FileHandle } from 'node:fs/promises'
import type { EventsLine } from '../contracts/types.js'
import { formatAjvErrors, validateEventsLine } from '../contracts/validate.js'

export interface EventsTailerHandlers {
  /**
   * A complete, schema-valid JSONL line and its index among the file's
   * non-empty lines (the identity of any signal it carries). Signal lines
   * must dispatch mid-run (SPEC §5). A returned promise is awaited before the
   * line counts as consumed, so the checkpoint never runs ahead of durable
   * acceptance.
   */
  onLine: (line: EventsLine, index: number) => void | Promise<void>
  /** A line that isn't valid JSON or doesn't match the events-line schema. Never fatal. */
  onMalformed: (raw: string, reason: string) => void
  /**
   * Called after each drained batch with the byte offset below which every
   * line has been consumed, and the count of non-empty lines consumed.
   * Persisting these is what lets a restarted supervisor resume without
   * replaying handled events.
   */
  onCheckpoint?: (offset: number, consumed: number) => void | Promise<void>
  /**
   * `onLine` rejected (durable acceptance of a child signal failed) or the
   * file could not be read. The tailer rewinds to the failing line and retries
   * on its next poll; nothing is skipped. Reported once per failure streak.
   */
  onError?: (err: unknown) => void
}

export interface EventsTailerOptions {
  pollMs?: number
  /** Resume point: byte offset of the first unconsumed line (see onCheckpoint). */
  startOffset?: number
  /** Resume point: index of the first unconsumed non-empty line. */
  startIndex?: number
}

export interface EventsTailerStopOptions {
  /**
   * `true` (default): the writer is gone — a trailing line without a newline
   * is complete and is delivered. `false` (detach): the writer may still be
   * mid-write, so the unterminated tail is left for the next supervisor.
   */
  final?: boolean
}

/**
 * Tails $AGENT_EVENTS_FILE from the host side of the bind mount by polling for
 * appended bytes. Polling (vs fs.watch) is deliberate: it works identically on
 * every platform and with any in-container writer (`echo >> $AGENT_EVENTS_FILE`).
 * Tolerates partial writes by buffering up to the last newline.
 */
export class EventsTailer {
  private handle: FileHandle | null = null
  private position: number
  private remainder = ''
  private consumed: number
  private timer: NodeJS.Timeout | null = null
  private draining: Promise<void> = Promise.resolve()
  private failing = false
  private readonly pollMs: number

  constructor(
    private readonly filePath: string,
    private readonly handlers: EventsTailerHandlers,
    options: EventsTailerOptions | number = {},
  ) {
    const opts = typeof options === 'number' ? { pollMs: options } : options
    this.pollMs = opts.pollMs ?? 100
    this.position = opts.startOffset ?? 0
    this.consumed = opts.startIndex ?? 0
  }

  /** Byte offset below which every line has been consumed (excludes a buffered partial line). */
  get checkpoint(): { offset: number; consumed: number } {
    return { offset: this.position - Buffer.byteLength(this.remainder, 'utf8'), consumed: this.consumed }
  }

  async start(): Promise<void> {
    this.handle = await open(this.filePath, 'r')
    this.timer = setInterval(() => {
      // Serialize drains so a slow read can't interleave with the next poll.
      // A failed drain must not poison the chain: the next poll retries.
      this.draining = this.draining.then(() => this.drain()).catch((err: unknown) => this.report(err))
    }, this.pollMs)
  }

  /** Final drain (including a trailing line without a newline), then release the file. */
  async stop(options: EventsTailerStopOptions = {}): Promise<void> {
    const final = options.final ?? true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.draining
    await this.drain()
    if (final && this.remainder.trim() !== '') {
      await this.emit(this.remainder)
      // position already counts the remainder's bytes; it is consumed now.
      this.remainder = ''
      await this.handlers.onCheckpoint?.(this.position, this.consumed)
    }
    await this.handle?.close()
    this.handle = null
  }

  private async drain(): Promise<void> {
    if (!this.handle) return
    const { size } = await this.handle.stat()
    let delivered = false
    // Byte offset of the next line to emit; only complete, handled lines move it.
    let lineStart = this.checkpoint.offset
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
        if (line.trim() !== '') {
          try {
            await this.emit(line)
          } catch (err) {
            // Rewind to this line: it is re-read and re-emitted on the next
            // poll, with the same index, after the lines before it are
            // checkpointed. Nothing is skipped, nothing is duplicated.
            this.consumed -= 1
            this.position = lineStart
            this.remainder = ''
            if (delivered) await this.handlers.onCheckpoint?.(lineStart, this.consumed)
            this.report(err)
            return
          }
          delivered = true
        }
        lineStart += Buffer.byteLength(line, 'utf8') + 1
      }
    }
    this.failing = false
    if (delivered) {
      const { offset, consumed } = this.checkpoint
      await this.handlers.onCheckpoint?.(offset, consumed)
    }
  }

  private report(err: unknown): void {
    if (this.failing) return
    this.failing = true
    this.handlers.onError?.(err)
  }

  private async emit(raw: string): Promise<void> {
    const index = this.consumed
    this.consumed += 1
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
    await this.handlers.onLine(parsed, index)
  }
}
