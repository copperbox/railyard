#!/bin/sh
# First link of the M1 exit-proof chain (SPEC §15 M1): reads its tick, emits a
# chain.step signal that must trigger chain-receiver.
set -eu

n=$(sed -n 's/.*"n": *\([0-9][0-9]*\).*/\1/p' "$AGENT_INPUT_FILE" | head -n 1)
echo "{\"kind\":\"signal\",\"type\":\"chain.step\",\"payload\":{\"n\":${n:-0}}}" >> "$AGENT_EVENTS_FILE"
printf '{"emitted": %s}\n' "${n:-0}" > "$AGENT_OUTPUT_DIR/result.json"
