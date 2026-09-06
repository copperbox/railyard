import type { ProvenanceEntry, SignalEnvelope } from '../contracts/types.js'
import { evaluateFilter } from './filter.js'
import type { LoadedAgent } from './loader.js'

/**
 * One routing decision for one agent. A signal produces at most one outcome
 * per agent; agents that match nothing produce none.
 */
export type RouteOutcome =
  /** The agent fires, via its first matching `on:` entry. */
  | { kind: 'matched'; agent: LoadedAgent; subscriptionIndex: number }
  /** A subscription matched, but the signal is the agent's own emission (SPEC §7). */
  | { kind: 'skipped'; agent: LoadedAgent; reason: 'self-trigger' }
  /** A subscription was rejected noisily: filter error or required-payload-schema failure. */
  | { kind: 'note'; agent: LoadedAgent; message: string }

/**
 * Railyard's routing semantics (SPEC §3, §7) as a pure function: no I/O, no
 * journaling, no dispatch. `Orchestrator` calls this and acts on the outcomes;
 * a host without a long-lived orchestrator can do the same.
 *
 * - Implicit fan-out: every matching agent gets a `matched` outcome, in agent order.
 * - An agent fires **at most once per signal**, via its first matching subscription.
 * - Per subscription: `type` equality, then the declarative filter (a filter error
 *   is a `note` and counts as not matched), then the required payload schema
 *   (a failure is a `note` and counts as not matched).
 * - Self-trigger guard: the agent's own emission is `skipped` unless the manifest
 *   sets `allowSelfTrigger`. Refusal is per agent — other agents still match.
 *
 * Outcomes are ordered as the checks ran, so a caller journaling them in order
 * reproduces the orchestrator's journal. Max chain depth is not checked here:
 * it applies at emission (SPEC §7), see `exceedsMaxChainDepth`.
 */
export function routeSignal(
  signal: SignalEnvelope,
  agents: readonly LoadedAgent[],
): RouteOutcome[] {
  const outcomes: RouteOutcome[] = []
  for (const agent of agents) {
    for (const [subscriptionIndex, sub] of agent.subscriptions.entries()) {
      if (sub.type !== signal.type) continue
      if (sub.filter) {
        let hit: boolean
        try {
          hit = evaluateFilter(sub.filter, signal.payload)
        } catch (err) {
          outcomes.push({
            kind: 'note',
            agent,
            message: `agent "${agent.name}": filter error on signal ${signal.id}, not matched: ${String(err)}`,
          })
          continue
        }
        if (!hit) continue
      }
      if (sub.validatePayload && !sub.validatePayload(signal.payload)) {
        // Reachable for agent-emitted types, which have no boot-time emitter schema.
        outcomes.push({
          kind: 'note',
          agent,
          message: `agent "${agent.name}": signal ${signal.id} (${signal.type}) failed its required payload schema, not matched`,
        })
        continue
      }
      if (
        signal.source.kind === 'agent' &&
        signal.source.name === agent.name &&
        !agent.manifest.allowSelfTrigger
      ) {
        outcomes.push({ kind: 'skipped', agent, reason: 'self-trigger' })
      } else {
        outcomes.push({ kind: 'matched', agent, subscriptionIndex })
      }
      break
    }
  }
  return outcomes
}

/**
 * The max-chain-depth rule (SPEC §7), applied at emission: an emission whose
 * provenance chain is already longer than `maxChainDepth` is dropped. Exposed so
 * a host ingesting signals from outside the process can apply the same rule at
 * its own ingest edge.
 */
export function exceedsMaxChainDepth(
  provenance: readonly ProvenanceEntry[],
  maxChainDepth: number,
): boolean {
  return provenance.length > maxChainDepth
}
