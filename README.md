# Railyard

> Stylized **rAIlyard**. A rail yard is where cars are sorted, routed, and dispatched down
> different tracks — this framework does the same with signals and AI agents.

`railyard` is a TypeScript framework library for pub/sub-style, multi-provider AI agent
orchestration. User-authored **monitors** watch the outside world and emit **signals**; the
**orchestrator** routes signals to **agents** — defined declaratively in self-contained
folders — and runs each invocation as an ephemeral, sandboxed Docker container.

It is deliberately non-prescriptive: the framework owns the *contracts* (signal shape,
routing, container I/O, lifecycle safeguards) and stays out of the *content* (which
provider, which prompts, which guardrails, what the agent actually does).
## Layout

- `packages/railyard` — the core framework (`@copperbox/railyard`).
- `packages/railyard-monitor-github` — first-party GitHub issues monitor
  ([`@copperbox/railyard-monitor-github`](packages/railyard-monitor-github/README.md)),
  built strictly against core's public API.
- `scaffolds/` — copyable agent folders; start with
  [`scaffolds/claude-code`](scaffolds/claude-code/README.md) for a Claude Code agent.
- `examples/demo` — a runnable end-to-end demo.

## Tests

- `pnpm test` — unit tests, no Docker needed.
- `pnpm test:docker` — everything, including container integration tests.
- `pnpm test:llm` — everything, plus tests that spend real API money
  (needs `ANTHROPIC_API_KEY`; prerequisites fail loudly, never skip silently).
- `pnpm test:github` — everything, plus read-only tests against the real GitHub API
  (needs `GITHUB_TOKEN`, e.g. `$(gh auth token)`; same fail-loudly posture).
