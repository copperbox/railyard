import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DirectoryLock,
  LOCK_FILE_NAME,
  RUNS_DIR_LOCK,
  STATE_DIR_LOCK,
  type DirectoryLockInfo,
} from '../src/run/lock.js'

async function tempRunsDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'railyard-lock-'))
}

/** Above every platform's pid_max, so `kill(pid, 0)` can only report "gone". */
const DEAD_PID = 0x7ffffffe

async function writeLock(runsDir: string, info: Partial<DirectoryLockInfo>): Promise<string> {
  const lockPath = path.join(runsDir, LOCK_FILE_NAME)
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: DEAD_PID,
      hostname: hostname(),
      acquiredAt: '2026-07-01T00:00:00.000Z',
      token: 'deadbeef',
      ...info,
    }),
  )
  return lockPath
}

describe('DirectoryLock', () => {
  it('creates the directory and writes an owner record', async () => {
    const runsDir = path.join(await tempRunsDir(), 'nested', 'runs')
    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)

    const info = JSON.parse(await readFile(lock.path, 'utf8')) as DirectoryLockInfo
    expect(info.pid).toBe(process.pid)
    expect(info.hostname).toBe(hostname())
    expect(info.token).toMatch(/^[0-9a-f]{8}$/)
    expect(Number.isNaN(Date.parse(info.acquiredAt))).toBe(false)

    await lock.release()
  })

  it('refuses a second acquire while the first is held, naming the holder', async () => {
    const runsDir = await tempRunsDir()
    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)

    await expect(DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)).rejects.toThrow(
      new RegExp(`locked by another railyard orchestrator[\\s\\S]*pid ${process.pid}`),
    )
    // The message must tell the operator how to recover.
    await expect(DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)).rejects.toThrow(/delete .*\.railyard\.lock/)

    await lock.release()
  })

  it('allows re-acquisition after release', async () => {
    const runsDir = await tempRunsDir()
    const first = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    await first.release()
    await expect(stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' })

    const second = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    await second.release()
  })

  it('takes over a lock left behind by a dead process on this host', async () => {
    const runsDir = await tempRunsDir()
    await writeLock(runsDir, { pid: DEAD_PID })

    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    const info = JSON.parse(await readFile(lock.path, 'utf8')) as DirectoryLockInfo
    expect(info.pid).toBe(process.pid)
    expect(info.token).not.toBe('deadbeef')

    await lock.release()
  })

  it('refuses a stale-looking lock from another host — liveness is unknowable there', async () => {
    const runsDir = await tempRunsDir()
    await writeLock(runsDir, { pid: DEAD_PID, hostname: 'some-other-box' })

    await expect(DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)).rejects.toThrow(/host "some-other-box"/)
  })

  it('refuses a corrupt lock file rather than clearing evidence', async () => {
    const runsDir = await tempRunsDir()
    await writeFile(path.join(runsDir, LOCK_FILE_NAME), 'not json at all')

    await expect(DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)).rejects.toThrow(/unreadable or corrupt/)
    // Still there — a human should look at it.
    expect(await readFile(path.join(runsDir, LOCK_FILE_NAME), 'utf8')).toBe('not json at all')
  })

  it('release is idempotent', async () => {
    const runsDir = await tempRunsDir()
    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('release leaves a lock that a successor took over', async () => {
    const runsDir = await tempRunsDir()
    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    // We were judged stale and someone else now owns the file (different token).
    await writeLock(runsDir, { pid: process.pid, token: 'successor' })

    await lock.release()

    const info = JSON.parse(await readFile(lock.path, 'utf8')) as DirectoryLockInfo
    expect(info.token).toBe('successor')
  })

  it('tolerates a lock file that vanished under it', async () => {
    const runsDir = await tempRunsDir()
    const lock = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    await rm(lock.path)
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('names the locked directory and explains what sharing it breaks', async () => {
    const runsDir = await tempRunsDir()
    const stateDir = await tempRunsDir()
    const runs = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)
    const state = await DirectoryLock.acquire(stateDir, STATE_DIR_LOCK)

    await expect(DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)).rejects.toThrow(
      /runs directory ".*" is locked[\s\S]*orphan-container sweep/,
    )
    await expect(DirectoryLock.acquire(stateDir, STATE_DIR_LOCK)).rejects.toThrow(
      /state directory ".*" is locked[\s\S]*Monitor cursors/,
    )

    await state.release()
    await runs.release()
  })

  it('locks runsDir and stateDir independently', async () => {
    const runsDir = await tempRunsDir()
    const stateDir = await tempRunsDir()
    const runs = await DirectoryLock.acquire(runsDir, RUNS_DIR_LOCK)

    // Holding one says nothing about the other.
    const state = await DirectoryLock.acquire(stateDir, STATE_DIR_LOCK)
    expect(state.path).toBe(path.join(stateDir, LOCK_FILE_NAME))

    await runs.release()
    await state.release()
  })
})
