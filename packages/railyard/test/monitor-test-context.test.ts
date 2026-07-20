import { describe, expect, it } from 'vitest'
import type { Monitor, SignalDeclaration } from '../src/index.js'
import { createMonitorTestContext, MemoryKvStore } from '../src/index.js'

const EMITS: SignalDeclaration[] = [
  {
    type: 'demo.tick',
    payloadSchema: {
      type: 'object',
      required: ['n'],
      additionalProperties: false,
      properties: { n: { type: 'number' } },
    },
  },
  { type: 'demo.free', payloadSchema: true },
]

describe('MemoryKvStore', () => {
  it('gets, sets, and deletes', async () => {
    const kv = new MemoryKvStore()
    expect(await kv.get('k')).toBeUndefined()
    await kv.set('k', { a: 1 })
    expect(await kv.get('k')).toEqual({ a: 1 })
    await kv.delete('k')
    expect(await kv.get('k')).toBeUndefined()
  })

  it('round-trips values through JSON like the disk backend would', async () => {
    const kv = new MemoryKvStore()
    const value = { nested: [1, 'two', null] }
    await kv.set('k', value)
    const stored = await kv.get('k')
    expect(stored).toEqual(value)
    expect(stored).not.toBe(value)
    await expect(kv.set('bad', { fn: () => 1, cycle: undefined, big: 1n })).rejects.toThrow()
  })
})

describe('createMonitorTestContext', () => {
  it('records valid emissions in order', () => {
    const { ctx, emitted } = createMonitorTestContext(EMITS)
    ctx.emit({ type: 'demo.tick', payload: { n: 1 } })
    ctx.emit({ type: 'demo.free', payload: 'anything' })
    ctx.emit({ type: 'demo.tick', payload: { n: 2 } })
    expect(emitted).toEqual([
      { type: 'demo.tick', payload: { n: 1 } },
      { type: 'demo.free', payload: 'anything' },
      { type: 'demo.tick', payload: { n: 2 } },
    ])
  })

  it('throws on an undeclared type with the orchestrator message', () => {
    const { ctx, emitted } = createMonitorTestContext(EMITS, { monitorName: 'gh' })
    expect(() => ctx.emit({ type: 'demo.nope', payload: {} })).toThrow(
      'monitor "gh" emitted undeclared signal type "demo.nope"',
    )
    expect(emitted).toHaveLength(0)
  })

  it('throws on a schema-invalid payload naming the errors', () => {
    const { ctx, emitted } = createMonitorTestContext(EMITS)
    expect(() => ctx.emit({ type: 'demo.tick', payload: { n: 'not-a-number' } })).toThrow(
      /emitted "demo\.tick" with an invalid payload:.*n/,
    )
    expect(() => ctx.emit({ type: 'demo.tick', payload: { n: 1, extra: true } })).toThrow(
      /invalid payload/,
    )
    expect(emitted).toHaveLength(0)
  })

  it('rejects duplicate declarations like register() does', () => {
    expect(() =>
      createMonitorTestContext(
        [
          { type: 'demo.tick', payloadSchema: true },
          { type: 'demo.tick', payloadSchema: true },
        ],
        { monitorName: 'dup' },
      ),
    ).toThrow('monitor "dup" declares "demo.tick" twice')
  })

  it('rejects an uncompilable declared schema at creation', () => {
    expect(() =>
      createMonitorTestContext([
        { type: 'demo.bad', payloadSchema: { type: 'not-a-real-type' } },
      ]),
    ).toThrow(/demo\.bad/)
  })

  it('exposes the kv store for seeding and asserting monitor state', async () => {
    const { ctx, kv } = createMonitorTestContext(EMITS)
    await kv.set('cursor', 41)

    // A minimal monitor that reads, increments, and persists its cursor.
    const monitor: Monitor = {
      name: 'counter',
      emits: EMITS,
      async start(c) {
        const last = ((await c.state.get('cursor')) as number | undefined) ?? 0
        c.emit({ type: 'demo.tick', payload: { n: last + 1 } })
        await c.state.set('cursor', last + 1)
      },
      async stop() {},
    }
    await monitor.start(ctx)
    expect(await kv.get('cursor')).toBe(42)
  })

  it('captures log lines with levels', () => {
    const { ctx, logs } = createMonitorTestContext(EMITS)
    ctx.log.info('hello')
    ctx.log.error('boom')
    expect(logs).toEqual([
      { level: 'info', message: 'hello' },
      { level: 'error', message: 'boom' },
    ])
  })
})
