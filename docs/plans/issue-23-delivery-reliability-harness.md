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
| A stranded `handed_off` batch is eventually delivered | `getPendingReminderRecord` selects only `built`/`failed`; only `recoverFromRestart` un-strands it |
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

1. **Stranded handoff.** Build a batch, ack `handed_off`, then simulate adapter death without `confirmed`. Assert the update is not silently lost: it either becomes deliverable again without a full daemon restart, or the test documents the restart requirement as the current guarantee and links a follow-up. Also assert that when new events later arrive, the stranded events reappear in the fresh batch rather than being skipped.
2. **Reap and revive.** Advance past `PREMIND_SESSION_STALE_MS`, run `reapStaleSessions`, and assert the PR target drops out of `listPrWatchTargets`. Then revive via `updateSessionState` and assert that changes which landed during the gap are still delivered, since `diffSnapshot` compares against the last stored snapshot.
3. **Cursor preservation.** Assert `ensureSessionControl` preserves the cursor for a same-context reattach, and resets to the high-water mark (deleting batches) only when repo or branch changed. Both directions matter: the reset is intended behavior, and the preservation is what prevents silent history skipping.
4. **Burst drain.** Insert more than 20 undelivered events and assert successive batches drain every event with none skipped and no duplicates.
5. **Watcher state recovery.** Drive `recordPollFailure` into `backing_off` and a rate-limit into `rate_limited`, then assert both return to `polling` once their deadlines elapse.

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

## Phase 3: Diagnostics, scripts, and CI

Emit a compact structured diagnostic on failure: scenario phase, watcher request history, stored snapshot identity and head SHA, event sequence and kinds, subscription cursors, batch IDs and handoff states, daemon operation transcript, and captured host deliveries. The goal is that a failure names its boundary — watcher scheduling, persistence, batching, handoff, or host injection — without a debugger.

Always close stores and remove temporary directories. Support `PREMIND_KEEP_FAILED_HARNESS=1` locally to retain the database and print its path; never retain by default in CI.

Add a `test:harness` script covering both new test files, include them in the full `test` script, and add a required `Delivery reliability harness` CI job after typecheck in `.github/workflows/ci.yml`. The job needs no network, credentials, or agent binaries. Keeping it separate from the broad unit job makes a reliability regression immediately legible.

Keep `.github/workflows/live-validation.yml` optional and non-authoritative: retain the OpenCode SDK smoke test, add a Pi smoke test only when CI can safely launch Pi, optionally add a read-only GitHub smoke against a controlled fixture PR, and report skipped checks clearly.

### Validation

`bun run check`, `bun run test:harness`, and `bun run test`, then commit.

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
