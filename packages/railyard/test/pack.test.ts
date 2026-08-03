import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Publish hardening (SPEC §15 M5): the tarball must ship the runtime + contracts
// and NOTHING else — no src, no tests, no build config. These assertions are
// build-independent: if dist/ isn't built the dist paths simply don't appear, and
// the allowlist still holds. dist presence in a real publish is guaranteed by the
// release process building before packing (see RELEASING.md).
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

// `npm pack --json` reports one entry per packed package, but the envelope
// changed shape in npm 12: <=11 emits an array, 12+ emits an object keyed by
// package name. We pack a single package either way, so take the lone entry.
function packedPaths(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' })
  const parsed = JSON.parse(out) as unknown
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>)
  const files = (entries[0] as { files?: { path: string }[] } | undefined)?.files
  if (!files) throw new Error(`unexpected \`npm pack --json\` output: ${out.slice(0, 200)}`)
  return files.map((f) => f.path)
}

const ALLOWED = /^(dist\/|schemas\/|package\.json$|README\.md$|LICENSE$)/
const FORBIDDEN = /(^src\/|\.test\.|tsconfig|vitest|\.map$)/

describe('npm pack', () => {
  it('publishes as a public scoped package at a real version', () => {
    expect(pkg.publishConfig?.access).toBe('public')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(pkg.version).not.toBe('0.0.0')
    expect(pkg.files).toEqual(['dist', 'schemas'])
    expect(pkg.exports['.'].import).toMatch(/^\.\/dist\//)
  })

  it('ships only dist + schemas + README + LICENSE + package.json', () => {
    const paths = packedPaths()
    for (const p of paths) expect(p, `unexpected packed path: ${p}`).toMatch(ALLOWED)
    for (const p of paths) expect(FORBIDDEN.test(p), `forbidden packed path: ${p}`).toBe(false)
    // Contracts always ship (they're on disk, build or no build).
    expect(paths.some((p) => p.startsWith('schemas/'))).toBe(true)
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
  })
})
