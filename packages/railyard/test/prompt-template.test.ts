import { describe, expect, it } from 'vitest'
import { parsePromptTemplate, renderPromptTemplate } from '../src/prompt/template.js'
import type { SignalEnvelope } from '../src/contracts/types.js'

function envelope(payload: unknown): SignalEnvelope {
  return {
    id: 'sig_test',
    timestamp: '2026-07-19T00:00:00.000Z',
    source: { kind: 'monitor', name: 'github-issues' },
    provenance: [],
    type: 'github.issue.labeled',
    payload,
  }
}

function render(source: string, payload: unknown): string {
  return renderPromptTemplate(parsePromptTemplate(source, 'test'), envelope(payload))
}

describe('parsePromptTemplate', () => {
  it('splits literals and placeholders', () => {
    const parsed = parsePromptTemplate('a {{type}} b {{payload.x}} c', 'test')
    expect(parsed.segments).toEqual([
      { kind: 'literal', text: 'a ' },
      { kind: 'placeholder', path: ['type'], raw: '{{type}}' },
      { kind: 'literal', text: ' b ' },
      { kind: 'placeholder', path: ['payload', 'x'], raw: '{{payload.x}}' },
      { kind: 'literal', text: ' c' },
    ])
  })

  it('tolerates whitespace inside braces', () => {
    expect(render('{{  type  }}', {})).toBe('github.issue.labeled')
  })

  it('handles adjacent placeholders and no literals', () => {
    expect(render('{{type}}{{id}}', {})).toBe('github.issue.labeledsig_test')
  })

  it('leaves }} without {{ as literal text', () => {
    expect(render('a }} b', {})).toBe('a }} b')
  })

  it('round-trips multi-line literal text exactly', () => {
    const source = '# Title\n\nline one\n  indented {{type}}\nlast\n'
    expect(render(source, {})).toBe('# Title\n\nline one\n  indented github.issue.labeled\nlast\n')
  })

  it.each([
    ['unclosed', 'hello {{payload.x'],
    ['empty', 'hello {{}}'],
    ['empty with spaces', 'hello {{   }}'],
    ['bad segment characters', '{{payload.items[0]}}'],
    ['trailing dot', '{{payload.}}'],
    ['leading dot', '{{.payload}}'],
    ['double dot', '{{payload..x}}'],
    ['space inside path', '{{payload x}}'],
  ])('rejects malformed placeholder: %s', (_name, source) => {
    expect(() => parsePromptTemplate(source, 'agents/foo/prompt.md')).toThrow(
      /agents\/foo\/prompt\.md: malformed placeholder at offset \d+/,
    )
  })
})

describe('renderPromptTemplate', () => {
  it('interpolates strings verbatim', () => {
    expect(render('title: {{payload.issue.title}}', { issue: { title: 'Fix the bug' } })).toBe(
      'title: Fix the bug',
    )
  })

  it('renders numbers, booleans and null as JSON literals', () => {
    expect(render('{{payload.n}}/{{payload.ok}}/{{payload.gone}}', { n: 42, ok: false, gone: null })).toBe(
      '42/false/null',
    )
  })

  it('renders objects and arrays as 2-space JSON', () => {
    expect(render('{{payload}}', { a: 1 })).toBe('{\n  "a": 1\n}')
    expect(render('{{payload.items}}', { items: [1, 2] })).toBe('[\n  1,\n  2\n]')
  })

  it('resolves envelope-root paths', () => {
    expect(render('{{type}} from {{source.kind}} {{source.name}}', {})).toBe(
      'github.issue.labeled from monitor github-issues',
    )
  })

  it('resolves array indices', () => {
    expect(render('{{payload.items.1}}', { items: ['a', 'b'] })).toBe('b')
  })

  it('resolves numeric object keys as string keys', () => {
    expect(render('{{payload.0}}', { '0': 'zero' })).toBe('zero')
  })

  it.each([
    ['missing key', '{{payload.nope}}', { x: 1 }, 'no such key: "nope"'],
    ['missing nested key', '{{payload.a.b}}', { a: {} }, 'no such key: "b"'],
    ['index out of range', '{{payload.items.5}}', { items: [1] }, 'no such array index: "5"'],
    ['non-numeric index into array', '{{payload.items.first}}', { items: [1] }, 'no such array index: "first"'],
    ['descending into a scalar', '{{payload.title.x}}', { title: 'hi' }, 'no such key: "x"'],
  ])('missing path is an error, never "": %s', (_name, source, payload, message) => {
    expect(() => render(source, payload)).toThrow(message)
  })

  it('errors name the placeholder as written', () => {
    expect(() => render('{{ payload.nope }}', {})).toThrow('{{ payload.nope }}')
  })
})
