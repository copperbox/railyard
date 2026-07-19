import type { LoadedAgent } from '../agents/loader.js'
import { docker, dockerOk, imageExists } from './cli.js'
import { hashAgentFolder, imageTagFor } from './hash.js'

export interface EnsureImageOptions {
  /** Receives docker build/pull progress lines. */
  onProgress?: (line: string) => void
}

/**
 * Make sure the agent's image exists locally; returns the image reference to
 * run. Dockerfile agents build at boot, tagged by folder content hash — an
 * unchanged folder is a cache hit (SPEC §11). `image:` agents are verified
 * (local inspect, else pull) instead. Failure here must fail boot (invariant 4).
 */
export async function ensureAgentImage(
  agent: LoadedAgent,
  options: EnsureImageOptions = {},
): Promise<string> {
  const onLine = options.onProgress ?? (() => {})

  if (agent.imageSource.kind === 'image') {
    const ref = agent.imageSource.ref
    if (await imageExists(ref)) return ref
    await dockerOk(['pull', ref], `agent "${agent.name}"`, {
      onStdoutLine: onLine,
      onStderrLine: onLine,
    })
    return ref
  }

  const tag = imageTagFor(agent.name, await hashAgentFolder(agent.dir))
  if (await imageExists(tag)) {
    onLine(`image ${tag} up to date (content hash unchanged)`)
    return tag
  }
  onLine(`building ${tag} from ${agent.dir}`)
  await dockerOk(['build', '--tag', tag, agent.dir], `agent "${agent.name}"`, {
    onStdoutLine: onLine,
    onStderrLine: onLine,
  })
  return tag
}

/** True when a docker daemon is reachable — used to gate integration tests. */
export async function dockerDaemonAvailable(): Promise<boolean> {
  return (await docker(['info', '--format', '{{.ServerVersion}}'])).code === 0
}
