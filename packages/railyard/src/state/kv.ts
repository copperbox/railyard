import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Per-monitor persistent KV for cursors ("last seen issue event", SPEC §9).
 * Pluggable backend; this default is plain JSON on disk — also the persistence
 * seam signal durability will reuse in v2.
 */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export class JsonFileKvStore implements KeyValueStore {
  private data: Record<string, unknown> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<unknown> {
    return (await this.load())[key]
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = await this.load()
    data[key] = value
    await this.persist()
  }

  async delete(key: string): Promise<void> {
    const data = await this.load()
    delete data[key]
    await this.persist()
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.data === null) {
      try {
        this.data = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        this.data = {}
      }
    }
    return this.data
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      // Write-then-rename so a crash can't leave a torn cursor file.
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, snapshot)
      await rename(tmp, this.filePath)
    })
    await this.queue
  }
}
