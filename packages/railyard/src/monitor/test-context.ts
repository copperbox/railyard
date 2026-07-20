import type { SignalDeclaration, SignalDraft, SignalSource } from '../contracts/types.js'
import { MemoryKvStore } from '../state/kv.js'
import {
  checkDraftAgainstDeclarations,
  compileDeclaredEmissions,
} from './declared-emissions.js'
import type { MonitorContext } from './monitor.js'

export interface CapturedLogLine {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

/** What createMonitorTestContext returns: a real MonitorContext plus its captures. */
export interface MonitorTestContext {
  ctx: MonitorContext
  /** Validated drafts, in emission order. */
  emitted: SignalDraft[]
  logs: CapturedLogLine[]
  /** The in-memory store behind ctx.state — seed cursors before, assert after. */
  kv: MemoryKvStore
}

/**
 * An offline MonitorContext for unit-testing monitors without an orchestrator
 * (SPEC invariant 9 — monitor authors need this seam; surfaced by M3).
 *
 * emit() validates exactly like the orchestrator — undeclared types and
 * schema-invalid payloads throw with the same messages — via the same compiled
 * validators Orchestrator.register() uses. Valid drafts are recorded to
 * `emitted`; log lines to `logs`; `state` is a fresh MemoryKvStore.
 */
export function createMonitorTestContext(
  emits: SignalDeclaration[],
  options?: { monitorName?: string },
): MonitorTestContext {
  const name = options?.monitorName ?? 'test-monitor'
  const source: SignalSource = { kind: 'monitor', name }
  const validators = compileDeclaredEmissions(name, emits)
  const emitted: SignalDraft[] = []
  const logs: CapturedLogLine[] = []
  const kv = new MemoryKvStore()
  const capture = (level: CapturedLogLine['level']) => (message: string) => {
    logs.push({ level, message })
  }
  const ctx: MonitorContext = {
    emit: (draft) => {
      const error = checkDraftAgainstDeclarations(source, draft, validators)
      if (error !== null) throw new Error(error)
      emitted.push({ type: draft.type, payload: draft.payload })
    },
    state: kv,
    log: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
  }
  return { ctx, emitted, logs, kv }
}
