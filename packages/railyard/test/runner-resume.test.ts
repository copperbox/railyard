import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
import { createRunIntent, readLifecycleRecord, updateLifecycleRecord } from '../src/run/lifecycle.js'
import { makeRunId, resumeRun } from '../src/run/runner.js'
import { watchdogAlive } from '../src/run/watchdog.js'

/**
 * A fake `docker` on PATH that answers `inspect` from a canned file, blocks in
 * `wait` until the test (or a `kill`) decides the exit code, and logs argv.
 */
async function fakeDocker() {
  const bin = await mkdtemp(path.join(tmpdir(), 'railyard-fakedocker-'))
  const log = path.join(bin, 'calls.log')
  const script = `#!/bin/sh
echo "$@" >> "${log}"
cmd="$1"
for a; do name="$a"; done
case "$cmd" in
  inspect) cat "${bin}/inspect-$name.json" ;;
  logs) echo "hello from $name" ;;
  wait) while [ ! -f "${bin}/exit-$name" ]; do sleep 0.05; done; cat "${bin}/exit-$name" ;;
  kill) echo 137 > "${bin}/exit-$name" ;;
esac
exit 0
`
  await writeFile(path.join(bin, 'docker'), script)
  await chmod(path.join(bin, 'docker'), 0o755)
  return {
    bin,
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
    running: (name: string, startedAt: string) =>
      writeFile(
        path.join(bin, `inspect-${name}.json`),
        JSON.stringify({
          State: { Status: 'running', ExitCode: 0, StartedAt: startedAt, FinishedAt: '0001-01-01T00:00:00Z' },
          Config: { Env: ['PATH=/usr/bin'] },
        }),
      ),
    exit: (name: string, code: number) => writeFile(path.join(bin, `exit-${name}`), `${code}\n`),
  }
}

/** A run persisted at phase `created`: the crash came between `docker start` and the record's `started` transition. */
async function createdRecord(runsDir: string, timeoutSeconds: number) {
  const signal = stampSignal({ kind: 'monitor', name: 'ticker' }, { type: 'demo.tick', payload: { n: 1 } })
  const intent = createRunIntent({
    runId: makeRunId('echo'),
    agent: 'echo',
    agentDir: '/agents/echo',
    imageRef: 'fake/echo:latest',
    signal,
    timeoutSeconds,
    network: 'default',
    secretNames: [],
    hasPrompt: false,
  })
  await mkdir(path.join(runsDir, intent.runId, 'output'), { recursive: true })
  await writeFile(path.join(runsDir, intent.runId, 'events.jsonl'), '')
  return updateLifecycleRecord(runsDir, intent, { phase: 'created', createdAt: new Date().toISOString() })
}

describe.skipIf(process.platform === 'win32')('resumeRun: container started before the record said so (SPEC §6.5)', () => {
  const originalPath = process.env.PATH

  async function withFakeDocker<T>(fn: (d: Awaited<ReturnType<typeof fakeDocker>>) => Promise<T>): Promise<T> {
    const d = await fakeDocker()
    process.env.PATH = `${d.bin}:${originalPath ?? ''}`
    try {
      return await fn(d)
    } finally {
      process.env.PATH = originalPath
    }
  }

  it('adopts the container\'s actual start as the deadline base and kills it when that deadline has already passed', { timeout: 10_000 }, async () => {
    await withFakeDocker(async (d) => {
      const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-resume-'))
      const record = await createdRecord(runsDir, 1)
      const startedAt = new Date(Date.now() - 5_000).toISOString()
      await d.running(record.containerName, startedAt)

      const outcome = await resumeRun({ lifecycle: record, runsDir, onEvent: () => {} })
      expect(outcome.kind).toBe('finished')
      if (outcome.kind !== 'finished') return
      expect(outcome.record).toMatchObject({ exitCode: 137, status: 'failed', killReason: 'timeout: exceeded 1s' })
      expect(outcome.record.startedAt).toBe(startedAt)

      const persisted = (await readLifecycleRecord(runsDir, record.runId))!
      expect(persisted.phase).toBe('finalized')
      expect(persisted.startedAt).toBe(startedAt)
      expect(persisted.deadlineAt).toBe(new Date(Date.parse(startedAt) + 1_000).toISOString())
      const calls = await d.calls()
      expect(calls).toContain(`kill ${record.containerName}`)
      expect(calls.some((c) => c.startsWith('start '))).toBe(false)
    })
  })

  it('records the start, fixes the deadline from it, and spawns a watchdog for the remaining time', { timeout: 10_000 }, async () => {
    await withFakeDocker(async (d) => {
      const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-resume-'))
      const record = await createdRecord(runsDir, 60)
      const startedAt = new Date().toISOString()
      await d.running(record.containerName, startedAt)

      const outcome = resumeRun({ lifecycle: record, runsDir, onEvent: () => {} })
      let pid = 0
      await vi.waitFor(async () => {
        const r = (await readLifecycleRecord(runsDir, record.runId))!
        expect(r.phase).toBe('started')
        expect(r.watchdogPid).not.toBeNull()
        pid = r.watchdogPid!
      })
      const started = (await readLifecycleRecord(runsDir, record.runId))!
      expect(started.startedAt).toBe(startedAt)
      expect(started.deadlineAt).toBe(new Date(Date.parse(startedAt) + 60_000).toISOString())
      expect(await watchdogAlive(pid, record.containerName)).toBe(true)

      await d.exit(record.containerName, 0)
      const result = await outcome
      expect(result.kind).toBe('finished')
      if (result.kind !== 'finished') return
      expect(result.record).toMatchObject({ exitCode: 0, status: 'succeeded', killReason: null, startedAt })
      await vi.waitFor(async () => expect(await watchdogAlive(pid, record.containerName)).toBe(false))
      expect(await d.calls()).toContain(`rm -f ${record.containerName}`)
    })
  })
})
