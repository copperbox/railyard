import { newSignalId } from '../contracts/id.js'
import type {
  ProvenanceEntry,
  SignalDraft,
  SignalEnvelope,
  SignalSource,
} from '../contracts/types.js'
import { formatAjvErrors, validateSignalEnvelope } from '../contracts/validate.js'

/**
 * Build the full envelope for an emitter's draft. The envelope is set by the
 * framework, never by the emitter (SPEC §2); provenance is the chain that led
 * to this emission (empty for monitor emissions).
 */
export function stampSignal(
  source: SignalSource,
  draft: SignalDraft,
  provenance: ProvenanceEntry[] = [],
): SignalEnvelope {
  const envelope: SignalEnvelope = {
    contractVersion: 'v1',
    id: newSignalId(),
    timestamp: new Date().toISOString(),
    source,
    provenance,
    type: draft.type,
    payload: draft.payload,
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
