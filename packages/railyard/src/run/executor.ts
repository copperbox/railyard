import type { LoadedAgent } from '../agents/loader.js'
import { ensureAgentImage, type EnsureImageOptions } from '../docker/build.js'
import { runAgent, sweepOrphanContainers, type RunAgentParams, type RunRecord } from './runner.js'

/**
 * The execution seam (SPEC §6, invariant 7): strictly-ephemeral Docker in v1;
 * warm pools / resident agents arrive later behind this same interface.
 */
export interface AgentExecutor {
  /** Make the agent runnable (build/pull its image); returns the image ref. Failures must fail boot. */
  ensureReady(agent: LoadedAgent, options?: EnsureImageOptions): Promise<string>
  execute(params: RunAgentParams): Promise<RunRecord>
  /** Boot-time cleanup of anything a crashed process left behind. Returns what was removed. */
  sweep(runsDir: string): Promise<string[]>
}

export class DockerExecutor implements AgentExecutor {
  ensureReady(agent: LoadedAgent, options?: EnsureImageOptions): Promise<string> {
    return ensureAgentImage(agent, options)
  }

  execute(params: RunAgentParams): Promise<RunRecord> {
    return runAgent(params)
  }

  sweep(runsDir: string): Promise<string[]> {
    return sweepOrphanContainers(runsDir)
  }
}
