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