import type { Monitor, MonitorContext, SignalDeclaration } from '@copperbox/railyard'
import {
  GitHubClient,
  type RawIssue,
  type RawIssueEvent,
  type RawRepo,
} from './client.js'
import {
  GITHUB_ISSUE_SIGNAL_TYPES,
  githubIssueEmits,
  type GitHubIssueLabeledPayload,
  type GitHubIssueSignalType,
  type GitHubIssueSnapshot,
  type GitHubRepoRef,
} from './schemas.js'

export interface GitHubIssuesMonitorOptions {
  /** Repositories to poll, each "owner/name". Required, non-empty. */
  repos: string[]
  /**
   * GitHub token (classic, fine-grained, or `gh auth token` output). Absent ⇒
   * unauthenticated: 60 requests/hour and public repos only — warned loudly.
   */
  token?: string | undefined
  /** Poll cadence. Default 60s. */
  pollIntervalMs?: number
  /** Also emit events for pull requests (the issues API surfaces them too). Default false. */
  includePullRequests?: boolean
  /** Monitor name — the signal source and the state-file identity. Default "github-issues". */
  name?: string
  /** Override for GitHub Enterprise. Default https://api.github.com. */
  apiBaseUrl?: string
  /** Max event pages (of 100) fetched per repo per poll. Default 10. */
  pageLimit?: number
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined
}

/** Events-API kinds → emitted signal types: v1's fixed allowlist (everything else is skipped). */
const EVENT_KIND_TO_SIGNAL: Record<string, GitHubIssueSignalType> = {
  labeled: GITHUB_ISSUE_SIGNAL_TYPES.labeled,
  unlabeled: GITHUB_ISSUE_SIGNAL_TYPES.unlabeled,
  closed: GITHUB_ISSUE_SIGNAL_TYPES.closed,
  reopened: GITHUB_ISSUE_SIGNAL_TYPES.reopened,
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * First-party GitHub issues monitor (SPEC §15 M3): polls the issue-events API,
 * keeps a per-repo cursor (highest processed event id) and ETag in ctx.state,
 * and emits github.issue.* signals. Dedup is this monitor's job (SPEC §9):
 * each GitHub event id is emitted at most once — except across a crash between
 * emit and cursor persist, where delivery is deliberately at-least-once.
 */
export class GitHubIssuesMonitor implements Monitor {
  readonly name: string
  readonly emits: SignalDeclaration[] = githubIssueEmits

  private readonly repos: string[]
  private readonly hasToken: boolean
  private readonly pollIntervalMs: number
  private readonly includePullRequests: boolean
  private readonly pageLimit: number
  private readonly client: GitHubClient

  private ctx: MonitorContext | null = null
  /** Repo metadata captured at preflight — payload truth (real private flag, GHE urls). */
  private readonly repoRefs = new Map<string, GitHubRepoRef>()
  private timer: NodeJS.Timeout | null = null
  private pollInFlight: Promise<void> | null = null
  /** Rate-limit pause gate: no requests for any repo until this epoch ms. */
  private pausedUntil = 0
  private stopped = false

  constructor(options: GitHubIssuesMonitorOptions) {
    if (!Array.isArray(options.repos) || options.repos.length === 0) {
      throw new Error('GitHubIssuesMonitor: options.repos must be a non-empty array')
    }
    for (const repo of options.repos) {
      if (!REPO_PATTERN.test(repo)) {
        throw new Error(`GitHubIssuesMonitor: repo "${repo}" is not in "owner/name" form`)
      }
    }
    const interval = options.pollIntervalMs ?? 60_000
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error(`GitHubIssuesMonitor: pollIntervalMs must be > 0, got ${interval}`)
    }
    const pageLimit = options.pageLimit ?? 10
    if (!Number.isInteger(pageLimit) || pageLimit < 1) {
      throw new Error(`GitHubIssuesMonitor: pageLimit must be a positive integer, got ${pageLimit}`)
    }
    this.repos = [...options.repos]
    this.hasToken = options.token !== undefined && options.token !== ''
    this.pollIntervalMs = interval
    this.includePullRequests = options.includePullRequests ?? false
    this.name = options.name ?? 'github-issues'
    this.pageLimit = pageLimit
    this.client = new GitHubClient({
      apiBaseUrl: options.apiBaseUrl ?? 'https://api.github.com',
      token: this.hasToken ? options.token : undefined,
      fetchImpl: options.fetchImpl,
    })
  }

  async start(ctx: MonitorContext): Promise<void> {
    this.ctx = ctx
    this.stopped = false
    if (!this.hasToken) {
      ctx.log.warn(
        'no GitHub token configured: unauthenticated polling is limited to 60 requests/hour ' +
          'and public repositories (tip: token: execSync("gh auth token").toString().trim())',
      )
    }
    // Preflight (invariant 4): a bad token or repo fails orchestrator.start()
    // loudly, instead of 401-looping at 2am.
    for (const repo of this.repos) {
      const result = await this.client.getRepo(repo)
      if (result.kind === 'error') {
        throw new Error(
          `GitHubIssuesMonitor preflight failed for "${repo}": ${result.detail}` +
            (result.status === 401 || result.status === 403
              ? ' (is the token valid and does it have access to this repository?)'
              : result.status === 404
                ? ' (does the repository exist? private repos need a token that can see them)'
                : ''),
        )
      }
      if (result.kind === 'rateLimited') {
        throw new Error(
          `GitHubIssuesMonitor preflight for "${repo}" is rate limited (${result.detail}); ` +
            'refusing to start blind',
        )
      }
      this.repoRefs.set(repo, repoRefFrom(result.repo))
    }
    await this.runPoll()
    this.timer = setInterval(() => {
      // Overlapping ticks are skipped — one poll in flight at a time.
      if (this.pollInFlight === null) {
        this.pollInFlight = this.runPoll().finally(() => {
          this.pollInFlight = null
        })
      }
    }, this.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.pollInFlight !== null) await this.pollInFlight
    this.ctx = null
  }

  private async runPoll(): Promise<void> {
    const ctx = this.ctx
    if (ctx === null) return
    if (Date.now() < this.pausedUntil) return
    for (const repo of this.repos) {
      if (this.stopped || Date.now() < this.pausedUntil) return
      try {
        await this.pollRepo(ctx, repo)
      } catch (err) {
        // A monitor must never take the orchestrator down from a timer tick.
        ctx.log.error(`poll of ${repo} failed: ${String(err)}`)
      }
    }
  }

  private async pollRepo(ctx: MonitorContext, repo: string): Promise<void> {
    const cursorKey = `cursor:${repo}`
    const etagKey = `etag:${repo}`
    const cursor = (await ctx.state.get(cursorKey)) as number | undefined
    const etag = (await ctx.state.get(etagKey)) as string | undefined

    const result = await this.client.listIssueEvents(repo, {
      sinceId: cursor,
      etag,
      pageLimit: this.pageLimit,
    })

    if (result.kind === 'notModified') return
    if (result.kind === 'rateLimited') {
      this.pausedUntil = result.resumeAt
      ctx.log.warn(
        `GitHub rate limit hit (${result.detail}); pausing all polling until ` +
          new Date(result.resumeAt).toISOString(),
      )
      return
    }
    if (result.kind === 'error') {
      ctx.log.error(`polling ${repo} failed: ${result.detail} (will retry next interval)`)
      return
    }

    if (result.gap) {
      // Invariant-10 spirit: a coverage gap must never be silent.
      const ids = result.events.map((e) => e.id)
      ctx.log.error(
        `event gap for ${repo}: page limit (${this.pageLimit}) reached before the cursor ` +
          `(${String(cursor)}); events between ${String(cursor)} and ${String(ids[0])} were missed`,
      )
    }

    if (cursor === undefined) {
      // First poll: baseline. History is never replayed.
      const newest = result.events.reduce((max, e) => Math.max(max, e.id), 0)
      await ctx.state.set(cursorKey, newest)
      if (result.etag !== null) await ctx.state.set(etagKey, result.etag)
      ctx.log.info(`baseline established for ${repo} at event ${newest}; emitting from here on`)
      return
    }

    let maxSeen = cursor
    for (const event of result.events) {
      maxSeen = Math.max(maxSeen, event.id)
      const payload = this.mapEvent(ctx, repo, event)
      if (payload === null) continue
      // At-least-once: emit, then persist. A crash between the two re-emits on
      // restart — recovery, not duplication (the triggered run died with us).
      ctx.emit(payload)
      await ctx.state.set(cursorKey, event.id)
    }
    // Cursor covers skipped/filtered ids too; a mid-batch crash re-fetches
    // them and they are filtered again idempotently.
    await ctx.state.set(cursorKey, maxSeen)
    if (result.etag !== null) await ctx.state.set(etagKey, result.etag)
  }

  /** Map one raw event to an emission, or null when it is outside the allowlist. */
  private mapEvent(
    ctx: MonitorContext,
    repo: string,
    event: RawIssueEvent,
  ): { type: GitHubIssueSignalType; payload: unknown } | null {
    const type = EVENT_KIND_TO_SIGNAL[event.event]
    if (type === undefined) return null
    const issue = event.issue
    if (issue === undefined) {
      ctx.log.warn(`event ${event.id} (${event.event}) on ${repo} has no issue object; skipped`)
      return null
    }
    if (issue.pull_request !== undefined && !this.includePullRequests) return null

    const repoRef = this.repoRefs.get(repo)
    if (repoRef === undefined) {
      ctx.log.warn(`no preflight metadata for ${repo}; skipping event ${event.id}`)
      return null
    }
    const base = {
      repo: repoRef,
      issue: issueSnapshotFrom(issue),
      actor: event.actor?.login ?? null,
      eventId: event.id,
      occurredAt: event.created_at,
    }
    if (type === GITHUB_ISSUE_SIGNAL_TYPES.labeled || type === GITHUB_ISSUE_SIGNAL_TYPES.unlabeled) {
      const label = event.label
      if (label === undefined || typeof label.name !== 'string') {
        ctx.log.warn(`event ${event.id} (${event.event}) on ${repo} carries no label; skipped`)
        return null
      }
      const payload: GitHubIssueLabeledPayload = {
        ...base,
        label: { name: label.name, color: label.color ?? null },
      }
      return { type, payload }
    }
    return { type, payload: base }
  }
}

function repoRefFrom(repo: RawRepo): GitHubRepoRef {
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    private: repo.private,
  }
}

function issueSnapshotFrom(issue: RawIssue): GitHubIssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state === 'closed' ? 'closed' : 'open',
    author: issue.user?.login ?? null,
    labels: (issue.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter((n) => n !== ''),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    url: issue.html_url,
    apiUrl: issue.url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  }
}
