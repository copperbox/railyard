#!/bin/sh
# Proves the rendered-prompt side of the container contract (M2): the file
# arrives at $AGENT_PROMPT_FILE on the read-only input mount, already rendered.
set -eu

[ -n "${AGENT_PROMPT_FILE:-}" ] || exit 7
[ -r "$AGENT_PROMPT_FILE" ] || exit 8
# Read-only mount: writing into input/ must fail.
if echo tamper > "$AGENT_INPUT_DIR/tamper.txt" 2>/dev/null; then
  exit 9
fi
prompt=$(cat "$AGENT_PROMPT_FILE")
printf '{"prompt": "%s"}\n' "$prompt" > "$AGENT_OUTPUT_DIR/result.json"
