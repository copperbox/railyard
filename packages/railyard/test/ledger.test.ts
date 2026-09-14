import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
import { LEDGER_FILE_NAME, WorkLedger, payloadHash } from '../src/run/ledger.js'
import { UnsupportedRecordError } from '../src/run/lifecycle.js'

const SRC = { kind: 'monitor', name: 'm' } as const
const sig = (payload: unknown, work?: { key: string; attempt?: number }) =>
  stampSignal(SRC, { type: 'demo.tick', payload, ...(work ? { work } : {}) })

async function fresh() {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-ledger-'))
  const ledger = new WorkLedger(runsDir)
  await ledger.load()
  return { runsDir, ledger }
}

describe('WorkLedger', () => {
  it('starts empty, persists atomically, and reloads what it wrote', async () => {
    const { runsDir, ledger } = await fresh()
    const s = sig({ n: 1 }, { key: 'issue-1' })
    ledger.noteSignal(s.id)
    ledger.accept('echo', s)
    await ledger.flush()
    const again = new WorkLedger(runsDir)
    await again.load()
    expect(again.hasSignal(s.id)).toBe(true)
    expect(again.delivery('echo', s.id)).toMatchObject({ status: 'queued', runId: null })
    expect(again.findWork('echo', { key: 'issue-1' })).toMatchObject({
      attempt: 1,
      signalId: s.id,
      payloadHash: payloadHash({ n: 1 }),
    })
  })

  it('accept is idempotent on (agent, signalId) and scopes work per agent', async () => {
    const { ledger } = await fresh()
    const s = sig({ n: 1 }, { key: 'issue-1' })
    const first = ledger.accept('echo', s)
    expect(ledger.accept('echo', s)).toBe(first)
    ledger.accept('other', s)
    expect(ledger.findWork('other', { key: 'issue-1' })?.agent).toBe('other')
    expect(ledger.deliveries()).toHaveLength(2)
  })

  it('status transitions flow through to the work identity', async () => {
    const { ledger } = await fresh()
    const s = sig({ n: 1 }, { key: 'issue-1', attempt: 2 })
    ledger.accept('echo', s)
    ledger.setStatus('echo', s.id, 'active', 'run-1')
    expect(ledger.findWork('echo', { key: 'issue-1', attempt: 2 })).toMatchObject({
      status: 'active',
      runId: 'run-1',
    })
    ledger.setStatus('echo', s.id, 'done', null)
    expect(ledger.delivery('echo', s.id)?.doneAt).not.toBeNull()
    expect(ledger.findWork('echo', { key: 'issue-1', attempt: 2 })?.status).toBe('done')
    // A different attempt is a different identity.
    expect(ledger.findWork('echo', { key: 'issue-1' })).toBeUndefined()
  })

  it('drop forgets a delivery and its work identity', async () => {
    const { ledger } = await fresh()
    const s = sig({}, { key: 'k' })
    ledger.accept('echo', s)
    ledger.drop('echo', s.id)
    expect(ledger.delivery('echo', s.id)).toBeUndefined()
    expect(ledger.findWork('echo', { key: 'k' })).toBeUndefined()
  })

  it('prunes only done entries older than the window; queued/active never expire', async () => {
    const { ledger } = await fresh()
    const old = new Date('2026-01-01T00:00:00.000Z')
    const done = sig({}, { key: 'done' })
    const active = sig({}, { key: 'active' })
    ledger.noteSignal(done.id, old)
    ledger.noteSignal(active.id, old)
    ledger.accept('echo', done, old)
    ledger.accept('echo', active, old)
    ledger.setStatus('echo', done.id, 'done', 'r', old)
    ledger.setStatus('echo', active.id, 'active', 'r2', old)
    const removed = ledger.prune(24 * 3600 * 1000, new Date('2026-02-01T00:00:00.000Z'))
    expect(removed).toBe(4) // 2 signal ids + 1 delivery + 1 work
    expect(ledger.hasSignal(done.id)).toBe(false)
    expect(ledger.delivery('echo', done.id)).toBeUndefined()
    expect(ledger.delivery('echo', active.id)?.status).toBe('active')
    expect(ledger.findWork('echo', { key: 'active' })).toBeDefined()
  })

  it('refuses an unsupported ledger version', async () => {
    const { runsDir } = await fresh()
    await writeFile(path.join(runsDir, LEDGER_FILE_NAME), JSON.stringify({ ledgerVersion: 7 }))
    const ledger = new WorkLedger(runsDir)
    await expect(ledger.load()).rejects.toThrow(UnsupportedRecordError)
  })

  it('payloadHash is independent of key order', () => {
    expect(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(payloadHash({ b: [1, { d: 3, c: 2 }], a: 1 }))
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
  })

  it('a flush with nothing new does not rewrite the file', async () => {
    const { runsDir, ledger } = await fresh()
    ledger.noteSignal('sig_x')
    await ledger.flush()
    const before = await readFile(path.join(runsDir, LEDGER_FILE_NAME), 'utf8')
    await ledger.flush()
    expect(await readFile(path.join(runsDir, LEDGER_FILE_NAME), 'utf8')).toBe(before)
  })
})
