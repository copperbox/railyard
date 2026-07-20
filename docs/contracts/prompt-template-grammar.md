# Prompt template grammar (Contract v1)

SPEC §4, milestone M2. An agent folder's `prompt.md` is rendered **once per matched
signal** and mounted read-only inside the container at `$AGENT_PROMPT_FILE`
(`input/prompt.md`, alongside `input/signal.json`). The grammar is a **language-neutral
disk contract** — a port must implement it identically — and is deliberately tiny:
resolvable with one regex and a JSON walk, no runtime evaluation.

## Grammar

- **Placeholder:** `{{ <path> }}` — whitespace inside the braces is optional
  (`{{path}}` and `{{ path }}` are equivalent).
- **`<path>`:** dot-separated segments. Each segment is either an **object key** matching
  `[A-Za-z0-9_-]+` or a **non-negative integer** array index.
- **Data root is the full signal envelope** — the exact JSON the container sees in
  `input/signal.json`. So `{{payload.issue.title}}`, `{{type}}`, `{{source.name}}`,
  `{{contractVersion}}`, and `{{payload.items.0}}` all resolve. (SPEC §15 says "from
  payload"; envelope-root is a confirmed superset — one rule: *the template sees what the
  container sees*.)
- **No quoting, expressions, defaults, escapes, or code.** Same declarative-only ceiling
  the filters hold — loading an agent never executes user code (invariant 2).

## Semantics

- **Strings** interpolate verbatim. **Numbers / booleans / null** render as JSON literals.
  **Objects / arrays** render as 2-space-indented JSON.
- **A missing path is a render error at spawn** — the run fails before any container
  exists, journaled via the `run.finished` `status: "error"` path. Never a silent empty
  string. **Present-but-null renders as `null`** (null is a value; absent is a bug).

## v1 limitation: no literal `{{`

Any `{{` that does not open a well-formed placeholder is a **parse error at boot**
(invariant 4). There is **no escape** for a literal `{{` in Contract v1 — if you need the
two characters `{{` in prompt text, v1 cannot express it. This is tracked as
[issue #3](https://github.com/copperbox/railyard/issues/3).

An escape (e.g. a doubling rule) is a **reserved additive change**: it would let previously
invalid input become meaningful without altering any currently valid template, so it is a
*minor* bump that does **not** change `contractVersion`. It is intentionally **not** part
of v1 — adding it is a cross-port grammar change every port must match, designed on its own
merits, not slipped in. Until then the boot parse error names this limitation and points
here.

## For port authors

- Parse `prompt.md` at load time (so a malformed template fails at boot, not at 2am); render
  per matched signal against the full envelope JSON; write the result to the prompt mount
  and set `AGENT_PROMPT_FILE` only when a `prompt.md` exists.
- Keep `prompt.md` inside the agent-folder content hash so editing it rebuilds the image,
  even though the rendered file is produced at spawn, not baked into the image.

Related: [Signal Contract v1 index](./README.md), [signal
envelope](./signal-envelope.md), [container contract](../container-contract.md).
