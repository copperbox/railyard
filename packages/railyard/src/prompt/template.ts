/**
 * prompt.md templating (SPEC §4, §15 M2). The grammar is a language-neutral
 * disk contract shared with the future Python/Rust ports, so it is deliberately
 * tiny and declarative-only — the same line the JSONPath filters hold:
 *
 * - A placeholder is `{{ <path> }}` (whitespace inside the braces optional).
 * - `<path>` is dot-separated segments; each segment matches [A-Za-z0-9_-]+
 *   (object key) or is a non-negative integer (array index).
 * - The data root is the full signal envelope — the exact JSON the container
 *   sees in input/signal.json — so {{payload.issue.title}}, {{type}} and
 *   {{source.name}} all work.
 * - No quoting, no expressions, no defaults, no escapes, no code.
 *
 * Any `{{` that does not open a well-formed placeholder is a parse error
 * (surfaced at boot, invariant 4). A path missing from the envelope is a render
 * error (fails the run before a container exists) — never a silent "".
 */

import type { SignalEnvelope } from '../contracts/types.js'

export type TemplateSegment =
  | { kind: 'literal'; text: string }
  | { kind: 'placeholder'; path: string[]; raw: string }

export interface ParsedPromptTemplate {
  source: string
  segments: TemplateSegment[]
}

const PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/

/**
 * Parse a prompt template, failing on any malformed `{{`. `context` prefixes
 * error messages (e.g. the prompt.md path) so boot failures name the culprit.
 */
export function parsePromptTemplate(source: string, context: string): ParsedPromptTemplate {
  const segments: TemplateSegment[] = []
  let cursor = 0
  while (cursor < source.length) {
    const open = source.indexOf('{{', cursor)
    if (open === -1) {
      segments.push({ kind: 'literal', text: source.slice(cursor) })
      break
    }
    if (open > cursor) segments.push({ kind: 'literal', text: source.slice(cursor, open) })
    const match = PLACEHOLDER.exec(source.slice(open))
    if (!match) {
      const snippet = source.slice(open, open + 40).split('\n')[0]
      throw new Error(
        `${context}: malformed placeholder at offset ${open}: "${snippet}" — expected {{ <dot.path> }} ` +
          `with segments matching [A-Za-z0-9_-]+. A literal "{{" is unsupported in Signal Contract v1 ` +
          `(there is no escape yet; see docs/contracts/prompt-template-grammar.md).`,
      )
    }
    segments.push({ kind: 'placeholder', path: match[1]!.split('.'), raw: match[0] })
    cursor = open + match[0].length
  }
  return { source, segments }
}

/**
 * Render a parsed template against one signal envelope. Strings interpolate
 * verbatim; numbers, booleans and null as JSON literals; objects and arrays as
 * 2-space-indented JSON. A missing path throws, naming the placeholder — a
 * present-but-null value is a value, an absent path is a bug.
 */
export function renderPromptTemplate(
  template: ParsedPromptTemplate,
  envelope: SignalEnvelope,
): string {
  let out = ''
  for (const segment of template.segments) {
    if (segment.kind === 'literal') {
      out += segment.text
      continue
    }
    out += renderValue(resolvePath(segment, envelope))
  }
  return out
}

function resolvePath(
  segment: Extract<TemplateSegment, { kind: 'placeholder' }>,
  envelope: SignalEnvelope,
): unknown {
  let current: unknown = envelope
  for (const key of segment.path) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key) || Number(key) >= current.length) {
        throw missingPath(segment, key, 'no such array index')
      }
      current = current[Number(key)]
    } else if (isPlainObject(current) && key in current) {
      current = current[key]
    } else {
      throw missingPath(segment, key, 'no such key')
    }
  }
  return current
}

function missingPath(
  segment: Extract<TemplateSegment, { kind: 'placeholder' }>,
  key: string,
  why: string,
): Error {
  return new Error(
    `prompt template: ${segment.raw.trim()} does not resolve against this signal (${why}: "${key}")`,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  return JSON.stringify(value, null, 2)
}
