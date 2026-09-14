import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  WATCHDOG_KILL_FILE,
  readWatchdogKill,
  spawnWatchdog,
  stopWatchdog,
  watchdogAlive,
} from '../src/run/watchdog.js'

/** A fake `docker` on PATH that records its argv and exits per FAKE_DOCKER_EXIT. */
async function fakeDocker(exitCode: number) {
  const bin = await mkdtemp(path.join(tmpdir(), 'railyard-fakedocker-'))
  const log = path.join(bin, 'calls.log')
  const script = path.join(bin, 'docker')
  await writeFile(script, `#!/bin/sh\necho "$@" >> "${log}"\nexit ${exitCode}\n`)
  await chmod(script, 0o755)
  return { env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, log }
}

describe.skipIf(process.platform === 'win32')('deadline watchdog', () => {
  it('kills the container at the deadline and leaves a timeout marker, outliving its parent', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'railyard-wd-'))
    const docker = await fakeDocker(0)
    const pid = spawnWatchdog({
      containerName: 'railyard--wd-test',
      runDir,
      deadlineAt: new Date(Date.now() + 300),
      timeoutSeconds: 42,
      env: docker.env,
    })
    expect(await watchdogAlive(pid, 'railyard--wd-test')).toBe(true)
    await vi.waitFor(async () => expect(await readWatchdogKill(runDir)).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    })
    expect(await readWatchdogKill(runDir)).toMatchObject({ reason: 'timeout: exceeded 42s' })
    expect((await readFile(docker.log, 'utf8')).trim()).toBe('kill railyard--wd-test')
    await vi.waitFor(async () => expect(await watchdogAlive(pid, 'railyard--wd-test')).toBe(false))
  })

  it('leaves no marker when the container was already gone (kill fails)', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'railyard-wd-'))
    const docker = await fakeDocker(1)
    const pid = spawnWatchdog({
      containerName: 'railyard--wd-gone',
      runDir,
      deadlineAt: new Date(Date.now() + 100),
      timeoutSeconds: 1,
      env: docker.env,
    })
    await vi.waitFor(async () => expect(await watchdogAlive(pid, 'railyard--wd-gone')).toBe(false), {
      timeout: 10_000,
    })
    expect(await readWatchdogKill(runDir)).toBeNull()
  })

  it('stopWatchdog terminates a live watchdog and ignores a pid that is not ours', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'railyard-wd-'))
    const docker = await fakeDocker(0)
    const pid = spawnWatchdog({
      containerName: 'railyard--wd-stop',
      runDir,
      deadlineAt: new Date(Date.now() + 60_000),
      timeoutSeconds: 60,
      env: docker.env,
    })
    expect(await watchdogAlive(pid, 'railyard--wd-stop')).toBe(true)
    // Our own pid is alive but is not a watchdog for that container.
    expect(await watchdogAlive(process.pid, 'railyard--wd-stop')).toBe(false)
    await stopWatchdog(process.pid, 'railyard--wd-stop') // must not signal ourselves
    await stopWatchdog(pid, 'railyard--wd-stop')
    await vi.waitFor(async () => expect(await watchdogAlive(pid, 'railyard--wd-stop')).toBe(false))
    await stopWatchdog(pid, 'railyard--wd-stop') // idempotent
    await mkdir(runDir, { recursive: true })
    expect(await readWatchdogKill(runDir)).toBeNull()
    expect(WATCHDOG_KILL_FILE).toBe('watchdog-kill.json')
  })
})
