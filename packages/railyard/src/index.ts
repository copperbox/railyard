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
} from './contracts/types.js'
export { newSignalId } from './contracts/id.js'
export {
  compilePayloadSchema,
  formatAjvErrors,
  validateAgentManifest,
  validateEventsLine,
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
export { stampSignal } from './bus/stamp.js'

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
  CONTAINER_PATHS,
  makeRunId,
  runAgent,
  sweepOrphanContainers,
  type RunAgentParams,
  type RunRecord,
} from './run/runner.js'
export { EventsTailer, type EventsTailerHandlers } from './run/events-tailer.js'

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
export { JsonFileKvStore, type KeyValueStore } from './state/kv.js'

// The orchestrator (SPEC §1, §10)
export { Orchestrator, type OrchestratorConfig } from './orchestrator.js'
