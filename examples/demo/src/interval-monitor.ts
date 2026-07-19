import type { Monitor, MonitorContext, SignalDeclaration } from '@copperbox/railyard'

export const TICK_SCHEMA = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'number' } },
} as const

/**
 * The SPEC §15 trivial monitor: emits demo.tick on an interval, keeping its
 * counter in ctx.state so it survives restarts. No scheduling sugar —
 * monitors are code; setInterval exists (SPEC §9).
 */
export class IntervalMonitor implements Monitor {
  readonly name = 'interval'
  readonly emits: SignalDeclaration[] = [
    { type: 'demo.tick', payloadSchema: TICK_SCHEMA as never },
  ]
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly everyMs = 5000) {}

  async start(ctx: MonitorContext): Promise<void> {
    const tick = async () => {
      const last = ((await ctx.state.get('n')) as number | undefined) ?? 0
      const n = last + 1
      await ctx.state.set('n', n)
      ctx.log.info(`emitting demo.tick n=${n}`)
      ctx.emit({ type: 'demo.tick', payload: { n } })
    }
    await tick()
    this.timer = setInterval(() => void tick(), this.everyMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
