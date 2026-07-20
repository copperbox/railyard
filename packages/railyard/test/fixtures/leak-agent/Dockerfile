FROM alpine:3.20
COPY entrypoint.sh /entrypoint.sh
# Build as root, run as non-root (brain: /docker/non-root-agents.md). uid 10001
# deliberately differs from any host uid: files this agent writes stay
# host-unwritable, keeping the temp+rename redaction path under test.
RUN adduser -D -u 10001 agent
USER agent
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
