---
type: pattern
title: prompt.md template grammar ({{ dot.path }}) — a cross-port disk contract
tags:
  - contracts
  - milestone-m2
timestamp: 2026-07-20T03:18:20.369Z
---

Shipped in M2 (2026-07-19). `prompt.md` in an agent folder is rendered per matched
signal and mounted read-only at `$AGENT_PROMPT_FILE` (`input/prompt.md`, alongside
`signal.json`). The grammar is a **language-neutral disk contract**: the Python/Rust
ports must implement it identically, so it is deliberately tiny — resolvable with a
regex and a JSON walk.

## Grammar

- Placeholder: `{{ <path> }}` — whitespace inside the braces optional.
- `<path>`: dot-separated segments; each segment matches `[A-Za-z0-9_-]+` (object
  key) or is a non-negative integer (array index into an array value).
- **Data root is the full signal envelope** — the exact JSON the container sees in
  `input/signal.json`. `{{payload.issue.title}}`, `{{type}}`, `{{source.name}}`,
  `{{payload.items.0}}` all work. (SPEC §15 says "from payload"; envelope-root is a
  confirmed superset: one rule, "the template sees what the container sees".)
- No quoting, no expressions, no defaults, no escapes, no code — the same
  declarative-only line the JSONPath filters hold (loading agents never executes
  user code, invariant 2).

## Semantics

- Strings interpolate **verbatim**; numbers/booleans/null as JSON literals;
  objects/arrays as 2-space-indented JSON.
- Any `{{` not opening a well-formed placeholder is a **parse error at boot**
  (invariant 4). A literal `{{` in a prompt is unsupported in v1; an escape can be
  added later, additively.
- A path missing from the signal is a **render error at spawn**: the run fails
  before any container exists, journaled via the existing `run.finished`
  `status: "error"` path — never a silent empty string. Present-but-null renders as
  `null` (null is a value; absent is a bug).

## Implementation notes (TS reference)

- `src/prompt/template.ts` — `parsePromptTemplate` / `renderPromptTemplate`, both
  exported publicly. Loader parses at boot; orchestrator renders inside the tracked
  run promise before secret resolution; runner writes the file and sets
  `AGENT_PROMPT_FILE` (now in `RESERVED_AGENT_ENV_VARS`) only when a prompt exists.
- `prompt.md` stays in the agent-folder content hash — editing it rebuilds the image
  even though the image doesn't contain it. Invariant 8 over a special case.

Related: [M2 design decisions](/decisions/m2-design-decisions.md),
[M0 design decisions](/decisions/m0-design-decisions.md) (filter grammar, the
declarative-only line).
