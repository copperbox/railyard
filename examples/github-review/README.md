# github-review example — the user-zero workflow (M4)

The SPEC §15 M4 sentence, runnable: a `needs-review` label on a GitHub issue in
`copperbox/railyard` → the `issue-reviewer` agent (a Claude Code container) writes a
triage review into the run record. First pass is **runs/-only**: the agent performs no
GitHub writes of any kind — the review lands in `runs/<id>/output/result.json` and a
human reads it there.

```
src/main.ts            orchestrator + GitHubIssuesMonitor + console narration
agents/issue-reviewer/ copied from scaffolds/claude-code, edited for issue triage
runs/  state/  .env    gitignored — run artifacts, monitor cursors, tokens
```

## Secrets

Two tokens, one `.env` (repo root — `main.ts` points `EnvSecretsProvider` there
explicitly, so it works from any cwd; process env always wins over the file):

| Name | Who uses it | Scope |
|---|---|---|
| `GITHUB_TOKEN` | the **monitor**, host-side, read-only polling | local dev: `GITHUB_TOKEN=$(gh auth token)`; deployments: a fine-grained PAT with read-only Issues + Metadata on `copperbox/railyard` |
| `ANTHROPIC_API_KEY` *or* `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_AUTH_TOKEN` | the **agent container** | Claude auth only — see the scaffold README |

The container deliberately declares **no `GITHUB_TOKEN`** — the signal payload already
carries everything the review needs, so the agent gets zero GitHub access. Least
privilege by construction (SPEC §8).

## Run it

```sh
pnpm install && pnpm --filter railyard-example-github-review start
```

Boot fails loudly (by design) if the GitHub token is missing/invalid (monitor
preflight probes the repo — it's private, so no token ⇒ 404), if Claude auth can't be
resolved, or if the agent's schema copy drifts from the monitor's published schema.

Then label an issue on `copperbox/railyard` with `needs-review`. Within one poll
interval (60 s) the terminal narrates signal → run, and the review appears in
`runs/<timestamp>--issue-reviewer--<id>/output/result.json`. That file is Claude's
result object verbatim (the framework never invents a cross-provider schema); the
review markdown is its `result` field:

```sh
jq -r .result runs/*/output/result.json | less   # read the reviews
jq -r '.total_cost_usd' runs/*/output/result.json  # per-run cost
```

Note the monitor **baselines on first start**: history is never replayed, so label an
issue *after* the app is up (or delete `state/` to re-baseline).

Re-review = remove and re-add the label (a fresh GitHub event id ⇒ a fresh signal;
event-id dedup means the old event never fires twice).
