import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stampSignal } from '../src/bus/stamp.js'
import {
  LIFECYCLE_FILE_NAME,
  LIFECYCLE_VERSION,
  UnsupportedRecordError,
  containerNameFor,
  createRunIntent,
  listLifecycleRecords,
  readLifecycleRecord,
  updateLifecycleRecord,
  writeLifecycleRecord,
} from '../src/run/lifecycle.js'

const signal = stampSignal({ kind: 'monitor', name: 'm' }, { type: 'demo.tick', payload: { n: 1 } })

function intent(runId: string) {
  return createRunIntent({
    runId,
    agent: 'echo',
    agentDir: '/agents/echo',
    imageRef: 'fake/echo:1',
    signal,
    timeoutSeconds: 900,
    network: 'default',
    secretNames: ['TOKEN'],
    hasPrompt: false,
  })
}

describe('run lifecycle records', () => {
  it('a fresh intent is versioned, phase "intent", with a deterministic container name', () => {
    const record = intent('2026-07-19T00-00-00.000Z--echo--aaaaaaaa')
    expect(record.lifecycleVersion).toBe(LIFECYCLE_VERSION)
    expect(record.phase).toBe('intent')
    expect(record.containerName).toBe(containerNameFor(record.runId))
    expect(record.containerName).toBe('railyard--2026-07-19T00-00-00.000Z--echo--aaaaaaaa')
    expect(record.eventsOffset).toBe(0)
    expect(record.eventsConsumed).toBe(0)
    expect(record.signal).toEqual(signal)
    // Names only — never values (SPEC §8).
    expect(record.secretNames).toEqual(['TOKEN'])
  })

  it('round-trips through the run directory and updates atomically', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-lc-'))
    const record = intent('2026-07-19T00-00-00.000Z--echo--aaaaaaaa')
    await writeLifecycleRecord(runsDir, record)
    expect(await readLifecycleRecord(runsDir, record.runId)).toEqual(record)

    const updated = await updateLifecycleRecord(runsDir, record, {
      phase: 'started',
      startedAt: '2026-07-19T00:00:01.000Z',
    })
    expect(updated.phase).toBe('started')
    expect(await readLifecycleRecord(runsDir, record.runId)).toEqual(updated)
    // The raw file is the single JSON document, no temp file left behind.
    const raw = await readFile(path.join(runsDir, record.runId, LIFECYCLE_FILE_NAME), 'utf8')
    expect(JSON.parse(raw).phase).toBe('started')
  })

  it('lists every record under runsDir, reporting unreadable ones as uncertain evidence', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-lc-'))
    const a = intent('2026-07-19T00-00-00.000Z--echo--aaaaaaaa')
    const b = intent('2026-07-19T00-00-01.000Z--echo--bbbbbbbb')
    await writeLifecycleRecord(runsDir, a)
    await writeLifecycleRecord(runsDir, b)
    // A run dir with no record (pre-recovery layout) and one with a corrupt record.
    await mkdir(path.join(runsDir, '2026-07-19T00-00-02.000Z--echo--cccccccc'))
    const corrupt = '2026-07-19T00-00-03.000Z--echo--dddddddd'
    await mkdir(path.join(runsDir, corrupt))
    await writeFile(path.join(runsDir, corrupt, LIFECYCLE_FILE_NAME), '{not json')
    await writeFile(path.join(runsDir, 'journal.jsonl'), '')

    const listed = await listLifecycleRecords(runsDir)
    expect(listed.records.map((r) => r.runId)).toEqual([a.runId, b.runId])
    expect(listed.unreadable).toEqual([corrupt])
  })

  it('refuses to load a record from a newer, unsupported version', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-lc-'))
    const record = intent('2026-07-19T00-00-00.000Z--echo--aaaaaaaa')
    await writeLifecycleRecord(runsDir, { ...record, lifecycleVersion: 99 as 1 })
    await expect(readLifecycleRecord(runsDir, record.runId)).rejects.toThrow(UnsupportedRecordError)
    await expect(listLifecycleRecords(runsDir)).rejects.toThrow(/lifecycle record version 99/)
  })

  it('returns null for a run directory without a record', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-lc-'))
    await mkdir(path.join(runsDir, 'x'))
    expect(await readLifecycleRecord(runsDir, 'x')).toBeNull()
  })
})
