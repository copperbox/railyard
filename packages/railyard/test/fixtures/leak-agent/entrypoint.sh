#!/bin/sh
# Deliberately leaks its secret through every channel the framework must scrub
# (SPEC §8): stdout, the events file (log + signal lines), and result.json.
set -eu

echo "the secret is $LEAK_SECRET"
printf 'split across chunks maybe: %s (no trailing newline)' "$LEAK_SECRET"
echo ""
echo "{\"kind\":\"log\",\"level\":\"info\",\"message\":\"got $LEAK_SECRET\"}" >> "$AGENT_EVENTS_FILE"
echo "{\"kind\":\"signal\",\"type\":\"leak.done\",\"payload\":{\"stolen\":\"$LEAK_SECRET\"}}" >> "$AGENT_EVENTS_FILE"
printf '{"stolen": "%s"}\n' "$LEAK_SECRET" > "$AGENT_OUTPUT_DIR/result.json"
