# Plan: installed-plugin smoke tests across current agent hosts (#68)

## Outcome and boundary

Detect when a supported **agent host CLI** stops installing or loading Premind as users do. The hosts are Codex CLI, Claude Code, OpenCode, and Pi; this is **not** a matrix of LLM/model providers. Test the released host CLI's actual install and discovery behavior against the Premind artifact built from the tested commit. Keep a deterministic known-good gate, including Codex's stated minimum 0.155.1, alongside a regularly refreshed latest-host signal. Do not claim that every future host version is compatible because a version comparison accepts it.

No model inference, GitHub polling, privileged approvals, or credentials are required for the core smoke suite. Authenticated end-to-end delivery remains a separate opt-in lane. This plan does not implement the suite or change host support policy.

## Current baseline and the gap

| Host | Existing coverage | Missing installed-host proof |
| --- | --- | --- |
| Codex | `scripts/validate-codex-contract-fixture.mjs` tests a synthetic marketplace; `scripts/validate-codex-package-plugin.mjs` installs real Premind in an isolated Codex home and probes MCP/hook bundles; `scripts/validate-codex-live-contract.mjs` is interactive. | Real package installer is not in `.github/workflows/ci.yml`; neither fixture nor source-unit tests prove every newer CLI still discovers the installed hooks. The package probe's `SessionEnd` hook with no `PLUGIN_DATA` does not prove that the MCP and a real hook share Codex's data directory. |
| Claude Code | `plugin-claude/test/` tests plugin contracts; `plugin-claude/live/session-id-contract.mjs` exercises fresh/resumed identity only with an authenticated model session and exits successfully when skipped. | Automated real-plugin install/discovery and no-model hook/MCP checks at an observed host version. |
| OpenCode | `src/plugin-opencode/__tests__/packaging.test.ts` imports a source entry; `src/test/live-validation.ts --contract-only` starts a real host via SDK, but does not verify the user-facing Premind install path. | Load the packaged GitHub/local plugin in an isolated OpenCode config and prove registration without a model call. |
| Pi | `package.json` declares `pi.extensions: ["./extensions/premind.ts"]`; `src/extension/__tests__/index.test.ts` calls the extension directly. Pi's package docs support npm/git/local installs and explicit extension discovery. | Install the package in a fresh Pi home with project trust addressed, then verify that Pi itself loads the extension and exposes a Premind command/tool in noninteractive mode. |

The weekday `.github/workflows/live-validation.yml` is an OpenCode SDK contract or authenticated prompt check, not a four-host installed-artifact test. PR #69 guards committed Codex bundles and shared manifest metadata; those static checks should remain, not be replaced by this suite.

## Decisions to confirm before coding

1. **Installer feasibility:** In a bounded spike, record for each host its official distribution identifier, exact `--version` output, stable noninteractive install/discovery command, clean-home environment variables, and whether it can load a plugin without model authentication. Do not guess npm package names or equate a source import with host loading. Codex's fixture and package scripts are starting points; Pi's `docs/packages.md` describes `pi install` and `pi list` but a real no-model load probe still needs proving.
2. **Artifact fidelity:** Prepare one versioned Premind artifact from a clean checkout. `npm pack` runs `prepack`, which rebuilds generated bundles and temporarily edits a version file; build/package only in a disposable workspace, inspect the tarball, and upload the immutable artifact to host jobs. For directory/marketplace installers, extract that same tarball into a temp root with the documented layout. If a host's real supported installer uses git rather than the tarball/directory, add a separate git-path check instead of silently substituting a different install route.
3. **Isolation:** Give each run a unique home/config/cache/state/socket path and an unrelated working directory. Prevent inherited personal plugins, credentials, and host config from satisfying assertions. Constrain only the necessary install-network access; keep test execution local. Clean up with `finally`/runner teardown and put timeouts on host commands and jobs.
4. **Reporting:** Distinguish `pass`, `fail`, and `unsupported/blocked`; a missing CLI, unavailable release, inability to install, missing auth-free contract, or a skipped probe must not be green. Print installed host version, Premind artifact commit/version, install source, and failing assertion, not home contents, tokens, or complete environment variables. Keep output bounded.

The capability spike fills this table with observed facts before implementing any host job (a blank cell is a blocker, not an assumption):

| Host | Distribution + exact-version resolution | Installed `--version` | User install/load command | No-auth registration evidence | Home/trust isolation |
| --- | --- | --- | --- | --- | --- |
| Codex 0.155.1 + latest | Verify official release source; pin both selected versions | To capture | Marketplace add + plugin add (existing script) | To verify: hooks and MCP reported by CLI | `CODEX_HOME`; hook trust requires explicit treatment |
| Claude Code latest | To verify | To capture | `claude plugin install` from package leaf | To verify without prompt | To verify |
| OpenCode latest | To verify | To capture | Configured plugin from supported package/local path | To verify without prompt | To verify |
| Pi latest | To verify | To capture | `pi install` from supported package path | To verify without model call | To verify trust/settings |
## Contract per host

- **Common:** resolve the host release to an exact immutable version, install it in isolation, install Premind through a supported user-facing route, ask the host (not an import of Premind source) whether the plugin/extension is registered, and fail if the expected command/tool/entrypoint is absent. Each probe must have a deliberately broken manifest/entrypoint fixture that fails, so a false-green check is caught.
- **Codex:** run the existing fixture as a cheap contract check; adapt `validate-codex-package-plugin.mjs` to accept a selected `codex` binary and immutable prepared artifact rather than deleting/rebuilding files in the source checkout. Check marketplace path selection, absence of root `plugin.json` in the installed leaf, hook registration/trust state, MCP discovery and `initialize`/`tools/list`, and a hook-to-MCP receipt/binding round trip in the same Codex-managed `PLUGIN_DATA` root. Exercise both 0.155.1 and the independently resolved latest release. A hook that merely exits zero without data is insufficient.
- **Claude Code:** install the real `plugin-claude/` directory from the prepared artifact; inspect host-reported plugin registration, expected hooks/commands and MCP config. Run a deterministic hook event and MCP handshake directly against the host-resolved installed paths without a model call. Keep the authenticated fresh/resume session-ID test opt-in and report its skip explicitly outside required CI.
- **OpenCode:** use the documented `github:jdtzmn/premind` plugin route where possible; for the branch artifact, first prove the supported local or packaged equivalent registers in an isolated `opencode.json`. Observe plugin load and at least one registered Premind command/tool or lifecycle signal via the real CLI/SDK, without an LLM request. Keep the existing SDK contract-only test, but do not count it as install coverage.
- **Pi:** use the documented `pi install` package path on the prepared package in an isolated settings home (and explicitly resolve project trust). Start Pi in a noninteractive/no-model mode; assert the installed extension, a Premind command/tool, and no startup error through Pi's own output/API. A direct `-e` source-file load or test import is only a diagnostic fallback, not the acceptance test.

If a host cannot expose a verifiable no-auth install/load contract, document the limitation and propose a narrowly scoped opt-in credentialed probe; do not silently downgrade the acceptance test to a file-existence check.

## Delivery slices (validate and commit each slice)

1. **Capability spike and contract table.** Verify official install/version/config APIs and perform manual isolated no-model trials for all four CLIs; capture exact commands and versions in this plan. Identify authentic user install routes and any auth/trust blocker. Exit criterion: one reproducible probe recipe per host or an explicit blocker/decision before building a generalized harness.
2. **Artifact preparation and Codex baseline.** Produce/upload an immutable package from disposable workspace; refactor the real Codex package check to consume that artifact and injected binary. Add pinned 0.155.1 plus a same-data-root assertion. Exit criterion: a broken compatibility manifest or split plugin-data location fails; the clean artifact passes with no credential.
3. **Other hosts one at a time.** Add Claude, OpenCode, then Pi isolated installers/probes only after each route is verified. Share minimal helpers for temp homes, process deadlines, version capture, result reporting; keep host-specific contracts explicit. Exit criterion per host: prepared package installs, host reports its capabilities, negative fixture fails, no model API used.
4. **Workflow policy and docs.** Add a required PR job for fast pinned/no-auth probes that prove stable on hosted runners. Add a scheduled + manual **latest** four-host matrix (including Codex latest), resolve versions afresh and print them, allow no silent skips, and use `permissions: contents: read` with per-job timeouts. Upload concise logs on failure; link reproduction commands and clarify that the `0.155.1 or newer` claim is supported by minimum + observed-latest tests, not all intervening versions. Decide after a reliability window whether latest jobs become required PR gates or alerting-only; failing latest jobs must remain visible.

Do not introduce a generic host-plugin framework before the second working host. Keep CI jobs isolated: a failure in one host should identify that host and version rather than hide behind an aggregate result.

## Verification and acceptance

- A documented single-host command runs each smoke probe locally against a chosen host version; CI runs the same command with explicit binary/artifact paths. CI version logs show both the requested release and actual executable version (and fail on mismatch).
- A reproducible Codex 0.155.1 check and latest check both verify installed hooks, MCP negotiation, and shared hook/MCP data. All four latest-host jobs prove actual registration from a built artifact, not only source-level unit tests.
- Poisoned manifest/entrypoint tests fail for each host; missing auth, missing binaries, unsupported flags and CLI drift never return a passing job.
- The pinned PR lane is bounded, deterministic, credential-free and green; the latest scheduled/manual lane surfaces host drift separately. Authenticated live probes remain opt-in, and existing unit/CI checks stay intact.
- The plan's command/version table is updated with verified facts during the capability spike before the suite is declared implemented. Any untestable host remains an open blocker on #68 rather than being marked complete.

## Review questions

- Should scheduled latest-host drift block merges immediately, or remain a visible non-required alert until its flake rate is measured? Proposal: required pinned PR lane first; latest scheduled/manual lane initially non-required, never silently skipped.
- For OpenCode's GitHub installer and Pi's git/npm package routes, which additional *release-path* probes are valuable beyond the immutable branch artifact? Proposal: start with the supported local/package route for branch correctness, then add separate published/git installation checks when their source can be pinned and attribution is unambiguous.
- If Claude/Pi host loading requires authentication or interactive trust despite an installed-artifact setup, should that host get an explicitly opt-in credentialed job or should the product expose a host-level offline diagnostic? Determine this in slice 1 rather than adding credentials to ordinary PR CI.
