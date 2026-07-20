import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import { RESERVED_AGENT_ENV_VARS, type AgentManifest, type JsonSchema } from '../contracts/types.js'
import {
  compilePayloadSchema,
  formatAjvErrors,
  validateAgentManifest,
} from '../contracts/validate.js'
import { parsePromptTemplate, type ParsedPromptTemplate } from '../prompt/template.js'
import { parseFilter, type ParsedFilter } from './filter.js'

export interface LoadedSubscription {
  type: string
  filter: ParsedFilter | null
  /** Raw schema as loaded from disk; null when the subscription accepts any payload. */
  payloadSchema: JsonSchema | null
  payloadSchemaPath: string | null
  validatePayload: ValidateFunction | null
}

export type ImageSource = { kind: 'dockerfile' } | { kind: 'image'; ref: string }

export interface LoadedAgent {
  name: string
  dir: string
  manifest: AgentManifest
  subscriptions: LoadedSubscription[]
  imageSource: ImageSource
  /**
   * Parsed prompt.md, when the folder has one (SPEC §4). Rendered per spawn
   * and mounted at $AGENT_PROMPT_FILE; null = promptless agent, no file, no var.
   */
  promptTemplate: ParsedPromptTemplate | null
}

export interface LoadAgentsResult {
  agents: LoadedAgent[]
  /** Subdirectories without a manifest.yaml — surfaced so a typo can't silently drop an agent. */
  skipped: string[]
}

/**
 * Load every agent folder under `agentsDir`. Pure data loading: nothing in the
 * folder is executed on the host (SPEC §4, invariant 2). Any invalid folder
 * fails the whole load — fail loudly at boot (invariant 4).
 */
export async function loadAgents(agentsDir: string): Promise<LoadAgentsResult> {
  let entries
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch {
    throw new Error(`agents directory not readable: ${agentsDir}`)
  }

  const agents: LoadedAgent[] = []
  const skipped: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = path.join(agentsDir, entry.name)
    if (!(await fileExists(path.join(dir, 'manifest.yaml')))) {
      skipped.push(dir)
      continue
    }
    agents.push(await loadAgentFolder(dir))
  }

  const byName = new Map<string, string>()
  for (const agent of agents) {
    const existing = byName.get(agent.name)
    if (existing) {
      throw new Error(`duplicate agent name "${agent.name}" in ${existing} and ${agent.dir}`)
    }
    byName.set(agent.name, agent.dir)
  }
  return { agents, skipped }
}

export async function loadAgentFolder(dir: string): Promise<LoadedAgent> {
  const manifestPath = path.join(dir, 'manifest.yaml')
  let parsed: unknown
  try {
    parsed = parseYaml(await readFile(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`${manifestPath}: not valid YAML: ${(err as Error).message}`)
  }
  if (!validateAgentManifest(parsed)) {
    throw new Error(
      `${manifestPath}: invalid manifest: ${formatAjvErrors(validateAgentManifest.errors)}`,
    )
  }
  const manifest = parsed as AgentManifest

  for (const secret of manifest.secrets) {
    if ((RESERVED_AGENT_ENV_VARS as readonly string[]).includes(secret)) {
      throw new Error(
        `${manifestPath}: secret "${secret}" collides with a reserved container-contract env var (SPEC §5)`,
      )
    }
  }

  const hasDockerfile = await fileExists(path.join(dir, 'Dockerfile'))
  if (manifest.image !== undefined && hasDockerfile) {
    throw new Error(
      `${dir}: has both a Dockerfile and 'image:' in the manifest — pick one (SPEC §4)`,
    )
  }
  if (manifest.image === undefined && !hasDockerfile) {
    throw new Error(`${dir}: needs either a Dockerfile or 'image:' in the manifest (SPEC §4)`)
  }
  const imageSource: ImageSource =
    manifest.image !== undefined ? { kind: 'image', ref: manifest.image } : { kind: 'dockerfile' }

  const subscriptions: LoadedSubscription[] = []
  for (const [i, sub] of manifest.on.entries()) {
    const context = `${manifestPath}: on[${i}] (${sub.type})`
    const filter = sub.filter !== undefined ? parseFilter(sub.filter, context) : null

    let payloadSchema: JsonSchema | null = null
    let payloadSchemaPath: string | null = null
    let validatePayload: ValidateFunction | null = null
    if (sub.payloadSchema !== undefined) {
      payloadSchemaPath = path.resolve(dir, sub.payloadSchema)
      if (path.relative(dir, payloadSchemaPath).startsWith('..')) {
        throw new Error(`${context}: payloadSchema must live inside the agent folder`)
      }
      let raw: string
      try {
        raw = await readFile(payloadSchemaPath, 'utf8')
      } catch {
        throw new Error(`${context}: payloadSchema file not readable: ${sub.payloadSchema}`)
      }
      try {
        payloadSchema = JSON.parse(raw) as JsonSchema
      } catch (err) {
        throw new Error(
          `${context}: payloadSchema is not valid JSON (${(err as Error).message}): ${sub.payloadSchema}`,
        )
      }
      validatePayload = compilePayloadSchema(payloadSchema, context)
    }
    subscriptions.push({ type: sub.type, filter, payloadSchema, payloadSchemaPath, validatePayload })
  }

  // prompt.md parses at boot so a malformed template fails loudly (invariant 4),
  // for Dockerfile and image: agents alike — the template is host-side data.
  const promptPath = path.join(dir, 'prompt.md')
  let promptTemplate: ParsedPromptTemplate | null = null
  if (await fileExists(promptPath)) {
    promptTemplate = parsePromptTemplate(await readFile(promptPath, 'utf8'), promptPath)
  }

  return { name: manifest.name, dir, manifest, subscriptions, imageSource, promptTemplate }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}
