/**
 * The github.issue.* signal contract: published JSON Schema files are the
 * source of truth (shipped in schemas/, inlined into dist at build); the TS
 * values and interfaces here mirror them for DX — core's pattern.
 *
 * Consumption story: core's schema compatibility check is deep structural
 * equality, so agents copy the schema file for the type they subscribe to into
 * their agent folder verbatim and point `payloadSchema` at the copy.
 */
import type { JsonSchema, SignalDeclaration } from '@copperbox/railyard'
import githubIssueClosedSchema from '../schemas/github-issue-closed.schema.json'
import githubIssueLabeledSchema from '../schemas/github-issue-labeled.schema.json'
import githubIssueReopenedSchema from '../schemas/github-issue-reopened.schema.json'
import githubIssueUnlabeledSchema from '../schemas/github-issue-unlabeled.schema.json'

export const GITHUB_ISSUE_LABELED_SCHEMA: JsonSchema = githubIssueLabeledSchema
export const GITHUB_ISSUE_UNLABELED_SCHEMA: JsonSchema = githubIssueUnlabeledSchema
export const GITHUB_ISSUE_CLOSED_SCHEMA: JsonSchema = githubIssueClosedSchema
export const GITHUB_ISSUE_REOPENED_SCHEMA: JsonSchema = githubIssueReopenedSchema

/** v1's fixed allowlist: every other events-API kind is skipped, never signaled. */
export const GITHUB_ISSUE_SIGNAL_TYPES = {
  labeled: 'github.issue.labeled',
  unlabeled: 'github.issue.unlabeled',
  closed: 'github.issue.closed',
  reopened: 'github.issue.reopened',
} as const

export type GitHubIssueSignalType =
  (typeof GITHUB_ISSUE_SIGNAL_TYPES)[keyof typeof GITHUB_ISSUE_SIGNAL_TYPES]

/** The monitor's `emits` declarations — all four types, always. */
export const githubIssueEmits: SignalDeclaration[] = [
  { type: GITHUB_ISSUE_SIGNAL_TYPES.labeled, payloadSchema: GITHUB_ISSUE_LABELED_SCHEMA },
  { type: GITHUB_ISSUE_SIGNAL_TYPES.unlabeled, payloadSchema: GITHUB_ISSUE_UNLABELED_SCHEMA },
  { type: GITHUB_ISSUE_SIGNAL_TYPES.closed, payloadSchema: GITHUB_ISSUE_CLOSED_SCHEMA },
  { type: GITHUB_ISSUE_SIGNAL_TYPES.reopened, payloadSchema: GITHUB_ISSUE_REOPENED_SCHEMA },
]

export interface GitHubRepoRef {
  owner: string
  name: string
  fullName: string
  /** The repository's html_url. */
  url: string
  private: boolean
}

/** Snapshot of the issue at poll time (historical snapshots don't exist). */
export interface GitHubIssueSnapshot {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  /** Login of the issue author; null for deleted (ghost) users. */
  author: string | null
  /** Current label names, filter-friendly. */
  labels: string[]
  /** Current assignee logins. */
  assignees: string[]
  /** The issue's html_url. */
  url: string
  /** The issue's REST API url. */
  apiUrl: string
  createdAt: string
  updatedAt: string
}

/** The events API label object carries name and color only. */
export interface GitHubLabelRef {
  name: string
  /** Hex color without the leading '#'; null when GitHub omits it. */
  color: string | null
}

interface GitHubIssueEventPayloadBase {
  repo: GitHubRepoRef
  issue: GitHubIssueSnapshot
  /** Login of the user who performed the event; null for deleted (ghost) users. */
  actor: string | null
  /** GitHub's issue-event id — the monitor's dedup key (each id emitted at most once). */
  eventId: number
  /** The event's created_at. */
  occurredAt: string
}

/** Shape A: label events carry the label the event applied/removed. */
export interface GitHubIssueLabeledPayload extends GitHubIssueEventPayloadBase {
  label: GitHubLabelRef
}
export type GitHubIssueUnlabeledPayload = GitHubIssueLabeledPayload

/** Shape B: state events, identical minus `label`. */
export type GitHubIssueClosedPayload = GitHubIssueEventPayloadBase
export type GitHubIssueReopenedPayload = GitHubIssueEventPayloadBase
