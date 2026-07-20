FROM alpine:3.20
COPY entrypoint.sh /entrypoint.sh
# Build as root, run as non-root (brain: /docker/non-root-agents.md). The
# container contract pre-chmods everything the agent must write.
RUN adduser -D -u 10001 agent
USER agent
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
