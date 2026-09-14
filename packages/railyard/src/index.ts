// Contracts (SPEC §2, §4, §5)
export { RESERVED_AGENT_ENV_VARS } from './contracts/types.js'
export type {
  AgentManifest,
  AgentSubscription,
  EventsLine,
  JsonSchema,
  LogEventLine,
  ProvenanceEntry,
  SignalDeclaration,
  SignalDraft,
  SignalEnvelope,
  SignalEventLine,
  SignalSource,
  SourceKind,
  WorkIdentity,
} from './contracts/types.js'
export { newSignalId } from './contracts/id.js'
export {
  compilePayloadSchema,
  formatAjvErrors,
  validateAgentManifest,
  validateEventsLine,
  validateJournalLine,
  validateSignalEnvelope,
} from './contracts/validate.js'

// Prompt templating (SPEC §4, §15 M2)
export {
  parsePromptTemplate,
  renderPromptTemplate,
  type ParsedPromptTemplate,
  type TemplateSegment,
} from './prompt/template.js'

// Signal bus (SPEC §10)
export { InMemoryTransport, type SignalHandler, type SignalTransport } from './bus/transport.js'
export { deterministicSignalId, stampSignal, type StampOptions } from './bus/stamp.js'

// Agents as data (SPEC §3, §4)
export {
  loadAgents,
  loadAgentFolder,
  type ImageSource,
  type LoadAgentsResult,
  type LoadedAgent,
  type LoadedSubscription,
} from './agents/loader.js'
export { evaluateFilter, parseFilter, type ParsedFilter } from './agents/filter.js'
export {
  checkSubscriptionCompatibility,
  schemasCompatible,
  type CompatibilityReport,
  type DeclaredEmission,
} from './agents/compat.js'

// Images (SPEC §11)
export { dockerDaemonAvailable, ensureAgentImage, type EnsureImageOptions } from './docker/build.js'
export { hashAgentFolder, imageTagFor } from './docker/hash.js'

// Retention (SPEC §12)
export {
  sweepRetention,
  type RetentionPolicy,
  type RetentionSweepOptions,
} from './run/retention.js'

// Execution (SPEC §5, §6)
export { DockerExecutor, type AgentExecutor } from './run/executor.js'
export {
  BackendUnavailableError,
  CONTAINER_PATHS,
  makeRunId,
  observeRun,
  recordInterruptedRun,
  resumeRun,
  runAgent,
  sweepOrphanContainers,
  type ResumeRunParams,
  type RunAgentParams,
  type RunControl,
  type RunObservation,
  type RunOutcome,
  type RunRecord,
  type RunSupervisionHandlers,
} from './run/runner.js'
export {
  EventsTailer,
  type EventsTailerHandlers,
  type EventsTailerOptions,
  type EventsTailerStopOptions,
} from './run/events-tailer.js'

// Durable lifecycle & recovery (SPEC §6.5, §6.6)
export {
  LIFECYCLE_FILE_NAME,
  LIFECYCLE_VERSION,
  UnsupportedRecordError,
  containerNameFor,
  createRunIntent,
  listLifecycleRecords,
  readLifecycleRecord,
  updateLifecycleRecord,
  writeLifecycleRecord,
  type LifecycleListing,
  type RunIntentParams,
  type RunLifecycleRecord,
  type RunPhase,
} from './run/lifecycle.js'
export {
  LEDGER_FILE_NAME,
  LEDGER_VERSION,
  WorkLedger,
  payloadHash,
  type DeliveryEntry,
  type DeliveryStatus,
  type WorkEntry,
} from './run/ledger.js'
export { DurableQueue, QUEUE_DIR_NAME, QUEUE_VERSION, type QueuedDelivery } from './run/queue.js'
export {
  WATCHDOG_KILL_FILE,
  readWatchdogKill,
  spawnWatchdog,
  stopWatchdog,
  watchdogAlive,
  type SpawnWatchdogParams,
  type WatchdogKill,
} from './run/watchdog.js'
export {
  DirectoryLock,
  LOCK_FILE_NAME,
  RUNS_DIR_LOCK,
  STATE_DIR_LOCK,
  type DirectoryLockInfo,
  type DirectoryLockOptions,
} from './run/lock.js'

// Secrets (SPEC §8)
export {
  EnvSecretsProvider,
  parseDotEnv,
  type EnvSecretsProviderOptions,
  type SecretsProvider,
} from './secrets/provider.js'
export { LineSplitter, Redactor, REDACTION_MIN_LENGTH } from './secrets/redactor.js'

// Journal (SPEC §12)
export { Journal, type JournalEntry, type JournaledEntry } from './journal/journal.js'

// Monitors (SPEC §9)
export {
  consoleLogger,
  type Logger,
  type Monitor,
  type MonitorContext,
} from './monitor/monitor.js'
export {
  createMonitorTestContext,
  type CapturedLogLine,
  type MonitorTestContext,
} from './monitor/test-context.js'
export { JsonFileKvStore, MemoryKvStore, type KeyValueStore } from './state/kv.js'

// The orchestrator (SPEC §1, §10)
export {
  Orchestrator,
  type OrchestratorConfig,
  type RecoveryPolicy,
  type ShutdownMode,
  type StopOptions,
} from './orchestrator.js'
