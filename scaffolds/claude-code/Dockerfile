# Claude Code agent scaffold (SPEC §13, M2). Copy the folder, edit manifest.yaml
# and prompt.md; this Dockerfile rarely needs changes. The image is generic —
# nothing agent-specific is baked in — so the same build also serves as the
# published ghcr helper image for `image:`-based agents.
FROM node:22-bookworm-slim

# git + certs for real agent work; the glibc base keeps Claude Code's bundled
# ripgrep working (avoid Alpine/musl here).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned exactly: an unpinned install would make railyard's content-hash image
# tags lie about what actually runs.
RUN npm install -g @anthropic-ai/claude-code@2.1.215

COPY entrypoint.mjs /entrypoint.mjs

# Build as root, run as non-root (brain: /docker/non-root-agents.md): smaller
# blast radius, no root-owned files on the host — and Claude Code itself
# refuses --dangerously-skip-permissions as uid 0, so USER is load-bearing.
# uid 10001 deliberately matches no host uid.
RUN useradd -u 10001 -m agent && mkdir /workspace && chown agent:agent /workspace
USER agent
# Claude Code needs a writable HOME (~/.claude) and a cwd it may work in.
ENV HOME=/home/agent
WORKDIR /workspace

# Copy-and-edit knobs, read by entrypoint.mjs.
ENV CLAUDE_MODEL=claude-sonnet-5
ENV CLAUDE_MAX_TURNS=16
# Extra CLI args, e.g. "--max-budget-usd 1.00 --allowedTools Bash,Read"
ENV CLAUDE_EXTRA_ARGS=""

ENTRYPOINT ["node", "/entrypoint.mjs"]
