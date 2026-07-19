import { describe, expect, it } from 'vitest'
import { LineSplitter, Redactor, REDACTION_MIN_LENGTH } from '../src/secrets/redactor.js'

describe('Redactor', () => {
  it('replaces every occurrence of every registered value, naming the secret', () => {
    const r = new Redactor()
    expect(r.register('TOKEN', 'sekret-token')).toBe(true)
    expect(r.register('OTHER', 'other-value')).toBe(true)
    expect(r.redactString('a sekret-token and other-value and sekret-token again')).toBe(
      'a [REDACTED:TOKEN] and [REDACTED:OTHER] and [REDACTED:TOKEN] again',
    )
  })

  it('is a no-op with nothing registered', () => {
    expect(new Redactor().redactString('unchanged')).toBe('unchanged')
  })

  it('applies longer values first, so a superstring secret redacts whole', () => {
    const r = new Redactor()
    r.register('SHORT', 'abcdef')
    r.register('LONG', 'abcdefgh')
    expect(r.redactString('x abcdefgh y')).toBe('x [REDACTED:LONG] y')
    expect(r.redactString('x abcdef y')).toBe('x [REDACTED:SHORT] y')
  })

  it('rejects values below the minimum length and does not redact them', () => {
    const r = new Redactor()
    expect(r.register('TINY', '12345')).toBe(false)
    expect(r.redactString('contains 12345 somewhere')).toBe('contains 12345 somewhere')
    expect(REDACTION_MIN_LENGTH).toBe(6)
  })

  it('registers each line of a multi-line value (PEM keys) individually', () => {
    const r = new Redactor()
    expect(r.register('KEY', '-----BEGIN KEY-----\nAAAABBBBCCCC\n-----END KEY-----')).toBe(true)
    // A line-oriented sink sees only one line of the value at a time.
    expect(r.redactString('leaked: AAAABBBBCCCC')).toBe('leaked: [REDACTED:KEY]')
  })

  it('deep-redacts JSON values including nested strings, arrays, and keys', () => {
    const r = new Redactor()
    r.register('TOKEN', 'sekret-token')
    expect(
      r.redactJson({
        note: 'has sekret-token inside',
        nested: { list: ['ok', 'sekret-token'], n: 42, flag: true, nothing: null },
        'key-with-sekret-token': 1,
      }),
    ).toEqual({
      note: 'has [REDACTED:TOKEN] inside',
      nested: { list: ['ok', '[REDACTED:TOKEN]'], n: 42, flag: true, nothing: null },
      'key-with-[REDACTED:TOKEN]': 1,
    })
  })
})

describe('LineSplitter', () => {
  it('reassembles lines across chunk boundaries', () => {
    const s = new LineSplitter()
    expect(s.push('first li')).toEqual([])
    expect(s.push('ne\nsecond')).toEqual(['first line'])
    expect(s.push(' line\nthird\n')).toEqual(['second line', 'third'])
    expect(s.flush()).toBeNull()
  })

  it('flushes a trailing unterminated line', () => {
    const s = new LineSplitter()
    expect(s.push('no newline')).toEqual([])
    expect(s.flush()).toBe('no newline')
    expect(s.flush()).toBeNull()
  })

  it('a secret split across chunks survives reassembly for redaction', () => {
    const r = new Redactor()
    r.register('TOKEN', 'sekret-token')
    const s = new LineSplitter()
    const lines = [...s.push('prefix sekret-'), ...s.push('token suffix\n')]
    expect(lines.map((l) => r.redactString(l))).toEqual(['prefix [REDACTED:TOKEN] suffix'])
  })
})
