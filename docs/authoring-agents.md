# Authoring agents

An **agent** is a *folder of data*, never code executed on your host (SPEC invariant 2).
Loading an agent parses and validates files; only the sandboxed container ever runs
anything. What is in the folder is literally what builds and runs — no codegen, no magic.

## The folder

```
agents/my-reviewer/
  manifest.yaml     # identity + subscriptions + runtime config (required)
  prompt.md         # optional prompt template, rendered per signal
  Dockerfile        # present unless manifest sets image:
  ...               # anything the Dockerfile COPYs in (e.g. entrypoint.mjs)
```

Put the folder inside your orchestrator's `agentsDir`. Agent `name` must be lowercase
`^[a-z0-9][a-z0-9-]*$` and unique across the directory.

## `manifest.yaml` reference

```yaml
name: my-reviewer            # required; lowercase, ≤63 chars
on:                          # required; ≥1 subscription
  - type: github.issue.labeled          # required; namespaced signal type
    filter: '$.label.name == "needs-review"'   # optional; declarative filter (§3)
    payloadSchema: ./issue-labeled.schema.json # optional; JSON Schema the agent requires
secrets: [ANTHROPIC_API_KEY]  # NAMES only, resolved at spawn (§8); default []
concurrency: 1                # simultaneous-run cap; default 1
timeout: 900                  # seconds before a framework kill; null = run forever; default 900
network: default              # or "none" to cut the container off the network
allowSelfTrigger: false       # may this agent's own emissions re-trigger it? default false
# image: registry.example/img:tag   # alternative to a Dockerfile (see below)
```

- **`filter`** is the declarative [filter grammar](./contracts/filter-grammar.md):
  `<jsonpath> <op> <json-literal>`, `==`/`!=` only. There is no escape into code — if a
  filter can't express it, write a smarter monitor.
- **`payloadSchema`** must live **inside the agent folder** and is the JSON Schema the
  agent *requires*. At boot the orchestrator checks it against the emitter's declared
  schema (deep structural equality) and fails loudly on drift. The idiomatic way to
  satisfy it: **copy the monitor's published schema file verbatim** into your folder —
  identical bytes are compatible by construction. Omit it to accept any payload (and skip
  the check for that subscription).
- **`secrets`** are names (`^[A-Z][A-Z0-9_]*$`), resolved per container at spawn; only the
  ones you name are injected. See [credential scoping](./credential-scoping.md).

## `prompt.md`

An optional template rendered once per matched signal and mounted read-only at
`$AGENT_PROMPT_FILE`. The grammar is `{{ dot.path }}` over the **full signal envelope**:

```md
Review issue #{{payload.issue.number}} in {{payload.repo.fullName}}.

Title: {{payload.issue.title}}
Body:
{{payload.issue.body}}
```

A `{{` that doesn't open a valid placeholder is a **boot parse error**; a path missing at
render time fails the run before any container starts. There is no escape for a literal
`{{` in Contract v1. Full rules: [prompt template
grammar](./contracts/prompt-template-grammar.md).

## Image sources (in order of ceremony)

1. **A `Dockerfile` in the folder.** Built at orchestrator boot, tagged by a **content
   hash of the folder** — edit any file and the next boot rebuilds; unchanged folders are
   cache hits. This is the hackable default (copy a scaffold and edit).
2. **`image:` in the manifest** — a prebuilt image reference, **pull-verified at boot**
   instead of built. Boot resolves the ref **local-first**, so a locally built tag needs
   no registry. One image can back many prompt-only agent folders. You manage freshness:
   rebuild/re-push when you change it (mutable tags like `:latest` are not re-pulled if the
   bytes already exist locally — pin a digest for cross-machine determinism).

A Dockerfile and `image:` are mutually exclusive; the loader enforces it. **railyard
publishes no images and operates no registry** (SPEC §14) — the image is yours to build
locally or push to a registry *you* own.

## Best practices baked into the scaffold

`scaffolds/claude-code` is a copy-me agent that adapts Claude Code's headless mode to the
container contract. Copy it and edit `manifest.yaml` + `prompt.md`:

```sh
cp -r scaffolds/claude-code my-app/agents/my-reviewer
```

It models conventions worth keeping:

- **Run as a non-root user.** Build as root, then `USER agent` (uid 10001, matching no
  host uid). Smaller blast radius, no root-owned files written to host mounts — and Claude
  Code itself refuses `--dangerously-skip-permissions` as uid 0, so it's load-bearing.
  railyard does *not* enforce this (it would break `image:` agents); it's guidance.
- **Pin your tools exactly.** An unpinned `npm install -g` would make the content-hash tag
  lie about what actually runs.
- **Copy-and-edit knobs as `ENV`** (model, turn caps, budget flags) so the folder stays
  the unit of change.

## The container's obligations

Whatever runs inside must honor the [container contract](./container-contract.md): read
the mounted signal, optionally emit events to the events file, write `result.json`, and
signal success/failure via the process exit code. It is writable from any language
(`echo >> "$AGENT_EVENTS_FILE"`), because agents are not required to be JavaScript.

Related: [container contract](./container-contract.md), [credential
scoping](./credential-scoping.md), [Signal Contract v1](./contracts/README.md).
