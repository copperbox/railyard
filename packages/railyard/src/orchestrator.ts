import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import { checkSubscriptionCompatibility, type DeclaredEmission } from './agents/compat.js'
import { evaluateFilter } from './agents/filter.js'
import { loadAgents, type LoadedAgent } from './agents/loader.js'
import { deterministicSignalId, stampSignal, type StampOptions } from './bus/stamp.js'
import { InMemoryTransport, type SignalTransport } from './bus/transport.js'
import type {
  ProvenanceEntry,
  SignalDraft,
  SignalEnvelope,
  SignalSource,
} from './contracts/types.js'
import { Journal, type JournaledEntry } from './journal/journal.js'
import {
  checkDraftAgainstDeclarations,
  compileDeclaredEmissions,
} from './monitor/declared-emissions.js'
import { consoleLogger, type Logger, type Monitor, type MonitorContext } from './monitor/monitor.js'
import { DockerExecutor, type AgentExecutor } from './run/executor.js'
import { WorkLedger, payloadHash } from './run/ledger.js'
import {
  createRunIntent,
  listLifecycleRecords,
  readLifecycleRecord,
  updateLifecycleRecord,
  writeLifecycleRecord,
  type RunLifecycleRecord,
} from './run/lifecycle.js'
import { DirectoryLock, RUNS_DIR_LOCK, STATE_DIR_LOCK } from './run/lock.js'
import { DurableQueue } from './run/queue.js'
import { sweepRetention, type RetentionPolicy } from './run/retention.js'
import { renderPromptTemplate } from './prompt/template.js'
import {
  makeRunId,
  recordInterruptedRun,
  type RunOutcome,
  type RunRecord,
  type RunSupervisionHandlers,
} from './run/runner.js'
import { EnvSecretsProvider, type SecretsProvider } from './secrets/provider.js'
import { Redactor, REDACTION_MIN_LENGTH } from './secrets/redactor.js'
import { JsonFileKvStore } from './state/kv.js'

/**
 * How `stop()` treats work in progress (SPEC §6.5):
 * - `drain` (default): no new admissions; wait for active runs; queued
 *   deliveries stay durable for the next start.
 * - `detach`: no new admissions; stop supervising active runs *without*
 *   stopping their containers; return promptly. The next start (same runsDir,
 *   same Docker host) reattaches to the same containers.
 * - `cancel`: no new admissions; kill active containers (recorded as
 *   `killReason: "cancelled"`); drop queued deliveries (journaled
 *   `run.skipped` / `cancelled`).
 */
export type ShutdownMode = 'drain' | 'detach' | 'cancel'

export interface StopOptions {
  mode?: ShutdownMode
}

export interface RecoveryPolicy {
  /**
   * When a persisted run's container never started (the intent was recorded
   * but the crash came before `docker start`) and is now missing, queue its
   * delivery again as a fresh run instead of just recording it interrupted.
   * Safe by construction — nothing ever ran. Default true. A run whose
   * container *had* started and is now missing is never retried
   * automatically: its side effects are unknown; re-emit with a new
   * `work.attempt` to retry deliberately.
   */
  requeueUnstarted?: boolean
  /**
   * How long completed deliveries and work identities stay in the ledger for
   * replay suppression (SPEC §6.6). Default 7 days.
   */
  ledgerRetentionDays?: number
}

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
  /**
   * Max provenance chain depth (SPEC §7); emissions beyond it are dropped and
   * journaled. Default 5.
   */
  maxChainDepth?: number
  /** Secret resolution seam (SPEC §8); defaults to process env + `.env`. */
  secrets?: SecretsProvider
  /**
   * Run-dir pruning (SPEC §12); whichever rule prunes more wins. Unset =
   * unlimited, with a loud startup warning. journal.jsonl is always exempt.
   */
  retention?: RetentionPolicy
  /** Restart/recovery behavior (SPEC §6.5). */
  recovery?: RecoveryPolicy
  /**
   * How long `start()` keeps retrying the owned-directory locks when a
   * predecessor still holds them — e.g. the process being replaced is still
   * finishing `stop({ mode: 'detach' })`. Default 0 (fail immediately).
   */
  lockWaitMs?: number
  logger?: Logger
}

interface RegisteredMonitor {
  monitor: Monitor
  validators: Map<string, ValidateFunction>
}

/** Live run bookkeeping for one agent: active count vs its cap, plus the FIFO queue. */
interface AgentRunState {
  active: number
  queue: SignalEnvelope[]
}

/** One supervised run and the levers stop() pulls on it. */
interface ActiveRun {
  runId: string
  agent: string
  signal: SignalEnvelope
  detach: AbortController
  cancel: AbortController
}

type Phase = 'idle' | 'booting' | 'started' | 'stopping' | 'stopped'

/**
 * The single in-process layer (SPEC §1): validates, routes, spawns, journals.
 * Boot is fail-fast — by the time start() resolves the system is fully
 * spawnable (SPEC §10, invariant 4) and every run the previous owner of the
 * runs directory left behind has been reconciled (SPEC §6.5).
 */
export class Orchestrator {
  private readonly agentsDir: string
  private readonly runsDir: string
  private readonly stateDir: string
  private readonly transport: SignalTransport
  private readonly executor: AgentExecutor
  private readonly logger: Logger
  private readonly journal: Journal
  private readonly ledger: WorkLedger
  private readonly queue: DurableQueue
  private readonly emitter = new EventEmitter()
  private readonly monitors: RegisteredMonitor[] = []
  private readonly imageRefs = new Map<string, string>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly runStates = new Map<string, AgentRunState>()
  private readonly maxChainDepth: number
  private readonly secretsProvider: SecretsProvider
  private readonly redactor = new Redactor()
  private readonly shortSecretWarned = new Set<string>()
  private readonly retention: RetentionPolicy
  private readonly recovery: Required<RecoveryPolicy>
  private readonly lockWaitMs: number
  private readonly activeRuns = new Map<string, ActiveRun>()
  /** Runs with an unfinished lifecycle record: exempt from retention until closed. */
  private readonly protectedRuns = new Set<string>()
  /** Routing in progress per signal id, so an emitter can wait for durable acceptance. */
  private readonly pendingRoutes = new Map<string, Promise<void>>()
  private routing: Promise<void> = Promise.resolve()
  /** (agent, signalId) → runId for every persisted run seen at boot, closed or not. */
  private readonly recoveredRuns = new Map<string, string>()
  private agents: LoadedAgent[] = []
  private phase: Phase = 'idle'
  private imagesReady = false
  private bootSettled: Promise<boolean> | null = null
  private stopping: Promise<void> | null = null
  private stopMode: ShutdownMode | null = null
  /**
   * The directories this orchestrator owns outright, locked for its whole
   * started lifetime; see DirectoryLock for why sharing either is unsafe.
   * Released in reverse acquisition order.
   */
  private dirLocks: DirectoryLock[] = []

  constructor(config: OrchestratorConfig) {
    this.agentsDir = config.agentsDir
    this.runsDir = config.runsDir
    this.maxChainDepth = config.maxChainDepth ?? 5
    if (!Number.isInteger(this.maxChainDepth) || this.maxChainDepth < 1) {
      throw new Error(`maxChainDepth must be a positive integer, got ${String(config.maxChainDepth)}`)
    }
    this.retention = config.retention ?? {}
    if (this.retention.maxAgeDays !== undefined && !(this.retention.maxAgeDays > 0)) {
      throw new Error(`retention.maxAgeDays must be positive, got ${String(this.retention.maxAgeDays)}`)
    }
    if (
      this.retention.maxRunsPerAgent !== undefined &&
      (!Number.isInteger(this.retention.maxRunsPerAgent) || this.retention.maxRunsPerAgent < 1)
    ) {
      throw new Error(
        `retention.maxRunsPerAgent must be a positive integer, got ${String(this.retention.maxRunsPerAgent)}`,
      )
    }
    this.recovery = {
      requeueUnstarted: config.recovery?.requeueUnstarted ?? true,
      ledgerRetentionDays: config.recovery?.ledgerRetentionDays ?? 7,
    }
    if (!(this.recovery.ledgerRetentionDays > 0)) {
      throw new Error(
        `recovery.ledgerRetentionDays must be positive, got ${String(config.recovery?.ledgerRetentionDays)}`,
      )
    }
    this.lockWaitMs = config.lockWaitMs ?? 0
    if (!(this.lockWaitMs >= 0)) {
      throw new Error(`lockWaitMs must be >= 0, got ${String(config.lockWaitMs)}`)
    }
    this.stateDir = config.stateDir ?? path.join(path.dirname(path.resolve(config.runsDir)), 'state')
    // Every framework log line passes through the redactor (SPEC §8).
    this.logger = redactingLogger(config.logger ?? consoleLogger('railyard'), this.redactor)
    this.transport =
      config.transport ??
      new InMemoryTransport({
        onHandlerError: (err) => this.logger.error(`subscriber error: ${String(err)}`),
      })
    this.executor = config.executor ?? new DockerExecutor()
    this.secretsProvider = config.secrets ?? new EnvSecretsProvider()
    this.journal = new Journal(config.runsDir)
    this.ledger = new WorkLedger(config.runsDir)
    this.queue = new DurableQueue(config.runsDir)
  }

  /** Register a monitor instance. Declared schemas are compiled (and rejected) here. */
  register(monitor: Monitor): void {
    if (this.phase !== 'idle') throw new Error('register() must be called before start()')
    if (this.monitors.some((m) => m.monitor.name === monitor.name)) {
      throw new Error(`duplicate monitor name "${monitor.name}"`)
    }
    this.monitors.push({ monitor, validators: compileDeclaredEmissions(monitor.name, monitor.emits) })
  }

  on<E extends JournaledEntry['event']>(
    event: E,
    handler: (entry: Extract<JournaledEntry, { event: E }>) => void,
  ): this {
    this.emitter.on(event, handler as (entry: JournaledEntry) => void)
    return this
  }

  off<E extends JournaledEntry['event']>(
    event: E,
    handler: (entry: Extract<JournaledEntry, { event: E }>) => void,
  ): this {
    this.emitter.off(event, handler as (entry: JournaledEntry) => void)
    return this
  }

  /** Boot sequence per SPEC §10, with recovery of persisted work (SPEC §6.5). */
  async start(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('start() may only be called once')
    this.phase = 'booting'
    let settle!: (ok: boolean) => void
    this.bootSettled = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    // Claim both owned directories before anything touches them — in particular
    // before recovery, the orphan-container and retention sweeps, which are
    // destructive and scoped by runs directory. Two orchestrators sharing either
    // directory destroy each other's work; see DirectoryLock.
    try {
      await this.lockOwnedDirectories()
      await this.boot()
    } catch (err) {
      // Boot is fail-fast (invariant 4) — a failed boot must not strand a lock.
      // Nothing recoverable has been removed: recovery stops at the first
      // thing it cannot resolve. The instance goes back to idle so a fixed
      // configuration can start() again; a stop() that was waiting on this
      // boot has nothing left to do.
      await this.releaseDirLocks()
      this.phase = 'idle'
      this.stopping = null
      this.stopMode = null
      settle(false)
      throw err
    }
    this.phase = 'started'
    settle(true)
    this.logger.info(
      `started: ${this.agents.length} agent(s), ${this.monitors.length} monitor(s), runs in ${this.runsDir}`,
    )
  }

  /**
   * Lock runsDir and stateDir. They are usually siblings, but a user may point
   * both at one directory — then a single lock already covers it, and asking
   * for a second would deadlock us against ourselves.
   */
  private async lockOwnedDirectories(): Promise<void> {
    this.dirLocks.push(await this.acquireLock(this.runsDir, RUNS_DIR_LOCK))
    if (path.resolve(this.stateDir) === path.resolve(this.runsDir)) return
    this.dirLocks.push(await this.acquireLock(this.stateDir, STATE_DIR_LOCK))
  }

  /** Acquire, retrying for lockWaitMs while a live predecessor still holds the lock. */
  private async acquireLock(dir: string, options: typeof RUNS_DIR_LOCK): Promise<DirectoryLock> {
    const deadline = Date.now() + this.lockWaitMs
    for (;;) {
      try {
        return await DirectoryLock.acquire(dir, options)
      } catch (err) {
        const message = String((err as Error).message ?? err)
        if (Date.now() >= deadline || !message.includes('locked by another')) throw err
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }

  private async releaseDirLocks(): Promise<void> {
    for (const lock of this.dirLocks.reverse()) {
      await lock.release().catch((err: unknown) => {
        this.logger.warn(`failed to release lock ${lock.path}: ${String(err)}`)
      })
    }
    this.dirLocks = []
  }

  private async boot(): Promise<void> {
    await this.journal.init()

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

    // 3. Resolve every declared secret — declared-but-unresolvable fails boot (SPEC §8).
    //    Done before recovery so recovered output is redacted with current values.
    const unresolvable: string[] = []
    for (const agent of agents) {
      for (const name of agent.manifest.secrets) {
        const value = await this.secretsProvider.resolve(name)
        if (value === undefined) unresolvable.push(`${name} (agent "${agent.name}")`)
        else this.registerSecret(name, value)
      }
    }
    if (unresolvable.length > 0) {
      throw new Error(
        `unresolvable secret(s):\n- ${[...new Set(unresolvable)].join('\n- ')}\n` +
          `Each is a name resolved via the SecretsProvider (default: process env, then a ` +
          `.env file — cwd-relative unless you pass an explicit envFile). See docs/credential-scoping.md.`,
      )
    }

    // 4. Wire routing first: recovered runs may emit child signals immediately.
    //    Anything routed before images are ready queues (durably) rather than launching.
    this.transport.subscribe((signal) => this.route(signal))
    await this.transport.start()

    // 5. Reconcile persisted work (SPEC §6.5) — before retention, queue
    //    admission, or monitor emissions can touch it.
    await this.reconcile()

    // 6. Retention (SPEC §12): sweep at boot; warn loudly when unlimited.
    if (this.retention.maxAgeDays === undefined && this.retention.maxRunsPerAgent === undefined) {
      const message =
        'retention is unset: run directories will accumulate without bound ' +
        '(set retention.maxAgeDays and/or retention.maxRunsPerAgent to prune; journal.jsonl is always kept)'
      this.logger.warn(message)
      this.record({ event: 'note', message })
    } else {
      await this.runRetentionSweep()
    }

    // 7. Build/pull every agent image. Already-running agents keep their original image.
    for (const agent of agents) {
      const ref = await this.executor.ensureReady(agent, {
        onProgress: (line) => this.logger.info(`[image ${agent.name}] ${line}`),
      })
      this.imageRefs.set(agent.name, ref)
    }
    this.imagesReady = true

    // 8. Restore queued deliveries against the restored concurrency accounting, then admit.
    await this.restoreQueue()

    // 9. Start monitors.
    for (const registered of this.monitors) {
      await registered.monitor.start(this.contextFor(registered))
    }
  }

  /**
   * Stop admission and shut down per `mode` (SPEC §6.5). Concurrent and
   * repeated calls share one completion: the first mode wins, later callers
   * await the same promise. During boot the request waits for boot to settle;
   * a failed boot has already released its locks and needs nothing more.
   * Ownership of the directories is released last, after every write has
   * landed and every supervisor has let go.
   */
  stop(options: StopOptions = {}): Promise<void> {
    const mode = options.mode ?? 'drain'
    if (this.stopping !== null) {
      if (mode !== this.stopMode) {
        this.logger.warn(`stop(${mode}) requested while stop(${String(this.stopMode)}) is in progress; joining it`)
      }
      return this.stopping
    }
    if (this.phase === 'idle') return Promise.resolve()
    this.stopMode = mode
    this.stopping = this.performStop(mode)
    return this.stopping
  }

  private async performStop(mode: ShutdownMode): Promise<void> {
    if (this.phase === 'booting') {
      const booted = await this.bootSettled!
      if (!booted) return
    }
    if (this.phase === 'stopped') return
    this.phase = 'stopping'
    for (const { monitor } of this.monitors) {
      await monitor.stop().catch((err: unknown) => {
        this.logger.error(`monitor "${monitor.name}" failed to stop: ${String(err)}`)
      })
    }
    if (mode === 'cancel') {
      for (const [agentName, state] of this.runStates) {
        for (const queued of state.queue.splice(0)) {
          this.record({
            event: 'run.skipped',
            agent: agentName,
            signalId: queued.id,
            signalType: queued.type,
            reason: 'cancelled',
          })
          await this.queue.remove(agentName, queued.id)
          this.ledger.drop(agentName, queued.id)
        }
      }
      for (const run of this.activeRuns.values()) run.cancel.abort()
    } else if (mode === 'detach') {
      for (const run of this.activeRuns.values()) run.detach.abort()
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
    await this.transport.stop()
    await this.ledger.flush()
    await this.journal.flush()
    this.phase = 'stopped'
    // Released last: nothing may touch the owned directories after this point.
    await this.releaseDirLocks()
    this.logger.info(`stopped (${mode})`)
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
    options: StampOptions = {},
  ): SignalEnvelope {
    // Redact before validation and stamping — what validates is what ships (SPEC §8).
    draft = {
      type: draft.type,
      payload: this.redactor.redactJson(draft.payload),
      ...(draft.work !== undefined ? { work: this.redactor.redactJson(draft.work) } : {}),
    }
    const fail = (reason: string): never => {
      this.record({ event: 'signal.dropped', reason, signalType: draft.type, source })
      throw new Error(reason)
    }
    // Depth limit (SPEC §7): only agent emissions can hit this — monitor chains are empty.
    if (provenance.length > this.maxChainDepth) {
      fail(
        `${source.kind} "${source.name}" emission "${draft.type}" dropped: provenance depth ${provenance.length} exceeds max chain depth ${this.maxChainDepth}`,
      )
    }
    if (validators !== null) {
      const declarationError = checkDraftAgainstDeclarations(source, draft, validators)
      if (declarationError !== null) fail(declarationError)
    }
    let envelope: SignalEnvelope
    try {
      envelope = stampSignal(source, draft, provenance, options)
    } catch (err) {
      return fail(String((err as Error).message))
    }
    this.transport.publish(envelope)
    return envelope
  }

  /**
   * Route one signal: implicit fan-out to every matching agent (SPEC §3).
   * Acceptance is durable before admission (SPEC §6.5): each matched delivery
   * is written to the queue and the ledger, and the ledger is flushed, before
   * any container is considered. A signal id the ledger already knows is a
   * replay (a re-read events line, a re-published envelope) and is not routed
   * twice.
   */
  private route(signal: SignalEnvelope): Promise<void> {
    // Routes are serialized in publish order: acceptance is async (durable
    // writes), and FIFO admission must follow emission order, not I/O luck.
    const done = this.routing
      .then(() => this.routeInner(signal))
      .finally(() => {
        this.pendingRoutes.delete(signal.id)
      })
    this.routing = done.catch(() => {})
    this.pendingRoutes.set(signal.id, done)
    return done
  }

  private async routeInner(signal: SignalEnvelope): Promise<void> {
    if (this.ledger.hasSignal(signal.id)) {
      this.record({
        event: 'note',
        message: `signal ${signal.id} (${signal.type}) already routed; replay suppressed`,
      })
      return
    }
    this.record({
      event: 'signal.received',
      signalId: signal.id,
      signalType: signal.type,
      source: signal.source,
      provenanceDepth: signal.provenance.length,
    })
    const accepted: LoadedAgent[] = []
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
        // Self-trigger guard (SPEC §7): refusal is per-agent — the signal still
        // reaches every other matching agent.
        if (
          signal.source.kind === 'agent' &&
          signal.source.name === agent.name &&
          !agent.manifest.allowSelfTrigger
        ) {
          this.record({
            event: 'run.skipped',
            agent: agent.name,
            signalId: signal.id,
            signalType: signal.type,
            reason: 'self-trigger',
          })
          break
        }
        if (await this.accept(agent, signal)) accepted.push(agent)
        break
      }
    }
    this.ledger.noteSignal(signal.id)
    await this.ledger.flush()
    for (const agent of accepted) this.admit(agent, signal)
  }

  /**
   * Durably accept one delivery, or refuse it: cancelled shutdown, an already
   * accepted (agent, signalId), or a logical work identity that is already
   * queued, active, or done within the retention window (SPEC §6.6). A
   * refused duplicate is journaled with what it collided with.
   */
  private async accept(agent: LoadedAgent, signal: SignalEnvelope): Promise<boolean> {
    if (this.phase === 'stopped' || (this.phase === 'stopping' && this.stopMode === 'cancel')) {
      this.record({
        event: 'run.skipped',
        agent: agent.name,
        signalId: signal.id,
        signalType: signal.type,
        reason: 'cancelled',
      })
      return false
    }
    if (this.ledger.delivery(agent.name, signal.id) !== undefined) return false
    if (signal.work !== undefined) {
      const existing = this.ledger.findWork(agent.name, signal.work)
      if (existing !== undefined) {
        const conflict = existing.payloadHash !== payloadHash(signal.payload)
        this.record({
          event: 'run.skipped',
          agent: agent.name,
          signalId: signal.id,
          signalType: signal.type,
          reason: 'duplicate',
          detail:
            `work "${existing.key}" attempt ${existing.attempt} is ${existing.status} ` +
            `(signal ${existing.signalId}${existing.runId !== null ? `, run ${existing.runId}` : ''})` +
            (conflict ? '; payload differs — a new revision needs a new work key' : ''),
        })
        return false
      }
    }
    // Claim in memory first (synchronously, so two concurrent routes can't
    // both pass the checks above), then make the delivery durable.
    this.ledger.accept(agent.name, signal)
    try {
      await this.queue.accept(agent.name, signal)
    } catch (err) {
      this.ledger.drop(agent.name, signal.id)
      throw err
    }
    return true
  }

  /**
   * Per-agent concurrency cap + FIFO queue (SPEC §6). Excess matched signals
   * queue; a settling run launches the next. While stopping (drain/detach)
   * nothing new starts — accepted deliveries stay queued for the next start.
   */
  private admit(agent: LoadedAgent, signal: SignalEnvelope): void {
    const state = this.runStateFor(agent.name)
    if (!this.canLaunch() || state.active >= agent.manifest.concurrency) {
      state.queue.push(signal)
      this.record({
        event: 'run.queued',
        agent: agent.name,
        signalId: signal.id,
        signalType: signal.type,
        queueDepth: state.queue.length,
      })
      return
    }
    this.launch(agent, signal, state)
  }

  private canLaunch(): boolean {
    return (this.phase === 'booting' || this.phase === 'started') && this.imagesReady && this.stopping === null
  }

  /** Launch queued deliveries for one agent up to its cap. */
  private admitNext(agentName: string): void {
    const agent = this.agents.find((a) => a.name === agentName)
    if (!agent) return
    const state = this.runStateFor(agentName)
    while (this.canLaunch() && state.active < agent.manifest.concurrency && state.queue.length > 0) {
      this.launch(agent, state.queue.shift()!, state)
    }
  }

  /**
   * Resolve the agent's declared secrets for one spawn (SPEC §8): fresh values
   * every time so rotation works without a restart. Only declared names are
   * injected — least privilege by construction. A name that has become
   * unresolvable since boot fails the run (journaled via the launch chain).
   */
  private async resolveSecretsFor(agent: LoadedAgent): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    const missing: string[] = []
    for (const name of agent.manifest.secrets) {
      const value = await this.secretsProvider.resolve(name)
      if (value === undefined) missing.push(name)
      else {
        env[name] = value
        this.registerSecret(name, value)
      }
    }
    if (missing.length > 0) {
      throw new Error(`agent "${agent.name}": secret(s) unresolvable at spawn: ${missing.join(', ')}`)
    }
    return env
  }

  /**
   * Feed a resolved value into the redactor. A value too short to redact
   * safely gets a loud (once per name) warning — tunable, never silent.
   */
  private registerSecret(name: string, value: string): void {
    if (!this.redactor.register(name, value) && !this.shortSecretWarned.has(name)) {
      this.shortSecretWarned.add(name)
      const message =
        `secret "${name}" is shorter than ${REDACTION_MIN_LENGTH} characters and cannot be ` +
        `safely redacted — its value may appear in logs and records`
      this.logger.warn(message)
      this.record({ event: 'note', message })
    }
  }

  private runStateFor(agentName: string): AgentRunState {
    let state = this.runStates.get(agentName)
    if (!state) {
      state = { active: 0, queue: [] }
      this.runStates.set(agentName, state)
    }
    return state
  }

  /**
   * Sweep run dirs per the retention policy; runs at boot and after each run —
   * no timers. Active runs and every run with an unfinished lifecycle record
   * are exempt. Expired ledger entries go at the same time.
   */
  private async runRetentionSweep(): Promise<void> {
    const removed = await sweepRetention({
      runsDir: this.runsDir,
      policy: this.retention,
      activeRunIds: new Set([...this.activeRuns.keys(), ...this.protectedRuns]),
    })
    if (removed.length > 0) this.record({ event: 'retention.swept', removed })
    this.ledger.prune(this.recovery.ledgerRetentionDays * 24 * 60 * 60 * 1000)
    await this.ledger.flush()
  }

  /** The events-file handlers for one run: child signals get deterministic ids. */
  private handlersFor(runId: string, agentName: string, signal: SignalEnvelope): RunSupervisionHandlers {
    const childProvenance: ProvenanceEntry[] = [
      ...signal.provenance,
      { source: signal.source, signalId: signal.id, signalType: signal.type },
    ]
    const agentSource: SignalSource = { kind: 'agent', name: agentName }
    return {
      onEvent: async (line, index) => {
        if (line.kind === 'signal') {
          const id = deterministicSignalId(runId, index)
          try {
            this.emitSignal(
              agentSource,
              { type: line.type, payload: line.payload, ...(line.work !== undefined ? { work: line.work } : {}) },
              childProvenance,
              null,
              { id },
            )
          } catch {
            // Already journaled as signal.dropped; must not kill the tailer.
            return
          }
          // Hold the events checkpoint until the deliveries are durable.
          await this.pendingRoutes.get(id)
        } else {
          childLogger(this.logger, agentName)[line.level ?? 'info'](line.message)
        }
      },
      onMalformedEvent: (raw, reason) => {
        this.record({
          event: 'note',
          message: `run ${runId}: malformed events line (${reason}): ${raw.slice(0, 200)}`,
        })
      },
    }
  }

  private launch(agent: LoadedAgent, signal: SignalEnvelope, state: AgentRunState): void {
    state.active += 1
    const runId = makeRunId(agent.name)
    const active: ActiveRun = {
      runId,
      agent: agent.name,
      signal,
      detach: new AbortController(),
      cancel: new AbortController(),
    }
    this.record({ event: 'run.started', runId, agent: agent.name, signalId: signal.id })

    const outcome = Promise.resolve().then(async (): Promise<RunOutcome> => {
      // Render before secret resolution: a missing template path fails the
      // run here — journaled below, no secrets touched, no container created.
      const renderedPrompt = agent.promptTemplate
        ? renderPromptTemplate(agent.promptTemplate, signal)
        : undefined
      const env = await this.resolveSecretsFor(agent)
      // Persist the intent before anything exists to recover (SPEC §6.5).
      const lifecycle = createRunIntent({
        runId,
        agent: agent.name,
        agentDir: agent.dir,
        imageRef: this.imageRefs.get(agent.name)!,
        signal,
        work: signal.work ?? null,
        timeoutSeconds: agent.manifest.timeout,
        network: agent.manifest.network,
        secretNames: [...agent.manifest.secrets],
        hasPrompt: renderedPrompt !== undefined,
      })
      await writeLifecycleRecord(this.runsDir, lifecycle)
      this.protectedRuns.add(runId)
      this.activeRuns.set(runId, active)
      // The intent now carries the delivery; the queue file has done its job.
      await this.queue.remove(agent.name, signal.id)
      this.ledger.setStatus(agent.name, signal.id, 'active', runId)
      await this.ledger.flush()
      return this.executor.execute({
        lifecycle,
        agent,
        runsDir: this.runsDir,
        env,
        redactor: this.redactor,
        ...(renderedPrompt !== undefined ? { renderedPrompt } : {}),
        control: { detach: active.detach.signal, cancel: active.cancel.signal },
        ...this.handlersFor(runId, agent.name, signal),
      })
    })
    this.track(active, state, outcome)
  }

  /**
   * Settle one supervised run: journal its terminal entry exactly once, close
   * its lifecycle record, release its slot, and admit the next queued
   * delivery. A detached run releases its slot without a terminal entry.
   */
  private track(active: ActiveRun, state: AgentRunState, outcome: Promise<RunOutcome>): void {
    const { runId, agent, signal } = active
    let detached = false
    const run: Promise<void> = outcome
      .then(async (result) => {
        if (result.kind === 'detached') {
          detached = true
          this.record({ event: 'run.detached', runId, agent, signalId: signal.id })
          return
        }
        const { record } = result
        await this.finishRun(active, {
          status: record.status,
          exitCode: record.exitCode,
          durationMs: record.durationMs,
          ...(record.killReason !== null ? { killReason: record.killReason } : {}),
        })
      })
      .catch(async (err: unknown) => {
        await this.finishRun(active, {
          status: 'error',
          exitCode: null,
          durationMs: null,
          error: String((err as Error).message ?? err),
        })
      })
      .then(async () => {
        if (detached) return
        // After-each-run retention sweep (SPEC §12), inside the tracked run
        // promise so stop() waits for it. Never fatal to the run's bookkeeping.
        await this.runRetentionSweep().catch((err: unknown) => {
          this.logger.warn(`retention sweep failed: ${String(err)}`)
        })
      })
      .finally(() => {
        this.inFlight.delete(run)
        this.activeRuns.delete(runId)
        state.active -= 1
        this.admitNext(agent)
      })
    this.inFlight.add(run)
  }

  private async finishRun(
    active: ActiveRun,
    outcome: Omit<Extract<JournaledEntry, { event: 'run.finished' }>, 'event' | 'at' | 'runId' | 'agent' | 'signalId'>,
  ): Promise<void> {
    const { runId, agent, signal } = active
    this.record({ event: 'run.finished', runId, agent, signalId: signal.id, ...outcome })
    await this.journal.flush()
    this.ledger.setStatus(agent, signal.id, 'done', runId)
    await this.queue.remove(agent, signal.id)
    await this.ledger.flush()
    await this.closeLifecycle(runId)
  }

  /** Mark a finalized record closed: its terminal journal entry is on disk. */
  private async closeLifecycle(runId: string): Promise<void> {
    try {
      const record = await readLifecycleRecord(this.runsDir, runId)
      if (record !== null && record.phase !== 'closed') {
        await updateLifecycleRecord(this.runsDir, record, {
          phase: 'closed',
          closedAt: new Date().toISOString(),
        })
      }
    } catch (err) {
      this.logger.warn(`run ${runId}: could not close lifecycle record: ${String(err)}`)
    }
    this.protectedRuns.delete(runId)
  }

  /**
   * Boot-time reconciliation (SPEC §6.5). For every persisted run that is not
   * closed: reattach to a live container, finalize an exited one, or record a
   * missing one as interrupted. Concurrency accounting is restored here, before
   * any queued delivery is admitted. Anything the backend cannot answer for
   * fails boot — nothing is removed on the strength of an unknown.
   */
  private async reconcile(): Promise<void> {
    await this.ledger.load()
    const { records, unreadable } = await listLifecycleRecords(this.runsDir)
    for (const runId of unreadable) {
      this.protectedRuns.add(runId)
      const message = `run ${runId}: lifecycle record is unreadable; kept for inspection, not recovered`
      this.logger.warn(message)
      this.record({ event: 'note', message })
    }
    for (const record of records) this.recoveredRuns.set(deliveryKey(record.agent, record.signal.id), record.runId)
    const open = records.filter((r) => r.phase !== 'closed')
    for (const record of open) this.protectedRuns.add(record.runId)

    // Finalized-but-not-closed: the crash came between result.json and the
    // journal line (or the close). Journal it once, from the journal's own view.
    const needTerminal = open.filter((r) => r.phase === 'finalized')
    if (needTerminal.length > 0) {
      const finished = new Set(
        (await this.journal.scan((e) => e.event === 'run.finished')).map(
          (e) => (e as Extract<JournaledEntry, { event: 'run.finished' }>).runId,
        ),
      )
      for (const record of needTerminal) {
        if (!finished.has(record.runId)) this.journalTerminal(record)
        await this.journal.flush()
        this.ledger.setStatus(record.agent, record.signal.id, 'done', record.runId)
        await this.queue.remove(record.agent, record.signal.id)
        await this.closeLifecycle(record.runId)
      }
    }

    let reattached = 0
    for (const record of open) {
      if (record.phase === 'finalized') continue
      let observation
      try {
        observation = await this.executor.observe(record)
      } catch (err) {
        throw new Error(
          `recovery: cannot determine the state of run ${record.runId} (container ` +
            `${record.containerName}): ${String((err as Error).message ?? err)}. Nothing has been ` +
            `changed. Make the container backend reachable and start again; if the run is known to ` +
            `be gone, remove its lifecycle.json to have it recorded as interrupted.`,
        )
      }
      const base = { runId: record.runId, agent: record.agent, signalId: record.signal.id }
      if (observation.state === 'missing') {
        const neverStarted = record.phase === 'intent' || record.phase === 'created'
        const agent = this.agents.find((a) => a.name === record.agent)
        if (neverStarted && this.recovery.requeueUnstarted && agent !== undefined) {
          this.record({ event: 'run.recovered', ...base, outcome: 'requeued' })
          const reason = 'container never started before supervision was lost; delivery requeued'
          const result = await recordInterruptedRun(this.runsDir, record, reason)
          this.record({
            event: 'run.finished',
            ...base,
            status: 'interrupted',
            exitCode: null,
            durationMs: result.durationMs,
            error: reason,
          })
          await this.journal.flush()
          await this.closeLifecycle(record.runId)
          // Same delivery, new attempt at running it: back to the durable queue.
          await this.queue.accept(record.agent, record.signal)
          this.ledger.setStatus(record.agent, record.signal.id, 'queued', null)
          this.recoveredRuns.delete(deliveryKey(record.agent, record.signal.id))
        } else {
          this.record({ event: 'run.recovered', ...base, outcome: 'interrupted' })
          const reason =
            record.phase === 'started'
              ? 'container missing on recovery; no exit was observed'
              : 'container never started and its delivery was not requeued'
          const result = await recordInterruptedRun(this.runsDir, record, reason)
          this.record({
            event: 'run.finished',
            ...base,
            status: 'interrupted',
            exitCode: null,
            durationMs: result.durationMs,
            error: reason,
          })
          await this.journal.flush()
          this.ledger.setStatus(record.agent, record.signal.id, 'done', record.runId)
          await this.queue.remove(record.agent, record.signal.id)
          await this.closeLifecycle(record.runId)
        }
        continue
      }
      // Live (or exited-but-uncollected): the redactor learns the values the
      // container actually holds, so rotated credentials still get scrubbed.
      for (const [name, value] of Object.entries(observation.secrets)) this.registerSecret(name, value)
      this.record({
        event: 'run.recovered',
        ...base,
        outcome: observation.state === 'exited' ? 'finalized' : 'reattached',
      })
      const state = this.runStateFor(record.agent)
      state.active += 1
      reattached += 1
      const active: ActiveRun = {
        runId: record.runId,
        agent: record.agent,
        signal: record.signal,
        detach: new AbortController(),
        cancel: new AbortController(),
      }
      this.activeRuns.set(record.runId, active)
      this.ledger.setStatus(record.agent, record.signal.id, 'active', record.runId)
      const outcome = this.executor.resume({
        lifecycle: record,
        runsDir: this.runsDir,
        redactor: this.redactor,
        control: { detach: active.detach.signal, cancel: active.cancel.signal },
        ...this.handlersFor(record.runId, record.agent, record.signal),
      })
      this.track(active, state, outcome)
    }
    await this.ledger.flush()
    if (reattached > 0) {
      this.record({ event: 'note', message: `recovery: resumed supervision of ${reattached} run(s)` })
    }

    // Containers with no record to recover from — a pre-2.0 orchestrator's, or
    // one whose run directory was removed by hand — are orphans, as before.
    const swept = await this.executor.sweep(this.runsDir, this.protectedRuns).catch((err: unknown) => {
      this.logger.warn(`orphan sweep failed: ${String(err)}`)
      return [] as string[]
    })
    if (swept.length > 0) {
      this.record({ event: 'note', message: `boot sweep removed ${swept.length} orphaned container(s)` })
    }
  }

  /** Journal the terminal entry a finalized record already holds. */
  private journalTerminal(record: RunLifecycleRecord): void {
    const base = { runId: record.runId, agent: record.agent, signalId: record.signal.id }
    const outcome: RunRecord | null = record.outcome
    if (outcome === null) {
      this.record({
        event: 'run.finished',
        ...base,
        status: 'error',
        exitCode: null,
        durationMs: null,
        error: record.error ?? 'run ended without an outcome',
      })
      return
    }
    this.record({
      event: 'run.finished',
      ...base,
      status: outcome.status,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      ...(outcome.killReason !== null ? { killReason: outcome.killReason } : {}),
      ...(outcome.status === 'interrupted' && outcome.resultError !== null ? { error: outcome.resultError } : {}),
    })
  }

  /**
   * Put every durable pending delivery back on its agent's queue (journaled
   * `run.queued` again, with the restored depth), then admit up to each
   * agent's *current* cap, counting the runs recovery already reattached.
   * Deliveries for agents that no longer exist are dropped, journaled.
   */
  private async restoreQueue(): Promise<void> {
    const pending = await this.queue.load()
    for (const entry of pending) {
      const agent = this.agents.find((a) => a.name === entry.agent)
      if (agent === undefined) {
        this.record({
          event: 'run.skipped',
          agent: entry.agent,
          signalId: entry.signal.id,
          signalType: entry.signal.type,
          reason: 'agent-removed',
          detail: 'queued delivery dropped: agent no longer defined',
        })
        await this.queue.remove(entry.agent, entry.signal.id)
        this.ledger.drop(entry.agent, entry.signal.id)
        continue
      }
      // A queue file that outlived its run's intent record (the crash came
      // between writing the intent and removing the file) carries nothing new.
      const runFor = this.recoveredRuns.get(deliveryKey(entry.agent, entry.signal.id))
      const delivery = this.ledger.delivery(agent.name, entry.signal.id)
      if (runFor !== undefined || delivery?.status === 'done') {
        await this.queue.remove(agent.name, entry.signal.id)
        continue
      }
      if (delivery === undefined) this.ledger.accept(agent.name, entry.signal)
      this.ledger.setStatus(agent.name, entry.signal.id, 'queued', null)
      const state = this.runStateFor(agent.name)
      state.queue.push(entry.signal)
      this.record({
        event: 'run.queued',
        agent: agent.name,
        signalId: entry.signal.id,
        signalType: entry.signal.type,
        queueDepth: state.queue.length,
      })
    }
    await this.ledger.flush()
    for (const agentName of this.runStates.keys()) this.admitNext(agentName)
  }

  /**
   * Journal an entry and mirror it on the in-process emitter (SPEC §12).
   * Entries are redacted first — both the disk line and what listeners see.
   */
  private record(entry: Parameters<Journal['append']>[0]): void {
    const redacted = this.redactor.redactJson(entry)
    const stamped = this.journal.append(redacted)
    this.emitter.emit(redacted.event, stamped)
  }
}

function deliveryKey(agent: string, signalId: string): string {
  return `${agent}\u0000${signalId}`
}

function redactingLogger(base: Logger, redactor: Redactor): Logger {
  return {
    debug: (m) => base.debug(redactor.redactString(m)),
    info: (m) => base.info(redactor.redactString(m)),
    warn: (m) => base.warn(redactor.redactString(m)),
    error: (m) => base.error(redactor.redactString(m)),
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
