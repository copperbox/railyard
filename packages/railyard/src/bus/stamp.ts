import { createHash } from 'node:crypto'
import { newSignalId } from '../contracts/id.js'
import type {
  ProvenanceEntry,
  SignalDraft,
  SignalEnvelope,
  SignalSource,
  WorkIdentity,
} from '../contracts/types.js'
import { formatAjvErrors, validateSignalEnvelope } from '../contracts/validate.js'

export interface StampOptions {
  /** Pre-assigned id (see deterministicSignalId); omitted = fresh random id. */
  id?: string
}

/**
 * Build the full envelope for an emitter's draft. The envelope is set by the
 * framework, never by the emitter (SPEC §2); provenance is the chain that led
 * to this emission (empty for monitor emissions).
 */
export function stampSignal(
  source: SignalSource,
  draft: SignalDraft,
  provenance: ProvenanceEntry[] = [],
  options: StampOptions = {},
): SignalEnvelope {
  const envelope: SignalEnvelope = {
    contractVersion: 'v1',
    id: options.id ?? newSignalId(),
    timestamp: new Date().toISOString(),
    source,
    provenance,
    type: draft.type,
    payload: draft.payload,
    ...(draft.work !== undefined ? { work: normalizeWork(draft.work) } : {}),
  }
  if (!validateSignalEnvelope(envelope)) {
    // Reachable only via a malformed draft (e.g. bad type string) — envelope
    // fields are framework-generated.
    throw new Error(
      `invalid signal from ${source.kind} "${source.name}": ${formatAjvErrors(validateSignalEnvelope.errors)}`,
    )
  }
  return envelope
}

function normalizeWork(work: WorkIdentity): WorkIdentity {
  return work.attempt === undefined ? { key: work.key } : { key: work.key, attempt: work.attempt }
}

/**
 * The id an agent-emitted signal gets: a function of the run and the index of
 * the events-file line that carried it. Re-reading the line after a restart
 * re-derives the same id, which is what lets the ledger tell a replayed line
 * from a new emission (SPEC §6.6). Formatted as a UUID so it satisfies the
 * envelope's id pattern.
 */
export function deterministicSignalId(runId: string, eventIndex: number): string {
  const hex = createHash('sha256').update(`${runId}\n${eventIndex}`).digest('hex').slice(0, 32)
  return `sig_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
