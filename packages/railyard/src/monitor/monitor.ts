import type { SignalDeclaration } from '../contracts/types.js'
import type { KeyValueStore } from '../state/kv.js'

/** SPEC §9, verbatim. Monitors are code; no scheduling sugar, dedup is theirs. */
export interface Monitor {
  name: string
  /** Used for boot-time compatibility checks against agent subscriptions. */
  emits: SignalDeclaration[]
  start(ctx: MonitorContext): Promise<void>
  stop(): Promise<void>
}

export interface MonitorContext {
  /** Throws if the type is undeclared or the payload fails the declared schema. */
  emit(signal: { type: string; payload: unknown }): void
  state: KeyValueStore
  log: Logger
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function consoleLogger(prefix: string): Logger {
  const line = (level: string, message: string) =>
    `${new Date().toISOString()} ${level} [${prefix}] ${message}`
  return {
    debug: (m) => console.debug(line('DEBUG', m)),
    info: (m) => console.info(line('INFO', m)),
    warn: (m) => console.warn(line('WARN', m)),
    error: (m) => console.error(line('ERROR', m)),
  }
}
