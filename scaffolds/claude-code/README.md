# claude-code scaffold

A copyable railyard agent folder that runs [Claude Code](https://code.claude.com)
in headless mode. The entrypoint helper adapts Claude Code's own CLI to the
railyard container contract; the framework stays provider-ignorant (SPEC §14).

## Use it

**Copy mode** (hackable — the image rebuilds at orchestrator boot):

```
cp -r scaffolds/claude-code my-app/agents/my-reviewer
# then edit: manifest.yaml (name + on:), prompt.md, optionally the Dockerfile ENV knobs
```

**Image mode** (no Dockerfile in the agent folder — reference an image you built):

```
docker build -t railyard-claude-code:local scaffolds/claude-code
```

```
my-app/agents/my-reviewer/
  manifest.yaml   # image: railyard-claude-code:local
  prompt.md
```

Boot verifies `image:` refs against local Docker first and only pulls when
absent, so a locally built tag needs no registry. One image can serve any
number of prompt-only agent folders. Freshness is yours to manage: rebuild the
tag yourself when you change the Dockerfile or bump the claude-code pin —
unlike copy mode, there is no content-hash staleness detection.

railyard publishes no prebuilt image — the image is yours to build. For
cross-machine deploys, build this Dockerfile and push the tag to a registry you
own (any registry works — Docker Hub, ghcr, ECR, a private Harbor), then point
`image:` at that ref. Pin a version tag or digest (`image: reg/img@sha256:…`):
because boot resolves local-first, a re-pushed mutable tag like `:latest` is
never re-pulled on a machine that already has the old bytes.

Either way the manifest must declare an auth secret the orchestrator's
`SecretsProvider` can resolve (process env or `.env` by default) — boot fails
loudly if it can't (SPEC §8).

## Auth

Declare exactly one of these under `secrets:` — Claude Code reads whichever is
present from env, and the entrypoint fails fast only when none is set:

| Secret | Use when |
|---|---|
| `ANTHROPIC_API_KEY` | Direct API billing (spend-capped keys recommended) |
| `CLAUDE_CODE_OAUTH_TOKEN` | A Claude subscription: mint a long-lived token with `claude setup-token` |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token for a gateway/proxy in front of the API |

If several are set, the CLI's own precedence applies
(`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN`).

## prompt.md templating

The framework renders `prompt.md` per matched signal and mounts the result at
`$AGENT_PROMPT_FILE`. Placeholders are `{{ dot.path }}` resolved against the
full signal envelope — the exact JSON in `input/signal.json`:

- `{{payload.issue.title}}` — into the payload
- `{{type}}`, `{{source.name}}`, `{{id}}` — envelope fields
- `{{payload.items.0}}` — array index

Strings interpolate verbatim; numbers/booleans/null as JSON literals;
objects/arrays as 2-space JSON. A malformed placeholder fails boot; a path
missing from a signal fails that run (journaled). No expressions, no escapes —
declarative only.

## Knobs (Dockerfile ENV, read by entrypoint.mjs)

| Var | Default | Meaning |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5` | Passed to `--model` |
| `CLAUDE_MAX_TURNS` | `16` | Passed to `--max-turns` |
| `CLAUDE_EXTRA_ARGS` | *(empty)* | Whitespace-split extra CLI args, e.g. `--max-budget-usd 1.00 --allowedTools Bash,Read` |

The entrypoint always passes `--dangerously-skip-permissions`: the container is
the sandbox — its only powers are its mounts and its declared secrets — and an
interactive permission prompt in headless mode is a hang, not a safeguard.
Claude Code refuses that flag as root, which is one of three reasons this image
runs as the non-root `agent` user (uid 10001); don't remove the `USER` line.

## Contract mapping

| Contract side | This scaffold |
|---|---|
| `$AGENT_PROMPT_FILE` | Read and piped to `claude -p` via stdin |
| `$AGENT_OUTPUT_DIR/result.json` | Claude's `--output-format json` object, verbatim |
| `$AGENT_EVENTS_FILE` | `log` lines from the helper (start/finish/cost) |
| Exit code | `0` iff the CLI exited 0 **and** `is_error === false` |

## Emitting signals (agent chaining)

The helper emits no `signal` lines itself. To chain agents, instruct Claude in
your prompt.md — the events file is writable from any tool call:

```
When done, run:
echo '{"kind":"signal","type":"review.completed","payload":{"ok":true}}' >> "$AGENT_EVENTS_FILE"
```

(Self-triggering is refused unless the manifest sets `allowSelfTrigger: true`;
chains are depth-limited. SPEC §7.)

## Credential scoping

Anything inside the container can read its injected env — that's SPEC §8's
accepted residual risk. Use a spend-capped, least-privilege API key. See the
[credential scoping guide](../../docs/credential-scoping.md).

## More

- [Authoring agents](../../docs/authoring-agents.md) — the agent folder and manifest reference.
- [Container contract](../../docs/container-contract.md) — what this entrypoint must honor.
