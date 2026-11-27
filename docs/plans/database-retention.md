# Database retention

The daemon database grows without bound on a busy machine. A snapshot of a
real state directory (November 2026) held:

| Table / data | Rows | Why it stays |
| --- | --- | --- |
| `daemon_instance_leases` | 37,440 | One row per daemon start; nothing deletes expired rows. |
| `reminder_handoff_settlements` / `reminder_handoff_execution_claims` | 5,665 each | Never deleted. |
| Non-closed sessions | 377 (124 detached, 253 dormant) | Detached and dormant sessions are never closed, so the 24-hour closed-session prune never reaches them. |
| `pr_events` | 19,000 (41 MB) | 14,506 belong to terminal PRs, but 169 active subscriptions held by dead sessions block the 30-day PR stream prune. |

Each step below lands as its own PR with a red/green test.

## 1. Prune expired daemon instance leases

Delete `daemon_instance_leases` rows whose `expires_at` has passed, at startup
and in the five-minute staleness sweep. Every reader already ignores expired
rows, and generations come from `storage_metadata.daemon_generation`, so a
deleted row's generation is never reissued.

## 2. Prune settled reminder handoffs

Delete handoff settlements, and their execution claims, seven days after
settlement. Before implementing, confirm that every reader only needs them to
make a retried acknowledgement idempotent. If any reader needs them longer,
stop and revisit.

## 3. Close long-idle sessions

Close sessions that are not active, paused, or closed and have had no activity
for 60 days. The existing 24-hour prune then deletes them and cascades to their
subscriptions, which releases their PRs to the 30-day stream prune.

The 60-day window comes from Pi transcript timestamps: across 678 sessions from
the previous 75 days, 140 resumes followed a gap longer than a day, 2 a gap
longer than 30 days, and none a gap longer than 45 days (the longest was 43.1
days). Sixty days leaves margin above that observed maximum.

Check before implementing: Claude sessions suspended by `suspendClaudeSession`,
and what a host sees when it resumes a session that was closed. Cover the
resume path with a test.

## Out of scope

- Ending subscriptions when their PR merges. That changes what an agent sees
  after a merge and needs its own decision.
- `VACUUM`. Freed pages are reused, so the file stops growing without the
  exclusive lock a vacuum takes.
- Closing sessions whose transcript file is gone. Only Pi session ids are file
  paths, so the rule would cover one harness; the idle window covers those
  sessions anyway.

## Per-harness coverage

All three steps run inside the shared daemon, so no harness needs its own
surface.

| Change | Pi | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- | --- |
| Prune expired daemon instance leases | ✅ | ✅ | ✅ | ✅ |
| Prune settled reminder handoffs | ✅ | ✅ | ✅ | ✅ |
| Close long-idle sessions | ✅ | ✅ | ✅ | ✅ |
