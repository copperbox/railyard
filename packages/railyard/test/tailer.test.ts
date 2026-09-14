import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EventsLine } from '../src/contracts/types.js'
import { EventsTailer } from '../src/run/events-tailer.js'

async function makeTailer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'railyard-tail-'))
  const file = path.join(dir, 'events.jsonl')
  await writeFile(file, '')
  const lines: EventsLine[] = []
  const malformed: Array<{ raw: string; reason: string }> = []
  const tailer = new EventsTailer(
    file,
    {
      onLine: (line) => {
        lines.push(line)
      },
      onMalformed: (raw, reason) => {
        malformed.push({ raw, reason })
      },
    },
    20,
  )
  await tailer.start()
  return { file, lines, malformed, tailer }
}

describe('EventsTailer', () => {
  it('delivers appended lines while the file keeps growing', async () => {
    const { file, lines, tailer } = await makeTailer()
    await appendFile(file, '{"kind":"log","message":"one"}\n')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await appendFile(file, '{"kind":"signal","type":"echo.done","payload":{"n":1}}\n')
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(lines[1]).toEqual({ kind: 'signal', type: 'echo.done', payload: { n: 1 } })
    await tailer.stop()
  })

  it('buffers partial writes until the newline arrives', async () => {
    const { file, lines, tailer } = await makeTailer()
    await appendFile(file, '{"kind":"log","mes')
    await new Promise((r) => setTimeout(r, 80))
    expect(lines).toHaveLength(0)
    await appendFile(file, 'sage":"split"}\n')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines[0]).toEqual({ kind: 'log', message: 'split' })
    await tailer.stop()
  })

  it('reports malformed lines and keeps going', async () => {
    const { file, lines, malformed, tailer } = await makeTailer()
    await appendFile(
      file,
      'garbage\n{"kind":"metric"}\n{"kind":"log","message":"still here"}\n',
    )
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(malformed).toHaveLength(2)
    expect(malformed[0]?.reason).toBe('not valid JSON')
    await tailer.stop()
  })

  it('flushes a trailing line without a newline on stop', async () => {
    const { file, lines, tailer } = await makeTailer()
    await appendFile(file, '{"kind":"log","message":"no newline"}')
    await tailer.stop()
    expect(lines).toEqual([{ kind: 'log', message: 'no newline' }])
  })
})

describe('EventsTailer checkpoints and resume', () => {
  it('reports a checkpoint after each batch, indexes lines, and resumes from a saved offset', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'railyard-tail-'))
    const file = path.join(dir, 'events.jsonl')
    await writeFile(file, '')
    const seen: Array<{ index: number; line: EventsLine }> = []
    const checkpoints: Array<{ offset: number; consumed: number }> = []
    const first = new EventsTailer(
      file,
      {
        onLine: (line, index) => {
          seen.push({ index, line })
        },
        onMalformed: () => {},
        onCheckpoint: (offset, consumed) => {
          checkpoints.push({ offset, consumed })
        },
      },
      { pollMs: 20 },
    )
    await first.start()
    const l1 = '{"kind":"log","message":"one"}\n'
    const l2 = '{"kind":"signal","type":"a.b","payload":1}\n'
    await appendFile(file, l1 + l2 + '{"kind":"log","mes')
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen.map((s) => s.index)).toEqual([0, 1])
    // The checkpoint excludes the buffered partial line.
    const expectedOffset = Buffer.byteLength(l1 + l2)
    expect(checkpoints.at(-1)).toEqual({ offset: expectedOffset, consumed: 2 })
    // Detach: the unfinished write is not treated as final.
    await first.stop({ final: false })
    expect(seen).toHaveLength(2)
    expect(first.checkpoint).toEqual({ offset: expectedOffset, consumed: 2 })

    // A new tailer resumes from the checkpoint and sees the completed line, index 2.
    const resumed: Array<{ index: number; line: EventsLine }> = []
    const second = new EventsTailer(
      file,
      {
        onLine: (line, index) => {
          resumed.push({ index, line })
        },
        onMalformed: () => {},
      },
      { pollMs: 20, startOffset: expectedOffset, startIndex: 2 },
    )
    await second.start()
    await appendFile(file, 'sage":"split"}\n')
    await vi.waitFor(() => expect(resumed).toHaveLength(1))
    expect(resumed[0]).toEqual({ index: 2, line: { kind: 'log', message: 'split' } })
    await second.stop()
  })

  it('a rejected onLine is reported and retried from the last checkpoint; later lines are not lost', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'railyard-tail-'))
    const file = path.join(dir, 'events.jsonl')
    await writeFile(file, '')
    const seen: Array<[number, unknown]> = []
    const errors: string[] = []
    const checkpoints: Array<[number, number]> = []
    let failOnce = true
    const tailer = new EventsTailer(
      file,
      {
        onLine: async (line, index) => {
          if (failOnce) {
            failOnce = false
            throw new Error('ENOSPC: durable acceptance failed')
          }
          seen.push([index, line])
        },
        onMalformed: () => {},
        onCheckpoint: (offset, consumed) => {
          checkpoints.push([offset, consumed])
        },
        onError: (err) => {
          errors.push(String((err as Error).message))
        },
      },
      20,
    )
    await tailer.start()
    const l0 = '{"kind":"log","message":"zero"}\n'
    const l1 = '{"kind":"log","message":"one"}\n'
    await appendFile(file, l0 + l1)
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen.map(([i, l]) => [i, (l as { message: string }).message])).toEqual([[0, 'zero'], [1, 'one']])
    expect(errors).toEqual(['ENOSPC: durable acceptance failed'])
    await vi.waitFor(() => expect(checkpoints.at(-1)).toEqual([Buffer.byteLength(l0 + l1), 2]))
    await tailer.stop()
  })

  it('awaits an async onLine before advancing the checkpoint', async () => {
    const { file, tailer } = await makeTailer()
    await tailer.stop()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const checkpoints: number[] = []
    const slow = new EventsTailer(
      file,
      {
        onLine: async () => {
          await gate
        },
        onMalformed: () => {},
        onCheckpoint: (offset) => {
          checkpoints.push(offset)
        },
      },
      { pollMs: 20 },
    )
    await slow.start()
    await appendFile(file, '{"kind":"log","message":"held"}\n')
    await new Promise((r) => setTimeout(r, 80))
    expect(checkpoints).toEqual([])
    release()
    await vi.waitFor(() => expect(checkpoints).toHaveLength(1))
    await slow.stop()
  })
})
