# Issue #67: Generate installable Premind skills

Issue: <https://github.com/jdtzmn/premind/issues/67>
Reference: Port's `scripts/generate-port-skill.ts` and generated `skills/port-cli/SKILL.md`.

## Goal

Replace the hand-maintained Premind Codex skill with a reproducible, installable Agent Skills package. Reuse Premind's concepts across coding agents without telling one harness to use another harness's commands, tools, session identity, or delivery behavior. Keep the instructions small through progressive disclosure.

The file is `SKILL.md` (singular) inside a skill directory, not a root-level `SKILLS.md` index. The skill directory is the package: `SKILL.md` plus optional `references/` files. A reference is read on demand; it is not independently discovered as a skill.

## Current constraints

- This checkout has `plugins/premind/skills/premind/SKILL.md`, a hard-coded Codex skill. PR #60 proposes a separate Codex compatibility plugin at `plugins/codex/premind/skills/premind/SKILL.md`. Finalize the generated Codex output path against the branch actually being implemented; if #60 lands first, update the compatibility leaf and preserve the portable leaf's packaging contract rather than silently leaving one stale.
- Pi, Claude Code, and OpenCode have different capability names and delivery semantics. `src/shared/command-capabilities.ts` already describes their command/tool names, but does not describe Codex. Codex's supported MCP controls are currently declared in `src/codex/mcp-server.ts` and require a session handle for mutations.
- A skill is agent guidance, not the source of truth for runtime behavior. Generating documentation must not change what a plugin actually exposes.
- Package discovery is host-specific. In particular, Pi's `package.json` currently declares only `pi.extensions`, not a skill. Confirm Claude and OpenCode skill discovery/installation before adding their artifacts to a published package.

## Design

Each supported host gets **one discoverable `premind` entry skill at its actual install location**. Do not ship a universal router that asks the model which agent it is running in. Each entry point contains only:

1. Frontmatter with a host-appropriate trigger description.
2. A brief explanation of Premind and the instructions needed on every invocation.
3. Explicit, conditional pointers to on-demand references such as `references/subscriptions.md` and `references/reminders.md`. Use relative paths from that skill directory. Split only when a reference is substantial enough to justify an extra read; do not manufacture tiny files.

Separate *shared product guidance* (untrusted PR content, subscription authority, duplicate event handling) from *host-specific instructions* (actual tool/command names, session binding, worktree activation, delivery timing). Generate the host-specific parts from a small, reviewable capability description backed by the existing capability matrix for Pi/Claude/OpenCode and by Codex's actual MCP surface. Where a description must differ, record the exception explicitly; do not infer behavior from tool names or expose tools that are unavailable in a host. Author shared prose once and render/copy it into each installed skill directory so its relative references work after packaging. Do not have installed skills reach across to repository source paths.

Suggested output layout (verify each host's discovery convention before enabling it):

```text
plugins/premind/skills/premind/SKILL.md                # portable Codex plugin today
plugins/premind/skills/premind/references/*.md
plugins/codex/premind/skills/premind/                    # PR #60 compatibility leaf, if present
plugin-claude/skills/premind/                            # only after Claude install verification
skills/premind/                                         # Pi package, if declared in pi.skills
```

OpenCode needs its own **verified installation path**; do not assume that a skill nested in the Codex plugin is discovered by OpenCode. If its plugin installation cannot ship a discoverable skill without additional user setup, document that constraint and defer the artifact rather than advertising a nonexistent integration. Likewise, add `pi.skills` only when Pi's installed package includes and discovers the generated skill. Skill names should match their containing directory; host-specific filenames need not become separate model-invoked skills.

## Implementation slices

### 1. Establish the artifact and source contract

- Reconcile the active branch with PR #60's portable/compatibility plugin layout.
- Audit the supported surfaces against runtime registrations and the current `src/shared/command-capabilities.ts` matrix. Decide whether to extend that matrix to Codex or create a narrow Codex metadata adapter; do not make Codex appear to support the Pi/Claude/OpenCode commands it lacks.
- Create a pure `generatePremindSkillMarkdown(host)` renderer plus a small output-path manifest. Keep common prose and host differences explicit and deterministic. Give generated files a marker and ensure the entry point only links to references actually packaged alongside it.
- Check representative generated Codex content against existing safety, session-handle, worktree, cross-repository, detail-file, duplicate-event, and delivery-boundary guidance before replacing the hard-coded file.

**Gate:** Generation twice produces identical bytes; generated Codex guidance preserves all applicable behavior and mentions only supported Codex controls. Commit this slice after focused checks.

### 2. Package and disclose per host

- Generate the Codex skill in the plugin directory or directories actually installed by the current marketplace and PR #60 compatibility package. Verify the published/installed package includes both the entry point and every linked reference.
- Add Pi, Claude Code, and OpenCode entry points **only after** confirming how each host discovers package skills and that its installed artifact contains the referenced files. Configure `pi.skills` for Pi when enabled. Avoid duplicating the same skill in two Pi discovery locations, and avoid accidentally exposing Codex-specific skill files to other hosts.
- Render each entry point against the host's actual capability surface. Claude's Stop-hook delivery and redaction rules, Codex's session handle and next-boundary delivery, and Pi/OpenCode's own controls must remain distinct. Keep the common safety semantics consistent.

**Gate:** For each enabled host, an installed-package or equivalent discovery smoke check loads exactly its intended `premind` skill, can follow its relative references, and finds no instructions for unavailable tools. If a host lacks a reliable path, leave it out and record the follow-up.

### 3. Guard against drift

- Add `generate:skill` to `package.json`; generate at development/build time and commit outputs, rather than regenerating only at installation or requiring Bun in the shipped skill.
- Add a CI regeneration-and-diff check for every generated skill and reference, analogous to Port's `generate:skill` check. Check the resulting files after generation rather than relying on a no-op command exit status.
- Add focused tests for deterministic output, valid frontmatter and relative links, host-specific control names/negative assertions, preservation of safety guidance, and equality between committed artifacts and renderer output. Extend packaging tests to confirm all required files are in the npm/marketplace leaves.
- Run `bun run check`, the generator tests, and focused packaging/contract checks locally; leave comprehensive suite/build verification to CI per repository policy.

**Gate:** CI fails on stale output or a missing packaged reference, and generation leaves a clean diff. Commit after the targeted validation.

## Out of scope

- Changing subscription, daemon, lifecycle, or delivery behavior to fit a skill.
- A root-level, always-loaded skills table of contents or one skill per agent that must be selected manually from a universal router.
- Claiming support for a host whose installation/discovery contract has not been demonstrated.

## Acceptance criteria

- Premind's installed Codex skill is generated, preserves the existing behavioral/safety contract, and works in each relevant Codex plugin leaf.
- Every additional host enabled in this change gets one discoverable, host-correct entry point with working on-demand references; no cross-harness tool instructions leak into it.
- Shared guidance has one maintained source, generated files are committed, regeneration is deterministic, and CI catches drift and missing packaged files.
- Documentation points to the generation command and explains how to update host-specific capability guidance without editing generated Markdown by hand.
