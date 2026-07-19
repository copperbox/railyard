import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepRetention } from '../src/run/retention.js'

const NOW = new Date('2026-07-19T12:00:00.000Z')

/** Fabricate a run dir named the way makeRunId() names them. */
async function makeRun(runsDir: string, iso: string, agent: string, suffix = 'abcd1234') {
  const runId = `${iso.replaceAll(':', '-')}--${agent}--${suffix}`
  await mkdir(path.join(runsDir, runId), { recursive: true })
  await writeFile(path.join(runsDir, runId, 'result.json'), '{}')
  return runId
}

async function setup() {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'railyard-retention-'))
  await writeFile(path.join(runsDir, 'journal.jsonl'), '{"event":"note"}\n')
  return runsDir
}

describe('sweepRetention', () => {
  it('does nothing when the policy has no rules', async () => {
    const runsDir = await setup()
    await makeRun(runsDir, '2020-01-01T00:00:00.000Z', 'old-agent')
    expect(await sweepRetention({ runsDir, policy: {}, now: NOW })).toEqual([])
  })

  it('prunes by age, keeping younger runs', async () => {
    const runsDir = await setup()
    const old = await makeRun(runsDir, '2026-07-16T12:00:00.000Z', 'echo')
    const young = await makeRun(runsDir, '2026-07-18T12:00:00.000Z', 'echo')
    const removed = await sweepRetention({ runsDir, policy: { maxAgeDays: 2 }, now: NOW })
    expect(removed).toEqual([old])
    expect(await readdir(runsDir)).toContain(young)
  })

  it('prunes by count per agent, keeping the newest', async () => {
    const runsDir = await setup()
    const a1 = await makeRun(runsDir, '2026-07-19T01:00:00.000Z', 'agent-a', '11111111')
    const a2 = await makeRun(runsDir, '2026-07-19T02:00:00.000Z', 'agent-a', '22222222')
    const a3 = await makeRun(runsDir, '2026-07-19T03:00:00.000Z', 'agent-a', '33333333')
    const b1 = await makeRun(runsDir, '2026-07-19T01:00:00.000Z', 'agent-b', '44444444')
    const removed = await sweepRetention({ runsDir, policy: { maxRunsPerAgent: 1 }, now: NOW })
    expect(removed.sort()).toEqual([a1, a2].sort())
    const left = await readdir(runsDir)
    expect(left).toContain(a3)
    expect(left).toContain(b1)
  })

  it('combines rules as a union — whichever prunes more wins (SPEC §12)', async () => {
    const runsDir = await setup()
    // Young but over-count:
    const overCount = await makeRun(runsDir, '2026-07-19T01:00:00.000Z', 'echo', '11111111')
    const newest = await makeRun(runsDir, '2026-07-19T02:00:00.000Z', 'echo', '22222222')
    // Under-count (different agent) but too old:
    const tooOld = await makeRun(runsDir, '2026-07-01T00:00:00.000Z', 'other', '33333333')
    const removed = await sweepRetention({
      runsDir,
      policy: { maxAgeDays: 7, maxRunsPerAgent: 1 },
      now: NOW,
    })
    expect(removed.sort()).toEqual([overCount, tooOld].sort())
    expect(await readdir(runsDir)).toContain(newest)
  })

  it('never touches journal.jsonl or non-run-shaped entries', async () => {
    const runsDir = await setup()
    await mkdir(path.join(runsDir, 'not-a-run-dir'))
    await writeFile(path.join(runsDir, 'stray-file.txt'), 'keep me')
    await makeRun(runsDir, '2020-01-01T00:00:00.000Z', 'echo')
    await sweepRetention({ runsDir, policy: { maxAgeDays: 1 }, now: NOW })
    const left = await readdir(runsDir)
    expect(left).toContain('journal.jsonl')
    expect(left).toContain('not-a-run-dir')
    expect(left).toContain('stray-file.txt')
  })

  it('never prunes an active run, whatever its age', async () => {
    const runsDir = await setup()
    const active = await makeRun(runsDir, '2020-01-01T00:00:00.000Z', 'echo', '11111111')
    const stale = await makeRun(runsDir, '2020-01-01T00:00:00.000Z', 'echo', '22222222')
    const removed = await sweepRetention({
      runsDir,
      policy: { maxAgeDays: 1 },
      activeRunIds: new Set([active]),
      now: NOW,
    })
    expect(removed).toEqual([stale])
    expect(await readdir(runsDir)).toContain(active)
  })

  it('tolerates a missing runs dir', async () => {
    expect(
      await sweepRetention({ runsDir: '/nope/never', policy: { maxAgeDays: 1 }, now: NOW }),
    ).toEqual([])
  })
})
