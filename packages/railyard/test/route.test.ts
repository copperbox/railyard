import { describe, expect, it } from 'vitest'
import { compilePayloadSchema } from '../src/contracts/validate.js'
import type { AgentManifest, SignalEnvelope, SignalSource } from '../src/contracts/types.js'
import { parseFilter } from '../src/agents/filter.js'
import type { LoadedAgent, LoadedSubscription } from '../src/agents/loader.js'
import { exceedsMaxChainDepth, routeSignal, type RouteOutcome } from '../src/agents/route.js'
import { stampSignal } from '../src/bus/stamp.js'

interface SubSpec {
  type: string
  filter?: string
  payloadSchema?: Record<string, unknown>
}

/** Build a LoadedAgent in memory — the shape `loadAgents` produces, minus the disk. */
function agent(
  name: string,
  subs: SubSpec[],
  manifestExtra: Partial<AgentManifest> = {},
): LoadedAgent {
  const manifest: AgentManifest = {
    name,
    on: subs.map((s) => ({ type: s.type, ...(s.filter !== undefined ? { filter: s.filter } : {}) })),
    secrets: [],
    concurrency: 1,
    timeout: 900,
    network: 'default',
    allowSelfTrigger: false,
    ...manifestExtra,
  }
  const subscriptions: LoadedSubscription[] = subs.map((s, i) => ({
    type: s.type,
    filter: s.filter !== undefined ? parseFilter(s.filter, `${name} on[${i}]`) : null,
    payloadSchema: s.payloadSchema ?? null,
    payloadSchemaPath: s.payloadSchema ? `/agents/${name}/schema-${i}.json` : null,
    validatePayload: s.payloadSchema
      ? compilePayloadSchema(s.payloadSchema, `${name} on[${i}]`)
      : null,
  }))
  return {
    name,
    dir: `/agents/${name}`,
    manifest,
    subscriptions,
    imageSource: { kind: 'dockerfile' },
    promptTemplate: null,
  }
}

const MONITOR: SignalSource = { kind: 'monitor', name: 'ticker' }

function signal(type: string, payload: unknown, source: SignalSource = MONITOR): SignalEnvelope {
  return stampSignal(source, { type, payload })
}

const N_SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } }

function kinds(outcomes: RouteOutcome[]): string[] {
  return outcomes.map((o) => `${o.agent.name}:${o.kind}`)
}

describe('routeSignal (SPEC §3 routing as a pure function)', () => {
  it('matches on type equality and reports the subscription index', () => {
    const echo = agent('echo', [{ type: 'other.thing' }, { type: 'demo.tick' }])
    const outcomes = routeSignal(signal('demo.tick', { n: 1 }), [echo])
    expect(outcomes).toEqual([{ kind: 'matched', agent: echo, subscriptionIndex: 1 }])
  })

  it('returns nothing for an agent with no subscription of that type', () => {
    const echo = agent('echo', [{ type: 'demo.tick' }])
    expect(routeSignal(signal('unrelated.event', {}), [echo])).toEqual([])
  })

  it('implicit fan-out: every matching agent is matched, in agent order (SPEC §3)', () => {
    const a = agent('a', [{ type: 'demo.tick' }])
    const b = agent('b', [{ type: 'nope' }])
    const c = agent('c', [{ type: 'demo.tick' }])
    const outcomes = routeSignal(signal('demo.tick', { n: 1 }), [a, b, c])
    expect(kinds(outcomes)).toEqual(['a:matched', 'c:matched'])
  })

  it('applies declarative filters; a non-matching filter yields no outcome', () => {
    const picky = agent('picky', [{ type: 'demo.tick', filter: '$.n == 2' }])
    expect(routeSignal(signal('demo.tick', { n: 1 }), [picky])).toEqual([])
    expect(kinds(routeSignal(signal('demo.tick', { n: 2 }), [picky]))).toEqual(['picky:matched'])
  })

  it('a filter error is a note, not a match, and does not stop later subscriptions', () => {
    // parseFilter rejects bad JSONPath at load time, so hand-build a filter that
    // only blows up when evaluated — the runtime failure the note guards against.
    const shaky = agent('shaky', [{ type: 'demo.tick' }, { type: 'demo.tick' }])
    shaky.subscriptions[0]!.filter = { source: '$..[?(@.boom(] == 1', path: '$..[?(@.boom(]', op: '==', literal: 1 }
    const sig = signal('demo.tick', { n: 1 })
    const outcomes = routeSignal(sig, [shaky])
    expect(kinds(outcomes)).toEqual(['shaky:note', 'shaky:matched'])
    const note = outcomes[0] as Extract<RouteOutcome, { kind: 'note' }>
    expect(note.message).toContain('agent "shaky"')
    expect(note.message).toContain(sig.id)
    expect(note.message).toContain('filter error')
    expect(outcomes[1]).toMatchObject({ kind: 'matched', subscriptionIndex: 1 })
  })

  it('a payload failing the required schema is a note, and the subscription is not matched', () => {
    const strict = agent('strict', [{ type: 'demo.tick', payloadSchema: N_SCHEMA }])
    const sig = signal('demo.tick', { n: 'not-a-number' })
    const outcomes = routeSignal(sig, [strict])
    expect(kinds(outcomes)).toEqual(['strict:note'])
    const note = outcomes[0] as Extract<RouteOutcome, { kind: 'note' }>
    expect(note.message).toContain('agent "strict"')
    expect(note.message).toContain(sig.id)
    expect(note.message).toContain('required payload schema')
    expect(kinds(routeSignal(signal('demo.tick', { n: 1 }), [strict]))).toEqual(['strict:matched'])
  })

  it('an agent fires at most once per signal, via its first matching subscription', () => {
    const eager = agent('eager', [
      { type: 'demo.tick', filter: '$.n == 99' },
      { type: 'demo.tick' },
      { type: 'demo.tick' },
    ])
    const outcomes = routeSignal(signal('demo.tick', { n: 1 }), [eager])
    expect(outcomes).toEqual([{ kind: 'matched', agent: eager, subscriptionIndex: 1 }])
  })

  it('refuses a self-trigger by default (SPEC §7), per agent — other agents still match', () => {
    const emitter = agent('emitter', [{ type: 'emitter.done' }])
    const other = agent('other', [{ type: 'emitter.done' }])
    const sig = signal('emitter.done', {}, { kind: 'agent', name: 'emitter' })
    const outcomes = routeSignal(sig, [emitter, other])
    expect(outcomes).toEqual([
      { kind: 'skipped', agent: emitter, reason: 'self-trigger' },
      { kind: 'matched', agent: other, subscriptionIndex: 0 },
    ])
  })

  it('a refused self-trigger consumes the agent for that signal — later subscriptions do not fire', () => {
    const emitter = agent('emitter', [{ type: 'emitter.done' }, { type: 'emitter.done' }])
    const sig = signal('emitter.done', {}, { kind: 'agent', name: 'emitter' })
    expect(kinds(routeSignal(sig, [emitter]))).toEqual(['emitter:skipped'])
  })

  it('allowSelfTrigger: true lets the agent match its own emission', () => {
    const looper = agent('looper', [{ type: 'looper.done' }], { allowSelfTrigger: true })
    const sig = signal('looper.done', {}, { kind: 'agent', name: 'looper' })
    expect(kinds(routeSignal(sig, [looper]))).toEqual(['looper:matched'])
  })

  it('a same-named monitor source is not a self-trigger', () => {
    const echo = agent('echo', [{ type: 'demo.tick' }])
    const sig = signal('demo.tick', {}, { kind: 'monitor', name: 'echo' })
    expect(kinds(routeSignal(sig, [echo]))).toEqual(['echo:matched'])
  })

  it('is pure: no mutation of the signal or the agents', () => {
    const echo = agent('echo', [{ type: 'demo.tick', filter: '$.n == 1' }])
    const sig = signal('demo.tick', { n: 1 })
    const sigBefore = structuredClone(sig)
    const agentsBefore = JSON.stringify([echo])
    routeSignal(sig, [echo])
    routeSignal(sig, [echo])
    expect(sig).toEqual(sigBefore)
    expect(JSON.stringify([echo])).toBe(agentsBefore)
  })
})

describe('exceedsMaxChainDepth (SPEC §7, checked at emission)', () => {
  it('is false at or below the limit and true beyond it', () => {
    const link = { source: { kind: 'agent' as const, name: 'a' }, signalId: 's', signalType: 'a.done' }
    expect(exceedsMaxChainDepth([], 5)).toBe(false)
    expect(exceedsMaxChainDepth(Array(5).fill(link), 5)).toBe(false)
    expect(exceedsMaxChainDepth(Array(6).fill(link), 5)).toBe(true)
  })
})
