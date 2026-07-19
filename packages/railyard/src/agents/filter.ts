import { JSONPath } from 'jsonpath-plus'
import { deepEqual } from '../util/deep-equal.js'

/**
 * The declarative filter grammar (SPEC §3): `<jsonpath> <op> <json-literal>`,
 * ops `==` and `!=`. Deliberately tiny — if a filter can't express it, write a
 * smarter monitor. There is no escape hatch into code.
 *
 * Semantics: the JSONPath is resolved against the payload to a set of matched
 * values. `==` is true when at least one matched value structurally equals the
 * literal; `!=` is its exact negation (so a missing path satisfies `!=`).
 */
export interface ParsedFilter {
  source: string
  path: string
  op: '==' | '!='
  literal: unknown
}

export function parseFilter(source: string, context: string): ParsedFilter {
  const match = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(source.trim())
  if (!match) {
    throw new Error(
      `${context}: filter must be '<jsonpath> <op> <json-literal>' with op == or !=, got: ${source}`,
    )
  }
  const [, rawPath, op, rawLiteral] = match as unknown as [string, string, '==' | '!=', string]
  const path = rawPath.trim()
  if (!path.startsWith('$')) {
    throw new Error(`${context}: filter path must start with '$', got: ${path}`)
  }
  let literal: unknown
  try {
    literal = JSON.parse(rawLiteral)
  } catch {
    throw new Error(
      `${context}: filter comparand must be a JSON literal (quote strings), got: ${rawLiteral}`,
    )
  }
  const filter: ParsedFilter = { source, path, op, literal }
  try {
    // Dry run so syntax errors (including eval-requiring script expressions,
    // which are disabled) surface at boot, not at 2am.
    resolvePath(filter, {})
  } catch (err) {
    throw new Error(`${context}: invalid JSONPath '${path}': ${(err as Error).message}`)
  }
  return filter
}

export function evaluateFilter(filter: ParsedFilter, payload: unknown): boolean {
  const matches = resolvePath(filter, payload)
  const hit = matches.some((value) => deepEqual(value, filter.literal))
  return filter.op === '==' ? hit : !hit
}

function resolvePath(filter: ParsedFilter, payload: unknown): unknown[] {
  return JSONPath({ path: filter.path, json: payload as never, wrap: true, eval: false }) ?? []
}
