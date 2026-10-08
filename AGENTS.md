<!-- entire-graph:begin -->
This repo has the entire-graph code graph installed. Before exploring code with
grep/find/whole-file reads, read .entire/graph-agent.md — resolution-first guidance
for using graph retrieval, focused source inspection, and verification.
@.entire/graph-agent.md
<!-- entire-graph:end -->

## Planning Documents

- Put one-off implementation and feature plans under `docs/plans/`; do not create generic root-level files such as `PLAN.md` or `PI_PLAN.md`.
- Give each plan a descriptive, durable filename tied to its scope, such as `worktree-subscriptions.md` or `pi-package.md`. Add a date or issue number when it improves disambiguation.
- Keep root-level documentation evergreen. Link to a plan from `README.md` only when it remains useful after that specific change ships.
- When moving or renaming a plan, update package manifests, tests, and cross-references in the same change.

## Supported Harnesses

Premind supports four coding-agent harnesses: **Pi, Claude Code, OpenCode, and Codex**.

- Every user-facing change (commands, tools, delivery or lifecycle behavior, agent-facing wording) must cover all four harnesses in the same change.
- Never decide on your own that a change is "adapter-specific". A harness may be skipped only with explicit user approval, recorded as an `unsupported` or `deferred` exception in `src/shared/command-capabilities.ts`. A `deferred` exception must name a tracking issue or PR.
- Every plan under `docs/plans/` must include a per-harness coverage table.
- The guardrails are tests, not memory: `src/shared/command-capabilities.test.ts`, `src/test/command-capability-contract.test.ts`, and the cross-adapter scenarios under `src/test/` iterate every harness. Extend them for new capabilities instead of adding adapter-local checks only.
- For each harness, check the lifecycle, not only the surface: whether reload or restart recreates the session, whether every delivery path honors session state, and whether reconnecting re-registers the session as active.
