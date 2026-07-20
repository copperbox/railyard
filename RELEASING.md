# Releasing

railyard publishes two packages to npm:

- `@copperbox/railyard` (core)
- `@copperbox/railyard-monitor-github` (peer-depends on core)

Versioning is **manual semver**, no automation (two packages don't warrant a changesets
pipeline yet). The `1.x` line implements **Signal Contract v1** (the `contractVersion: "v1"`
wire tag); a breaking wire/disk contract change is a new major *and* a new contract version.

## Prerequisites (one-time)

- The **`@copperbox` scope must exist on npm** (create the org, or publish under a user
  scope you own). Scoped packages are private by default — each package sets
  `publishConfig.access = "public"`, so a public publish is explicit.
- `npm login` with an account that can publish to the scope. 2FA recommended.

## Cutting a release

1. **Bump versions.** Edit the `version` in the package(s) you're releasing. If core gets
   a new major, bump the monitor's `peerDependencies["@copperbox/railyard"]` range to match.
2. **Build + verify, all green:**
   ```sh
   pnpm -r build
   pnpm test:docker          # unit + container gates
   pnpm test:github          # monitor real-API gate (needs GITHUB_TOKEN)
   # pnpm test:llm            # spends real API money — run when the scaffold changed
   ```
   The `pack.test.ts` in each package asserts the tarball ships only `dist` + `schemas` +
   `README` + `LICENSE` + `package.json`. Eyeball it too:
   ```sh
   ( cd packages/railyard && npm pack --dry-run )
   ( cd packages/railyard-monitor-github && npm pack --dry-run )
   ```
3. **Commit + tag** (e.g. `railyard@1.0.0`, `monitor-github@1.0.0`).
4. **Publish core first, then the monitor** (peer-dep order):
   ```sh
   pnpm --filter @copperbox/railyard publish
   pnpm --filter @copperbox/railyard-monitor-github publish
   ```
5. **Smoke-test from the registry** in a scratch dir:
   ```sh
   npm i @copperbox/railyard-monitor-github @copperbox/railyard
   node -e "import('@copperbox/railyard').then(m=>console.log(!!m.Orchestrator))"
   ```

## Provenance

npm [provenance](https://docs.npmjs.com/generating-provenance-statements) requires
publishing from CI over OIDC — it cannot be produced by a local `npm publish`. So:

- **The first `1.0.0` publish is local/manual** (the steps above) and carries **no
  provenance**. That's expected.
- **Every release after that** should go through `.github/workflows/release.yml`: push a
  release tag and the workflow runs `npm publish --provenance` with `id-token: write`. It
  needs an `NPM_TOKEN` repo secret (an automation token for the scope). The workflow is
  wired but intentionally not the first release's path.
