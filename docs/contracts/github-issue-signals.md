# `github.issue.*` signal payloads (Contract v1)

The payloads emitted by `@copperbox/railyard-monitor-github` (SPEC §9, milestone M3).
These are permanent cross-port contract surface: a Python or Rust port of the monitor must
reproduce them byte-for-byte. Authoritative schemas ship in the package's `schemas/` dir
and are also exported as `@copperbox/railyard-monitor-github/schemas/*` and as TS constants.

## The four types, two shapes

| Signal type | Shape | `$id` (identifier, see [note](./README.md#the-id-urls)) |
|---|---|---|
| `github.issue.labeled` | A (carries `label`) | `…/railyard-monitor-github/github-issue-labeled.schema.json` |
| `github.issue.unlabeled` | A (carries `label`) | `…/github-issue-unlabeled.schema.json` |
| `github.issue.closed` | B (no `label`) | `…/github-issue-closed.schema.json` |
| `github.issue.reopened` | B (no `label`) | `…/github-issue-reopened.schema.json` |

One self-contained schema file per type. Within a shape pair the contents are identical
except `$id`/`title`/`description`; a unit test in the package enforces that.

Both shapes carry:

- **`repo`** — `{ owner, name, fullName, url, private }`. Taken from the boot preflight's
  `GET /repos/{owner}/{name}` response, so `private` and the urls are true and GitHub
  Enterprise-correct.
- **`issue`** — a **poll-time snapshot**: `{ number, title, body, state, author, labels,
  assignees, url, apiUrl, createdAt, updatedAt }`.
- **`actor`** — login of the user who performed the event.
- **`eventId`** — GitHub's issue-event id; the monitor's **dedup key** (emitted at most
  once).
- **`occurredAt`** — the event's `created_at`.

Shape A adds **`label`** — `{ name, color }` (color is a hex string without `#`, or null).

## Rules a port must honor

- **Users are login strings, not objects.** `issue.author`, `actor`, and `issue.assignees[*]`
  are logins.
- **Labels are name strings.** `issue.labels` is an array of names, and shape A's
  `label.name` is a string — chosen so filters like `$.label.name == "needs-review"` and
  `$.issue.labels[*]` work in the [filter grammar](./filter-grammar.md).
- **Nullable set:** `issue.body`, `label.color`, `actor`, `issue.author` (deleted "ghost"
  users null any login).
- **`additionalProperties: false` at every level, everything required.** Under the
  deep-equality compatibility rule (below) any change is a *new* contract, so strictness
  only makes drift visible.

## Consumption: verbatim copy

Core's schema-compatibility check is **deep structural equality**. An agent that subscribes
to one of these types **copies the schema file verbatim** into its agent folder and points
`payloadSchema` at the copy. Identical bytes are compatible by construction; a mutated copy
fails boot loudly. This is what `examples/github-review` does with
`github-issue-labeled.schema.json`.

## Dedup, cursor, baseline (monitor-owned semantics)

- Each GitHub issue-event id is emitted **at most once**; the cursor is the highest
  processed event id per repo.
- First start **baselines** (cursor := newest event id, nothing emitted); history is never
  replayed. Delete the monitor's state to re-baseline.
- **At-least-once across a crash:** emit, then persist the cursor — a crash in the window
  re-emits on restart (recovery, since the triggered run died in the same crash).
- Non-allowlisted event kinds (assigned, renamed, milestoned, …) advance the cursor without
  emitting. Comments are not issue events; a future `github.issue.commented` is an additive
  second poll — a *minor* change that does not bump `contractVersion`.

Related: [Signal Contract v1 index](./README.md), [signal
envelope](./signal-envelope.md), [filter grammar](./filter-grammar.md).
