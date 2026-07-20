/**
 * Minimal GitHub REST client over injected fetch — zero deps, only what the
 * monitor needs: the issue-events endpoint (with ETag + Link pagination) and a
 * repo probe for the boot preflight. No monitor logic lives here.
 */

/** Subset of a GitHub issue-events API event we consume. */
export interface RawIssueEvent {
  id: number
  event: string
  actor: { login: string } | null
  label?: { name: string; color: string | null } | undefined
  created_at: string
  issue?: RawIssue | undefined
}

/** Subset of a GitHub issue object we consume (embedded in events). */
export interface RawIssue {
  number: number
  title: string
  body: string | null
  state: string
  user: { login: string } | null
  labels: Array<string | { name?: string }>
  assignees: Array<{ login: string }> | null
  html_url: string
  url: string
  created_at: string
  updated_at: string
  /** Present when the "issue" is actually a pull request. */
  pull_request?: unknown
}

export interface RawRepo {
  name: string
  full_name: string
  owner: { login: string }
  html_url: string
  private: boolean
}

export interface GitHubClientOptions {
  apiBaseUrl: string
  token?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

export interface ListIssueEventsParams {
  /** Cursor: only events with id > sinceId are returned. Undefined = baseline (first page only). */
  sinceId?: number | undefined
  /** Page-1 conditional request; a 304 means nothing new (and costs no rate limit). */
  etag?: string | undefined
  /** Max pages fetched per call (100 events each). */
  pageLimit: number
}

export type ListIssueEventsResult =
  | {
      kind: 'ok'
      /** New events (id > sinceId), sorted ascending by id regardless of response order. */
      events: RawIssueEvent[]
      /** The page-1 ETag, for the next conditional request. */
      etag: string | null
      /** True when the page cap hit before reaching the cursor — events were missed. */
      gap: boolean
    }
  | { kind: 'notModified' }
  | { kind: 'rateLimited'; resumeAt: number; detail: string }
  | { kind: 'error'; status: number | null; detail: string }

export type GetRepoResult =
  | { kind: 'ok'; repo: RawRepo }
  | { kind: 'rateLimited'; resumeAt: number; detail: string }
  | { kind: 'error'; status: number | null; detail: string }

const LINK_NEXT = /<([^>]+)>;\s*rel="next"/

export class GitHubClient {
  private readonly apiBaseUrl: string
  private readonly token: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: GitHubClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private headers(etag?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects requests without a User-Agent; undici does not set one.
      'user-agent': 'copperbox-railyard-monitor-github',
    }
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`
    if (etag !== undefined) headers['if-none-match'] = etag
    return headers
  }

  /** 403/429 with rate-limit markers → when to resume (epoch ms), else null. */
  private static rateLimitedUntil(response: Response): { resumeAt: number; detail: string } | null {
    if (response.status !== 403 && response.status !== 429) return null
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      return {
        resumeAt: Date.now() + Number(retryAfter) * 1000,
        detail: `HTTP ${response.status} with retry-after ${retryAfter}s`,
      }
    }
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = response.headers.get('x-ratelimit-reset')
    if (remaining === '0' && reset !== null && /^\d+$/.test(reset)) {
      return {
        resumeAt: Number(reset) * 1000,
        detail: `HTTP ${response.status} with rate limit exhausted until ${new Date(Number(reset) * 1000).toISOString()}`,
      }
    }
    return null
  }

  private static async errorDetail(response: Response): Promise<string> {
    let excerpt = ''
    try {
      excerpt = (await response.text()).slice(0, 200)
    } catch {
      /* body unreadable — the status alone will have to do */
    }
    return `HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`
  }

  /** Boot preflight probe: does the repo exist and can this token see it? */
  async getRepo(repoFullName: string): Promise<GetRepoResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/repos/${repoFullName}`, {
        headers: this.headers(),
      })
    } catch (err) {
      return { kind: 'error', status: null, detail: `network error: ${String(err)}` }
    }
    const rateLimited = GitHubClient.rateLimitedUntil(response)
    if (rateLimited !== null) return { kind: 'rateLimited', ...rateLimited }
    if (!response.ok) {
      return { kind: 'error', status: response.status, detail: await GitHubClient.errorDetail(response) }
    }
    try {
      return { kind: 'ok', repo: (await response.json()) as RawRepo }
    } catch (err) {
      return { kind: 'error', status: response.status, detail: `unparsable body: ${String(err)}` }
    }
  }

  /**
   * Fetch issue events newer than the cursor. Pages are walked via the Link
   * header until an event at or below the cursor is seen or pageLimit exhausts
   * (→ gap: true). With no cursor (baseline) only the first page is fetched.
   * Events are sorted ascending by id — correctness does not depend on
   * GitHub's response ordering.
   */
  async listIssueEvents(
    repoFullName: string,
    params: ListIssueEventsParams,
  ): Promise<ListIssueEventsResult> {
    const collected: RawIssueEvent[] = []
    let pageEtag: string | null = null
    let url: string | null = `${this.apiBaseUrl}/repos/${repoFullName}/issues/events?per_page=100`
    let reachedCursor = false
    let hadNext = false

    const pages = params.sinceId === undefined ? 1 : params.pageLimit
    for (let page = 1; page <= pages && url !== null; page++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          headers: this.headers(page === 1 ? params.etag : undefined),
        })
      } catch (err) {
        return { kind: 'error', status: null, detail: `network error: ${String(err)}` }
      }
      if (page === 1 && response.status === 304) return { kind: 'notModified' }
      const rateLimited = GitHubClient.rateLimitedUntil(response)
      if (rateLimited !== null) return { kind: 'rateLimited', ...rateLimited }
      if (!response.ok) {
        return { kind: 'error', status: response.status, detail: await GitHubClient.errorDetail(response) }
      }
      if (page === 1) pageEtag = response.headers.get('etag')

      let events: RawIssueEvent[]
      try {
        events = (await response.json()) as RawIssueEvent[]
      } catch (err) {
        return { kind: 'error', status: response.status, detail: `unparsable body: ${String(err)}` }
      }
      for (const event of events) {
        if (params.sinceId !== undefined && event.id <= params.sinceId) {
          reachedCursor = true
        } else {
          collected.push(event)
        }
      }
      if (reachedCursor) break

      const link = response.headers.get('link')
      const next = link !== null ? LINK_NEXT.exec(link) : null
      hadNext = next !== null
      url = next?.[1] ?? null
    }

    collected.sort((a, b) => a.id - b.id)
    const gap = params.sinceId !== undefined && !reachedCursor && hadNext
    return { kind: 'ok', events: collected, etag: pageEtag, gap }
  }
}
