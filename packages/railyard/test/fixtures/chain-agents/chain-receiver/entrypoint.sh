#!/bin/sh
# Second link of the chain: proves the agent-emitted signal arrived intact.
set -eu

n=$(sed -n 's/.*"n": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
printf '{"receivedN": %s}\n' "${n:-0}" > "$AGENT_OUTPUT_DIR/result.json"
