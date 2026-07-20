/**
 * Real-GitHub-API tests, gated by RAILYARD_GITHUB_TESTS=1 (`pnpm test:github`).
 * Same never-silently-skip posture as the Docker/LLM gates: skipped (visibly)
 * when unset; once set, a missing GITHUB_TOKEN fails loudly in beforeAll.
 *
 * Read-only, a handful of requests against a stable public repo. This is where
 * our response-shape assumptions (event id ordering, label shape, PR markers,
 * ETag behavior) meet reality. Never asserts on volatile content.
 */
import { EnvSecretsProvider } from '@copperbox/railyard'
import { beforeAll, describe, expect, it } from 'vitest'
import { GitHubClient, type RawIssueEvent } from '../src/client.js'
import { GitHubIssuesMonitor } from '../src/index.js'

const GITHUB = process.env.RAILYARD_GITHUB_TESTS === '1'
// Stable, ancient, public, tiny: GitHub's own hello-world demo repo.
const REPO = 'octocat/Hello-World'

let token: string

describe.skipIf(!GITHUB)('github: real API contract checks', () => {
  let client: GitHubClient
  let events: RawIssueEvent[]

  beforeAll(async () => {
    const resolved = await new EnvSecretsProvider().resolve('GITHUB_TOKEN')
    if (resolved === undefined) {
      throw new Error(
        'RAILYARD_GITHUB_TESTS=1 is set but GITHUB_TOKEN is unresolvable ' +
          '(process env or repo-root .env). Tip: GITHUB_TOKEN=$(gh auth token). ' +
          'Refusing to skip silently.',
      )
    }
    token = resolved
    client = new GitHubClient({ apiBaseUrl: 'https://api.github.com', token })
    const result = await client.listIssueEvents(REPO, { pageLimit: 1 })
    if (result.kind !== 'ok') throw new Error(`listIssueEvents failed: ${JSON.stringify(result)}`)
    events = result.events
  }, 60_000)

  it('preflight succeeds against a public repo', async () => {
    const result = await client.getRepo(REPO)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.repo.full_name).toBe(REPO)
    expect(result.repo.owner.login).toBe('octocat')
    expect(typeof result.repo.private).toBe('boolean')
  })

  it('events match our shape assumptions: ids, kinds, embedded issue', () => {
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(typeof event.id).toBe('number')
      expect(Number.isSafeInteger(event.id)).toBe(true)
      expect(typeof event.event).toBe('string')
      expect(typeof event.created_at).toBe('string')
      expect(new Date(event.created_at).toString()).not.toBe('Invalid Date')
      // The repository events endpoint embeds the issue object.
      expect(event.issue, `event ${event.id} has no issue`).toBeDefined()
      expect(typeof event.issue?.number).toBe('number')
      expect(typeof event.issue?.html_url).toBe('string')
    }
  })

  it('page 1 is newest-first (the baseline assumption)', async () => {
    // Baseline takes page 1's max id as "now" — that only works if page 1 holds
    // the newest events. Probe the raw response order, not the client's sort.
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/issues/events?per_page=10`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'copperbox-railyard-monitor-github-tests',
        },
      },
    )
    expect(response.ok).toBe(true)
    const raw = (await response.json()) as Array<{ id: number }>
    expect(raw.length).toBeGreaterThan(1)
    for (let i = 1; i < raw.length; i++) {
      expect(raw[i]!.id, 'events endpoint no longer returns newest-first').toBeLessThan(raw[i - 1]!.id)
    }
  })

  it('event ids are monotonic with creation order (the cursor assumption)', () => {
    // The client sorts ascending by id; creation timestamps must not decrease
    // along that order — id order == chronological order is what makes an
    // id cursor sound.
    const sorted = [...events].sort((a, b) => a.id - b.id)
    for (let i = 1; i < sorted.length; i++) {
      const prev = Date.parse(sorted[i - 1]!.created_at)
      const curr = Date.parse(sorted[i]!.created_at)
      expect(curr, `event ${sorted[i]!.id} created before ${sorted[i - 1]!.id}`).toBeGreaterThanOrEqual(prev)
    }
  })

  it('labeled/unlabeled events carry a {name, color} label object', () => {
    const labelEvents = events.filter((e) => e.event === 'labeled' || e.event === 'unlabeled')
    for (const event of labelEvents) {
      expect(typeof event.label?.name).toBe('string')
    }
    // Hello-World has labeled events in its ancient history; if the first page
    // happens to contain none, say so rather than silently passing.
    if (labelEvents.length === 0) {
      console.warn(`no labeled events on the first page of ${REPO}; label-shape check had nothing to bite on`)
    }
  })

  it('an ETag round-trip yields 304 (free polling)', async () => {
    const first = await client.listIssueEvents(REPO, { pageLimit: 1 })
    if (first.kind !== 'ok') throw new Error(`expected ok, got ${first.kind}`)
    expect(first.etag).not.toBeNull()
    const second = await client.listIssueEvents(REPO, {
      sinceId: Number.MAX_SAFE_INTEGER,
      etag: first.etag!,
      pageLimit: 1,
    })
    expect(second.kind).toBe('notModified')
  })

  it('a full monitor start() baselines against the real API', async () => {
    const { createMonitorTestContext } = await import('@copperbox/railyard')
    const monitor = new GitHubIssuesMonitor({
      repos: [REPO],
      token,
      pollIntervalMs: 3_600_000, // no second tick during the test
      pageLimit: 1,
    })
    const { ctx, emitted, kv, logs } = createMonitorTestContext(monitor.emits)
    await monitor.start(ctx)
    await monitor.stop()
    expect(emitted).toHaveLength(0)
    expect((await kv.get(`cursor:${REPO}`)) as number).toBeGreaterThan(0)
    expect(logs.some((l) => /baseline established/.test(l.message))).toBe(true)
  }, 60_000)
})
