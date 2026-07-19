import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvSecretsProvider, parseDotEnv } from '../src/secrets/provider.js'

describe('parseDotEnv', () => {
  it('parses plain KEY=value lines, trimming whitespace', () => {
    expect(parseDotEnv('FOO=bar\n  BAZ = qux  \n')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips comments and blank lines', () => {
    expect(parseDotEnv('# comment\n\nFOO=bar\n   # indented comment\n')).toEqual({ FOO: 'bar' })
  })

  it('splits at the first = only', () => {
    expect(parseDotEnv('URL=postgres://u:p@h/db?a=b')).toEqual({ URL: 'postgres://u:p@h/db?a=b' })
  })

  it('strips surrounding quotes; expands \\n inside double quotes only', () => {
    expect(parseDotEnv('A="line1\\nline2"\nB=\'raw\\nkept\'\nC="spaced value"')).toEqual({
      A: 'line1\nline2',
      B: 'raw\\nkept',
      C: 'spaced value',
    })
  })

  it('ignores lines without a key', () => {
    expect(parseDotEnv('=nokey\nnovalue\n')).toEqual({})
  })
})

describe('EnvSecretsProvider', () => {
  it('prefers the environment over the .env file, falls back to the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'railyard-secrets-'))
    const envFile = path.join(dir, '.env')
    await writeFile(envFile, 'FROM_FILE=file-value\nSHADOWED=file-loses\n')
    const provider = new EnvSecretsProvider({
      envFile,
      env: { SHADOWED: 'env-wins', ONLY_ENV: 'env-value' },
    })
    expect(await provider.resolve('SHADOWED')).toBe('env-wins')
    expect(await provider.resolve('ONLY_ENV')).toBe('env-value')
    expect(await provider.resolve('FROM_FILE')).toBe('file-value')
    expect(await provider.resolve('NOWHERE')).toBeUndefined()
  })

  it('treats a missing .env file as empty, not an error', async () => {
    const provider = new EnvSecretsProvider({ envFile: '/nonexistent/.env', env: {} })
    expect(await provider.resolve('ANYTHING')).toBeUndefined()
  })

  it('re-reads the file on each resolve, so rotation needs no restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'railyard-secrets-'))
    const envFile = path.join(dir, '.env')
    await writeFile(envFile, 'TOKEN=before\n')
    const provider = new EnvSecretsProvider({ envFile, env: {} })
    expect(await provider.resolve('TOKEN')).toBe('before')
    await writeFile(envFile, 'TOKEN=after\n')
    expect(await provider.resolve('TOKEN')).toBe('after')
  })
})
