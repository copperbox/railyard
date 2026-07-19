#!/bin/sh
# Triggered by echo-agent's emitted echo.done signal — agents chaining agents
# (SPEC §7/§15 M1). Check this run's invocation.json to see the provenance
# chain leading back through echo-agent to the interval monitor.
set -eu

n=$(sed -n 's/.*"n": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
echo '{"kind":"log","level":"info","message":"following the chain"}' >> "$AGENT_EVENTS_FILE"
printf '{"followed": %s}\n' "${n:-0}" > "$AGENT_OUTPUT_DIR/result.json"
