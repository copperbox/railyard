import type { ValidateFunction } from 'ajv/dist/2020.js'
import type { SignalDeclaration, SignalDraft, SignalSource } from '../contracts/types.js'
import { compilePayloadSchema, formatAjvErrors } from '../contracts/validate.js'

/**
 * Compile a monitor's declared emissions into per-type payload validators.
 * Shared by Orchestrator.register() and createMonitorTestContext so the test
 * harness can never drift from the orchestrator's real validation behavior.
 */
export function compileDeclaredEmissions(
  monitorName: string,
  emits: SignalDeclaration[],
): Map<string, ValidateFunction> {
  const validators = new Map<string, ValidateFunction>()
  for (const declaration of emits) {
    if (validators.has(declaration.type)) {
      throw new Error(`monitor "${monitorName}" declares "${declaration.type}" twice`)
    }
    validators.set(
      declaration.type,
      compilePayloadSchema(
        declaration.payloadSchema,
        `monitor "${monitorName}", type "${declaration.type}"`,
      ),
    )
  }
  return validators
}

/** The error message an emission would fail with, or null if it is valid. */
export function checkDraftAgainstDeclarations(
  source: SignalSource,
  draft: SignalDraft,
  validators: Map<string, ValidateFunction>,
): string | null {
  const validate = validators.get(draft.type)
  if (!validate) {
    return `${source.kind} "${source.name}" emitted undeclared signal type "${draft.type}"`
  }
  if (!validate(draft.payload)) {
    return `${source.kind} "${source.name}" emitted "${draft.type}" with an invalid payload: ${formatAjvErrors(validate.errors)}`
  }
  return null
}
