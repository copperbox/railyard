import type { JsonSchema, SignalDeclaration } from '../contracts/types.js'
import { deepEqual } from '../util/deep-equal.js'
import type { LoadedAgent } from './loader.js'

/**
 * Boot-time subscription check (SPEC §3): every emitter schema must be
 * compatible with the agent's required schema.
 *
 * M0 rule: compatible = deep structural equality of the two schema documents.
 * True JSON Schema subsumption is undecidable in general; equality is
 * strict-but-honest and can be replaced here without changing the boot step.
 */
export function schemasCompatible(emitter: JsonSchema, required: JsonSchema): boolean {
  return deepEqual(emitter, required)
}

export interface DeclaredEmission {
  monitor: string
  declaration: SignalDeclaration
}

export interface CompatibilityReport {
  errors: string[]
  /** Subscriptions that could not be checked (no registered emitter declares the type). */
  unchecked: string[]
}

export function checkSubscriptionCompatibility(
  agents: LoadedAgent[],
  emissions: DeclaredEmission[],
): CompatibilityReport {
  const byType = new Map<string, DeclaredEmission[]>()
  for (const emission of emissions) {
    const list = byType.get(emission.declaration.type) ?? []
    list.push(emission)
    byType.set(emission.declaration.type, list)
  }

  const errors: string[] = []
  const unchecked: string[] = []
  for (const agent of agents) {
    for (const sub of agent.subscriptions) {
      if (sub.payloadSchema === null) continue
      const emitters = byType.get(sub.type)
      if (!emitters || emitters.length === 0) {
        // Agent-emitted types have no boot-time declaration in M0; noted, not fatal.
        unchecked.push(`agent "${agent.name}" requires a schema for "${sub.type}" but no registered monitor declares that type`)
        continue
      }
      for (const emitter of emitters) {
        if (!schemasCompatible(emitter.declaration.payloadSchema, sub.payloadSchema)) {
          errors.push(
            `agent "${agent.name}" subscription to "${sub.type}" requires a payload schema ` +
              `(${sub.payloadSchemaPath}) that does not match what monitor "${emitter.monitor}" declares. ` +
              `M0 compatibility means structurally identical schema documents.`,
          )
        }
      }
    }
  }
  return { errors, unchecked }
}
