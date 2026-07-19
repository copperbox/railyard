import { describe, expect, it, vi } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
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
