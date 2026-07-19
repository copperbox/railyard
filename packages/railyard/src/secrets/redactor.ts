/**
 * The redaction guarantee (SPEC §8, invariant 5): secret values never appear in
 * signals, run records, journal entries, or framework-captured logs. Mechanism
 * is literal substring replacement — see the brain's redaction decision for why
 * (and why very short values are excluded with a loud warning instead).
 */

/** Values shorter than this cannot be safely redacted (coincidental-match blast radius). */
export const REDACTION_MIN_LENGTH = 6

export class Redactor {
  /** pattern value → secret name (longest patterns applied first). */
  private readonly byValue = new Map<string, string>()
  private sorted: string[] | null = null

  /**
   * Register a secret value. Multi-line values (PEM keys) also register each
   * individual line so line-oriented sinks still match. Returns false when the
   * value is too short to redact safely — the caller must warn loudly.
   */
  register(name: string, value: string): boolean {
    const parts = new Set([value])
    if (value.includes('\n')) {
      for (const line of value.split('\n')) parts.add(line)
    }
    let covered = false
    for (const part of parts) {
      if (part.length < REDACTION_MIN_LENGTH) continue
      covered = true
      if (!this.byValue.has(part)) {
        this.byValue.set(part, name)
        this.sorted = null
      }
    }
    return covered
  }

  /** Replace every occurrence of every registered value with [REDACTED:NAME]. */
  redactString(text: string): string {
    if (this.byValue.size === 0) return text
    if (this.sorted === null) {
      // Longest first, so a secret that contains another secret redacts whole.
      this.sorted = [...this.byValue.keys()].sort((a, b) => b.length - a.length)
    }
    let out = text
    for (const value of this.sorted) {
      if (out.includes(value)) out = out.replaceAll(value, `[REDACTED:${this.byValue.get(value)!}]`)
    }
    return out
  }

  /** Deep-redact every string (keys included) in a JSON-shaped value. */
  redactJson<T>(value: T): T {
    if (this.byValue.size === 0) return value
    return this.walk(value) as T
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.redactString(value)
    if (Array.isArray(value)) return value.map((item) => this.walk(item))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        out[this.redactString(key)] = this.walk(entry)
      }
      return out
    }
    return value
  }
}

/**
 * Split a chunked stream into complete lines, buffering partials — redaction
 * must see whole lines or a secret split across two chunks would slip through.
 */
export class LineSplitter {
  private buffer = ''

  /** Feed a chunk; returns the complete lines it closed off. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop()!
    return lines
  }

  /** The trailing unterminated line, if any. Resets the buffer. */
  flush(): string | null {
    const rest = this.buffer
    this.buffer = ''
    return rest === '' ? null : rest
  }
}
