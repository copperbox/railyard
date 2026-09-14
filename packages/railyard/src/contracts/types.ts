/**
 * TypeScript mirrors of the language-neutral contracts in ../../schemas/.
 * The JSON Schemas are the source of truth (SPEC §16.1); these types exist for DX.
 */

/** A JSON Schema document. `true`/`false` are valid schemas per the spec. */
export type JsonSchema = Record<string, unknown> | boolean

/**
 * Env var names the container contract reserves (SPEC §5). A declared secret
 * may not collide with these — silent clobbering would break the contract.
 */
export const RESERVED_AGENT_ENV_VARS = [
  'AGENT_INPUT_DIR',
  'AGENT_INPUT_FILE',
  'AGENT_OUTPUT_DIR',
  'AGENT_EVENTS_FILE',
  'AGENT_PROMPT_FILE',
] as const

export type SourceKind = 'monitor' | 'agent'

export interface SignalSource {
  kind: SourceKind
  name: string
}

/** One link in the causality chain (SPEC §7), oldest first. */
export interface ProvenanceEntry {
  source: SignalSource
  signalId: string
  signalType: string
}

/**
 * Optional application-supplied logical work identity (SPEC §6.6). Scoped per
 * target agent by the framework: one (agent, key, attempt) runs at most once
 * within the ledger's replay-retention window, whatever signal ids carry it.
 * `attempt` (default 1) is how a deliberate retry is expressed; a new
 * revision of the work is a new key.
 */
export interface WorkIdentity {
  key: string
  attempt?: number
}

/** A signal on the bus: framework-set envelope + emitter-set type/payload (SPEC §2). */
export interface SignalEnvelope {
  /**
   * Signal Contract version tag, framework-stamped (never emitter-set). Always
   * `"v1"` in this runtime; the envelope JSON Schema pins it with `const`. The
   * wire marker a future multi-version runtime negotiates on — cross-version
   * policy is a v2 concern (SPEC §2, §14). See /docs/contracts.
   */
  contractVersion: string
  id: string
  timestamp: string
  source: SignalSource
  provenance: ProvenanceEntry[]
  type: string
  payload: unknown
  /** Emitter-set logical work identity, carried through for duplicate suppression. */
  work?: WorkIdentity
}

/** What an emitter hands the framework; the envelope is stamped by the orchestrator. */
export interface SignalDraft {
  type: string
  payload: unknown
  work?: WorkIdentity
}

/** A monitor's declaration of one signal type it emits (SPEC §9). */
export interface SignalDeclaration {
  type: string
  payloadSchema: JsonSchema
}

/** One `on:` entry in an agent manifest (SPEC §3/§4). */
export interface AgentSubscription {
  type: string
  filter?: string
  /** Path relative to the agent folder; omitted = accepts any payload. */
  payloadSchema?: string
}

/** manifest.yaml after validation, with schema defaults applied. */
export interface AgentManifest {
  name: string
  on: AgentSubscription[]
  secrets: string[]
  concurrency: number
  timeout: number | null
  network: 'default' | 'none'
  allowSelfTrigger: boolean
  image?: string
}

/** A `kind: "signal"` line in $AGENT_EVENTS_FILE (SPEC §5). */
export interface SignalEventLine {
  kind: 'signal'
  type: string
  payload: unknown
  work?: WorkIdentity
}

/** A `kind: "log"` line in $AGENT_EVENTS_FILE (SPEC §5). */
export interface LogEventLine {
  kind: 'log'
  level?: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

export type EventsLine = SignalEventLine | LogEventLine
