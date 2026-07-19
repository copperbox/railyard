#!/bin/sh
# A no-op agent honoring the container contract (SPEC §5) from plain POSIX sh.
set -eu

echo '{"kind":"log","level":"info","message":"tick received"}' >> "$AGENT_EVENTS_FILE"

n=$(sed -n 's/.*"n": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
echo "{\"kind\":\"signal\",\"type\":\"echo.done\",\"payload\":{\"n\":${n:-0}}}" >> "$AGENT_EVENTS_FILE"

printf '{"echoed": %s}\n' "${n:-0}" > "$AGENT_OUTPUT_DIR/result.json"
