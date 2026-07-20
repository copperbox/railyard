# Echo-style proof agent (step 8's Docker-gated e2e builds this; unit tests only
# need it to exist for loader validation). Reads its input, appends one log
# event, writes the received payload back as its result.
FROM alpine:3.20
RUN adduser -D -u 10001 agent
USER agent
ENTRYPOINT ["/bin/sh", "-c", "\
  cat \"$AGENT_INPUT_FILE\" > \"$AGENT_OUTPUT_DIR/result.json\" && \
  printf '{\"kind\":\"log\",\"level\":\"info\",\"message\":\"labeled-review-agent ran\"}\\n' >> \"$AGENT_EVENTS_FILE\" \
"]
