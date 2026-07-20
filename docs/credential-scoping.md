# Credential scoping

railyard's secrets model is **least privilege by construction** (SPEC §8). This guide is
the framework's half of the bargain — how injection and redaction work — and *your* half:
scoping the credentials themselves, which the framework deliberately cannot do for you.

## How the framework handles secrets

- **Manifests declare names only.** An agent's `secrets: [ANTHROPIC_API_KEY]` names an env
  var; the value is resolved at spawn through a `SecretsProvider` (default: process env,
  then a `.env` file). Vault and friends plug in behind the same interface.
- **Only the declared secrets are injected, per container.** An agent that names one secret
  gets exactly one; a sibling agent gets its own set. Nothing ambient leaks in.
- **Boot-time check.** A declared-but-unresolvable secret **fails `start()` loudly** — you
  learn at boot, not when the first signal arrives.
- **Redaction guarantee.** Secret *values* never appear in signals, run records, journals,
  or framework-captured logs (including agent stdout/stderr). Redaction is literal value
  matching above a minimum length, applied to everything the framework persists.
- **Monitors resolve their own credentials.** A monitor is host-side code (SPEC §9), so it
  takes a token **value** via its constructor, not a secret name — resolve it yourself
  (e.g. `await secrets.resolve('GITHUB_TOKEN')`) and hand it over. The `SecretsProvider`
  seam is agent-container machinery; reusing it for the monitor just keeps one `.env`.

## The accepted residual risk

**Anything running inside a container can read that container's own injected env.** This is
inherent to passing secrets as env vars, and railyard accepts it rather than pretend
otherwise. The framework's job ends at *injecting only what was declared and never leaking
values into what it persists*. Keeping the blast radius small when the agent (or something
it runs) is compromised is **credential scoping — your responsibility, guided here, not
framework machinery.**

## Your half: scope the credentials

Make each injected credential able to do as little as possible:

- **Fine-grained tokens.** Prefer a token scoped to exactly the permission the agent needs.
  For GitHub, a fine-grained PAT limited to read-only Issues + Metadata on a single repo,
  not a classic `repo`-scoped token.
- **Spend-capped keys.** For paid provider APIs, use a key with a budget/rate cap so a
  runaway prompt is bounded in dollars, not just turns. The Claude Code scaffold also
  passes turn and `--max-budget-usd` caps as container `ENV`.
- **Don't inject what the agent doesn't need.** The strongest scoping is *absence*.
- **`network: none`** for agents that do no outbound calls — an exfiltration path removed.
- **Rotate.** The default provider re-reads on each spawn, so a rotated secret takes effect
  at the next run without a restart.

## The worked example: zero GitHub access in the agent

`examples/github-review` reviews GitHub issues, yet its agent container declares **Claude
auth as its only secret — no `GITHUB_TOKEN` inside**:

- The **monitor** (host-side) holds a read-only GitHub token and does the polling.
- The **agent** needs nothing from GitHub, because the signal *payload* already carries the
  issue title, body, labels, and author — the whole input.

Least privilege fell out of the architecture rather than being bolted on: the container
that reviews issues literally cannot touch GitHub. If you later want the agent to *post*
its review back (the banked [second pass, issue
#2](https://github.com/copperbox/railyard/issues/2)), that is a deliberate decision to add
a **write-scoped** token to that one container — designed on its own merits, with the
narrowest scope that posts a comment and nothing more.

## Non-goals (be clear-eyed)

railyard ships **no secret vault** and **no egress allowlisting** (SPEC §14). The
`SecretsProvider` seam lets you *integrate* a vault; the sandbox is exactly as tight as
documented (declared secrets in, `network: none` optional), no tighter. Scoping the
credential is the mitigation, and it is yours.

Related: [container contract](./container-contract.md), [authoring
agents](./authoring-agents.md), [getting started](./getting-started.md).
