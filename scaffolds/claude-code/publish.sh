#!/bin/sh
# Build (and optionally push) the generic claude-code helper image (SPEC §13).
# Tags track the pinned Claude Code version in the Dockerfile, plus latest.
# Manual by design — CI publishing is M5's problem. Pushing requires
# `docker login ghcr.io` and an explicit --push.
set -eu
cd "$(dirname "$0")"

IMAGE=ghcr.io/copperbox/railyard-claude-code
VERSION=$(grep -oE '@anthropic-ai/claude-code@[0-9][0-9.]*' Dockerfile | cut -d@ -f3)
[ -n "$VERSION" ] || { echo "could not read the pinned claude-code version from Dockerfile" >&2; exit 1; }

docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
echo "built $IMAGE:$VERSION (+ latest)"

if [ "${1:-}" = "--push" ]; then
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  echo "pushed $IMAGE:{$VERSION,latest}"
else
  echo "build only — rerun with --push to publish"
fi
