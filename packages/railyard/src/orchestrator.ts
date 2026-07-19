import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import { checkSubscriptionCompatibility, type DeclaredEmission } from './agents/compat.js'
import { evaluateFilter } from './agents/filter.js'
import { loadAgents, type LoadedAgent } from './agents/loader.js'
import { stampSignal } from './bus/stamp.js'
import { InMemoryTransport, type SignalTransport } from './bus/transport.js'
import type {
  ProvenanceEntry,
  SignalDraft,
  SignalEnvelope,
  SignalSource,
} from './contracts/types.js'
import { compilePayloadSchema, formatAjvErrors } from './contracts/validate.js'
import { Journal, type JournaledEntry } from './journal/journal.js'
import { consoleLogger, type Logger, type Monitor, type MonitorContext } from './monitor/monitor.js'
import { DockerExecutor, type AgentExecutor } from './run/executor.js'
import { makeRunId } from './run/runner.js'
import { JsonFileKvStore } from './state/kv.js'

export interface OrchestratorConfig {
  /** Directory of agent folders (SPEC §4). */
  agentsDir: string
  /** Run journal + per-run directories (SPEC §12). */
  runsDir: string
  /** Per-monitor KV files; defaults to a `state/` directory next to runsDir. */
  stateDir?: string
  /** Signal bus; defaults to in-memory (SPEC §10). */
  transport?: SignalTransport
  /** Execution backend; defaults to ephemeral Docker (SPEC §6). */
  executor?: AgentExecutor
  logger?: Logger
}

interface RegisteredMonitor {
  monitor: Monitor
  validators: Map<string, ValidateFunction>
}

/**
 * The single in-process layer (SPEC §1): validates, routes, spawns, journals.
 * Boot is fail-fast — by the time start() resolves the system is fully
 * spawnable (SPEC §10, invariant 4).
 */
export class Orchestrator {
  private readonly agentsDir: string
  private readonly runsDir: string
  private readonly stateDir: string
  private readonly transport: SignalTransport
  private readonly executor: AgentExecutor
  private readonly logger: Logger
  private readonly journal: Journal
  private readonly emitter = new EventEmitter()
  private readonly monitors: RegisteredMonitor[] = []
  private readonly imageRefs = new Map<string, string>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private agents: LoadedAgent[] = []
  private phase: 'idle' | 'started' | 'stopped' = 'idle'

  constructor(config: OrchestratorConfig) {
    this.agentsDir = config.agentsDir
    this.runsDir = config.runsDir
    this.stateDir = config.stateDir ?? path.join(path.dirname(path.resolve(config.runsDir)), 'state')
    this.logger = config.logger ?? consoleLogger('railyard')
    this.transport =
      config.transport ??
      new InMemoryTransport({
        onHandlerError: (err) => this.logger.error(`subscriber error: ${String(err)}`),
      })
    this.executor = config.executor ?? new DockerExecutor()
    this.journal = new Journal(config.runsDir)
  }

  /** Register a monitor instance. Declared schemas are compiled (and rejected) here. */
  register(monitor: Monitor): void {
    if (this.phase !== 'idle') throw new Error('register() must be called before start()')
    if (this.monitors.some((m) => m.monitor.name === monitor.name)) {
      throw new Error(`duplicate monitor name "${monitor.name}"`)
    }
    const validators = new Map<string, ValidateFunction>()
    for (const declaration of monitor.emits) {
      if (validators.has(declaration.type)) {
        throw new Error(`monitor "${monitor.name}" declares "${declaration.type}" twice`)
      }
      validators.set(
        declaration.type,
        compilePayloadSchema(
          declaration.payloadSchema,
          `monitor "${monitor.name}", type "${declaration.type}"`,
        ),
      )
    }
    this.monitors.push({ monitor, validators })
  }

  on(event: JournaledEntry['event'], handler: (entry: JournaledEntry) => void): this {
    this.emitter.on(event, handler)
    return this
  }

  off(event: JournaledEntry['event'], handler: (entry: JournaledEntry) => void): this {
    this.emitter.off(event, handler)
    return this
  }

  /** Boot sequence per SPEC §10. (Secrets resolution slots in as step 3 in M1.) */
  async start(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('start() may only be called once')
    await this.journal.init()

    const swept = await this.executor.sweep(this.runsDir).catch((err: unknown) => {
      this.logger.warn(`orphan sweep failed: ${String(err)}`)
      return [] as string[]
    })
    if (swept.length > 0) {
      this.record({ event: 'note', message: `boot sweep removed ${swept.length} orphaned container(s)` })
    }

    // 1. Load and validate agent manifests.
    const { agents, skipped } = await loadAgents(this.agentsDir)
    for (const dir of skipped) {
      this.logger.warn(`skipping ${dir}: no manifest.yaml`)
      this.record({ event: 'note', message: `skipped non-agent directory ${dir}` })
    }
    this.agents = agents

    // 2. Check schema compatibility for every subscription.
    const emissions: DeclaredEmission[] = this.monitors.flatMap((m) =>
      m.monitor.emits.map((declaration) => ({ monitor: m.monitor.name, declaration })),
    )
    const report = checkSubscriptionCompatibility(agents, emissions)
    if (report.errors.length > 0) {
      throw new Error(`subscription compatibility check failed:\n- ${report.errors.join('\n- ')}`)
    }
    for (const note of report.unchecked) {
      this.logger.warn(note)
      this.record({ event: 'note', message: note })
    }

    // 4. Build/pull every agent image.
    for (const agent of agents) {
      const ref = await this.executor.ensureReady(agent, {
        onProgress: (line) => this.logger.info(`[image ${agent.name}] ${line}`),
      })
      this.imageRefs.set(agent.name, ref)
    }

    // 5. Wire routing, then start monitors.
    this.transport.subscribe((signal) => this.route(signal))
    await this.transport.start()
    for (const registered of this.monitors) {
      await registered.monitor.start(this.contextFor(registered))
    }
    this.phase = 'started'
    this.logger.info(
      `started: ${agents.length} agent(s), ${this.monitors.length} monitor(s), runs in ${this.runsDir}`,
    )
  }

  /** Stop monitors, drain in-flight runs, stop the transport. */
  async stop(): Promise<void> {
    if (this.phase !== 'started') return
    this.phase = 'stopped'
    for (const { monitor } of this.monitors) {
      await monitor.stop().catch((err: unknown) => {
        this.logger.error(`monitor "${monitor.name}" failed to stop: ${String(err)}`)
      })
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
    await this.transport.stop()
    await this.journal.flush()
    this.logger.info('stopped')
  }

  private contextFor(registered: RegisteredMonitor): MonitorContext {
    const name = registered.monitor.name
    const source: SignalSource = { kind: 'monitor', name }
    return {
      emit: (draft) => {
        this.emitSignal(source, draft, [], registered.validators)
      },
      state: new JsonFileKvStore(path.join(this.stateDir, `${name}.json`)),
      log: childLogger(this.logger, name),
    }
  }

  /**
   * Stamp, validate, and publish one emission. Monitors are validated against
   * their declared schemas (SPEC §2/§9); agent emissions have no boot-time
   * declaration in M0 and only get envelope validation. Invalid emissions are
   * journaled as dropped and thrown back at the emitter — never silent.
   */
  private emitSignal(
    source: SignalSource,
    draft: SignalDraft,
    provenance: ProvenanceEntry[],
    validators: Map<string, ValidateFunction> | null,
  ): void {
    const fail = (reason: string): never => {
      this.record({ event: 'signal.dropped', reason, signalType: draft.type, source })
      throw new Error(reason)
    }
    if (validators !== null) {
      const validate = validators.get(draft.type)
      if (!validate) {
        fail(`${source.kind} "${source.name}" emitted undeclared signal type "${draft.type}"`)
      } else if (!validate(draft.payload)) {
        fail(
          `${source.kind} "${source.name}" emitted "${draft.type}" with an invalid payload: ${formatAjvErrors(validate.errors)}`,
        )
      }
    }
    let envelope: SignalEnvelope
    try {
      envelope = stampSignal(source, draft, provenance)
    } catch (err) {
      fail(String((err as Error).message))
      return
    }
    this.transport.publish(envelope)
  }

  /** Route one signal: implicit fan-out to every matching agent (SPEC §3). */
  private route(signal: SignalEnvelope): void {
    this.record({
      event: 'signal.received',
      signalId: signal.id,
      signalType: signal.type,
      source: signal.source,
      provenanceDepth: signal.provenance.length,
    })
    for (const agent of this.agents) {
      // An agent fires at most once per signal, via its first matching subscription.
      for (const sub of agent.subscriptions) {
        if (sub.type !== signal.type) continue
        if (sub.filter) {
          let hit: boolean
          try {
            hit = evaluateFilter(sub.filter, signal.payload)
          } catch (err) {
            this.record({
              event: 'note',
              message: `agent "${agent.name}": filter error on signal ${signal.id}, not matched: ${String(err)}`,
            })
            continue
          }
          if (!hit) continue
        }
        if (sub.validatePayload && !sub.validatePayload(signal.payload)) {
          // Reachable for agent-emitted types, which have no boot-time emitter schema.
          this.record({
            event: 'note',
            message: `agent "${agent.name}": signal ${signal.id} (${signal.type}) failed its required payload schema, not matched`,
          })
          continue
        }
        this.dispatch(agent, signal)
        break
      }
    }
  }

  private dispatch(agent: LoadedAgent, signal: SignalEnvelope): void {
    // M1's per-agent concurrency cap and queue slot in here.
    const runId = makeRunId(agent.name)
    this.record({ event: 'run.started', runId, agent: agent.name, signalId: signal.id })
    const childProvenance: ProvenanceEntry[] = [
      ...signal.provenance,
      { source: signal.source, signalId: signal.id, signalType: signal.type },
    ]
    const agentSource: SignalSource = { kind: 'agent', name: agent.name }

    const run = this.executor
      .execute({
        agent,
        imageRef: this.imageRefs.get(agent.name)!,
        signal,
        runsDir: this.runsDir,
        runId,
        onEvent: (line) => {
          if (line.kind === 'signal') {
            try {
              this.emitSignal(agentSource, { type: line.type, payload: line.payload }, childProvenance, null)
            } catch {
              // Already journaled as signal.dropped; must not kill the tailer.
            }
          } else {
            childLogger(this.logger, agent.name)[line.level ?? 'info'](line.message)
          }
        },
        onMalformedEvent: (raw, reason) => {
          this.record({
            event: 'note',
            message: `run ${runId}: malformed events line (${reason}): ${raw.slice(0, 200)}`,
          })
        },
      })
      .then((record) => {
        this.record({
          event: 'run.finished',
          runId,
          agent: agent.name,
          signalId: signal.id,
          status: record.status,
          exitCode: record.exitCode,
          durationMs: record.durationMs,
        })
      })
      .catch((err: unknown) => {
        this.record({
          event: 'run.finished',
          runId,
          agent: agent.name,
          signalId: signal.id,
          status: 'error',
          exitCode: null,
          durationMs: null,
          error: String((err as Error).message ?? err),
        })
      })
      .finally(() => this.inFlight.delete(run))
    this.inFlight.add(run)
  }

  /** Journal an entry and mirror it on the in-process emitter (SPEC §12). */
  private record(entry: Parameters<Journal['append']>[0]): void {
    const stamped = this.journal.append(entry)
    this.emitter.emit(entry.event, stamped)
  }
}

function childLogger(base: Logger, prefix: string): Logger {
  return {
    debug: (m) => base.debug(`[${prefix}] ${m}`),
    info: (m) => base.info(`[${prefix}] ${m}`),
    warn: (m) => base.warn(`[${prefix}] ${m}`),
    error: (m) => base.error(`[${prefix}] ${m}`),
  }
}
