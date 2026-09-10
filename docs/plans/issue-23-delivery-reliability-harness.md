# Delivery Reliability Test Harness

## Context

[Issue #23](https://github.com/jdtzmn/premind/issues/23) reports that pull request updates sometimes appear to be missed entirely. That symptom — no error, no reminder, nothing in the log — points at the paths where premind stops watching or stops delivering *silently*, not at the paths where parsing or diffing is wrong.

Existing coverage is already strong at the individual boundaries:

- `src/daemon/github/graphql.test.ts` covers GraphQL response mapping, ETag propagation, `304`, `not_found`, and check-state variants.
- `src/daemon/github/diff.test.ts` covers snapshot diffing and dedupe keys.
- `src/daemon/watchers/integration.test.ts` covers persistence, batching, ETag short-circuiting, and independent store-level cursors.
- `src/daemon/reminders/reminder-handoff-registry.test.ts` covers handoff transitions, refresh, and retry of `failed` batches.
- `src/plugin/__tests__/idle-delivery.test.ts` and `src/extension/__tests__/index.test.ts` cover adapter delivery against fabricated reminder batches.
- `src/test/live-validation.ts` covers OpenCode SDK contract assumptions against a real OpenCode server.

Two things are missing, and only the second one is about the happy path:

1. **No test covers the silent-stop mechanisms.** A stranded handoff, a reaped session, or a cursor reset to the high-water mark can each drop an update with no failure signal anywhere.
2. **No single test proves one persisted update reaches every supported agent harness.** Adapter tests use fabricated batches, so nothing links real persisted events to real adapter delivery.

The currently implemented harnesses are OpenCode (`src/plugin/index.ts`) and Pi (`src/extension/index.ts`). Claude Code is described in `docs/claude-code-support.md` but is not implemented, so it is outside the test matrix.

## Guarantees to establish

Each guarantee below names the mechanism that can violate it. Anything already covered by an existing test is deliberately excluded.

| Guarantee | Mechanism that can break it |
| --- | --- |
| A persisted update reaches every supported adapter | Adapter tests use fabricated batches; nothing links real events to real delivery |
| Pending updates survive a daemon restart | Delivery could depend on in-memory state rather than SQLite |
| A stranded `handed_off` batch is eventually delivered | **Was broken.** The `UNIQUE` constraint on `reminder_batches.subscription_id` made rebuilding throw, wedging every later poll for that PR — see [Outcome](#outcome-shipped) |
| A reaped-then-revived session loses nothing | `last_activity_at` only advances on session-state writes, so `listPrWatchTargets` silently drops the target |
| Reattaching preserves a cursor; only context change resets it | `ensureSessionControl` resets recreated or context-changed sessions to `MAX(seq)` and deletes their batches |
| A burst larger than the batch window fully drains | `listUndeliveredEventsForSubscription` caps at 20 events per batch |
| A watcher in `backing_off` or `rate_limited` resumes polling | `pollingTargets` only returns actors in `polling` |
| Confirming one session does not consume another's update | Shared PR stream with per-subscription cursors |

## Non-goals

- Re-testing GraphQL mapping, snapshot diffing, or dedupe-key generation.
- Mutating a real pull request in required CI.
- Launching real agent runtimes in the deterministic test.
- Adding Claude Code support.
- Covering IPC socket framing, reconnect, or daemon-spawn races (see [Known gaps](#known-gaps)).

## Approach

Work reliability-first, then extract shared infrastructure once two adapters need the same setup. The earlier draft of this plan built three abstractions before answering a single reliability question, which risks designing the harness around the happy path and then bending the interesting cases to fit it.

Test seams, in order of preference:

- **GitHub boundary:** reuse the snapshot-level fixture client pattern from `integration.test.ts`. Do *not* script raw `fetch` responses — `graphql.test.ts` already owns that boundary. Add exactly one wiring assertion that `GitHubClient.fetchPullRequestSnapshot` reaches the GraphQL mapper, so the harness cannot pass while production is wired to something else.
- **Daemon boundary:** drive a real `Router` over a real `StateStore` on a temporary database. This exercises request validation and daemon semantics without socket or subprocess flakiness.
- **Adapter boundary:** drive the public lifecycle entry points (`session.created` / `session.idle`, `session_start` / `agent_end`). Delivery bugs live in the gating logic — `ownedSessions`, `deliveryInFlight`, idle timers — not in the injection call.

Fixed timestamps throughout. Node mock timers or completion promises instead of sleeps.

### Assertion style

Assert that the text an adapter delivered is the text returned by the daemon call that adapter made, plus matching batch identity and event IDs. Do **not** assert byte equality against a batch read at a different moment: `refreshPendingReminder` intentionally re-renders reminder text against the current snapshot (supersede notes, cleared blockers), so a stricter assertion would be flaky and would train people to loosen it.

## Phase 1: Silent-stop scenarios

Add `src/test/delivery-reliability.test.ts`, built directly on `StateStore`, `PullRequestWatcher`, and the existing fixture-client helpers. No new abstraction yet.

1. **Stranded handoff.** Build a batch, ack `handed_off`, then simulate adapter death without `confirmed`. Assert the update is not silently lost, and that events arriving while stranded stay queued rather than being skipped.
2. **Reap and revive.** Advance past `PREMIND_SESSION_STALE_MS`, run `reapStaleSessions`, and assert the PR target drops out of `listPrWatchTargets`. Then revive via `updateSessionState` and assert that changes which landed during the gap are still delivered, since `diffSnapshot` compares against the last stored snapshot.
3. **Cursor preservation.** Assert `ensureSessionControl` preserves the cursor for a same-context reattach, and resets to the high-water mark (deleting batches) only when repo or branch changed. Both directions matter: the reset is intended behavior, and the preservation is what prevents silent history skipping.
4. **Burst drain.** Insert more than 20 undelivered events and assert successive batches drain every event with none skipped and no duplicates.
5. **Watcher state recovery.** Drive `recordPollFailure` into `backing_off` and a rate-limit into `rate_limited`, then assert both return to `polling` once their deadlines elapse.

### Outcome (shipped)

Four of the five guarantees already held. The stranded-handoff case did not, and the real behavior was worse than this plan anticipated.

`reminder_batches.subscription_id` is `UNIQUE`, so a batch left in `handed_off` is invisible to `getPendingReminderRecord` (which selects only `built`/`failed`) while still occupying the subscription's single batch slot. `buildReminderBatch` then attempted a plain `INSERT` and threw `UNIQUE constraint failed`. Because `PullRequestWatcher.tick` catches per-target errors, **every subsequent poll of that PR failed silently**: snapshots and events kept persisting, no reminder was ever rebuilt, and delivery only resumed when a daemon restart ran `recoverFromRestart`. That is precisely the "missed entirely" symptom in issue #23.

The fix ships alongside the tests:

- `buildReminderBatch` treats an in-flight handoff as already-pending and returns `null` instead of violating the constraint (`StateStore.hasInFlightHandoff`).
- `StateStore.expireStaleHandoffs` returns handoffs abandoned for longer than `PREMIND_REMINDER_HANDOFF_STALE_MS` (5 minutes) to `failed`, which the existing retry path promotes back to `built`.
- `ReminderHandoffRegistry.getPendingReminder` reclaims on the delivery path; the daemon sweep in `src/daemon/index.ts` reclaims even when no adapter polls again.

Both halves of the fix were verified by removing each one and confirming the regression test fails.

### Second defect: restart re-baselines the cursor past queued events

Investigating a report of "no updates after restarting a Pi session" against a real premind database surfaced a separate silent drop, and this one matches the original symptom more directly than the handoff wedge.

The Pi extension calls `activateWorktree` on every `session_start`, and that calls `deactivateAutomaticSubscriptions`. Re-attachment is owned by `BranchDiscoveryWatcher` (note `recordBranchAssociation` only re-baselines *legacy* sessions that have no worktree binding), and re-attachment ran `baselineAutomaticSubscription`, which set `last_delivered_event_seq = MAX(seq)`. So every session start moved the cursor to the current high-water mark, and any event queued but not yet delivered at that moment was skipped permanently:

```text
undelivered before restart: 1
after activateWorktree -> sub state: unsubscribed
after re-attach          -> cursor: 1   (jumped past the queued comment)
undelivered after re-attach: 0          <- comment lost
```

The fix keeps a re-attaching session's own cursor and baselines to high water only for a genuinely new subscription, so a first attach still does not dump stale history. It reads and writes a single session's cursor, which matters because several independent sessions routinely share one branch (for example many sessions on `main` in one checkout); anything that shared or adopted cursors across sessions would break that isolation and leak one session's subscriptions into another.

Verified the same way: reverting the cursor change makes the restart test fail.

### Migration coverage

Hardening `migrate()` (replacing an interpolated `ALTER TABLE` with static statements) exposed that the `ADD COLUMN` upgrade path had no test at all — a fresh database receives every column from `CREATE TABLE`, so the whole suite skipped it while real installs depend on it. `store.test.ts` now covers a legacy `pr_watchers` upgrade, including that a legacy watcher which still has subscribers is promoted to `warming_up` rather than being left `stopped` (a stopped watcher is never returned by `pollingTargets`, which would be yet another silent stop).

### Validation

`node --import tsx --test src/test/delivery-reliability.test.ts`, then commit.

## Phase 2: Cross-adapter fan-out

Only now extract shared setup, because two adapters need identical scaffolding. Add:

- `src/test/harness/pr-update-scenario.ts` — temporary database, sessions, subscriptions, watcher ticks, baseline confirmation, persistence assertions, diagnostic transcript.
- `src/test/harness/router-daemon-client.ts` — adapter-facing daemon methods over a real `Router`.
- `src/test/harness/adapters/{opencode,pi,index}.ts` — the driver registry.

The scenario runner should:

1. Create a temporary database and register one session plus an independent subscription per adapter against the same PR.
2. Tick the baseline snapshot and confirm the initial `pr.snapshot.initialized` batch for every subscription, so all cursors start at a known sequence.
3. Tick one update snapshot containing a changed head SHA, a new approval, a new comment, and a failed check.
4. Assert persistence before any adapter runs: stored snapshot reflects the update, expected event kinds exist in stable order, and each subscription has a batch over the same source events.
5. Assert once that replaying the same snapshot adds no rows. Dedupe depth stays in `diff.test.ts` and `integration.test.ts`.
6. Close and reopen the same database file, then hand the reopened store to the drivers.

Each driver invokes its adapter's real lifecycle entry points and asserts exactly one delivery, correct session targeting, `built → handed_off → confirmed` transitions, and no duplicate on a second idle boundary. The OpenCode driver captures `client.session.promptAsync`; the Pi driver captures `pi.sendMessage` with `customType: "premind-reminder"` and `{ deliverAs: "followUp", triggerTurn: true }`.

Drivers run sequentially so the suite can assert that the first adapter's confirmation leaves the second adapter's batch pending.

The registry is the review gate: a new production adapter must add a driver and participate here.

### Validation

Run the harness plus the existing OpenCode and Pi suites, then commit.

### Outcome (shipped)

Implemented as planned, with two deviations worth recording.

**Pi delivers at `turn_end`, not `agent_end`.** "Delay Pi reminders until turn end" (#26) moved the trigger and introduced `deliverPendingReminders`, which drains in a loop. The Pi driver drives the real `session_start` / `agent_start` / `agent_end` / `turn_end` sequence, so a future change to the delivery trigger surfaces as a failure here instead of silently narrowing coverage.

**The scenario uses manual subscriptions.** `activateWorktree` deactivates a session's *automatic* subscriptions on every session start, and the Pi driver calls it through the real router. Manual subscriptions survive that, which keeps the fan-out scenario about delivery rather than about re-attachment timing. Re-attachment is already pinned by the restart test in `delivery-reliability.test.ts`.

Assertions per adapter: exactly one delivery, correct target session, delivered text equal to the batch the daemon handed that adapter, `built -> handed_off -> confirmed` against real rows, cursor advanced to the batch high-water mark, and no duplicate on a second idle boundary. Between adapters the suite asserts that confirming one leaves every later adapter's update still pending, and at the end that all adapters converge on the same cursor.

The registry in `src/test/harness/adapters/index.ts` is asserted against an explicit list, so adding a production adapter without a driver fails the suite rather than quietly skipping coverage.

Both mutations were checked rather than assumed: removing Pi's `turn_end` trigger fails with "pi should deliver exactly one reminder", and returning fabricated text fails with "pi delivered text that differs from the batch the daemon handed it".

## Phase 3: Diagnostics, scripts, and CI

Emit a compact structured diagnostic on failure: scenario phase, watcher request history, stored snapshot identity and head SHA, event sequence and kinds, subscription cursors, batch IDs and handoff states, daemon operation transcript, and captured host deliveries. The goal is that a failure names its boundary — watcher scheduling, persistence, batching, handoff, or host injection — without a debugger.

Always close stores and remove temporary directories. Support `PREMIND_KEEP_FAILED_HARNESS=1` locally to retain the database and print its path; never retain by default in CI.

Add a `test:harness` script covering both new test files, include them in the full `test` script, and add a required `Delivery reliability harness` CI job after typecheck in `.github/workflows/ci.yml`. The job needs no network, credentials, or agent binaries. Keeping it separate from the broad unit job makes a reliability regression immediately legible.

Keep `.github/workflows/live-validation.yml` optional and non-authoritative: retain the OpenCode SDK smoke test, add a Pi smoke test only when CI can safely launch Pi, optionally add a read-only GitHub smoke against a controlled fixture PR, and report skipped checks clearly.

### Validation

`bun run check`, `bun run test:harness`, and `bun run test`, then commit.

## Phase 4: Conservation under lifecycle churn

Phases 1-3 are scenario tests: each pins one *known* mechanism, written after the bug was understood. They prove a fix holds, but they cannot find the next bug of the same family, because you have to already know which disruption to write. Both defects found while working this issue shared one shape:

> an event was persisted -> a lifecycle disruption happened -> the event was never delivered, and nothing reported it

`src/test/delivery-conservation.test.ts` asserts invariants over a *space* of disruptions instead of one story:

- **P1 delivery conservation.** Every event persisted while a subscription is active is eventually covered by exactly one confirmed batch. The ledger records the `(previousCursor, maxEventSeq]` range each confirmed batch covers, so gaps and overlaps are exact. Counting rendered events would not work, because `renderReminder` condenses them for display.
- **P2 watch liveness.** Once things settle, an active subscription on a live session is in the poll set and its watcher is not `stopped`. No state that claims to be watched but is not.
- **P3 no swallowed internal failure.** `PullRequestWatcher.tick` catches per-target errors and logs a warning, so a bug inside a tick is invisible except as a recorded poll failure. The only failure the suite tolerates is the one `watcherBackoff` injects deliberately.

Coverage is every single disruption, every ordered pair, and a handful of adversarial longer runs (77 sequences, about 1.5s).

### The boundary that makes this test meaningful

Only *transparent* disruptions belong in the set - ones that must never lose an event. Intentional history-skipping is deliberately excluded, because folding it in would make the suite fail constantly until someone loosened it into uselessness:

- a first automatic attach baselines at high water, so stale history is not dumped
- a repo/branch context change resets the cursor and clears batches
- a brand-new session id is a new consumer, not a restart, and must not inherit another session's cursor - several independent sessions routinely share one branch

### Validated against the known defects

The point of a discovery test is that it finds bugs without being told where to look, so each fix was reverted in turn:

| Reverted fix | Caught as |
| --- | --- |
| in-flight handoff guard | `adapterCrashThenQuickPoll: the watcher swallowed an internal failure - UNIQUE constraint failed` |
| stale-handoff reclamation | `adapterCrashMidHandoff: events persisted but never delivered` |
| cursor preservation on re-attach | `reactivateWorktree: events persisted but never delivered` |

The first revert initially **escaped**. Every scenario advanced ten minutes before draining, so a stranded handoff was always already reclaimed and the rebuild collision never happened - while production polls every 20s-5m, comfortably inside the five minute window. That gap produced both the `adapterCrashThenQuickPoll` disruption and P3. Worth remembering: a property suite that passes on a known bug is measuring its own blind spot, not the code.

## Known gaps

Stated explicitly so they are chosen rather than overlooked:

- **IPC transport is not covered.** The router-backed client bypasses the Unix socket, so framing, reconnect, retry, and daemon-spawn races remain covered only by `src/plugin/daemon-client.test.ts`. Given the reported symptom is silent loss, this deserves a named follow-up rather than silence.
- **Adaptive scheduling delay is not asserted end to end.** `adaptive-schedule.test.ts` covers tier math; the harness does not assert wall-clock freshness for quiet PRs, where a 5-minute idle interval can read as a missed update.
- **Real agent runtimes are exercised only by optional live validation.**

## Acceptance criteria

Issue #23 is complete when required deterministic CI demonstrates that:

- one persisted update reaches both OpenCode and Pi from the same source events;
- pending updates survive a database close and reopen;
- a stranded `handed_off` batch has a documented, tested recovery path;
- a reaped-then-revived session loses no changes from the gap;
- cursors are preserved on reattach and reset only on context change;
- a burst larger than the batch window drains completely, without duplicates;
- watchers in `backing_off` and `rate_limited` resume polling;
- confirming one session never consumes another session's update;
- and a failure identifies which boundary broke.
