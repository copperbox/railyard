import { describe, expect, it } from 'vitest'
import { GitHubClient, type RawIssueEvent } from '../src/client.js'
import { stubFetch } from './helpers/fetch-stub.js'

const BASE = 'https://api.github.test'
const EVENTS_URL = `${BASE}/repos/o/r/issues/events?per_page=100`

function event(id: number, kind = 'labeled'): RawIssueEvent {
  return { id, event: kind, actor: { login: 'dan' }, created_at: '2026-07-19T00:00:00Z' }
}

function client(fetchImpl: typeof fetch, token?: string): GitHubClient {
  return new GitHubClient({ apiBaseUrl: BASE, token, fetchImpl })
}

describe('GitHubClient headers', () => {
  it('always sends accept, api-version, and user-agent; bearer only with a token', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: [] }))
    await client(fetchImpl, 'tok_123').listIssueEvents('o/r', { pageLimit: 10 })
    await client(fetchImpl).listIssueEvents('o/r', { pageLimit: 10 })

    expect(calls[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'copperbox-railyard-monitor-github',
      authorization: 'Bearer tok_123',
    })
    expect(calls[1]?.headers.authorization).toBeUndefined()
  })

  it('sends if-none-match on page 1 only', async () => {
    const page2 = `${BASE}/repos/o/r/issues/events?per_page=100&page=2`
    const { fetchImpl, calls } = stubFetch((url) =>
      url === EVENTS_URL
        ? { body: [event(10)], headers: { link: `<${page2}>; rel="next"` } }
        : { body: [event(9), event(1)] },
    )
    const result = await client(fetchImpl).listIssueEvents('o/r', {
      sinceId: 5,
      etag: 'W/"abc"',
      pageLimit: 10,
    })
    expect(result.kind).toBe('ok')
    expect(calls[0]?.headers['if-none-match']).toBe('W/"abc"')
    expect(calls[1]?.headers['if-none-match']).toBeUndefined()
  })
})

describe('GitHubClient.listIssueEvents', () => {
  it('collects events above the cursor across pages, sorted ascending', async () => {
    const page2 = `${BASE}/repos/o/r/issues/events?per_page=100&page=2`
    const { fetchImpl, calls } = stubFetch((url) =>
      url === EVENTS_URL
        ? { body: [event(110), event(105)], headers: { link: `<${page2}>; rel="next"` } }
        : { body: [event(100), event(95), event(90)] },
    )
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 95, pageLimit: 10 })
    expect(result).toMatchObject({ kind: 'ok', gap: false })
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.events.map((e) => e.id)).toEqual([100, 105, 110])
    expect(calls).toHaveLength(2)
  })

  it('sorts ascending even if the API returns ascending order', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: [event(7), event(9), event(8)] }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
    expect(result.events.map((e) => e.id)).toEqual([7, 8, 9])
  })

  it('stops paginating once the cursor is reached', async () => {
    const page2 = `${BASE}/repos/o/r/issues/events?per_page=100&page=2`
    const { fetchImpl, calls } = stubFetch((url) =>
      url === EVENTS_URL
        ? { body: [event(20), event(10)], headers: { link: `<${page2}>; rel="next"` } }
        : { body: [event(5)] },
    )
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 10, pageLimit: 10 })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
    expect(result.events.map((e) => e.id)).toEqual([20])
    expect(calls).toHaveLength(1)
  })

  it('flags a gap when the page cap hits before the cursor with more pages available', async () => {
    const next = (n: number) => `${BASE}/repos/o/r/issues/events?per_page=100&page=${n}`
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url === EVENTS_URL) return { body: [event(300)], headers: { link: `<${next(2)}>; rel="next"` } }
      if (url === next(2)) return { body: [event(200)], headers: { link: `<${next(3)}>; rel="next"` } }
      return { body: [event(100)] }
    })
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 2 })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
    expect(result.gap).toBe(true)
    expect(result.events.map((e) => e.id)).toEqual([200, 300])
    expect(calls).toHaveLength(2)
  })

  it('reports no gap when history simply ends before the cursor', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: [event(20)] }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
    expect(result.gap).toBe(false)
    expect(result.events.map((e) => e.id)).toEqual([20])
  })

  it('baseline (no cursor) fetches exactly one page even when more exist', async () => {
    const page2 = `${BASE}/repos/o/r/issues/events?per_page=100&page=2`
    const { fetchImpl, calls } = stubFetch(() => ({
      body: [event(50), event(40)],
      headers: { link: `<${page2}>; rel="next"` },
    }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { pageLimit: 10 })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
    expect(result.events.map((e) => e.id)).toEqual([40, 50])
    expect(result.gap).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('returns notModified on a 304 and captures the page-1 etag on hits', async () => {
    const { fetchImpl } = stubFetch((_url, call) =>
      call === 0
        ? { body: [event(10)], headers: { etag: 'W/"fresh"' } }
        : { status: 304 },
    )
    const c = client(fetchImpl)
    const first = await c.listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    if (first.kind !== 'ok') throw new Error(`expected ok, got ${first.kind}`)
    expect(first.etag).toBe('W/"fresh"')
    const second = await c.listIssueEvents('o/r', { sinceId: 10, etag: 'W/"fresh"', pageLimit: 10 })
    expect(second.kind).toBe('notModified')
  })

  it('classifies 403 with exhausted rate limit, resuming at x-ratelimit-reset', async () => {
    const reset = 1900000000
    const { fetchImpl } = stubFetch(() => ({
      status: 403,
      body: { message: 'rate limited' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    expect(result).toMatchObject({ kind: 'rateLimited', resumeAt: reset * 1000 })
  })

  it('classifies 429 with retry-after, resuming after the given seconds', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 429,
      body: {},
      headers: { 'retry-after': '120' },
    }))
    const before = Date.now()
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    if (result.kind !== 'rateLimited') throw new Error(`expected rateLimited, got ${result.kind}`)
    expect(result.resumeAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(result.resumeAt).toBeLessThanOrEqual(Date.now() + 121_000)
  })

  it('treats a 403 without rate-limit markers as a plain error', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { message: 'forbidden' } }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    expect(result).toMatchObject({ kind: 'error', status: 403 })
  })

  it('surfaces HTTP errors with status and body excerpt', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    if (result.kind !== 'error') throw new Error(`expected error, got ${result.kind}`)
    expect(result.status).toBe(401)
    expect(result.detail).toContain('Bad credentials')
  })

  it('surfaces network failures as errors with null status', async () => {
    const { fetchImpl } = stubFetch(() => ({ throwError: new Error('ECONNREFUSED') }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    expect(result).toMatchObject({ kind: 'error', status: null })
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.detail).toContain('ECONNREFUSED')
  })

  it('surfaces unparsable bodies as errors', async () => {
    const { fetchImpl } = stubFetch(() => ({ text: 'not json {' }))
    const result = await client(fetchImpl).listIssueEvents('o/r', { sinceId: 5, pageLimit: 10 })
    expect(result).toMatchObject({ kind: 'error', status: 200 })
  })
})

describe('GitHubClient.getRepo', () => {
  it('returns the repo on 200', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: {
        name: 'r',
        full_name: 'o/r',
        owner: { login: 'o' },
        html_url: 'https://github.com/o/r',
        private: false,
      },
    }))
    const result = await client(fetchImpl, 'tok').getRepo('o/r')
    expect(result).toMatchObject({ kind: 'ok', repo: { full_name: 'o/r' } })
    expect(calls[0]?.url).toBe(`${BASE}/repos/o/r`)
  })

  it('classifies 404 as error and exhausted 403 as rateLimited', async () => {
    const { fetchImpl } = stubFetch((_url, call) =>
      call === 0
        ? { status: 404, body: { message: 'Not Found' } }
        : {
            status: 403,
            body: {},
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
          },
    )
    const c = client(fetchImpl)
    expect(await c.getRepo('o/missing')).toMatchObject({ kind: 'error', status: 404 })
    expect(await c.getRepo('o/r')).toMatchObject({ kind: 'rateLimited' })
  })
})
