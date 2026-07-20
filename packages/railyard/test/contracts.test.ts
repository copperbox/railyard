import { describe, expect, it } from 'vitest'
import { newSignalId } from '../src/contracts/id.js'
import {
  compilePayloadSchema,
  formatAjvErrors,
  validateAgentManifest,
  validateEventsLine,
  validateSignalEnvelope,
} from '../src/contracts/validate.js'
import type { AgentManifest } from '../src/contracts/types.js'

function goodEnvelope() {
  return {
    contractVersion: 'v1',
    id: newSignalId(),
    timestamp: new Date().toISOString(),
    source: { kind: 'monitor', name: 'github-issues' },
    provenance: [],
    type: 'github.issue.labeled',
    payload: { label: 'needs-review' },
  }
}

describe('signal envelope schema', () => {
  it('accepts a well-formed envelope', () => {
    expect(validateSignalEnvelope(goodEnvelope())).toBe(true)
  })

  it('accepts a provenance chain', () => {
    const env = goodEnvelope()
    env.provenance = [
      {
        source: { kind: 'agent', name: 'github-reviewer' },
        signalId: newSignalId(),
        signalType: 'github.issue.labeled',
      },
    ] as never
    expect(validateSignalEnvelope(env)).toBe(true)
  })

  it.each([
    ['missing id', (e: any) => delete e.id],
    ['bad id shape', (e: any) => (e.id = 'not-a-signal-id')],
    ['bad timestamp', (e: any) => (e.timestamp = 'yesterday')],
    ['bad source kind', (e: any) => (e.source.kind = 'webhook')],
    ['empty type', (e: any) => (e.type = '')],
    ['type with spaces', (e: any) => (e.type = 'github issue')],
    ['missing payload', (e: any) => delete e.payload],
    ['extra envelope key', (e: any) => (e.dedupKey = 'x')],
    ['missing contractVersion', (e: any) => delete e.contractVersion],
    ['unknown contractVersion', (e: any) => (e.contractVersion = 'v2')],
  ])('rejects %s', (_name, mutate) => {
    const env = goodEnvelope() as any
    mutate(env)
    expect(validateSignalEnvelope(env)).toBe(false)
  })
})

describe('agent manifest schema', () => {
  it('accepts the SPEC §4 example shape and applies defaults', () => {
    const manifest = {
      name: 'github-reviewer',
      on: [
        {
          type: 'github.issue.labeled',
          filter: '$.label == "needs-review"',
          payloadSchema: './schemas/issue-labeled.json',
        },
      ],
      secrets: ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'],
    }
    expect(validateAgentManifest(manifest)).toBe(true)
    const normalized = manifest as unknown as AgentManifest
    expect(normalized.concurrency).toBe(1)
    expect(normalized.timeout).toBe(900)
    expect(normalized.network).toBe('default')
    expect(normalized.allowSelfTrigger).toBe(false)
  })

  it('accepts explicit timeout: null (run forever, SPEC §6)', () => {
    expect(
      validateAgentManifest({ name: 'a', on: [{ type: 't' }], timeout: null }),
    ).toBe(true)
  })

  it.each([
    ['missing on', { name: 'a' }],
    ['empty on', { name: 'a', on: [] }],
    ['uppercase name', { name: 'GithubReviewer', on: [{ type: 't' }] }],
    ['lowercase secret name', { name: 'a', on: [{ type: 't' }], secrets: ['token'] }],
    ['zero concurrency', { name: 'a', on: [{ type: 't' }], concurrency: 0 }],
    ['unknown network', { name: 'a', on: [{ type: 't' }], network: 'host' }],
    ['unknown top-level key', { name: 'a', on: [{ type: 't' }], entrypoint: 'x' }],
    ['unknown subscription key', { name: 'a', on: [{ type: 't', when: 'x' }] }],
  ])('rejects %s', (_name, manifest) => {
    expect(validateAgentManifest(manifest)).toBe(false)
  })
})

describe('events line schema', () => {
  it('accepts a signal line', () => {
    expect(
      validateEventsLine({ kind: 'signal', type: 'review.completed', payload: {} }),
    ).toBe(true)
  })

  it('accepts a log line without level', () => {
    expect(validateEventsLine({ kind: 'log', message: 'hello' })).toBe(true)
  })

  it.each([
    ['unknown kind', { kind: 'metric', name: 'x' }],
    ['signal without payload', { kind: 'signal', type: 't' }],
    ['log without message', { kind: 'log', level: 'info' }],
    ['bad log level', { kind: 'log', level: 'trace', message: 'x' }],
  ])('rejects %s', (_name, line) => {
    expect(validateEventsLine(line)).toBe(false)
  })
})

describe('payload schema compilation', () => {
  it('compiles and validates a user schema', () => {
    const validate = compilePayloadSchema(
      { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
      'test',
    )
    expect(validate({ n: 1 })).toBe(true)
    expect(validate({})).toBe(false)
  })

  it('names the context on an uncompilable schema', () => {
    expect(() =>
      compilePayloadSchema({ type: 'not-a-type' }, 'monitor demo, type demo.tick'),
    ).toThrow(/monitor demo, type demo\.tick/)
  })
})

describe('helpers', () => {
  it('newSignalId is sig_-prefixed and unique', () => {
    const a = newSignalId()
    const b = newSignalId()
    expect(a).toMatch(/^sig_[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })

  it('formatAjvErrors names the failing path', () => {
    validateAgentManifest({ name: 'a', on: [] })
    expect(formatAjvErrors(validateAgentManifest.errors)).toContain('/on')
  })
})
