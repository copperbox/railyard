---
type: pattern
title: The events file is append-only and single-writer — both failures are silent
tags:
  - concurrency
  - contracts
  - docker
  - gotcha
timestamp: 2026-07-27T02:52:06.363Z
---

`$AGENT_EVENTS_FILE` is the only backchannel out of a running agent (SPEC §5),
and it is the one file railyard cannot make safe on the agent's behalf: the
writer is an arbitrary container in an arbitrary language, the reader is the
host polling the other side of a bind mount (`EventsTailer`,
`src/run/events-tailer.ts`). Two agent-side mistakes break it, and neither
raises an error anywhere.

## Replacing the file instead of appending

The mount is `-v ${eventsFile}:/railyard/events.jsonl` — a **single-file** bind
mount (`src/run/runner.ts`). The tailer holds an open handle to that one inode.
Any writer that replaces the file rather than appending — `>` instead of `>>`,
an editor save, write-temp-then-`mv`, `open(path, "w")`, `sed -i` — leaves the
host tailing the orphaned inode. Every subsequent event is lost with no error,
no malformed-line record, and no clue in the run record. This is the nastier of
the two because it looks exactly like "the agent emitted nothing".

## Concurrent appends from inside the container

If an agent fans out (parallel subprocesses, worker threads, a tool logging
from a callback) and each appends to the same file, `O_APPEND` keeps writes
under ~4 KiB atomic on Linux, but a larger write can be split and a concurrent
writer can land inside it. Payloads reach 4 KiB easily — a diff, a file
listing, a captured log. Docker Desktop's macOS/Windows file shares weaken the
guarantee further.

A torn line is **not fatal**: the tailer buffers to the last newline and reports
the wreckage via `onMalformedEvent`, which is journaled. But the event inside it
is gone, and if it was a `signal` line the downstream agent silently never runs
— a chain that simply doesn't happen.

## Guidance given to agent authors

In order of preference: emit from one place (workers return results, the main
process writes events); keep lines small and put bulk in `result.json`; or
serialize writers yourself (mutex, queue, or `flock`, which only coordinates
writers *inside* the container — nothing else contends for the file).

Documented for users in `docs/container-contract.md` ("Writing safely"),
`docs/authoring-agents.md`, and the Claude Code scaffold README; stated as an
agent-side constraint in SPEC §5.

Related: [in-process write serialization](/concurrency/in-process-write-serialization.md),
[container file ownership](/docker/container-file-ownership.md),
[github.issue.* signal contract](/contracts/github-issue-signals.md).
