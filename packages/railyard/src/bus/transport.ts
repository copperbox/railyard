import type { SignalEnvelope } from '../contracts/types.js'

export type SignalHandler = (signal: SignalEnvelope) => void | Promise<void>

/**
 * The seam that makes signal durability and out-of-process monitors a v2
 * transport feature rather than a redesign (SPEC §10). v1 ships in-memory only.
 */
export interface SignalTransport {
  publish(signal: SignalEnvelope): void
  /** Returns an unsubscribe function. */
  subscribe(handler: SignalHandler): () => void
  start(): Promise<void>
  stop(): Promise<void>
}

export interface InMemoryTransportOptions {
  /** Called when a subscriber throws/rejects; errors never propagate across subscribers. */
  onHandlerError?: (err: unknown, signal: SignalEnvelope) => void
}

export class InMemoryTransport implements SignalTransport {
  private readonly handlers = new Set<SignalHandler>()
  private readonly onHandlerError: (err: unknown, signal: SignalEnvelope) => void

  constructor(options: InMemoryTransportOptions = {}) {
    this.onHandlerError =
      options.onHandlerError ??
      ((err, signal) => {
        console.error(`railyard: unhandled subscriber error for signal ${signal.id}:`, err)
      })
  }

  publish(signal: SignalEnvelope): void {
    // Snapshot so a handler that (un)subscribes mid-publish doesn't skew delivery.
    for (const handler of [...this.handlers]) {
      try {
        const result = handler(signal)
        if (result instanceof Promise) {
          result.catch((err) => this.onHandlerError(err, signal))
        }
      } catch (err) {
        this.onHandlerError(err, signal)
      }
    }
  }

  subscribe(handler: SignalHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.handlers.clear()
  }
}
