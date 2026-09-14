import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Orchestrator } from '@copperbox/railyard'
import { IntervalMonitor } from './interval-monitor.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const orchestrator = new Orchestrator({
  agentsDir: path.join(here, '../agents'),
  runsDir: path.join(here, '../runs'),
  stateDir: path.join(here, '../state'),
  // M1 safeguards, demoed: keep the newest 20 runs per agent.
  retention: { maxRunsPerAgent: 20 },
})

orchestrator.register(new IntervalMonitor(5000))
orchestrator.on('run.finished', (e) => {
  console.log(`run ${'runId' in e ? e.runId : ''} finished: ${'status' in e ? e.status : ''}`)
})

await orchestrator.start()
console.log('railyard demo running — watch examples/demo/runs/. Ctrl-C to stop.')

process.on('SIGINT', () => {
  console.log('\nstopping (drain: waiting for active runs)…')
  void orchestrator.stop().then(() => process.exit(0))
})
// A deploy sends SIGTERM: detach and leave containers running for the next start.
process.on('SIGTERM', () => {
  console.log('\ndetaching (containers keep running)…')
  void orchestrator.stop({ mode: 'detach' }).then(() => process.exit(0))
})
