import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import agentManifestSchema from '../../schemas/agent-manifest.schema.json'
import eventsLineSchema from '../../schemas/events-line.schema.json'
import signalEnvelopeSchema from '../../schemas/signal-envelope.schema.json'
import type { AgentManifest, EventsLine, JsonSchema, SignalEnvelope } from './types.js'

/**
 * One shared ajv instance for the framework's own contract schemas.
 * `useDefaults` fills manifest defaults in place, so a validated manifest
 * is also a normalized one.
 */
const ajv = new Ajv2020({ allErrors: true, useDefaults: true })
addFormats(ajv)

export const validateSignalEnvelope: ValidateFunction<SignalEnvelope> =
  ajv.compile<SignalEnvelope>(signalEnvelopeSchema)

export const validateAgentManifest: ValidateFunction<AgentManifest> =
  ajv.compile<AgentManifest>(agentManifestSchema)

export const validateEventsLine: ValidateFunction<EventsLine> =
  ajv.compile<EventsLine>(eventsLineSchema)

/**
 * Compile a user-supplied payload schema (a monitor's declared emission or an
 * agent's required schema). Uses a separate ajv instance per call site's schema
 * set so user `$id` collisions cannot poison the framework instance.
 */
export function compilePayloadSchema(schema: JsonSchema, context: string): ValidateFunction {
  const userAjv = new Ajv2020({ allErrors: true })
  addFormats(userAjv)
  try {
    return userAjv.compile(schema)
  } catch (err) {
    throw new Error(`invalid JSON Schema for ${context}: ${(err as Error).message}`)
  }
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown validation error'
  return errors
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? ''}`.trim())
    .join('; ')
}
