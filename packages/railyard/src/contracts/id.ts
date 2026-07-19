import { randomUUID } from 'node:crypto'

/** Unique per emission; the framework never dedups (SPEC §2). */
export function newSignalId(): string {
  return `sig_${randomUUID()}`
}

/** Short unique suffix for run directories and container names. */
export function newRunId(): string {
  return randomUUID().slice(0, 8)
}
