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
