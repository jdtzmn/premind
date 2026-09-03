# premind Pi Package Plan

## 1. Purpose

Create a first-class Pi package from the core of the existing `premind` OpenCode plugin. The package should keep the durable GitHub/PR watcher daemon, but replace the OpenCode-specific integration layer with a Pi-native extension that can revive an idle Pi chat when new pull request context arrives.

The most exciting Pi-native improvement is to use the same delivery pattern as `pi-background-tasks`: inject a custom session message with `deliverAs: "followUp"` and `triggerTurn: true`, so important PR updates can wake the agent after it becomes idle.

## 2. Product Vision

`premind` for Pi should feel like the agent naturally notices new PR context while it works:

1. A Pi session starts on a branch.
2. `premind` attaches the session to the branch's PR, or keeps looking until a PR exists.
3. The daemon watches GitHub and computes incremental PR changes.
4. If the agent is busy, changes are queued.
5. When the agent becomes idle, `premind` injects a structured reminder into the same session.
6. Pi wakes the agent to continue with the fresh context.

This should be less like a synthetic user prompt and more like native operational context added to the session.

## 3. Why Pi Makes This Better

### 3.1 Native chat revival

`pi-background-tasks` completes long-running tasks by sending a custom message:

```ts
pi.sendMessage(message, {
  deliverAs: "followUp",
  triggerTurn: task.triggerOnCompletion,
})
```

`premind` can use the same idea for PR reminders:

```ts
pi.sendMessage(
  {
    customType: "premind-reminder",
    content: renderedReminderXml,
    display: true,
    details: batchMetadata,
  },
  {
    deliverAs: "followUp",
    triggerTurn: true,
  },
)
```

That means when a pending PR reminder is ready and the agent is idle, Pi can immediately start a new turn with that context.

### 3.2 Structured custom messages

The OpenCode plugin injects reminders with `client.session.promptAsync()`. In Pi, reminders can be custom session messages with:

- `customType: "premind-reminder"`
- machine-readable reminder content
- structured `details` metadata
- custom TUI rendering
- explicit delivery mode and turn-trigger behavior

This makes reminders easier to render, debug, and distinguish from normal user prompts.

### 3.3 Native commands and tools

Pi packages should expose namespaced user commands:

- `/premind:status`
- `/premind:pause`
- `/premind:resume`
- `/premind:flush`
- `/premind:debug`

Model-callable tools can remain schema-safe identifiers:

- `premind_status`
- `premind_pause`
- `premind_resume`
- `premind_flush`

### 3.4 Better UI affordances

Pi extensions can use:

- `ctx.ui.setStatus()` for footer status
- `ctx.ui.setWidget()` for richer session state
- `ctx.ui.notify()` for explicit user feedback
- `pi.registerMessageRenderer()` for custom reminder rendering
- `pi.registerCommand()` for namespaced commands
- `pi.registerTool()` for model-callable control surfaces

This lets `premind` become a native Pi experience instead of just a port.

## 4. Architecture Overview

Keep the existing two-component architecture:

1. A thin Pi extension integration layer.
2. A local machine daemon that owns GitHub polling, diffing, queueing, and persistence.

### 4.1 Pi extension responsibilities

The Pi extension should:

- start or connect to the daemon lazily
- register the current Pi session with repo/branch metadata
- track agent busy/idle lifecycle
- request pending reminders when the session becomes idle
- inject reminders with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
- expose `/premind:*` commands
- expose `premind_*` tools
- render `premind-reminder` custom messages
- clean up heartbeats/resources on `session_shutdown`

The extension should stay thin. It should not do GitHub polling, heavy diffing, or durable queue management.

### 4.2 Daemon responsibilities

The existing daemon should continue to own:

- one local process per user/machine
- client leases and heartbeats
- GitHub polling and backoff
- branch discovery watchers
- canonical PR watchers keyed by repo/PR
- normalized event generation
- per-session cursors and pending queues
- reminder batch rendering
- detail file generation
- persistence and restart recovery
- IPC protocol validation

### 4.3 Shared package code

The current `src/shared` schemas and constants should be reused by both the extension and daemon. Existing daemon tests should remain valuable and mostly unchanged.

## 5. Proposed Package Structure

```text
premind/
  PI_PLAN.md
  PLAN.md
  package.json
  tsconfig.json
  extensions/
    premind.ts                  # Pi package extension entrypoint
  src/
    extension/
      index.ts                  # Pi extension factory
      daemon-bridge.ts          # daemon lifecycle + reminder delivery
      session-state.ts          # current session attachment/busy state
      commands.ts               # /premind:* commands
      tools.ts                  # premind_* tools
      renderers.ts              # premind-reminder renderer
      git-context.ts            # Pi-facing repo/branch detection, if split out
    plugin/
      index.ts                  # existing OpenCode plugin, optional legacy path
      ...
    daemon/
      index.ts
      github/
      ipc/
      logging/
      persistence/
      reminders/
      watchers/
    shared/
      constants.ts
      ipc.ts
      schema.ts
  skills/
    premind/
      SKILL.md                  # optional guidance for handling reminders
```

The package can support both OpenCode and Pi during transition, but the Pi package manifest should load only `extensions/premind.ts`.

## 6. Package Manifest Plan

Add Pi package metadata to `package.json`:

```json
{
  "name": "premind",
  "keywords": [
    "pi-package",
    "pi-extension",
    "github",
    "pull-request",
    "review",
    "notifications"
  ],
  "pi": {
    "extensions": ["./extensions/premind.ts"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

Runtime dependencies that are not bundled by Pi should remain in `dependencies`, for example:

- `zod`
- `tsx`, if the daemon launcher still relies on TypeScript execution

Pi-provided packages should be peer dependencies, not bundled dependencies.

## 7. Pi Extension Lifecycle

### 7.1 Extension factory

Do not start the daemon in the extension factory. Pi extension docs warn that factories may run in invocations that never start a session.

The factory should only register:

- event handlers
- commands
- tools
- message renderers
- maybe shortcuts later

### 7.2 `session_start`

On `session_start`:

1. detect cwd/repo/branch
2. lazily ensure the daemon is running
3. create/register daemon client lease
4. start heartbeat interval
5. register the Pi session with the daemon
6. update footer/status UI
7. optionally check pending reminders after a small idle-safe delay

### 7.3 `agent_start` / busy transition

On `agent_start` or an equivalent busy lifecycle signal:

1. mark the session busy in the daemon
2. cancel local delivery timers
3. update UI status

### 7.4 `agent_end` / idle transition

On `agent_end`:

1. mark the session idle in the daemon
2. ask for pending reminders
3. if no batch exists, update status and stop
4. if a batch exists, deliver it with `pi.sendMessage(... followUp + triggerTurn)`
5. ack handoff/confirmation according to delivery state rules

### 7.5 `session_shutdown`

On `session_shutdown`:

1. clear timers
2. stop heartbeat
3. unregister or mark the session inactive
4. release daemon client lease
5. update/clear UI state

## 8. Reminder Delivery Design

### 8.1 Message shape

Use a custom message type:

```ts
type PremindReminderMessage = {
  customType: "premind-reminder"
  content: string
  display: true
  details: {
    batchId: string
    sessionId: string
    repo: string
    prNumber: number | null
    events: Array<{
      eventId: string
      kind: string
      priority: "high" | "medium" | "low"
      summary: string
      detailFilePath?: string
    }>
  }
}
```

### 8.2 Content format

The content should remain machine-legible. Suggested format:

```xml
<premind-reminder batch-id="...">
  <repo>owner/repo</repo>
  <pr-number>123</pr-number>
  <summary>New pull request context was detected since the last premind reminder.</summary>
  <changes>
    <change priority="high" kind="review_comment.created">
      <summary>alice left a review comment on src/foo.ts:42.</summary>
      <detail-file>/Users/.../premind/review-comment-123.json</detail-file>
    </change>
  </changes>
  <instruction>
    Incorporate only the new information above into your reasoning, then continue the user's current task.
  </instruction>
</premind-reminder>
```

### 8.3 Delivery call

Use the `pi-background-tasks` pattern:

```ts
pi.sendMessage(
  {
    customType: "premind-reminder",
    content: batch.reminderText,
    display: true,
    details: batch,
  },
  {
    deliverAs: "followUp",
    triggerTurn: true,
  },
)
```

`deliverAs: "followUp"` waits until the current agent work is complete. `triggerTurn: true` revives the chat if the agent is idle.

### 8.4 Recursion guard

Every injected reminder should include a stable marker such as:

```text
premind://reminder/<batchId>
```

The extension should ignore its own reminder-originated messages when determining whether to queue or confirm additional delivery.

## 9. Delivery State Machine

The current daemon already models reminder batch acknowledgements. For Pi, refine the state machine around custom message delivery:

```text
pending -> built -> handed_off -> confirmed
                         \
                          -> failed
```

Suggested v1 semantics:

1. daemon builds a batch and returns it from `getPendingReminder`
2. extension immediately acks `handed_off`
3. extension calls `pi.sendMessage(...)`
4. if send succeeds, extension acks `confirmed`
5. if send throws, extension acks `failed`

Possible v2 strengthening:

- only ack `confirmed` after observing the custom message in `ctx.sessionManager`
- or after observing a subsequent `agent_start` caused by the reminder

## 10. Commands

Use Pi-style namespaced commands.

### 10.1 `/premind:status`

Show daemon status, active sessions, watchers, PR attachments, pending reminders, and recent errors.

### 10.2 `/premind:pause`

Pause reminder delivery for the current Pi session. Events continue accumulating.

### 10.3 `/premind:resume`

Resume reminder delivery for the current Pi session. Optionally attempt immediate flush if the session is idle.

### 10.4 `/premind:flush`

Manually ask the daemon for pending reminders and deliver one immediately if available and safe.

### 10.5 `/premind:debug`

Show local diagnostic state:

- daemon socket path
- daemon protocol version
- client id
- session id
- repo/branch detection result
- last delivery attempt
- runtime state path

## 11. Tools

Expose model-callable tools with underscore names.

### 11.1 `premind_status`

Return daemon and session status to the model.

### 11.2 `premind_pause`

Pause reminders for the current session.

### 11.3 `premind_resume`

Resume reminders for the current session.

### 11.4 `premind_flush`

Attempt reminder delivery. This is useful when the agent explicitly wants to check for queued PR context.

Tool descriptions should clearly state that reminder delivery may trigger a follow-up turn through Pi's session message mechanism.

## 12. Custom Rendering

Register a renderer:

```ts
pi.registerMessageRenderer("premind-reminder", renderPremindReminder)
```

The TUI rendering should be concise and readable:

```text
🔔 premind PR update: owner/repo#123

High priority
- alice commented on src/foo.ts:42
- lint failed on abc123

Details
- /Users/.../premind/review-comment-123.json
- /Users/.../premind/check-lint-abc123.json
```

Rendering should tolerate missing or malformed `details` and fall back to plain message content.

## 13. UI Status

Use a small footer status key, for example `premind`:

- no active session: no status
- attached and quiet: `premind quiet`
- pending while busy: `premind pending 3`
- paused: `premind paused`
- daemon error: `premind error`

Optionally use `ctx.ui.setWidget()` for richer debug/status output, but avoid noisy persistent UI by default.

## 14. Daemon Launcher Adjustments

The current daemon launcher resolves the daemon entry relative to the OpenCode plugin file:

```ts
const DAEMON_ENTRY = path.resolve(THIS_DIR, "..", "daemon", "index.ts")
```

For the Pi package, the launcher should be robust from `src/extension` and package install locations. Options:

1. keep a shared launcher that receives the daemon entry path from the extension
2. move launcher into `src/shared` or `src/extension`
3. compile/package a stable daemon entry path

The launcher should continue to:

- prefer Node + `tsx`
- avoid native SQLite dependencies if using `node:sqlite`
- capture bounded startup diagnostics
- wait for the socket before reporting success
- unref the daemon process

## 15. Configuration

Keep v1 config small. Possible sources:

- package defaults
- project-local trusted config, later
- user-level config, later

Suggested config shape:

```ts
type PremindPiConfig = {
  enabled: boolean
  autoAttach: boolean
  triggerTurnOnReminder: boolean
  idleDeliveryThresholdMs: number
  showFooterStatus: boolean
  debugLogging: boolean
}
```

Default `triggerTurnOnReminder` should be `true`, because chat revival is the core Pi-native value.

## 16. Optional Skill

Add a package skill at `skills/premind/SKILL.md` only if it adds durable value. It could instruct the agent how to respond when a `premind-reminder` appears:

- read the reminder as fresh PR context
- inspect detail files only when needed
- avoid re-processing already addressed changes
- report briefly to the user when taking action because of a reminder

This may be unnecessary if the custom message content is already clear enough.

## 17. Testing Strategy

### 17.1 Package tests

- `package.json` includes `pi-package` keyword
- `pi.extensions` points at an existing file
- `extensions/premind.ts` exports a default extension factory
- package does not rely on OpenCode dependencies for Pi runtime
- `npm pack --dry-run` includes extension, daemon, shared schemas, and docs

### 17.2 Extension unit tests

Mock `ExtensionAPI` and verify:

- commands are registered as `premind:status`, `premind:pause`, etc.
- tools are registered as `premind_status`, `premind_pause`, etc.
- renderer is registered for `premind-reminder`
- session lifecycle starts/stops daemon bridge at the right time
- errors produce safe notifications/status, not crashes

### 17.3 Delivery tests

Mock the daemon client and `pi.sendMessage`:

- pending reminder sends custom message
- options include `deliverAs: "followUp"`
- options include `triggerTurn: true`
- no reminder sends nothing
- paused session sends nothing
- send failure acks `failed`
- send success acks `confirmed`
- duplicate in-flight batch is not sent twice

### 17.4 Daemon compatibility tests

Existing daemon tests should continue to cover:

- branch discovery
- PR watcher diffing
- event dedupe
- reminder batching
- detail files
- restart recovery
- IPC validation

### 17.5 End-to-end smoke test

Run Pi with the package extension locally:

```bash
pi --no-extensions -e ./extensions/premind.ts --offline --no-tools --no-session -p "/premind:status"
```

Then test interactively in a sandbox repo:

1. open Pi on a PR branch
2. verify `/premind:status` shows attachment
3. create a PR comment/check event
4. wait for daemon detection
5. finish current agent turn
6. verify a `premind-reminder` message appears
7. verify Pi starts a follow-up turn automatically

## 18. Rollout Phases

### Phase 1: Pi package scaffold

- add `extensions/premind.ts`
- add `pi` manifest to `package.json`
- add package tests
- keep OpenCode plugin unchanged

Validation:

```bash
npm run check
npm pack --dry-run
```

### Phase 2: Minimal Pi extension shell

- register `/premind:status`
- register `premind_status`
- connect to daemon lazily
- render daemon status

Validation:

```bash
pi -e ./extensions/premind.ts --offline --no-tools --no-session -p "/premind:status"
```

### Phase 3: Session registration

- handle `session_start`
- detect git repo/branch
- register session with daemon
- heartbeat/release lifecycle
- footer status

Validation:

- mocked unit test for registration
- manual status command shows current session/repo/branch

### Phase 4: Manual reminder flush

- implement `/premind:flush`
- request pending reminder from daemon
- send `premind-reminder` custom message
- ack success/failure

Validation:

- unit test asserts `pi.sendMessage` options
- manual fake-daemon test sends one reminder

### Phase 5: Automatic idle revival

- track busy/idle lifecycle
- on idle, fetch pending batch
- use `deliverAs: "followUp"` and `triggerTurn: true`
- prevent duplicate delivery

Validation:

- mocked `agent_end` test
- sandbox Pi session revives automatically after PR event

### Phase 6: UI polish

- custom renderer
- footer status states
- clearer debug output
- better errors for auth/rate limit/socket failures

Validation:

- renderer snapshot tests
- manual TUI inspection

### Phase 7: Hardening and migration

- restart recovery validation
- duplicate-delivery tests
- package install from local path
- optional npm publish prep
- document OpenCode legacy vs Pi package paths

Validation:

- multi-session dogfood on same PR
- daemon restart during pending reminder
- branch-without-PR upgrade flow

## 19. Open Questions

1. Should `triggerTurnOnReminder` be configurable per session, globally, or both?
2. Should high-priority events revive immediately when idle, while low-priority events wait for batching?
3. Is v1 confirmation after `pi.sendMessage()` sufficient, or should confirmation wait for session-manager observation?
4. Should the OpenCode plugin remain in the same package, or should Pi become the primary package and OpenCode move to a compatibility path?
5. Should reminders be custom messages only, or should some cases use `pi.sendUserMessage()` for stronger user-message semantics?

## 20. Recommended First Implementation Slice

Build the smallest Pi-native loop first:

1. Pi package manifest
2. `extensions/premind.ts` entrypoint
3. `/premind:status`
4. daemon bridge startup
5. session registration
6. `/premind:flush`
7. custom `premind-reminder` delivery via:

```ts
pi.sendMessage(message, {
  deliverAs: "followUp",
  triggerTurn: true,
})
```

This proves the core advantage of making `premind` a Pi package: PR context can revive an idle Pi chat as a native session message.

## 21. Acceptance Criteria for v1

`premind` is ready as a Pi package when:

- `pi install` can load the package extension
- commands use Pi namespace style: `/premind:*`
- tools use model-safe names: `premind_*`
- sessions auto-attach on PR branches
- branches without PRs can attach later when a PR is opened
- multiple sessions on one PR share one daemon watcher
- reminders only deliver when safe/idle
- reminders are custom `premind-reminder` messages
- reminder delivery uses `deliverAs: "followUp"`
- reminder delivery can use `triggerTurn: true` to revive idle chats
- reminders are not duplicated after daemon or Pi restarts
- users can pause, resume, inspect, and manually flush reminders
- detail files remain available for large comments/checks
- logs and debug commands are sufficient to diagnose field issues

## 22. Final Recommendation

Build `premind` as a Pi-native package centered on custom reminder messages and automatic idle revival. Preserve the existing daemon as the durable GitHub intelligence layer, but make the session integration a proper Pi extension.

The defining feature should be: when the PR changes underneath an active coding session, Pi receives a structured `premind-reminder` and wakes the agent to continue with the new context.

## 23. Issue #13: Worktree and Subscription Controls

The Pi extension must use the shared worktree-aware subscription architecture in `PLAN.md` §35. Pi's startup `ctx.cwd` is only the initial worktree; it cannot reliably infer a later shell-local `cd` into a linked or nested worktree.

Expose these Pi commands and model tools in place of pause/resume controls:

- `/premind:activate-worktree <path>` and `premind_activate_worktree({ path })` select the session's active Git worktree and begin automatic branch-to-PR resolution, even when no PR exists yet.
- `/premind:subscribe <pr> [owner/repo]` and `premind_subscribe({ prNumber, repo? })` add a manual subscription. The default repository is the active worktree repository; external accessible GitHub repositories are supported.
- `/premind:unsubscribe <pr> [owner/repo]` and `premind_unsubscribe({ prNumber, repo? })` remove the current session's matching subscription, including an automatic subscription.

The extension should guide the model to call `premind_activate_worktree` whenever it begins work in another Git worktree. It must not attempt to infer durable worktree changes from an individual shell command's `cd`. Runtime reconciliation at session start, agent start/end, and the status-poll cadence is an optimization, not a replacement for explicit activation.

Pi must keep manual subscriptions when activating a new worktree. When the new branch has no PR, the daemon continues branch discovery and later creates the automatic subscription. Status UI and rendered reminders must include fully qualified PR identities for cross-repository subscriptions.
