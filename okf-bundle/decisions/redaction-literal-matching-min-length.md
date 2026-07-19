---
type: decision
title: Redaction is literal value matching with a minimum length
tags:
  - milestone-m1
  - secrets
  - redaction
timestamp: 2026-07-19T23:38:06.974Z
---

Railyard's secret redaction (SPEC §8) is **literal substring replacement**: every
occurrence of each resolved secret value, in every sink (journal, framework logs,
agent.log, emitted signal payloads, run records, preserved events.jsonl), becomes
`[REDACTED:<NAME>]`. Substring — not whole-word — matching is required because
secrets legitimately appear embedded in other text (`Bearer sk-...`, tokens inside
URLs, values inside JSON strings); there is no boundary to anchor on.

**Consequence: values shorter than 6 characters are excluded from redaction, with a
loud boot warning naming the secret.** Substring-replacing a short value corrupts the
records it is meant to protect — a secret value of `1` would rewrite every timestamp,
exit code, and JSON number in the journal; `8080` would mangle durations and unrelated
log lines. A value that short also has too little entropy to be meaningfully protected
by hiding occurrences.

Alternatives rejected:

- **Redact anyway** — corrupts journals/logs/run records via coincidental matches.
- **Fail boot on short secrets** — too strict; short non-sensitive values may be
  declared just to get env injection.
- **Silently skip** — violates invariant 5 ("tunable, never silently absent"); hence
  the mandatory loud warning.

The 6-char threshold is a judgment call, not science: real credentials are 20+ chars,
so the cutoff only bites values that are almost certainly not secrets. It can become a
config knob (`redactionMinLength`) if anyone asks.

Further known limitation, accepted for v1: matching is literal only — base64- or
URL-encoded copies of a secret are not caught (same accepted-residual-risk posture as
SPEC §8's in-container visibility note).

Multi-line secret values (e.g. PEM keys) additionally register each individual line as
a pattern, so line-oriented sinks (agent.log) still catch them. Implementation notes
(line-buffered log capture, temp+rename rewrites of container-owned files, which
sinks are covered) live in [M1 design decisions](/decisions/m1-design-decisions.md).

Related: [M0 design decisions](/decisions/m0-design-decisions.md).
