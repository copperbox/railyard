/**
 * @copperbox/railyard-monitor-github — first-party GitHub issues monitor.
 *
 * Built strictly against @copperbox/railyard's public exports (SPEC invariant 9):
 * runtime imports from core are type-only; this package ships zero runtime deps.
 */

export { GitHubIssuesMonitor, type GitHubIssuesMonitorOptions } from './monitor.js'
export {
  GITHUB_ISSUE_CLOSED_SCHEMA,
  GITHUB_ISSUE_LABELED_SCHEMA,
  GITHUB_ISSUE_REOPENED_SCHEMA,
  GITHUB_ISSUE_SIGNAL_TYPES,
  GITHUB_ISSUE_UNLABELED_SCHEMA,
  githubIssueEmits,
  type GitHubIssueClosedPayload,
  type GitHubIssueLabeledPayload,
  type GitHubIssueReopenedPayload,
  type GitHubIssueSignalType,
  type GitHubIssueSnapshot,
  type GitHubIssueUnlabeledPayload,
  type GitHubLabelRef,
  type GitHubRepoRef,
} from './schemas.js'
