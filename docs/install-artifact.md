# Prepared install artifact

Use this artifact to test the package built from a specific Premind commit, without publishing it. It is not a substitute for testing OpenCode's `github:` route or Pi's `git:` route separately.

From a checkout with Node 22.13+, Bun, npm, git, and tar available:

```sh
node scripts/build-install-artifact.mjs /tmp/premind-install-artifact
node scripts/verify-install-artifact.mjs /tmp/premind-install-artifact
```

The output directory must not exist and must be outside the source checkout. The builder clones the checkout's **HEAD** into a disposable workspace, runs `bun install --frozen-lockfile`, and invokes `npm pack` once there. Uncommitted changes are deliberately excluded; the original checkout is not rebuilt or modified. A failure removes the staged output. Do not pass an existing directory, since it may contain another run's files.

The output contains:

- `artifact.json`: source commit, Premind package version, tarball filename, SHA-256 digest, and extracted root;
- `premind-<version>.tgz`: the npm package including generated Codex and Claude bundles;
- `package/`: the same tarball extracted, including `.agents/plugins/marketplace.json` and `plugins/codex/premind/` for Codex's directory marketplace, and `plugin-claude/` for Claude's directory installer.

The verifier checks the archive digest, package/manifest version, expected entrypoints and generated runtime parity, and compares the extracted files with the archive. Run it **after downloading** a CI artifact and before passing `package/` or the tarball to a host probe. Host jobs should use the `sourceCommit` in `artifact.json` to associate results with the tested commit. The `.agents` directory is explicitly included in `package.json#files` so the extracted package is a valid repository-local Codex marketplace root.

The CI **Install artifact** job prepares and uploads these files as `premind-install-<commit>` for seven days. It does not install or run any agent host. Follow-up issue #68 adds host-specific install/discovery checks and pins their CLI versions. It must separately prove any git/source installation path that does not match the packaged artifact; no npm registry or marketplace publication is performed here.
