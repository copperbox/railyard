# Signal envelope (Contract v1)

SPEC §2. A signal is a JSON document with a **framework-set envelope** and an
**emitter-set `type` + `payload`**. Authoritative schema:
`@copperbox/railyard` → `schemas/signal-envelope.schema.json`
(`$id: https://schemas.copperbox.dev/railyard/signal-envelope.schema.json`).

```json
{
  "contractVersion": "v1",
  "id": "sig_1f2e3d4c-5b6a-7089-abcd-ef0123456789",
  "timestamp": "2026-07-20T06:56:00.000Z",
  "source": { "kind": "monitor", "name": "github-issues" },
  "provenance": [],
  "type": "github.issue.labeled",
  "payload": { "repo": { "…": "…" }, "issue": { "…": "…" } }
}
```

## Fields

| Field | Set by | Type | Notes |
|---|---|---|---|
| `contractVersion` | framework | string, `const "v1"` | The version tag. Pinned; never emitter-set. See [the version rules](./README.md#what-a-version-change-means). |
| `id` | framework | string | Unique **per emission**. Pattern `^sig_<uuid># Signal envelope (Contract v1)

SPEC §2. A signal is a JSON document with a **framework-set envelope** and an
**emitter-set `type` + `payload`**. Authoritative schema:
`@copperbox/railyard` → `schemas/signal-envelope.schema.json`
(`$id: https://schemas.copperbox.dev/railyard/signal-envelope.schema.json`).

```json
{
  "contractVersion": "v1",
  "id": "sig_1f2e3d4c-5b6a-7089-abcd-ef0123456789",
  "timestamp": "2026-07-20T06:56:00.000Z",
  "source": { "kind": "monitor", "name": "github-issues" },
  "provenance": [],
  "type": "github.issue.labeled",
  "payload": { "repo": { "…": "…" }, "issue": { "…": "…" } }
}
```

## Fields

| Field | Set by | Type | Notes |
|---|---|---|---|
| `contractVersion` | framework | string, `const "v1"` | The version tag. Pinned; never emitter-set. See [the version rules](./README.md#what-a-version-change-means). |
 (a `sig_` prefix + a v-any UUID). Monitor emissions get a random id; agent emissions get a deterministic id derived from `(runId, events-line index)`, so a replayed events line yields the same id and the delivery ledger routes it at most once (SPEC §6.6). |
| `timestamp` | framework | string, `date-time` | RFC 3339 / ISO 8601 UTC instant of emission. |
| `source` | framework | object | `{ kind: "monitor" \| "agent", name: string }` — who emitted it. `name` is non-empty. |
| `provenance` | framework | array | Ordered causality chain, oldest first; **empty for monitor-emitted signals**. See §7 and below. |
| `type` | emitter | string | Namespaced signal type, pattern `^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`, e.g. `github.issue.labeled`. |
| `payload` | emitter | any JSON | Validated against the emitter's declared JSON Schema for that `type`. |
| `work` | emitter, optional | object | `{ key: string, attempt?: integer ≥ 1 }` — the logical work identity, scoped per target agent by the framework for duplicate suppression (SPEC §6.6). Absent = no suppression. Additive in v1 (since 2.0). |

`additionalProperties` is **false** at the envelope level — an unknown key is a validation
failure, so contract drift is visible rather than silently tolerated.

## Provenance entries

Each entry in `provenance` is:

```json
{ "source": { "kind": "agent", "name": "issue-reviewer" },
  "signalId": "sig_…", "signalType": "github.issue.labeled" }
```

The chain is the ordered list of `(source, signal)` pairs that caused this emission
(SPEC §7). A monitor emission starts an empty chain; an agent-emitted signal appends the
signal that triggered the agent. **Max chain depth** is framework-enforced (default 5);
signals beyond it are dropped and journaled (never silent — invariant 10).

## Serialization

Signals must be **fully JSON-serializable** — no dates-as-objects, no functions, no
cycles. This is the property that lets a future transport carry a signal between processes
without a redesign (SPEC §10). A port emits and consumes exactly this JSON.

## For port authors

- Stamp `contractVersion: "v1"`, `id`, `timestamp`, `source`, and `provenance` in your
  equivalent of `stampSignal` — the single place envelopes are minted. Emitters hand you
  only `{ type, payload }` and, optionally, `work`, which you normalize (drop an
  undefined `attempt`) and pass through.
- Derive agent-emission ids as `sig_` + the first 32 hex chars of
  `sha256(runId + "\n" + lineIndex)` laid out as a UUID (8-4-4-4-12). Line index counts
  the file's non-empty lines from 0, malformed ones included.
- Validate the full envelope against the schema on creation. In v1 you only ever validate
  envelopes you just stamped (no foreign ingest), so a non-`"v1"` value cannot legitimately
  arise; treat one as a bug in your stamper, not a negotiation case.

Related: [Signal Contract v1 index](./README.md), [prompt template
grammar](./prompt-template-grammar.md), [filter grammar](./filter-grammar.md).
