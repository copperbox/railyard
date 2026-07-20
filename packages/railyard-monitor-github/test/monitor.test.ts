import { createMonitorTestContext } from '@copperbox/railyard'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawIssue, RawIssueEvent } from '../src/client.js'
import { GitHubIssuesMonitor, githubIssueEmits } from '../src/index.js'
import { stubFetch, type StubResponse } from './helpers/fetch-stub.js'

const BASE = 'https://api.github.test'

function rawIssue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 7,
    title: 'A bug',
    body: 'It breaks',
    state: 'open',
    user: { login: 'reporter' },
    labels: [{ name: 'bug' }, 'needs-review'],
    assignees: [{ login: 'dan' }],
    html_url: 'https://github.com/o/r/issues/7',
    url: `${BASE}/repos/o/r/issues/7`,
    created_at: '2026-07-18T00:00:00Z',
    updated_at: '2026-07-19T00:00:00Z',
    ...over,
  }
}

function rawEvent(id: number, kind: string, over: Partial<RawIssueEvent> = {}): RawIssueEvent {
  return {
    id,
    event: kind,
    actor: { login: 'labeler' },
    label: kind === 'labeled' || kind === 'unlabeled' ? { name: 'needs-review', color: 'd73a4a' } : undefined,
    created_at: '2026-07-19T12:00:00Z',
    issue: rawIssue(),
    ...over,
  }
}

function repoBody(fullName: string, isPrivate = false) {
  const [owner = '', name = ''] = fullName.split('/')
  return {
    name,
    full_name: fullName,
    owner: { login: owner },
    html_url: `https://github.com/${fullName}`,
    private: isPrivate,
  }
}

/** Route stub for one-or-more repos; per-repo events can be swapped between polls. */
function githubStub(eventsByRepo: Record<string, () => StubResponse>) {
  return stubFetch((url) => {
    for (const [repo, events] of Object.entries(eventsByRepo)) {
      if (url === `${BASE}/repos/${repo}`) return { body: repoBody(repo, repo.endsWith('/secret')) }
      if (url.startsWith(`${BASE}/repos/${repo}/issues/events`)) return events()
    }
    return { status: 404, body: { message: `unstubbed ${url}` } }
  })
}

function monitor(over: Partial<ConstructorParameters<typeof GitHubIssuesMonitor>[0]> = {}, fetchImpl?: typeof fetch) {
  return new GitHubIssuesMonitor({
    repos: ['o/r'],
    token: 'tok_test',
    apiBaseUrl: BASE,
    pollIntervalMs: 60_000,
    fetchImpl,
    ...over,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GitHubIssuesMonitor config validation', () => {
  it('rejects empty or malformed repos, bad intervals, bad page limits', () => {
    expect(() => monitor({ repos: [] })).toThrow(/non-empty/)
    expect(() => monitor({ repos: ['not-a-repo'] })).toThrow(/owner\/name/)
    expect(() => monitor({ pollIntervalMs: 0 })).toThrow(/pollIntervalMs/)
    expect(() => monitor({ pageLimit: 0 })).toThrow(/pageLimit/)
  })

  it('declares all four github.issue.* types', () => {
    expect(monitor().emits).toBe(githubIssueEmits)
  })
})

describe('GitHubIssuesMonitor preflight', () => {
  it('fails start() loudly when a repo is unreachable, naming the repo', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: { message: 'Not Found' } }))
    const m = monitor({}, fetchImpl)
    const { ctx } = createMonitorTestContext(m.emits)
    await expect(m.start(ctx)).rejects.toThrow(/preflight failed for "o\/r".*404.*exist/s)
  })

  it('fails start() on 401 with a token hint', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }))
    const m = monitor({}, fetchImpl)
    const { ctx } = createMonitorTestContext(m.emits)
    await expect(m.start(ctx)).rejects.toThrow(/token valid/)
  })

  it('warns loudly when polling unauthenticated', async () => {
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: [] }) })
    const m = monitor({ token: undefined }, fetchImpl)
    const { ctx, logs } = createMonitorTestContext(m.emits)
    await m.start(ctx)
    await m.stop()
    expect(logs.some((l) => l.level === 'warn' && /unauthenticated.*60 requests/.test(l.message))).toBe(true)
  })
})

describe('GitHubIssuesMonitor polling', () => {
  it('baselines on first poll: emits nothing, sets cursor to the newest event id', async () => {
    const { fetchImpl } = githubStub({
      'o/r': () => ({ body: [rawEvent(300, 'labeled'), rawEvent(200, 'closed')] }),
    })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, logs, kv } = createMonitorTestContext(m.emits)
    await m.start(ctx)
    await m.stop()
    expect(emitted).toHaveLength(0)
    expect(await kv.get('cursor:o/r')).toBe(300)
    expect(logs.some((l) => l.level === 'info' && /baseline established for o\/r at event 300/.test(l.message))).toBe(true)
  })

  it('emits only allowlisted kinds, ascending, with schema-valid payloads', async () => {
    const events = [
      rawEvent(105, 'renamed'),
      rawEvent(104, 'reopened'),
      rawEvent(103, 'assigned'),
      rawEvent(102, 'unlabeled'),
      rawEvent(101, 'closed'),
      rawEvent(100, 'labeled'),
    ]
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: events }) })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 99)
    await m.start(ctx)
    await m.stop()
    // The harness already validated every payload against the published schemas.
    expect(emitted.map((e) => e.type)).toEqual([
      'github.issue.labeled',
      'github.issue.closed',
      'github.issue.unlabeled',
      'github.issue.reopened',
    ])
    expect(await kv.get('cursor:o/r')).toBe(105)
  })

  it('maps the labeled payload faithfully, repo identity from preflight', async () => {
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: [rawEvent(100, 'labeled')] }) })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    await m.stop()
    expect(emitted).toEqual([
      {
        type: 'github.issue.labeled',
        payload: {
          repo: {
            owner: 'o',
            name: 'r',
            fullName: 'o/r',
            url: 'https://github.com/o/r',
            private: false,
          },
          issue: {
            number: 7,
            title: 'A bug',
            body: 'It breaks',
            state: 'open',
            author: 'reporter',
            labels: ['bug', 'needs-review'],
            assignees: ['dan'],
            url: 'https://github.com/o/r/issues/7',
            apiUrl: `${BASE}/repos/o/r/issues/7`,
            createdAt: '2026-07-18T00:00:00Z',
            updatedAt: '2026-07-19T00:00:00Z',
          },
          label: { name: 'needs-review', color: 'd73a4a' },
          actor: 'labeler',
          eventId: 100,
          occurredAt: '2026-07-19T12:00:00Z',
        },
      },
    ])
  })

  it('handles ghost users and null bodies', async () => {
    const event = rawEvent(100, 'labeled', {
      actor: null,
      issue: rawIssue({ user: null, body: null, assignees: null }),
    })
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: [event] }) })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    await m.stop()
    const payload = emitted[0]?.payload as { actor: unknown; issue: { author: unknown; body: unknown } }
    expect(payload.actor).toBeNull()
    expect(payload.issue.author).toBeNull()
    expect(payload.issue.body).toBeNull()
  })

  it('skips pull-request events by default, includes them when opted in', async () => {
    const prEvent = rawEvent(100, 'labeled', { issue: rawIssue({ pull_request: { url: 'x' } }) })
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: [prEvent] }) })

    const excluded = monitor({}, fetchImpl)
    const excludedCtx = createMonitorTestContext(excluded.emits)
    await excludedCtx.kv.set('cursor:o/r', 1)
    await excluded.start(excludedCtx.ctx)
    await excluded.stop()
    expect(excludedCtx.emitted).toHaveLength(0)
    // Cursor still advances past filtered events.
    expect(await excludedCtx.kv.get('cursor:o/r')).toBe(100)

    const { fetchImpl: fetch2 } = githubStub({ 'o/r': () => ({ body: [prEvent] }) })
    const included = monitor({ includePullRequests: true }, fetch2)
    const includedCtx = createMonitorTestContext(included.emits)
    await includedCtx.kv.set('cursor:o/r', 1)
    await included.start(includedCtx.ctx)
    await included.stop()
    expect(includedCtx.emitted).toHaveLength(1)
  })

  it('skips malformed events (no issue, label event without label) with a warning', async () => {
    const events = [
      rawEvent(101, 'labeled', { label: undefined }),
      rawEvent(100, 'closed', { issue: undefined }),
    ]
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: events }) })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, logs, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    await m.stop()
    expect(emitted).toHaveLength(0)
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(2)
    expect(await kv.get('cursor:o/r')).toBe(101)
  })

  it('is deduped by cursor: an identical second poll emits nothing', async () => {
    vi.useFakeTimers()
    const { fetchImpl, calls } = githubStub({
      'o/r': () => ({ body: [rawEvent(100, 'labeled')] }),
    })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    expect(emitted).toHaveLength(1)
    const callsAfterFirst = calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBeGreaterThan(callsAfterFirst)
    await m.stop()
    expect(emitted).toHaveLength(1)
    expect(await kv.get('cursor:o/r')).toBe(100)
  })

  it('a seeded mid-batch cursor emits only the tail (at-least-once semantics)', async () => {
    const events = [rawEvent(103, 'labeled'), rawEvent(102, 'closed'), rawEvent(101, 'labeled')]
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: events }) })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    // As if a crash happened after persisting 102: only 103 must re-emit.
    await kv.set('cursor:o/r', 102)
    await m.start(ctx)
    await m.stop()
    expect(emitted.map((e) => (e.payload as { eventId: number }).eventId)).toEqual([103])
  })

  it('persists the cursor after each emission, before the batch completes', async () => {
    const events = [rawEvent(102, 'closed'), rawEvent(101, 'labeled')]
    const { fetchImpl } = githubStub({ 'o/r': () => ({ body: events }) })
    const m = monitor({}, fetchImpl)
    const harness = createMonitorTestContext(m.emits)
    await harness.kv.set('cursor:o/r', 100)
    const cursorAtEmit: unknown[] = []
    const originalEmit = harness.ctx.emit.bind(harness.ctx)
    harness.ctx.emit = (draft) => {
      originalEmit(draft)
      cursorAtEmit.push(void 0)
    }
    // Wrap kv.set to observe ordering: each emit must be followed by a cursor write
    // before the next emit (emit-then-persist, per event).
    const writes: number[] = []
    const originalSet = harness.kv.set.bind(harness.kv)
    harness.kv.set = async (key, value) => {
      if (key === 'cursor:o/r') writes.push(value as number)
      await originalSet(key, value)
    }
    await m.start(harness.ctx)
    await m.stop()
    expect(harness.emitted).toHaveLength(2)
    // 101 persisted after the first emit, 102 after the second, then batch-end max.
    expect(writes).toEqual([101, 102, 102])
  })

  it('keeps per-repo cursors independent', async () => {
    const { fetchImpl } = githubStub({
      'o/a': () => ({ body: [rawEvent(500, 'labeled')] }),
      'o/b': () => ({ body: [rawEvent(9, 'closed')] }),
    })
    const m = monitor({ repos: ['o/a', 'o/b'] }, fetchImpl)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/a', 499)
    await kv.set('cursor:o/b', 5)
    await m.start(ctx)
    await m.stop()
    expect(emitted.map((e) => e.type).sort()).toEqual(['github.issue.closed', 'github.issue.labeled'])
    expect(await kv.get('cursor:o/a')).toBe(500)
    expect(await kv.get('cursor:o/b')).toBe(9)
  })

  it('treats 304 as nothing-new and sends the persisted etag', async () => {
    let etagSeen: string | undefined
    const { fetchImpl } = stubFetch((url) => {
      if (url === `${BASE}/repos/o/r`) return { body: repoBody('o/r') }
      return { status: 304 }
    })
    const wrapped: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/issues/events')) {
        etagSeen = (init?.headers as Record<string, string>)['if-none-match']
      }
      return fetchImpl(input, init)
    }
    const m = monitor({}, wrapped)
    const { ctx, emitted, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 50)
    await kv.set('etag:o/r', 'W/"cached"')
    await m.start(ctx)
    await m.stop()
    expect(etagSeen).toBe('W/"cached"')
    expect(emitted).toHaveLength(0)
    expect(await kv.get('cursor:o/r')).toBe(50)
  })

  it('logs a loud error when the page cap leaves a gap', async () => {
    const next = `${BASE}/repos/o/r/issues/events?per_page=100&page=2`
    const { fetchImpl } = stubFetch((url) => {
      if (url === `${BASE}/repos/o/r`) return { body: repoBody('o/r') }
      if (url === next) return { body: [rawEvent(200, 'labeled')], headers: { link: `<${next}3>; rel="next"` } }
      return { body: [rawEvent(300, 'labeled')], headers: { link: `<${next}>; rel="next"` } }
    })
    const m = monitor({ pageLimit: 2 }, fetchImpl)
    const { ctx, emitted, logs, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 5)
    await m.start(ctx)
    await m.stop()
    expect(emitted).toHaveLength(2)
    expect(logs.some((l) => l.level === 'error' && /event gap for o\/r/.test(l.message))).toBe(true)
  })

  it('pauses all polling until the rate limit resets, then resumes', async () => {
    vi.useFakeTimers()
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    let limited = true
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url === `${BASE}/repos/o/r`) return { body: repoBody('o/r') }
      if (limited) {
        return {
          status: 403,
          body: {},
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) },
        }
      }
      return { body: [rawEvent(100, 'labeled')] }
    })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, logs, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    expect(logs.some((l) => l.level === 'warn' && /rate limit hit.*pausing/.test(l.message))).toBe(true)

    // Next tick falls inside the pause window: no new requests are made.
    const callsWhilePaused = calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBe(callsWhilePaused)

    // Past the reset, polling resumes.
    limited = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.length).toBeGreaterThan(callsWhilePaused)
    expect(emitted).toHaveLength(1)
    await m.stop()
  })

  it('recovers on the next interval after a transient error, cursor untouched', async () => {
    vi.useFakeTimers()
    let fail = true
    const { fetchImpl } = githubStub({
      'o/r': () => (fail ? { status: 500, body: {} } : { body: [rawEvent(100, 'labeled')] }),
    })
    const m = monitor({}, fetchImpl)
    const { ctx, emitted, logs, kv } = createMonitorTestContext(m.emits)
    await kv.set('cursor:o/r', 1)
    await m.start(ctx)
    expect(emitted).toHaveLength(0)
    expect(logs.some((l) => l.level === 'error' && /will retry next interval/.test(l.message))).toBe(true)
    expect(await kv.get('cursor:o/r')).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toHaveLength(1)
    await m.stop()
  })

  it('skips overlapping ticks while a poll is still in flight', async () => {
    vi.useFakeTimers()
    let release: (() => void) | null = null
    let eventCalls = 0
    const { fetchImpl } = stubFetch((url) => {
      if (url === `${BASE}/repos/o/r`) return { body: repoBody('o/r') }
      eventCalls++
      return { body: [] }
    })
    const gated: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/issues/events') && release === null) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return fetchImpl(input, init)
    }
    const m = monitor({}, gated)
    const { ctx } = createMonitorTestContext(m.emits)
    const started = m.start(ctx)
    await vi.advanceTimersByTimeAsync(0) // let preflight settle; first poll now blocked
    await vi.advanceTimersByTimeAsync(180_000) // three ticks elapse while blocked
    release!()
    await started
    await vi.advanceTimersByTimeAsync(0)
    expect(eventCalls).toBe(1)
    await m.stop()
  })

  it('stop() halts polling: no further requests after stop', async () => {
    vi.useFakeTimers()
    const { fetchImpl, calls } = githubStub({ 'o/r': () => ({ body: [] }) })
    const m = monitor({}, fetchImpl)
    const { ctx } = createMonitorTestContext(m.emits)
    await m.start(ctx)
    await m.stop()
    const after = calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls.length).toBe(after)
  })
})
