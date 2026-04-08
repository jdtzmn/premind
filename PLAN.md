# premind Implementation Plan

## 1. Purpose

`premind` is an OpenCode companion that keeps an active session up to date with pull request changes without requiring the user to manually re-run `/pr-context` or tab between terminals. It should detect important PR activity, compute the incremental delta since the last reminder delivered to a given session, and inject a new message beginning with `<system-reminder>` so the assistant resumes with the latest relevant context. The reminder should arrive through normal OpenCode session flow so existing idle/notification plugins continue to work unchanged.

This plan is intentionally comprehensive. It is meant to drive implementation, testing, rollout, and future maintenance.

## 2. Goals

- Automatically attach OpenCode primary sessions to the PR associated with the current branch.
- Continue checking for a PR if none exists yet when the session starts.
- Detect incremental PR changes and queue them for delivery when the session next becomes idle.
- Deliver reminders in a format the model will reliably interpret as fresh operational context.
- Reuse the user's current OpenCode notification behavior by injecting reminders as normal messages.
- Avoid redundant GitHub polling and duplicate work when multiple sessions track the same PR.
- Persist enough state to survive daemon or plugin restarts without losing queued events or re-delivering stale ones.
- Make behavior observable, debuggable, and safe under real-world failures.

## 3. Non-Goals

- Replacing `/pr-context` for full manual audits.
- Becoming a full GitHub bot or webhook receiver service.
- Performing automatic code changes, review replies, or merge actions.
- Watching every PR in a repository by default.
- Supporting non-GitHub for the first version.

## 4. Product Principles

### 4.1 Minimal surprise

The system should feel like OpenCode naturally remembered new PR context. It should not spam the user, hijack prompts while the model is mid-response, or create noisy duplicate reminders across tabs.

### 4.2 Incremental, not repetitive

Each reminder should only include what changed since that session last received a reminder for the same PR. Repetition should be minimized.

### 4.3 Durable and recoverable

Restarts, auth hiccups, temporary GitHub inconsistency, or session churn should not cause silent data loss.

### 4.4 Prefer boring infrastructure

Use local, deterministic primitives: one daemon, embedded persistence, typed IPC, explicit queues, structured logs, and a testable diff engine.

### 4.5 Human-prioritized context

Not every change matters equally. Review requests, change requests, failing checks, conflicts, and new comments should be elevated above low-signal metadata churn.

## 5. User Experience

## 5.1 Happy path

1. User opens OpenCode on a branch with an open PR.
2. `premind` plugin auto-attaches the primary session to that branch and repo.
3. A local daemon either finds or creates a canonical watcher for that PR.
4. While the user works, GitHub activity occurs: review comments, issue comments, check updates, approval, request changes, merge conflict changes, new commits, etc.
5. If the session is busy, `premind` stores these as queued incremental events.
6. When OpenCode emits `session.idle`, the plugin asks the daemon whether pending reminders exist.
7. The daemon returns a coalesced reminder payload containing only undelivered changes.
8. The plugin injects a new message into the same session using the OpenCode SDK, beginning with a `<system-reminder>` block.
9. OpenCode processes the message like a normal follow-up prompt.
10. Existing idle/ready notifications fire naturally when the model completes.

## 5.2 Branch without a PR yet

1. Session starts on a branch with no open PR.
2. The plugin still registers the session and branch.
3. The daemon creates a low-frequency branch association watcher.
4. Once a PR is opened for that branch, the daemon upgrades the session subscription to the canonical PR watcher.
5. Future reminders work normally.

## 5.3 Multiple OpenCode sessions on the same PR

- All sessions share one upstream PR watcher.
- Each session tracks its own delivery cursor and queue state.
- One session receiving a reminder must not mark the events delivered for another session.

## 5.4 User control

The first version should include per-session controls, likely through plugin-exposed commands or config:

- pause reminders for this session
- resume reminders for this session
- disable auto-attach for this repo or globally
- inspect current watcher/subscription state
- flush pending reminder now if idle

## 6. High-Level Architecture

The system should be split into two main runtime components.

### 6.1 OpenCode plugin

Responsibilities:

- auto-register eligible sessions with the daemon
- observe OpenCode events such as session lifecycle and idle/busy changes
- provide session metadata to the daemon
- ask the daemon for pending reminder payloads when a session becomes idle
- inject reminder messages into sessions using the OpenCode SDK
- expose a small control surface for pause/resume/status operations

The plugin should stay thin. It should not perform GitHub polling, heavy diffing, or long-lived queue management.

### 6.2 Local machine daemon

Responsibilities:

- single process per machine/user
- own all GitHub polling and stateful diffing
- maintain canonical PR watchers keyed by `{owner, repo, prNumber}`
- maintain branch discovery watchers keyed by `{owner, repo, branch}`
- persist snapshots, normalized events, session subscriptions, cursors, and queue state
- coalesce pending events into reminder payloads
- generate temp/detail files for comments, reviews, checks, and snapshots
- expose local IPC for plugin registration, state updates, and reminder retrieval

### 6.3 Why one daemon is preferred

One daemon process with many watcher objects is preferred over one process per session because it:

- deduplicates GitHub requests across tabs and sessions
- centralizes rate limiting and exponential backoff
- simplifies durable state and cache cleanup
- avoids N x M polling explosions on active repos
- makes debugging much easier

### 6.4 Daemon lifecycle and ownership

The daemon should be lazily started by the first interested plugin instance and should exit when it is no longer needed.

Recommended lifecycle model:

- plugin connects to the Unix socket
- if the daemon is absent, the plugin starts it
- each plugin instance acquires a lightweight lease or heartbeat-backed client registration
- the daemon tracks active clients and active session subscriptions
- when the last client lease expires and no active subscriptions remain, the daemon begins a short graceful shutdown timer
- if a new client appears during that timer, shutdown is cancelled

This gives the desired "start when first MCP/plugin consumer appears, stop when the last one goes away" behavior without making shutdown too eager during brief restarts or reconnects.

## 7. Recommended Tech Stack

### 7.1 Language and runtime

- TypeScript across plugin, daemon, schemas, fixtures, and tests
- Node-compatible runtime APIs so the plugin runs safely inside OpenCode environments
- Bun can be used for local development and test running if convenient, but runtime assumptions should remain Node-friendly unless repo constraints prove otherwise

### 7.2 Libraries and infrastructure

- `zod` for config, IPC contracts, event normalization schemas, and validation
- `better-sqlite3` or an equivalent synchronous embedded SQLite client for durable local state
- a small GitHub API layer using official REST and GraphQL endpoints through `fetch` or `@octokit/*`
- Unix domain socket IPC on macOS/Linux for local-only daemon communication
- file-based cache directory for human-readable detail artifacts
- structured logging via JSON lines or a small logging library

### 7.2.1 Concrete preferences

Unless implementation constraints prove otherwise, the default choices should be:

- `typescript`
- `tsx` or an equivalent zero-build dev runner during development
- `better-sqlite3` for local persistence
- `@octokit/rest` plus a very small GraphQL helper only where REST is insufficient
- Node's built-in `net` module for Unix socket IPC
- `vitest` for unit and integration tests
- `msw` or a small local fake server for GitHub API simulation in integration tests

### 7.3 Why SQLite over plain JSON

SQLite is strongly preferred because `premind` needs:

- durable queues
- last-delivered cursor tracking per session
- event dedupe indexes
- watcher lease bookkeeping
- restart-safe compaction and cleanup jobs

This is awkward and error-prone with ad hoc JSON files.

## 8. OpenCode Integration Plan

## 8.1 Relevant OpenCode capabilities

Based on research:

- Plugins can subscribe to session and generic events.
- Plugins receive an SDK client.
- Plugins can send messages with `client.session.prompt()` or `client.session.promptAsync()`.
- OpenCode itself already uses `<system-reminder>` blocks in prompt construction, so this format is consistent with native behavior.

### 8.2 Injection method

Preferred method:

- plugin calls `client.session.promptAsync({ path: { id: sessionID }, body: { parts: [...], ... } })`

Reasoning:

- asynchronous injection avoids blocking the plugin event handler
- the server will process the reminder through normal session execution flow
- the existing notification plugin should observe the session transition and completion naturally

### 8.3 Recursion prevention

The plugin must prevent self-triggered loops. It should:

- tag injected reminder messages with a recognizable marker in text or metadata
- ignore reminder-originated `chat.message` or follow-up events when evaluating whether to re-register or enqueue additional work
- maintain a short-lived local guard for in-flight injected message IDs if needed

### 8.4 Primary session bias

The plugin should auto-attach only primary sessions by default. Subagent sessions should not independently register as top-level watched sessions unless there is a future, deliberate reason to do so.

## 9. GitHub Data Model

The daemon should build its watcher state from a combination of GitHub REST and, where useful, GraphQL endpoints.

### 9.0 Endpoint strategy

Start REST-first. Reach for GraphQL only when it clearly reduces polling cost or exposes required thread state that is awkward to derive from REST.

Initial preferred surfaces:

- PR core: `GET /repos/{owner}/{repo}/pulls/{pull_number}`
- reviews: `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
- issue comments: `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`
- review comments: `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`
- check runs: `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
- branch -> PR association: `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`

If review-thread state is too expensive or lossy through REST, add a narrowly scoped GraphQL query for thread metadata rather than broadening the entire fetch stack.

### 9.1 Core PR snapshot fields

- repository owner and name
- PR number
- title
- body
- state
- draft status
- URL
- author
- base branch
- head branch
- head SHA
- created and updated timestamps
- mergeability / merge state status
- review decision
- labels
- assignees
- requested reviewers
- auto-merge state if available

### 9.2 Review and comment surfaces

- reviews submitted to the PR
- issue comments on the PR conversation
- review comments on code lines
- review thread state where accessible, including resolved/unresolved/outdated

### 9.3 CI and checks

- check runs
- status contexts if needed
- workflow/job metadata that helps explain failures

### 9.4 Repo-branch association data

- current branch name from plugin registration
- repository name with owner
- open PR resolution for branch head

## 10. Event Taxonomy

The daemon should normalize raw GitHub state changes into explicit internal events. Suggested event kinds:

### 10.1 Comment events

- `issue_comment.created`
- `issue_comment.edited`
- `issue_comment.deleted`
- `review_comment.created`
- `review_comment.edited`
- `review_comment.deleted`

### 10.2 Review events

- `review.submitted`
- `review.approved`
- `review.changes_requested`
- `review.commented`
- `review.dismissed`

### 10.3 Review thread events

- `review_thread.resolved`
- `review_thread.unresolved`
- `review_thread.outdated`
- `review_thread.reactivated`

### 10.4 Check events

- `check.created`
- `check.queued`
- `check.in_progress`
- `check.succeeded`
- `check.failed`
- `check.cancelled`
- `check.timed_out`
- `check.neutral`
- `check.skipped`

### 10.5 Mergeability and branch events

- `merge_conflict.detected`
- `merge_conflict.cleared`
- `pr.synchronized`
- `pr.force_pushed`
- `pr.base_changed`

### 10.6 Review readiness and lifecycle events

- `pr.opened`
- `pr.reopened`
- `pr.closed`
- `pr.merged`
- `pr.converted_to_draft`
- `pr.ready_for_review`

### 10.7 Reviewer and metadata events

- `reviewer.requested`
- `reviewer.removed`
- `label.added`
- `label.removed`
- `assignee.changed`
- `auto_merge.enabled`
- `auto_merge.disabled`

## 11. Event Priority Model

Not all events should be treated equally. The reminder payload builder should assign priorities.

### 11.1 High priority

- `review.changes_requested`
- `review.approved`
- new issue comments
- new review comments
- `merge_conflict.detected`
- `check.failed`
- `pr.ready_for_review`
- `reviewer.requested`

### 11.2 Medium priority

- `check.succeeded`
- `review.commented`
- `review.dismissed`
- `review_thread.unresolved`
- `pr.synchronized`
- `pr.force_pushed`

### 11.3 Low priority

- label changes
- assignee changes
- check creation without status transition
- low-signal edits to previous comments unless the text changed materially

The priority model should drive ordering and truncation, not event loss. Even low-priority events should still be available in detail files or a collapsed summary if undelivered.

## 12. Normalized Event Shape

Each normalized event should have a durable shape, approximately:

- `eventId`
- `kind`
- `repo`
- `prNumber`
- `branch`
- `headSha`
- `sourceId` (GitHub review/comment/check id if present)
- `occurredAt`
- `observedAt`
- `priority`
- `dedupeKey`
- `summary`
- `shortText`
- `detailFilePath` optional
- `payload` object with full normalized detail

The `dedupeKey` is critical. It should encode the event kind and the concrete change identity, not just the GitHub object ID.

Examples:

- comment created: `review_comment.created:12345`
- check transition: `check.failed:lint:shaabc123`
- merge conflict change: `merge_conflict.detected:shaabc123`

## 13. Watcher Model

### 13.1 Branch discovery watcher

Keyed by `{repo, branch}`.

Responsibilities:

- periodically ask GitHub if an open PR exists for this branch
- keep polling at a low frequency if none exists yet
- when a PR is found, emit an internal association event and attach subscribed sessions to the canonical PR watcher

### 13.2 Canonical PR watcher

Keyed by `{repo, prNumber}`.

Responsibilities:

- fetch current snapshot
- diff against the last persisted snapshot
- emit normalized events
- update session queues for subscribed sessions
- maintain polling/backoff policy

### 13.3 Subscription model

Each session subscription record should include:

- `sessionId`
- `repo`
- `branch`
- `prNumber` nullable until resolved
- `status` such as active, paused, closed
- `lastDeliveredCursor`
- `lastKnownBusyState`
- `lastReminderAttemptAt`
- `createdAt`
- `updatedAt`

## 14. Polling Strategy

## 14.1 Discovery polling

If no PR exists yet for a branch:

- use a low-frequency interval, for example 60 to 180 seconds with jitter
- reset the interval when a new branch association is registered or the branch changes
- stop the watcher when no active subscriptions remain

### 14.2 Active PR polling

Suggested approach:

- base interval around 15 to 30 seconds when the PR is active or recently changed
- increase interval gradually during quiet periods
- use jitter to avoid synchronized calls across many watchers
- reduce or temporarily pause high-cost endpoints when the PR is inactive for long periods

### 14.3 Backoff

Back off on:

- secondary GitHub rate limits
- auth failures
- transient network errors
- repeated mergeability `UNKNOWN` or incomplete snapshots

The daemon should preserve watcher and queue state during backoff. It should not drop events merely because GitHub is temporarily unavailable.

## 15. Diff Engine

The diff engine is the core correctness layer.

### 15.1 Snapshot-based diffing

Each watcher cycle should:

1. fetch a complete enough snapshot
2. compare it to the previously persisted snapshot
3. derive normalized events
4. persist the new snapshot and emitted events atomically

### 15.2 Comparison categories

- scalar field changes: draft, review decision, head SHA, mergeability
- set changes: labels, reviewers, assignees
- append-only items with edits: comments, reviews, checks
- state machines: checks, review threads, merge conflict transitions

### 15.3 Special handling

- force-push detection should compare head SHA changes and possibly commit ancestry if available
- comment edits should compare body hashes, not just timestamps
- check transitions should only emit when status meaningfully changes
- merge conflict events should be debounced until mergeability is stable enough to trust

## 16. Queueing and Delivery Semantics

### 16.1 Per-session queues

Even if events are produced once per PR watcher, delivery must be tracked per session.

Each session should effectively have:

- a cursor over emitted normalized events for the attached PR
- a view of which events have already been delivered
- a pending batch for events observed while the session was busy or paused

### 16.2 Busy/idle handling

- while session is busy, append new events to pending state
- on transition to idle, attempt to build the next reminder batch
- if no undelivered events exist, do nothing
- if the plugin successfully injects the reminder, advance the delivered cursor only after the daemon has durable confirmation of handoff

### 16.2.1 Delivery state machine

To avoid ambiguity and duplicate reminders, each batch should move through explicit states:

- `pending`: events exist but no batch has been assembled yet
- `built`: a batch has been rendered and reserved for a specific session
- `handed_off`: the plugin received the payload and attempted injection
- `confirmed`: OpenCode emitted enough evidence that the injected message entered normal flow
- `failed`: handoff or confirmation failed and the batch should be retried or rebuilt

The recommended v1 confirmation rule is:

- plugin requests batch
- daemon marks it `built`
- plugin injects via `promptAsync`
- plugin acknowledges `handed_off`
- plugin observes a confirming signal such as a matching `chat.message`, `session.status` transition, or other reliable message/session event
- daemon advances the cursor only after `confirmed`

If confirmation never arrives within a bounded timeout, the batch should be marked retryable rather than silently dropped.

### 16.3 Burst coalescing

The system should coalesce bursts of events into a single reminder batch if they arrive during one busy window. This reduces model churn and notification spam.

### 16.4 Paused sessions

- continue accumulating undelivered events or keep them queryable by cursor
- do not inject reminders until resumed
- optionally surface count of pending events in status command output

## 17. Reminder Payload Design

## 17.1 Output goals

Reminder payloads must be:

- machine-legible to the model
- concise enough to avoid wasting context
- rich enough to direct the next action
- stable and easy to test

### 17.2 Required structure

Each injected message should begin with a `<system-reminder>` block. It should include:

- repo and PR identifier
- statement that the content is incremental since the last delivered reminder
- event sections ordered by priority and recency
- references to generated detail files where relevant
- explicit instruction to address the new information and continue the existing task

### 17.3 Example skeleton

```text
<system-reminder>
New pull request context was detected since the last reminder for owner/repo#123.

Changes:
1. review_comment.created
- reviewer: alice
- file: src/foo.ts:42
- summary: Consider extracting this helper.
- detail file: /Users/.../premind/review-comment-123.json

2. check.failed
- check: lint
- sha: abc123
- summary: ESLint failed on 3 files.
- detail file: /Users/.../premind/check-lint-abc123.json

3. merge_conflict.detected
- summary: GitHub now reports merge conflicts with the base branch.

Please incorporate only the new information above into your reasoning, then continue with the user's current task.
</system-reminder>
```

### 17.4 Message origin tagging

The injected reminder should include a hidden or explicit marker such as `premind://reminder/<id>` so the plugin can identify its own injected prompts and avoid recursion.

### 17.5 Batching and truncation rules

The renderer should follow clear rules so reminder shape is predictable:

- one reminder batch per idle transition by default
- sort sections by priority first, then recency
- collapse repeated low-priority events into grouped summaries where possible
- show full inline summaries for high-priority events
- attach file references for long comments, large failing checks, or threads with replies
- cap inline batch size with a deterministic truncation policy and a final note that additional detail exists in files

Suggested v1 policy:

- include all high-priority events inline unless they are individually too large
- include medium-priority events inline up to a configurable count
- summarize low-priority overflow as a compact tail section

## 18. Detail File Strategy

## 18.1 Why files are needed

Some events are too large for inline reminder content:

- long issue comments
- multi-comment review threads
- dense failing check summaries
- full review history snapshots

### 18.2 Storage location

Use a cache directory such as:

- macOS: `~/Library/Caches/premind/`
- Linux: `$XDG_CACHE_HOME/premind/` or `~/.cache/premind/`

### 18.3 File categories

- full PR snapshot file
- per-comment detail files
- per-review detail files
- per-check detail files
- per-batch reminder rendering for debugging

### 18.4 Retention policy

- TTL-based cleanup, for example 7 to 30 days
- cleanup on daemon startup and periodically during idle time
- never rely on file path existence as the sole source of truth; the database should retain canonical references

## 19. Persistence Model

The daemon should persist at least the following tables or equivalent records:

### 19.1 `watchers`

- watcher id
- type: branch or pr
- repo
- branch nullable
- pr number nullable
- status
- poll schedule fields
- last success / failure timestamps

### 19.2 `snapshots`

- watcher id
- snapshot version
- head SHA
- snapshot blob or file pointer
- fetched at

### 19.3 `events`

- internal event id
- watcher id
- kind
- dedupe key unique
- normalized payload
- priority
- occurred at
- created at

### 19.4 `subscriptions`

- session id unique per active attachment
- repo
- branch
- pr number nullable
- status
- pause flag
- last delivered event id or cursor
- last idle timestamp
- metadata for debugging

### 19.5 `delivery_attempts`

- session id
- batch id
- event range
- status
- attempted at
- confirmed at
- failure info

### 19.6 `client_leases`

- client id
- process metadata if useful for debugging
- first seen at
- last heartbeat at
- expiry at

This table supports graceful daemon shutdown and stale-client cleanup.

## 20. IPC Design

Use a versioned Unix socket protocol with typed request and response envelopes.

### 20.1 Core operations

- register client lease
- heartbeat client lease
- release client lease
- register session
- update session state
- unregister session
- resolve current attachment status
- fetch pending reminder batch
- acknowledge reminder handoff
- pause subscription
- resume subscription
- inspect daemon health and watcher stats

### 20.2 Request examples

- `registerClient`
- `heartbeatClient`
- `releaseClient`
- `registerSession`
- `setSessionBusy`
- `setSessionIdle`
- `getPendingReminder`
- `ackReminderInjected`
- `pauseSession`
- `resumeSession`
- `debugStatus`

### 20.3 Reliability concerns

- daemon may not be running when the plugin starts
- plugin may disconnect while daemon continues running
- multiple plugin instances may attempt startup simultaneously

Mitigations:

- daemon lock file or single-instance socket bind
- retry with bounded backoff in plugin
- heartbeat or lightweight liveness checks

### 20.4 Protocol versioning

The IPC protocol should be explicitly versioned from day one.

- every request should include a protocol version
- the daemon should reject unsupported major versions clearly
- minor additions should remain backward compatible when possible
- debug/status output should expose both daemon version and protocol version

## 21. Plugin Behavior in Detail

### 21.1 On initialization

- determine project/repo context
- connect to daemon, starting it if needed
- subscribe to relevant OpenCode events

### 21.2 On session creation or first primary activity

- identify primary session
- discover current branch and repo
- register the session with the daemon

### 21.3 On session busy transitions

- inform daemon that reminders must be queued, not injected

### 21.4 On `session.idle`

- ask daemon for pending reminder batch
- if none exists, exit quietly
- if a batch exists, inject it into the session via `promptAsync`
- acknowledge the handoff to the daemon

### 21.5 On session deletion or plugin teardown

- unregister session or mark inactive
- allow daemon to garbage collect unused watchers

## 22. Daemon Behavior in Detail

### 22.1 Startup

- acquire single-instance lock
- open database
- run migrations
- restore active watchers and subscriptions
- run cache cleanup
- begin polling scheduler

### 22.1.1 Shutdown policy

The daemon should not run forever if nothing is attached.

- periodically evaluate active client leases and active subscriptions
- expire dead clients automatically if heartbeats stop
- if there are no active leases and no active subscriptions, begin graceful shutdown
- flush logs, close DB handles, and remove the socket on exit

### 22.2 Watch cycle

- fetch snapshot
- diff
- persist new snapshot and normalized events atomically
- mark affected subscriptions as pending

### 22.3 Reminder build

- gather undelivered events after `lastDeliveredCursor`
- apply burst coalescing
- rank by priority
- render inline summary and detail files
- persist a delivery batch
- return payload to plugin

### 22.4 Acknowledge and cursor advance

- once plugin confirms handoff, mark batch delivered
- advance session cursor
- keep audit record for debugging

## 23. Failure Modes and Mitigations

### 23.1 Daemon crash

- state is durable in SQLite
- plugin reconnects on next event or idle transition
- pending undelivered events remain intact

### 23.2 Plugin crash or OpenCode restart

- session may need re-registration
- daemon should eventually expire stale subscriptions using heartbeat or inactivity timeout

### 23.3 GitHub auth failure

- mark watchers degraded
- back off polling
- surface local warning in status/debug output
- keep existing queue state

### 23.4 GitHub rate limit or abuse detection

- apply exponential backoff with jitter
- reduce expensive endpoints first
- log clearly which watcher is affected

### 23.5 Mergeability uncertainty

- GitHub sometimes reports unknown mergeability transiently
- do not emit conflict events on unknown alone
- require stable or repeated evidence before changing conflict state

### 23.6 Duplicate delivery

- prevented by unique event dedupe keys, persisted delivery batches, and cursor-based confirmation semantics

## 24. Security and Privacy Considerations

- local-only IPC by Unix socket with filesystem permissions
- no remote service required in v1
- cache and DB should live in user-owned directories
- logs should avoid dumping full comment bodies unless debug mode is enabled
- detail files may contain sensitive review content; store locally, document retention, and support cleanup

## 24.1 Configuration Surface

The v1 config surface should stay intentionally small, but it should exist.

Recommended config keys:

- `enabled`: global on/off switch
- `autoAttach`: default true
- `discoveryPollIntervalMs`
- `activePollIntervalMs`
- `maxActivePollIntervalMs`
- `cacheTtlDays`
- `inlineEventLimit`
- `inlineCommentCharLimit`
- `debugLogging`

Per-session controls should override global defaults where appropriate.

## 25. Observability and Debugging

The first implementation should include strong observability.

### 25.1 Structured logs

Every significant daemon action should log:

- watcher id
- repo and PR
- poll result
- diff counts by event kind
- queue changes
- reminder batch creation
- delivery ack/failure

### 25.2 Debug commands

Add plugin or CLI commands to inspect:

- current session attachment
- current PR and branch mapping
- pending event count
- last poll status
- recent errors
- last delivered batch id

### 25.3 Optional debug artifacts

- latest raw snapshot per watcher
- latest rendered reminder batch
- normalized event history for last N events

## 26. Testing Strategy

Testing should be treated as a first-class deliverable, not cleanup work.

### 26.1 Unit tests

Target:

- branch -> PR association logic
- snapshot diffing
- check transition recognition
- comment create/edit/delete detection
- priority ordering
- reminder rendering
- dedupe key generation
- cleanup logic

### 26.2 Contract tests with fixtures

Maintain a fixtures corpus of real or redacted GitHub payloads for:

- issue comments
- review comments
- reviews
- review thread changes
- check runs across state transitions
- mergeability changes
- draft / ready-for-review transitions
- reviewer requests
- force-push scenarios

These tests ensure normalization is stable as implementation evolves.

### 26.3 Persistence tests

Cover:

- daemon restart restoring watchers and subscriptions
- event dedupe after restart
- undelivered batch surviving crash before ack
- cache cleanup not breaking DB references unexpectedly

### 26.4 IPC tests

Cover:

- plugin connect/disconnect
- duplicate daemon startup race
- malformed message rejection through schema validation
- pause/resume semantics

### 26.5 Integration tests

Use a fake GitHub API server or recorded fixture responder to simulate:

- polling cycles
- event bursts while session busy
- idle flush
- multiple sessions sharing one watcher
- auth and rate-limit failures

### 26.6 Plugin integration tests

Validate:

- plugin auto-registers only intended sessions
- idle event triggers batch fetch
- plugin injects reminders using OpenCode SDK correctly
- recursion guards hold

### 26.7 End-to-end smoke tests

Run against a sandbox GitHub repo:

- create PR
- add comments
- submit reviews
- push commits
- fail and pass checks
- create and clear merge conflicts if possible
- verify reminders arrive in a real OpenCode session in the expected order

### 26.8 Regression matrix

Every release candidate should pass a compact but representative regression matrix:

- single session, existing PR, new review comment while idle
- single session, existing PR, new review comment while busy
- two sessions on same PR receiving separate reminders
- branch with no PR, PR opened later, watcher upgrades correctly
- daemon restart before confirmation, no duplicate delivery after recovery
- failing check followed by passing rerun on same head SHA
- force-push causing new head SHA and potential outdated comments

## 27. Real-World Validation Plan

Testing alone is not enough. The feature should be dogfooded in realistic workflows.

### 27.1 Sandbox dogfooding

- two or more OpenCode tabs on one PR
- one long-running session while comments arrive mid-response
- branch without a PR initially, then PR created later

### 27.2 Stress scenarios

- many check runs arriving together
- force-push during busy session
- daemon restart during queued state
- network loss and recovery

### 27.3 Success criteria

- no duplicate reminders for the same event in the same session
- reminders only fire on idle
- queued events survive restarts
- resource usage remains modest with multiple sessions on one PR
- user can understand why a reminder appeared and inspect its source details

## 28. Performance Expectations

The system should be efficient enough for daily use on a developer workstation.

### 28.1 Resource expectations

- one daemon process
- low idle CPU usage
- bounded memory per watcher
- DB and cache growth managed by cleanup policies

### 28.2 Scaling assumptions for v1

- dozens of active sessions across repos on one machine should still be acceptable
- many sessions on one PR should remain cheap due to watcher deduplication
- many PRs across repos should trigger adaptive polling and cleanup

## 29. Rollout Plan

### 29.1 Phase 1: skeleton

- repo scaffold
- daemon lifecycle and IPC skeleton
- plugin connection and session registration
- SQLite persistence and migrations

### 29.2 Phase 2: branch association

- branch discovery watcher
- PR resolution and attachment upgrade
- basic debug status surfaces

### 29.3 Phase 3: core PR polling and diffing

- snapshot fetcher
- normalized event model
- persistence of snapshots and events

### 29.4 Phase 4: reminder delivery

- per-session queue/cursor logic
- idle-triggered fetch
- `promptAsync` injection with `<system-reminder>` rendering
- recursion guard

### 29.5 Phase 5: detail files and prioritization

- comment/review/check detail files
- priority ordering
- burst coalescing and truncation rules

### 29.6 Phase 6: hardening

- restart recovery
- rate limit handling
- logging and debug tools
- pause/resume controls
- retention cleanup

### 29.7 Phase 7: dogfooding and polish

- sandbox repo e2e tests
- real workflow dogfooding
- tune polling intervals and reminder formatting

### 29.8 Validation gate after each phase

Each phase should end with the smallest relevant proof that the new surface actually works.

- Phase 1: daemon boots once, plugin connects, schema validation passes
- Phase 2: branch with no PR upgrades to PR attachment in a controlled test
- Phase 3: snapshot diff tests pass against fixture corpus
- Phase 4: injected reminder reaches a real OpenCode session and triggers normal completion notifications
- Phase 5: large comment/check payloads render into detail files with stable references
- Phase 6: restart and failure-mode tests pass without duplicate delivery
- Phase 7: dogfood sessions remain stable over multiple days of real use

## 30. Proposed Repository Layout

One possible layout:

```text
premind/
  PLAN.md
  package.json
  tsconfig.json
  src/
    daemon/
      index.ts
      server.ts
      scheduler.ts
      watchers/
        branch-watcher.ts
        pr-watcher.ts
      github/
        client.ts
        snapshots.ts
        diff.ts
        normalize.ts
      persistence/
        db.ts
        migrations/
        repositories/
      reminders/
        render.ts
        batching.ts
        detail-files.ts
      ipc/
        protocol.ts
        server.ts
        client.ts
      logging/
        logger.ts
      config/
        schema.ts
    plugin/
      index.ts
      session-hooks.ts
      daemon-client.ts
      commands.ts
      guards.ts
    shared/
      schema.ts
      types.ts
      priorities.ts
      time.ts
    test/
      fixtures/
      unit/
      integration/
      e2e/
```

## 31. Open Questions to Validate During Implementation

These are not blockers for starting, but they should be resolved deliberately.

### 31.1 GitHub API selection

- which endpoints are cheapest and most stable for review thread state?
- is GraphQL worth the complexity for fewer round trips?

### 31.2 Reminder batching policy

- should some high-priority events bypass batching if the session becomes idle quickly?
- should approvals and change requests always be their own top section?

### 31.3 Delivery acknowledgment semantics

- is daemon ack after plugin `promptAsync` sufficient?
- or should the plugin wait for a message-created/session-busy transition confirmation before final cursor advance?

### 31.4 Session identity assumptions

- do any OpenCode edge cases cause primary session identification to be ambiguous?

## 32. Recommended First Slice

The first implementation slice should prove the end-to-end loop with the least surface area.

### 32.1 Scope

- plugin auto-registers a primary session
- daemon resolves branch to PR
- daemon polls core PR snapshot plus issue/review comments and checks
- daemon emits a minimal set of normalized events
- plugin requests pending reminder on idle
- plugin injects one `<system-reminder>` message

### 32.2 Event scope for first slice

- `issue_comment.created`
- `review_comment.created`
- `review.approved`
- `review.changes_requested`
- `check.failed`
- `check.succeeded`
- `merge_conflict.detected`
- `merge_conflict.cleared`

### 32.3 Why this slice

It covers the highest-value user cases and validates the most important architectural assumptions without needing every metadata edge case on day one.

## 33. Acceptance Criteria for v1

`premind` is ready for broader use when all of the following are true:

- primary sessions auto-attach on PR branches
- sessions on branches without PRs eventually attach when a PR is opened
- multiple sessions on one PR share one canonical watcher
- busy sessions do not receive injected reminders until idle
- reminders contain only undelivered incremental changes for that session
- comment, review, check, and merge conflict changes can be inspected through detail files when needed
- daemon restarts do not lose undelivered events
- duplicate reminders for identical events are prevented in tested restart and burst scenarios
- logs and status tooling are sufficient to debug field issues

## 34. Final Recommendation

Build `premind` as a typed TypeScript system composed of a thin OpenCode plugin and a single machine-local daemon with durable SQLite-backed watcher state. Start with the highest-value PR event types, prove the end-to-end injection path through normal OpenCode session behavior, and invest early in diff-engine tests plus restart-safe delivery semantics. The product will succeed if it feels invisible when things are calm and immediately useful when PR context changes underneath an active coding session.
