import type { LoadedAgent } from '../agents/loader.js'
import { ensureAgentImage, type EnsureImageOptions } from '../docker/build.js'
import type { RunLifecycleRecord } from './lifecycle.js'
import {
  observeRun,
  resumeRun,
  runAgent,
  sweepOrphanContainers,
  type ResumeRunParams,
  type RunAgentParams,
  type RunObservation,
  type RunOutcome,
} from './runner.js'

/**
 * The execution seam (SPEC §6, invariant 7). Ephemeral Docker in v1; the
 * recovery half of the contract (observe/resume) is what lets an orchestrator
 * restart without stopping the containers it launched (SPEC §6.5).
 * Applications never inspect the backend themselves — everything they need
 * comes through the orchestrator's journal.
 */
export interface AgentExecutor {
  /** Make the agent runnable (build/pull its image); returns the image ref. Failures must fail boot. */
  ensureReady(agent: LoadedAgent, options?: EnsureImageOptions): Promise<string>
  /**
   * Launch a run from its persisted intent record and supervise it to the end
   * — or until told to detach. Must advance the lifecycle record through every
   * transition it performs.
   */
  execute(params: RunAgentParams): Promise<RunOutcome>
  /**
   * Report a persisted run's container state without changing it. Must throw
   * (not report `missing`) when the backend cannot answer.
   */
  observe(lifecycle: RunLifecycleRecord): Promise<RunObservation>
  /** Resume supervising a run observed as created/running/exited. */
  resume(params: ResumeRunParams): Promise<RunOutcome>
  /**
   * Remove backend resources labeled for this runs directory whose run id is
   * not in `keep` — things with no record to recover from. Returns what went.
   */
  sweep(runsDir: string, keep: ReadonlySet<string>): Promise<string[]>
}

export class DockerExecutor implements AgentExecutor {
  ensureReady(agent: LoadedAgent, options?: EnsureImageOptions): Promise<string> {
    return ensureAgentImage(agent, options)
  }

  execute(params: RunAgentParams): Promise<RunOutcome> {
    return runAgent(params)
  }

  observe(lifecycle: RunLifecycleRecord): Promise<RunObservation> {
    return observeRun(lifecycle)
  }

  resume(params: ResumeRunParams): Promise<RunOutcome> {
    return resumeRun(params)
  }

  sweep(runsDir: string, keep: ReadonlySet<string>): Promise<string[]> {
    return sweepOrphanContainers(runsDir, keep)
  }
}
