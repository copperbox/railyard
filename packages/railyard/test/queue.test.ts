import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
import { UnsupportedRecordError } from '../src/run/lifecycle.js'
import { DurableQueue, QUEUE_DIR_NAME } from '../src/run/queue.js'

const sig = (n: number) => stampSignal({ kind: 'monitor', name: 'm' }, { type: 'demo.tick', payload: { n } })

describe('DurableQueue', () => {
  it('accepts, lists oldest-first, and removes', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-queue-'))
    const queue = new DurableQueue(runsDir)
    expect(await queue.load()).toEqual([])
    const a = sig(1)
    const b = sig(2)
    await queue.accept('echo', a, new Date('2026-07-19T00:00:01.000Z'))
    await queue.accept('echo', b, new Date('2026-07-19T00:00:00.000Z'))
    const loaded = await queue.load()
    expect(loaded.map((e) => e.signal.id)).toEqual([b.id, a.id])
    expect(loaded[0]).toMatchObject({ queueVersion: 1, agent: 'echo' })
    await queue.remove('echo', b.id)
    await queue.remove('echo', 'never-there')
    expect((await queue.load()).map((e) => e.signal.id)).toEqual([a.id])
  })

  it('re-accepting the same delivery overwrites instead of duplicating', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-queue-'))
    const queue = new DurableQueue(runsDir)
    const a = sig(1)
    await queue.accept('echo', a)
    await queue.accept('echo', a)
    expect(await readdir(path.join(runsDir, QUEUE_DIR_NAME))).toHaveLength(1)
  })

  it('refuses an unsupported entry version', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-queue-'))
    const queue = new DurableQueue(runsDir)
    await queue.accept('echo', sig(1))
    await writeFile(path.join(queue.dir, 'echo--sig_future.json'), JSON.stringify({ queueVersion: 2 }))
    await expect(queue.load()).rejects.toThrow(UnsupportedRecordError)
  })
})
