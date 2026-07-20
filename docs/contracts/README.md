# railyard Signal Contract v1

This directory is the **versioned, language-neutral specification** of everything that
travels on a railyard bus or sits on disk between the framework and user code. It exists
so a non-TypeScript implementation — the planned Python and Rust ports — has a spec to
hit without reading the TypeScript source. Nothing here requires a TS runtime to
interpret: it is JSON, JSON Schema, JSONPath, and a tiny string grammar (SPEC invariant 1).

## What "v1" covers

| Sub-contract | Kind | Spec | Machine-readable source of truth |
|---|---|---|---|
| [Signal envelope](./signal-envelope.md) | wire | SPEC §2 | `@copperbox/railyard` → `schemas/signal-envelope.schema.json` |
| [`github.issue.*` payloads](./github-issue-signals.md) | wire | SPEC §9, M3 | `@copperbox/railyard-monitor-github` → `schemas/github-issue-*.schema.json` |
| [Prompt template grammar](./prompt-template-grammar.md) | disk | SPEC §4, M2 | this document (grammar is too small for a schema) |
| [Filter grammar](./filter-grammar.md) | routing | SPEC §3 | this document |

The prose here is normative; where a JSON Schema file exists, **the schema file is
authoritative** and the prose describes it. Each package ships its schemas in a `schemas/`
directory that is included in the npm tarball, so an installed package always carries the
contract it implements.

## The version tag on the wire

Every signal envelope carries a framework-stamped field:

```json
{ "contractVersion": "v1", "id": "sig_…", … }
```

- It is **framework-set, never emitter-set** (SPEC §2) — a monitor or agent that emits a
  signal never writes this field; the framework stamps it when it builds the envelope.
- It is **pinned**: the envelope JSON Schema fixes it with `"const": "v1"`, so a runtime
  validates that every signal is exactly the contract it speaks.
- It is an **opaque string tag**, not a number — `"v1"`, not `1` or `"1.0"`. It has no
  ordering to reason about across ports.

## What a version change means

- **Additive changes do not bump the tag.** A new `github.issue.*` signal type, a new
  optional payload field, or a future prompt-grammar escape are *minor* changes: existing
  consumers keep working, so the wire tag stays `"v1"`. Minor history is tracked in these
  docs, not on the wire.
- **A breaking change to the envelope is a new contract** — a new tag (`"v2"`) and a new
  runtime. Payload compatibility is deep structural equality (see the github-issue doc),
  so any change to a payload schema under that rule is likewise a *new* contract for that
  signal type, not a silent mutation.
- **Cross-version negotiation is deliberately unspecified in v1.** A world where a `"v1"`
  emitter and a `"v2"` consumer share a bus only exists once out-of-process transports can
  carry foreign signals (a v2 feature, SPEC §14). v1 has no such ingest path — the
  framework only ever validates signals it just stamped — so the policy for an unknown
  version (reject, warn, or negotiate at boot) is a v2 decision, made when it can occur.
  The string tag is chosen so that a future runtime has a clean key to negotiate on.

## The `$id` URLs

The JSON Schema `$id`s use `https://schemas.copperbox.dev/…`. These are **stable
identifiers, not (currently) resolvable URLs** — a JSON Schema `$id` need not resolve, and
railyard operates no schema registry (SPEC §14 refuses framework-operated infrastructure).
The authoritative copies are the files shipped inside the npm packages. Treat the `$id` as
a name; fetch the bytes from the installed package.
