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
