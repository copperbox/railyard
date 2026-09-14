import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * The deadline watchdog (SPEC §6.2 under recovery): one tiny detached process
 * per run with a hard timeout, spawned at container start. It sleeps until the
 * run's absolute deadline and then `docker kill`s the container, writing a
 * marker into the run directory so finalization can report the kill as a
 * timeout. Because it is its own process group, it outlives the orchestrator:
 * a run's original deadline stays enforced while no orchestrator is running.
 * A restarted supervisor verifies the watchdog is still alive (and respawns
 * one for the remaining time if not); normal finalization stops it.
 */
export const WATCHDOG_KILL_FILE = 'watchdog-kill.json'

export interface WatchdogKill {
  killedAt: string
  reason: string
}

export interface SpawnWatchdogParams {
  containerName: string
  runDir: string
  deadlineAt: Date
  timeoutSeconds: number
  /** Test seam: extra env for the watchdog (e.g. a PATH with a fake docker). */
  env?: Record<string, string>
}

/** Runs under `node -e`; process.argv[1..] are the args after the script. */
const WATCHDOG_SCRIPT = `
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const [containerName, deadlineMs, runDir, timeoutSeconds] = process.argv.slice(1)
const MAX_DELAY = 2147483647
function fire() {
  const result = spawnSync('docker', ['kill', containerName], { stdio: 'ignore' })
  if (result.status === 0) {
    const marker = { killedAt: new Date().toISOString(), reason: 'timeout: exceeded ' + timeoutSeconds + 's' }
    try { fs.writeFileSync(path.join(runDir, '${WATCHDOG_KILL_FILE}'), JSON.stringify(marker, null, 2)) } catch {}
  }
}
function wait() {
  const remaining = Number(deadlineMs) - Date.now()
  if (remaining <= 0) fire()
  else setTimeout(wait, Math.min(remaining, MAX_DELAY))
}
wait()
`

export function spawnWatchdog(params: SpawnWatchdogParams): number {
  const child = spawn(
    process.execPath,
    [
      '-e',
      WATCHDOG_SCRIPT,
      params.containerName,
      String(params.deadlineAt.getTime()),
      params.runDir,
      String(params.timeoutSeconds),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: params.env ? { ...process.env, ...params.env } : process.env,
    },
  )
  child.unref()
  if (child.pid === undefined) throw new Error('failed to spawn deadline watchdog')
  return child.pid
}

/**
 * True when `pid` is alive *and* is our watchdog for this container. The
 * second check (Linux: /proc cmdline; elsewhere: `ps`) guards against pid
 * reuse after a reboot — we must never signal a stranger's process.
 */
export async function watchdogAlive(pid: number, containerName: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  return commandLineMentions(pid, containerName)
}

async function commandLineMentions(pid: number, needle: string): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      const cmdline = await readFile(path.join('/proc', String(pid), 'cmdline'), 'latin1')
      return cmdline.includes(needle)
    } catch {
      return false
    }
  }
  return new Promise((resolve) => {
    const ps = spawn('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    ps.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    ps.on('error', () => resolve(false))
    ps.on('close', () => resolve(out.includes(needle)))
  })
}

/** Stop a watchdog we own. Silent when it is already gone or isn't ours. */
export async function stopWatchdog(pid: number | null, containerName: string): Promise<void> {
  if (pid === null) return
  if (!(await watchdogAlive(pid, containerName))) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/** The marker a watchdog leaves after a successful kill; null when it never fired. */
export async function readWatchdogKill(runDir: string): Promise<WatchdogKill | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runDir, WATCHDOG_KILL_FILE), 'utf8')) as WatchdogKill
    return typeof parsed.reason === 'string' ? parsed : null
  } catch {
    return null
  }
}
