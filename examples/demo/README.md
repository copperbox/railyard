# demo example — the walking skeleton

The no-dependencies end-to-end demo (SPEC §15 M0–M1): an interval monitor emits `demo.tick`
on a timer; a no-op shell agent reads its input, appends events, and writes a result — then
emits its own signal that triggers a second agent, proving agent-chaining and its guards.
No API keys, no GitHub — just Docker.

```
src/main.ts                 orchestrator + IntervalMonitor + console narration
src/interval-monitor.ts     the SPEC §9 trivial monitor (emits demo.tick, counter in ctx.state)
agents/echo-agent/          on: demo.tick — logs, emits echo.done, writes result.json (POSIX sh)
agents/chain-follower/      on: echo.done — fires from the echo-agent's emission (chaining)
runs/  state/               gitignored — run records + monitor cursor
```

The echo agent is plain POSIX `sh` — a reminder that **the container contract is
language-neutral** (SPEC §5): it reads `$AGENT_INPUT_FILE`, appends to `$AGENT_EVENTS_FILE`,
and writes `$AGENT_OUTPUT_DIR/result.json`, no JavaScript inside.

## Run it

```sh
pnpm install && pnpm --filter railyard-example-demo start
```

Every ~5 s a `demo.tick` fires. Watch `runs/` fill, and the terminal narrate
`run.finished`. Two runs appear per tick: `echo-agent` (from `demo.tick`), then
`chain-follower` (from the `echo.done` the echo agent emitted). `Ctrl-C` stops cleanly.

Inspect a run:

```sh
cat runs/*--echo-agent--*/output/result.json     # {"echoed": N}
cat runs/*--echo-agent--*/events.jsonl           # the log + signal lines it appended
cat runs/journal.jsonl                            # the append-only index of everything
```

## What it exercises

The full round-trip before any AI specifics exist: manifest loading + validation,
schema-compatibility checks, boot-time image build (content-hash tagged), the Docker runner
(input mount, live events-file tailing, result collection, guaranteed teardown), the run
journal, retention (`maxRunsPerAgent: 20`), and agent-emitted signals with provenance +
depth guards.

See [getting started](../../docs/getting-started.md) for the guided walkthrough.
