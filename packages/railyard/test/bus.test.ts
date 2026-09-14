import { describe, expect, it, vi } from 'vitest'
import { deterministicSignalId, stampSignal } from '../src/bus/stamp.js'
import { validateSignalEnvelope } from '../src/contracts/validate.js'
import { InMemoryTransport } from '../src/bus/transport.js'
import type { SignalEnvelope } from '../src/contracts/types.js'

const MONITOR = { kind: 'monitor', name: 'demo' } as const

function tick(n = 1): SignalEnvelope {
  return stampSignal(MONITOR, { type: 'demo.tick', payload: { n } })
}

describe('stampSignal', () => {
  it('stamps id, timestamp, source, empty provenance', () => {
    const sig = tick()
    expect(sig.id).toMatch(/^sig_/)
    expect(Date.parse(sig.timestamp)).not.toBeNaN()
    expect(sig.source).toEqual(MONITOR)
    expect(sig.provenance).toEqual([])
    expect(sig.payload).toEqual({ n: 1 })
  })

  it('stamps the Signal Contract version tag on every envelope', () => {
    // Framework-set, never emitter-set (SPEC §2). The envelope schema pins it to
    // `const: "v1"`, so a stamped signal always validates as the v1 contract.
    expect(tick().contractVersion).toBe('v1')
  })

  it('rejects a malformed type, naming the emitter', () => {
    expect(() => stampSignal(MONITOR, { type: 'not a type', payload: {} })).toThrow(
      /monitor "demo"/,
    )
  })
})

describe('InMemoryTransport', () => {
  it('fans out to every subscriber', () => {
    const bus = new InMemoryTransport()
    const seen: string[] = []
    bus.subscribe((s) => {
      seen.push(`a:${s.id}`)
    })
    bus.subscribe((s) => {
      seen.push(`b:${s.id}`)
    })
    const sig = tick()
    bus.publish(sig)
    expect(seen).toEqual([`a:${sig.id}`, `b:${sig.id}`])
  })

  it('unsubscribe stops delivery', () => {
    const bus = new InMemoryTransport()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe(handler)
    bus.publish(tick())
    unsubscribe()
    bus.publish(tick())
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('isolates a throwing subscriber from the others', () => {
    const errors: unknown[] = []
    const bus = new InMemoryTransport({ onHandlerError: (err) => errors.push(err) })
    const after = vi.fn()
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe(after)
    bus.publish(tick())
    expect(after).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it('routes async subscriber rejections to onHandlerError', async () => {
    const errors: unknown[] = []
    const bus = new InMemoryTransport({ onHandlerError: (err) => errors.push(err) })
    bus.subscribe(async () => {
      throw new Error('async boom')
    })
    bus.publish(tick())
    await vi.waitFor(() => expect(errors).toHaveLength(1))
  })

  it('stop() clears subscribers', async () => {
    const bus = new InMemoryTransport()
    const handler = vi.fn()
    bus.subscribe(handler)
    await bus.stop()
    bus.publish(tick())
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('work identity and deterministic ids (recovery contract)', () => {
  it('stamps an emitter-set work identity onto the envelope, normalized', () => {
    const env = stampSignal(
      { kind: 'monitor', name: 'm' },
      { type: 'demo.tick', payload: {}, work: { key: 'issue-1', attempt: 2 } },
    )
    expect(env.work).toEqual({ key: 'issue-1', attempt: 2 })
    expect(validateSignalEnvelope(env)).toBe(true)
    expect(
      stampSignal({ kind: 'monitor', name: 'm' }, { type: 'demo.tick', payload: {} }).work,
    ).toBeUndefined()
  })

  it('rejects an invalid work identity', () => {
    expect(() =>
      stampSignal(
        { kind: 'monitor', name: 'm' },
        { type: 'demo.tick', payload: {}, work: { key: '', attempt: 0 } },
      ),
    ).toThrow(/invalid signal/)
  })

  it('derives the same signal id for the same (runId, events index), and a valid one', () => {
    const a = deterministicSignalId('2026-07-19T00-00-00.000Z--echo--aaaaaaaa', 3)
    expect(a).toBe(deterministicSignalId('2026-07-19T00-00-00.000Z--echo--aaaaaaaa', 3))
    expect(a).not.toBe(deterministicSignalId('2026-07-19T00-00-00.000Z--echo--aaaaaaaa', 4))
    const env = stampSignal({ kind: 'agent', name: 'echo' }, { type: 'x.y', payload: null }, [], { id: a })
    expect(env.id).toBe(a)
    expect(validateSignalEnvelope(env)).toBe(true)
  })
})
