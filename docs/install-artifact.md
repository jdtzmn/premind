# Build, test and release dist

The `dist/` directory is a release candidate, not a test-only package. Build it once from a committed revision, run the distribution tests against its archives, and publish **those same archives** on a version tag. Node 22.13+, Bun, npm, git and tar are required to build; validation and promotion need only Node and tar (plus `gh` for publication).

```sh
node scripts/build-install-artifact.mjs         # creates a new, gitignored dist/
node scripts/test-dist.mjs dist                  # tests the archives, not source bundles
```

The output directory must not exist. You can pass a fresh absolute output path outside the checkout instead. The builder clones **HEAD** into a disposable workspace, runs `bun install --frozen-lockfile`, and invokes `npm pack` once there. It then extracts that tarball and makes host archives from its bytes; no host build is run separately. Uncommitted changes are deliberately excluded. A failed build removes the staged output.

`dist/` contains:

- `premind-<package-version>.tgz`: the installable npm package for Pi and OpenCode, declaring dependencies and carrying TypeScript entrypoints and generated runtimes. It is not a bundled standalone binary; installing dependencies remains the host/package manager's responsibility.
- `premind-codex-<package-version>.tgz`: extract to a Codex directory-marketplace root (`.agents/plugins/marketplace.json` and `plugins/codex/premind/`).
- `premind-claude-<claude-plugin-version>.tgz`: extract to a Claude directory-plugin root (`.claude-plugin/plugin.json` and its runtime). Claude's plugin manifest currently has an independent version (`0.2.0`), which is recorded separately from the package/release version in `artifact.json`.
- `package/`: the npm tarball extracted for validation and local install probes; it is not a separate release asset.
- `artifact.json`: source commit, package and Claude versions, archive filenames and SHA-256 digests.
- `SHA256SUMS`: checksums for all three archives. The metadata and checksums are also release assets.

`node scripts/verify-install-artifact.mjs dist` checks checksums, versions, required entrypoints, generated runtime parity and selected archive-to-extracted-file equality. `test-dist.mjs` additionally extracts the **Codex and Claude release archives** into an isolated directory, initializes the Codex MCP bundle, lists its tools, invokes its SessionEnd hook and syntax-checks the Claude entrypoints. These are offline distribution checks, **not yet the latest-host installation/discovery tests** tracked in #68. Source/git installation routes that bypass the release archives still need separate coverage.

## Tag promotion

CI builds and tests the dist archives on pull requests and pushes. A push of `v<package-version>` runs those checks and, once typecheck, unit, harness, compatibility and dist jobs pass, the release job downloads the **tested artifact from that same workflow run**. It tests the downloaded bytes again, requires the tag version and commit to match `artifact.json`, then publishes its three archives plus `SHA256SUMS` and `artifact.json` as GitHub Release assets. The release job never runs `npm pack`, the runtime builder, or another archive producer. Existing releases are not overwritten.

This publishes GitHub Release assets only; it does **not** publish to npm or automatically update host marketplaces. Pi/OpenCode users who rely on npm registry or GitHub-source installation need those distribution routes validated and enabled separately before claiming parity with the release assets. No tag or release is created by this PR itself.
