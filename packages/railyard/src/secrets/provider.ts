import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The secrets seam (SPEC §8, invariant 7). Manifests declare names only; the
 * orchestrator resolves them here at boot (fail-fast check) and again at each
 * spawn (rotation without restart). Vault etc. plug in behind this interface.
 */
export interface SecretsProvider {
  /** Resolved value, or undefined if this provider cannot supply the name. */
  resolve(name: string): Promise<string | undefined>
}

export interface EnvSecretsProviderOptions {
  /**
   * `.env` file consulted after the environment; default `<cwd>/.env`. Missing
   * file is fine. Note the default is **cwd-relative** — the working directory
   * the process was started from, which for a workspace app run via `pnpm start`
   * is the package dir, not the repo root. Pass an explicit absolute path (e.g.
   * resolved from `import.meta.url`) if you want one `.env` regardless of cwd.
   */
  envFile?: string
  /** Environment map consulted first; default `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Default provider (SPEC §8): process env first, then a `.env` file. The file
 * is re-read on every resolve so an edited `.env` takes effect at the next
 * spawn without a restart.
 */
export class EnvSecretsProvider implements SecretsProvider {
  private readonly envFile: string
  private readonly env: Record<string, string | undefined>

  constructor(options: EnvSecretsProviderOptions = {}) {
    this.envFile = options.envFile ?? path.join(process.cwd(), '.env')
    this.env = options.env ?? process.env
  }

  async resolve(name: string): Promise<string | undefined> {
    const fromEnv = this.env[name]
    if (fromEnv !== undefined) return fromEnv
    let raw: string
    try {
      raw = await readFile(this.envFile, 'utf8')
    } catch {
      return undefined
    }
    return parseDotEnv(raw)[name]
  }
}

/**
 * Minimal `.env` parser, deliberately not the full dotenv dialect: `KEY=value`
 * lines, `#` comments, surrounding single/double quotes stripped, `\n` expanded
 * inside double quotes (multi-line secrets like PEM keys). No interpolation.
 */
export function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\n', '\n')
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}
