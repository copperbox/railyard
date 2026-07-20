import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvSecretsProvider, Orchestrator } from '@copperbox/railyard'
import { GitHubIssuesMonitor } from '@copperbox/railyard-monitor-github'

const here = path.dirname(fileURLToPath(import.meta.url))

// One .env serves both tokens no matter where the app is started from:
// EnvSecretsProvider defaults to <cwd>/.env, so an explicit path removes the
// cwd dependence. Process env still wins over the file.
const secrets = new EnvSecretsProvider({ envFile: path.join(here, '../../../.env') })

const orchestrator = new Orchestrator({
  agentsDir: path.join(here, '../agents'),
  runsDir: path.join(here, '../runs'),
  stateDir: path.join(here, '../state'),
  secrets,
  retention: { maxRunsPerAgent: 50 },
})

orchestrator.register(
  new GitHubIssuesMonitor({
    repos: ['copperbox/railyard'],
    // The monitor takes a value, not a secret name — monitors are host-side
    // code (SPEC §9); resolving it through the same provider keeps one .env.
    token: await secrets.resolve('GITHUB_TOKEN'),
    pollIntervalMs: 60_000,
  }),
)

// Narrate the workflow on the terminal; the journal keeps the durable copy.
orchestrator.on('signal.received', (e) => {
  if (e.event !== 'signal.received') return
  console.log(`[${e.at}] signal ${e.signalType} from ${e.source.kind}:${e.source.name} (${e.signalId})`)
})
orchestrator.on('run.started', (e) => {
  if (e.event !== 'run.started') return
  console.log(`[${e.at}] run ${e.runId} started: agent=${e.agent} signal=${e.signalId}`)
})
orchestrator.on('run.finished', (e) => {
  if (e.event !== 'run.finished') return
  console.log(
    `[${e.at}] run ${e.runId} finished: status=${e.status} exit=${e.exitCode} in ${e.durationMs}ms` +
      (e.error ? ` — ${e.error}` : ''),
  )
})

await orchestrator.start()
console.log(
  'github-review example running — label an issue on copperbox/railyard with ' +
    '"needs-review" and watch examples/github-review/runs/. Ctrl-C to stop.',
)

process.on('SIGINT', () => {
  console.log('\nstopping…')
  void orchestrator.stop().then(() => process.exit(0))
})
