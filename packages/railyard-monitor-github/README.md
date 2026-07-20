# @copperbox/railyard-monitor-github

First-party GitHub issues monitor for [railyard](../../README.md): polls a repository's
issue events and emits `github.issue.*` signals with published JSON Schemas. Built
strictly against `@copperbox/railyard`'s public exports — core is a peer dependency and
every import from it is type-only; this package has zero runtime dependencies.

```ts
import { Orchestrator } from '@copperbox/railyard'
import { GitHubIssuesMonitor } from '@copperbox/railyard-monitor-github'

const orchestrator = new Orchestrator({ agentsDir, runsDir, stateDir })
orchestrator.register(
  new GitHubIssuesMonitor({
    repos: ['copperbox/railyard'],
    token: process.env.GITHUB_TOKEN,
  }),
)
await orchestrator.start()
```

## Signals

v1 emits a fixed allowlist of four types — everything else the events API yields
(assigned, renamed, milestoned, …) advances the cursor but emits nothing. Comments are
not issue events and are out of scope for this endpoint; a future
`github.issue.commented` would be an additive second poll.

| Type | When | Payload |
|---|---|---|
| `github.issue.labeled` | a label was applied | shape A (has `label`) |
| `github.issue.unlabeled` | a label was removed | shape A |
| `github.issue.closed` | issue closed | shape B (no `label`) |
| `github.issue.reopened` | issue reopened | shape B |

Both shapes carry `repo` (identity from the boot preflight: owner, name, fullName, url,
private), `issue` (a snapshot **at poll time** — number, title, body, state, author,
label names, assignee logins, urls, timestamps), `actor` (who did it), `eventId`
(GitHub's issue-event id — the dedup key), and `occurredAt`. Shape A adds
`label: { name, color }`. Users are login strings; `issue.body`, `label.color`,
`actor`, and `issue.author` are nullable (deleted "ghost" users).

Applying three labels at once is three GitHub events → three independently routable
signals. A manifest filter like `$.label.name == "needs-review"` fires only for that
label.

## Consuming the schemas (important)

Core's boot-time schema compatibility check is **deep structural equality**, so an
agent subscribing to these signals must reference a schema *structurally identical* to
the published one. Copy the file verbatim into your agent folder:

```sh
cp node_modules/@copperbox/railyard-monitor-github/schemas/github-issue-labeled.schema.json \
   agents/my-reviewer/issue-labeled.schema.json
```

```yaml
# agents/my-reviewer/manifest.yaml
name: my-reviewer
on:
  - type: github.issue.labeled
    filter: '$.label.name == "needs-review"'
    payloadSchema: ./issue-labeled.schema.json
```

The files are also importable as `@copperbox/railyard-monitor-github/schemas/<file>`,
and exported as TS values (`GITHUB_ISSUE_LABELED_SCHEMA`, …) with payload interfaces
(`GitHubIssueLabeledPayload`, …).

## Options

| Option | Default | Notes |
|---|---|---|
| `repos` | — (required) | `"owner/name"[]`, non-empty |
| `token` | none | see below; absent ⇒ unauthenticated (60 req/h, public repos only) with a loud warning |
| `pollIntervalMs` | `60_000` | one events request per repo per poll (usually a free 304) |
| `includePullRequests` | `false` | the issues API surfaces PR events too; opt in to emit them |
| `name` | `"github-issues"` | signal `source.name` and the state-file identity — override to run multiple instances |
| `apiBaseUrl` | `https://api.github.com` | GitHub Enterprise |
| `pageLimit` | `10` | max event pages (of 100) per repo per poll; hitting it logs a **loud gap error** |
| `fetchImpl` | global `fetch` | test seam |

### Token

Monitors are host-side user code, so you pass the token in — core's `SecretsProvider`
is agent-container machinery and does not apply here.

- Local dev, zero ceremony: `GITHUB_TOKEN=$(gh auth token)` and pass
  `process.env.GITHUB_TOKEN`.
- Deployments: a fine-grained PAT scoped to the polled repos with read-only
  Issues/Metadata permissions — least privilege, same posture as SPEC §8's
  credential-scoping guidance.

A bad token or unreachable repo fails `orchestrator.start()` loudly (each repo is
probed at boot), not as a 401 loop at 2am.

## Dedup, cursor, and delivery semantics

Dedup is the monitor's job (SPEC §9), and this monitor's rule is: **each GitHub
issue-event id is emitted at most once**, tracked by a per-repo cursor (the highest
processed event id) in `ctx.state`.

- State keys, per repo: `cursor:<owner>/<repo>` (number) and `etag:<owner>/<repo>`
  (string). The ETag makes quiet polls HTTP 304s, which cost **zero** rate limit.
- **First start baselines**: the cursor is set to the newest event id and nothing is
  emitted — history is never replayed. Delete the state file to re-baseline.
- **Delivery is at-least-once across a crash**: the cursor is persisted *after* each
  emission, so a crash in between re-emits that event on restart. That is recovery,
  not duplication — the agent run the lost emission triggered died in the same crash.
- Rate limits (403/429): polling pauses monitor-wide until `retry-after` /
  `x-ratelimit-reset`, with a warning naming the resume time. Other errors log and
  retry on the next interval; the cursor is untouched, so nothing is lost.

## Testing

Unit tests run offline against canned responses (`pnpm test`). Real-API tests are
gated: `pnpm test:github` sets `RAILYARD_GITHUB_TESTS=1` and then **requires**
`GITHUB_TOKEN` (process env or repo-root `.env`) — read-only requests against a stable
public repo, never silently skipped. The Docker-gated e2e (`pnpm test:docker`) proves
monitor → filter → container end-to-end with a stubbed API.

To unit-test your own monitors the same way, core exports the harness this package
uses: `createMonitorTestContext(monitor.emits)` returns a real `MonitorContext` with
orchestrator-identical emit validation, captured emissions/logs, and an in-memory
`ctx.state`.

## Documentation

- [Authoring monitors](https://github.com/copperbox/railyard/blob/main/docs/authoring-monitors.md)
- [`github.issue.*` payload contract](https://github.com/copperbox/railyard/blob/main/docs/contracts/github-issue-signals.md)
  — the versioned, language-neutral payload spec.
