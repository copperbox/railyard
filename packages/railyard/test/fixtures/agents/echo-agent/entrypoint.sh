#!/bin/sh
# Exercises the whole container contract (SPEC §5) from plain POSIX sh:
# reads $AGENT_INPUT_FILE, appends to $AGENT_EVENTS_FILE, writes result.json.
# Behavior is driven by the signal payload: n (echoed back), sleep (seconds
# to stay alive after emitting, proving mid-run dispatch), fail (exit 3).
set -eu

cat "$AGENT_INPUT_FILE" > /dev/null

echo '{"kind":"log","level":"info","message":"echo agent starting"}' >> "$AGENT_EVENTS_FILE"

n=$(sed -n 's/.*"n": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
echo "{\"kind\":\"signal\",\"type\":\"echo.done\",\"payload\":{\"n\":${n:-0}}}" >> "$AGENT_EVENTS_FILE"
echo 'deliberately not json' >> "$AGENT_EVENTS_FILE"

s=$(sed -n 's/.*"sleep": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
if [ -n "${s:-}" ]; then sleep "$s"; fi

if grep -q '"fail": *true' "$AGENT_INPUT_FILE"; then
  echo '{"kind":"log","level":"error","message":"failing as asked"}' >> "$AGENT_EVENTS_FILE"
  exit 3
fi

printf '{"echoed": %s}\n' "${n:-0}" > "$AGENT_OUTPUT_DIR/result.json"
