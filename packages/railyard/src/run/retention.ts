import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Retention policy (SPEC §12): whichever rule prunes more wins (the union of
 * what each selects). Unset = unlimited — the orchestrator warns loudly at
 * boot instead of ever silently deleting evidence.
 */
export interface RetentionPolicy {
  /** Prune run dirs older than this many days. */
  maxAgeDays?: number
  /** Keep at most this many newest run dirs per agent. */
  maxRunsPerAgent?: number
}

export interface RetentionSweepOptions {
  runsDir: string
  policy: RetentionPolicy
  /** Run ids currently executing — never pruned, whatever their age. */
  activeRunIds?: ReadonlySet<string>
  /** Clock override for tests. */
  now?: Date
}

/** Matches makeRunId(): `<ISO stamp, colons dashed>--<agent>--<8 hex>`. */
const RUN_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)--(.+)--([0-9a-f]{8})$/

/**
 * Prune run directories per the policy. Only directories shaped like run ids
 * are ever touched — journal.jsonl (and anything else) is structurally exempt
 * (SPEC §12). Returns the removed run ids.
 */
export async function sweepRetention(options: RetentionSweepOptions): Promise<string[]> {
  const { runsDir, policy, activeRunIds } = options
  if (policy.maxAgeDays === undefined && policy.maxRunsPerAgent === undefined) return []

  let entries
  try {
    entries = await readdir(runsDir, { withFileTypes: true })
  } catch {
    return [] // no runs dir yet — nothing to prune
  }

  interface RunDir {
    runId: string
    agent: string
    startedAt: number
  }
  const runs: RunDir[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = RUN_DIR_PATTERN.exec(entry.name)
    if (!match) continue
    const iso = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
    const startedAt = Date.parse(iso)
    if (Number.isNaN(startedAt)) continue
    runs.push({ runId: entry.name, agent: match[2]!, startedAt })
  }

  const doomed = new Set<string>()

  if (policy.maxAgeDays !== undefined) {
    const cutoff = (options.now ?? new Date()).getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000
    for (const run of runs) {
      if (run.startedAt < cutoff) doomed.add(run.runId)
    }
  }

  if (policy.maxRunsPerAgent !== undefined) {
    const byAgent = new Map<string, RunDir[]>()
    for (const run of runs) {
      const list = byAgent.get(run.agent) ?? []
      list.push(run)
      byAgent.set(run.agent, list)
    }
    for (const list of byAgent.values()) {
      list.sort((a, b) => b.startedAt - a.startedAt)
      for (const run of list.slice(policy.maxRunsPerAgent)) doomed.add(run.runId)
    }
  }

  const removed: string[] = []
  for (const runId of [...doomed].sort()) {
    if (activeRunIds?.has(runId)) continue
    await rm(path.join(runsDir, runId), { recursive: true, force: true })
    removed.push(runId)
  }
  return removed
}
