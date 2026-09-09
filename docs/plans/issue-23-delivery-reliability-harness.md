# Delivery Reliability Test Harness

## Context

[Issue #23](https://github.com/jdtzmn/premind/issues/23) reports that pull request updates sometimes appear to be missed. The current test suite covers the relevant pieces independently:

- `src/daemon/github/graphql.test.ts` verifies that GitHub GraphQL responses map to pull request snapshots.
- `src/daemon/watchers/integration.test.ts` verifies snapshot diffing, persistence, batching, ETags, and independent session cursors.
- `src/plugin/__tests__/idle-delivery.test.ts` verifies OpenCode delivery with fabricated reminder batches.
- `src/extension/__tests__/index.test.ts` verifies Pi delivery with fabricated reminder batches.
- `src/test/live-validation.ts` verifies OpenCode SDK contract assumptions against a real OpenCode server.

What is missing is one test that connects these boundaries and proves that a single GitHub update is persisted and then delivered to every supported agent harness. Repeating the complete GitHub path separately for each adapter would be slow, duplicative, and harder to diagnose.

The currently implemented agent harnesses are OpenCode and Pi. Claude Code is described in `docs/claude-code-support.md`, but is not implemented and is therefore outside the initial test matrix.

## Goals

1. Prove that production GitHub response parsing and watcher logic persist the expected PR snapshot and normalized events.
2. Prove that persisted events survive a database close and reopen.
3. Prove that every supported agent adapter receives a reminder built from those persisted events.
4. Prove that delivery cursors remain independent across sessions and adapters.
5. Detect duplicate, dropped, or prematurely acknowledged updates with actionable diagnostics.
6. Keep the required CI test deterministic, credential-free, and independent of installed agent binaries.

## Non-goals

- Mutating a real pull request in required CI.
- Launching every real agent runtime in the deterministic test.
- Replacing focused unit tests for diff variants, lifecycle edge cases, or transport behavior.
- Adding Claude Code support as part of this issue.
- Treating optional live validation as the primary correctness signal.

## Proposed architecture

Use one shared ingestion scenario and fan its database-backed reminders out through thin adapter drivers:

```text
Scripted GitHub GraphQL responses
              |
              v
  GitHubHttpClient + GitHubClient
              |
              v
      PullRequestWatcher.tick()
              |
              v
      Temporary SQLite database
              |
       close and reopen
              |
              v
       Router-backed client
          /           \
         v             v
  OpenCode driver    Pi driver
```

The scripted HTTP boundary exercises the production GraphQL mapper rather than supplying an already-normalized `PullRequestSnapshot`. The router-backed client exercises daemon request behavior while avoiding Unix-socket, subprocess, and timing flakiness. Existing transport tests continue to cover IPC framing and retries.

Closing and reopening SQLite before adapter delivery is a deliberate boundary assertion: it proves that delivery comes from durable state rather than shared in-memory test objects.

## Phase 1: Shared fixtures and test seams

Add `src/test/harness/github-fixtures.ts` with declarative, fixed-time fixtures for:

1. A baseline PR snapshot.
2. An updated snapshot containing several representative changes:
   - a changed head SHA;
   - a new approval;
   - a new issue or review comment;
   - a failed check.
3. A repeated response or HTTP `304 Not Modified` response.

Each scenario should declare expected snapshot fields, normalized event kinds, event ordering, and ETags. Assertions should target stable event fields rather than snapshotting entire rendered reminder prose.

Use `GitHubHttpClient` with a queue-backed `fetch` implementation and construct the production `GitHubClient` around it. Record request URLs, request count, and `If-None-Match` headers for failure diagnostics.

Add `src/test/harness/router-daemon-client.ts`. It should implement the adapter-facing daemon-client methods by constructing validated IPC requests and passing them through a real `Router` backed by the temporary `StateStore`. It should also record a compact operation transcript containing session IDs, batch IDs, acknowledgement states, and errors.

Where practical, extract reusable snapshot or response builders from existing tests instead of maintaining competing fixture formats.

### Validation

- Fixture mapping tests prove that the baseline and update responses produce the expected `PullRequestSnapshot` values.
- Router client tests prove that malformed responses fail loudly and valid responses retain the production response shape.

## Phase 2: Shared ingestion scenario

Add `src/test/harness/pr-update-harness.ts`.

The runner should:

1. Create a uniquely named temporary directory and SQLite database.
2. Register one session per supported adapter.
3. Create independent manual subscriptions for those sessions to the same `owner/repo#number`.
4. Queue the baseline GraphQL response and run `PullRequestWatcher.tick()`.
5. Confirm the initial `pr.snapshot.initialized` batch for every subscription so all delivery cursors begin at the same known sequence.
6. Queue the update response and run one additional watcher tick.
7. Assert the persistence boundary before invoking any adapter:
   - `StateStore.getSnapshot()` reflects the new head SHA and changed collections;
   - undelivered rows contain the expected event kinds in stable order;
   - event IDs or dedupe keys are unique;
   - each subscription has a database-built batch covering the same source event sequence;
   - each batch identifies the correct repository, PR, subscription, and source.
8. Replay the same response, then return `304`, and assert that neither path inserts or delivers duplicate events.
9. Close the store and reopen the same database file.
10. Return a scenario context containing the reopened store, adapter sessions, expected batches, and diagnostic transcript.

Use fixed timestamps throughout. Avoid wall-clock sleeps in the shared runner.

### Validation

Add focused assertions for:

- latest persisted snapshot;
- normalized event sequence and deduplication;
- pending reminder state after database reopen;
- identical source event coverage across subscriptions;
- independent initial delivery cursors.

## Phase 3: Adapter contract drivers

Add an explicit driver registry under `src/test/harness/adapters/`:

- `opencode.ts`
- `pi.ts`
- `index.ts`

Each driver receives a router-backed daemon client and an existing session containing a pending database-built reminder. A driver must invoke the adapter's public lifecycle entry points rather than an extracted delivery helper.

### OpenCode driver

Instantiate `createPremindPlugin` with the router-backed daemon client and a fake OpenCode SDK. Drive:

1. `session.created` to establish adapter ownership.
2. A busy lifecycle event while the update is pending.
3. `session.idle` to permit delivery.

Capture `client.session.promptAsync()` and assert:

- exactly one prompt is sent;
- the target session ID is correct;
- the prompt text exactly matches the reminder read from SQLite;
- acknowledgement transitions are `built -> handed_off -> confirmed`;
- a second idle event produces no duplicate prompt.

Use Node mock timers or a delivery-completion promise instead of arbitrary sleeps. Keep separate focused tests for countdown timing and cancellation behavior.

### Pi driver

Instantiate `createPremindPiExtension` with the same router-backed client pattern. Drive:

1. `session_start`;
2. `agent_start` while the update is pending;
3. `agent_end` to permit delivery.

Assert exactly one `pi.sendMessage()` call with:

- `customType: "premind-reminder"`;
- content equal to the database reminder text;
- details equal to the database batch;
- `{ deliverAs: "followUp", triggerTurn: true }`.

Assert the same handoff transitions and that another idle boundary produces no duplicate message.

### Fan-out invariant

Deliver through the drivers sequentially. After the first adapter confirms its batch, assert that the second adapter still has its batch pending. This proves that one session's confirmation cannot consume another session's update.

The adapter registry is the review point for adding future supported harnesses. Any new production adapter must add a driver and participate in this shared scenario.

## Phase 4: Reliability suite

Add `src/test/pr-update-delivery.test.ts` with these scenarios:

1. **GitHub-to-database fan-out:** one parsed GitHub update creates the expected snapshot, events, and one batch per adapter session.
2. **Persistence boundary:** pending batches remain available after closing and reopening SQLite.
3. **Independent delivery cursors:** confirming OpenCode leaves Pi pending, and vice versa.
4. **Deduplication:** replayed snapshots and `304` responses create no additional events or host deliveries.
5. **Busy-to-idle behavior:** updates arriving while an adapter is busy remain queued until its supported idle boundary.
6. **Delivery failure and retry:** a host injection failure records `failed` without advancing the delivery cursor, and a later valid attempt can deliver the same source events once.

The primary fan-out scenario should share one ingestion execution across all drivers. Do not create a separate GitHub-to-SQLite run for every adapter.

Existing watcher, store, OpenCode, and Pi tests should remain in place for detailed edge cases. Refactor duplicated helpers only when doing so improves consistency without obscuring those focused tests.

## Failure diagnostics

When an assertion fails, emit a compact structured diagnostic containing:

- scenario phase;
- GitHub request history and ETags;
- stored snapshot repository, PR number, head SHA, and update timestamp;
- event sequence, kind, ID or dedupe key;
- subscription IDs and delivery cursors;
- pending batch IDs and handoff states;
- daemon-client operation transcript;
- captured host deliveries.

Always close the store and remove temporary directories. Support `PREMIND_KEEP_FAILED_HARNESS=1` locally to retain the database and print its path after a failure. Never retain it by default in CI.

## Phase 5: CI and live validation

Update `package.json` with a dedicated command:

```json
{
  "scripts": {
    "test:harness": "node --import tsx --test src/test/pr-update-delivery.test.ts"
  }
}
```

Include the new test in the complete `test` command as well.

Update `.github/workflows/ci.yml` with a required job named `Delivery reliability harness` after typecheck. It should require no network, credentials, or installed OpenCode/Pi binaries. Keeping it separate from the broad unit-test job makes the broken boundary immediately visible.

Keep `.github/workflows/live-validation.yml` optional and non-authoritative:

- retain the real OpenCode SDK contract smoke test;
- add a real Pi smoke test only when CI can safely launch and observe Pi;
- optionally add a read-only GitHub smoke against a controlled fixture PR;
- report skipped live checks clearly when credentials or runtimes are unavailable;
- never make deterministic correctness depend on external API timing or mutation of an arbitrary PR.

## Implementation sequence

1. Add shared GitHub fixtures and the router-backed daemon client; run their focused tests and commit.
2. Add the shared ingestion runner and persistence/reopen assertions; run the new core test and commit.
3. Add the OpenCode driver and fan-out assertion; run OpenCode plus harness tests and commit.
4. Add the Pi driver and complete adapter registry; run Pi plus harness tests and commit.
5. Add failure/retry and deduplication scenarios; run the full harness and commit.
6. Add package scripts and the required CI job; run `bun run check`, `bun run test:harness`, and `bun run test`, then commit.

## Acceptance criteria

Issue #23 is complete when a required deterministic CI test demonstrates that:

- a scripted GitHub GraphQL update passes through production parsing and watcher code;
- the expected snapshot and normalized events are persisted atomically;
- pending updates survive a database close and reopen;
- OpenCode and Pi each receive a reminder built from the same persisted source events;
- delivery confirmation advances only the confirming subscription's cursor;
- repeated snapshots and `304` responses do not cause duplicate delivery;
- updates received while busy are delivered at the next valid idle boundary;
- a failed host handoff does not silently lose the update;
- failures identify whether the break occurred during GitHub mapping, persistence, batching, handoff, or host injection.
