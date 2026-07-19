#!/bin/sh
# Proves secret injection (SPEC §8) without ever writing the value anywhere:
# compares $MY_SECRET against the expectation and reports only the verdict.
set -eu

if [ "${MY_SECRET:-}" = "expected-secret-value" ]; then
  printf '{"secretSeen": true}\n' > "$AGENT_OUTPUT_DIR/result.json"
  exit 0
fi
exit 9
