import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { newRunId } from '../contracts/id.js'

/** Contents of `<dir>/.railyard.lock`; written once at acquire, read on conflict. */
export interface DirectoryLockInfo {
  /** Owning process id — liveness-checked on conflict, but only on the same host. */
  pid: number
  /** `os.hostname()` of the owner; a foreign host means liveness can't be checked. */
  hostname: string
  /** ISO timestamp of acquisition. */
  acquiredAt: string
  /** Random per-acquisition id, so release only ever removes *our* lock. */
  token: string
}

export interface DirectoryLockOptions {
  /** How the directory is named in errors, e.g. `runs directory`. */
  label: string
  /** Why sharing this directory is unsafe; shown after the "who holds it" line. */
  why: string
}

export const LOCK_FILE_NAME = '.railyard.lock'

/** The two directories an orchestrator owns, and what sharing each one breaks. */
export const RUNS_DIR_LOCK: DirectoryLockOptions = {
  label: 'runs directory',
  why:
    'Retention sweeps and the boot-time orphan-container sweep are scoped by runs ' +
    "directory and only exempt their own active runs, so concurrent owners delete each " +
    "other's live run directories and force-remove each other's running containers.",
}

export const STATE_DIR_LOCK: DirectoryLockOptions = {
  label: 'state directory',
  why:
    'Monitor cursors are loaded once and cached in memory, so concurrent owners silently ' +
    'overwrite each other\'s progress — re-processing or skipping whatever the monitor ' +
    'tracks. Note stateDir defaults to a "state" directory beside runsDir, so two ' +
    'orchestrators with different runsDirs under one parent share it unless you set ' +
    'stateDir explicitly.',
}

/**
 * Exclusive, advisory lock over a whole directory, held for an orchestrator's
 * started lifetime.
 *
 * Two orchestrators sharing a directory is not a line-interleaving problem — it
 * destroys data (see RUNS_DIR_LOCK / STATE_DIR_LOCK for the specifics of each).
 * So this is a boot-time guard that turns silent mutual destruction into a loud
 * startup error. It is advisory: it guards against a second *railyard*, not
 * against `rm`.
 */
export class DirectoryLock {
  private constructor(
    readonly path: string,
    private readonly info: DirectoryLockInfo,
    private released = false,
  ) {}

  /**
   * Take the lock, creating `dir` if needed. Throws if another orchestrator
   * holds it. A lock left behind by a crashed process on *this* host is
   * detected (its pid is gone) and taken over; one from another host cannot be
   * liveness-checked, so it is reported for the operator to clear by hand.
   */
  static async acquire(dir: string, options: DirectoryLockOptions): Promise<DirectoryLock> {
    const lockPath = path.join(dir, LOCK_FILE_NAME)
    await mkdir(dir, { recursive: true })

    const info: DirectoryLockInfo = {
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      token: newRunId(),
    }
    const body = JSON.stringify(info, null, 2) + '\n'

    // Two attempts: the second only happens after we cleared a provably stale lock.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 'wx' = create-exclusive; the O_CREAT|O_EXCL that makes this a lock.
        const handle = await open(lockPath, 'wx')
        try {
          await handle.writeFile(body)
        } finally {
          await handle.close()
        }
        return new DirectoryLock(lockPath, info)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        if (attempt === 1) break
        if (!(await clearIfStale(lockPath))) break
      }
    }

    throw new Error(await conflictMessage(lockPath, dir, options))
  }

  /** Release the lock. Idempotent, and never removes a lock we no longer own. */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    const current = await readLockInfo(this.path)
    // A different token means someone took over (we were judged stale); leave theirs.
    if (current !== null && current.token !== this.info.token) return
    await unlink(this.path).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }
}

/** Parse an existing lock file. Returns null if absent or unreadable/corrupt. */
async function readLockInfo(lockPath: string): Promise<DirectoryLockInfo | null> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DirectoryLockInfo>
    if (typeof parsed.pid !== 'number' || typeof parsed.hostname !== 'string') return null
    if (typeof parsed.token !== 'string') return null
    return parsed as DirectoryLockInfo
  } catch {
    return null
  }
}

/**
 * True if the pid is running (or we can't tell, which counts as running —
 * refusing to boot is always the safe side of this guess).
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another user. ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove the lock if its owner is provably gone. Returns whether it was
 * cleared. A corrupt lock file is *not* cleared — it is evidence, and a human
 * should look at it.
 */
async function clearIfStale(lockPath: string): Promise<boolean> {
  const info = await readLockInfo(lockPath)
  if (info === null) return false
  if (info.hostname !== hostname()) return false // can't check a foreign pid
  if (pidAlive(info.pid)) return false

  // Re-read and compare before unlinking: if a racing process already took the
  // lock over in the gap, the token differs and we must not remove theirs.
  const stillThere = await readLockInfo(lockPath)
  if (stillThere === null || stillThere.token !== info.token) return false
  try {
    await unlink(lockPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  }
}

/** The startup error: say who holds it, why we can't share, and how to clear it. */
async function conflictMessage(
  lockPath: string,
  dir: string,
  options: DirectoryLockOptions,
): Promise<string> {
  const info = await readLockInfo(lockPath)
  const held =
    info === null
      ? `${lockPath} exists but is unreadable or corrupt`
      : `held by pid ${info.pid} on ${
          info.hostname === hostname() ? 'this host' : `host "${info.hostname}"`
        } since ${info.acquiredAt}`

  return (
    `${options.label} "${dir}" is locked by another railyard orchestrator: ${held}.\n` +
    `${options.why}\n` +
    `Give each orchestrator its own runsDir and stateDir. If you are certain no ` +
    `orchestrator is running, delete ${lockPath} and retry.`
  )
}
