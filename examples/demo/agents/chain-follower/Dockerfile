FROM alpine:3.20
COPY entrypoint.sh /entrypoint.sh
# Best practice modeled here on purpose: build as root, run as non-root
# (brain: /docker/non-root-agents.md).
RUN adduser -D -u 10001 agent
USER agent
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
