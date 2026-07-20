# railyard documentation

Guides for building with railyard, plus the versioned contract reference the framework
and its future ports must honor.

## Guides

- **[Getting started](./getting-started.md)** — install, the mental model, and two
  runnable tracks (the no-keys demo and the real GitHub reviewer).
- **[Authoring monitors](./authoring-monitors.md)** — write code that emits signals;
  `emits` declarations, `ctx.state` cursors, dedup, testing.
- **[Authoring agents](./authoring-agents.md)** — the agent folder, `manifest.yaml`
  reference, `prompt.md`, image sources, non-root best practice.
- **[Container contract](./container-contract.md)** — exactly what a container is given
  and must produce; the events-file backchannel and lifecycle safeguards.
- **[Credential scoping](./credential-scoping.md)** — least-privilege secrets, the
  redaction guarantee, the accepted residual risk, and how to scope tokens.

## Contract reference — [Signal Contract v1](./contracts/README.md)

The language-neutral, versioned specification (JSON / JSON Schema / JSONPath / grammar) a
non-TypeScript port must reproduce:

- [Signal envelope](./contracts/signal-envelope.md) — the wire shape (incl. the
  `contractVersion` tag).
- [`github.issue.*` payloads](./contracts/github-issue-signals.md) — the first-party
  monitor's signals.
- [Prompt template grammar](./contracts/prompt-template-grammar.md).
- [Filter grammar](./contracts/filter-grammar.md).

## Reference material in the repo

- [`SPEC.md`](../SPEC.md) — the framework specification and design invariants.
- [`scaffolds/claude-code`](../scaffolds/claude-code/README.md) — a copy-me Claude Code agent.
- [`examples/demo`](../examples/demo/README.md) and
  [`examples/github-review`](../examples/github-review/README.md) — the runnable examples
  these docs are kept honest against.
