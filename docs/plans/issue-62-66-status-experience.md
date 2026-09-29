# Plan: Current-Session-First Status and Open PR List

## Goal

Make premind's normal status answer the question a returning developer actually has:

> What branch am I on, is this session watching it, what PRs do I have open, and is premind healthy?

This plan resolves [#62](https://github.com/jdtzmn/premind/issues/62) and [#66](https://github.com/jdtzmn/premind/issues/66) as one product surface. It deliberately distinguishes a **normal, current-session view** from an **explicit diagnostic view of every daemon session**.

## Product Decisions

1. **`premind:status` is current-session first.** It must not dump every daemon session in the ordinary case.
2. **The default view contains both session state and the user's open PRs in the current repository.** “Watching” and “my open PRs” are separate concepts and must remain visibly separate:
   - watching is the set of subscriptions that can deliver reminders to this session;
   - open PRs is a live, author-filtered GitHub query and is useful for recovering a stack even when every PR is not subscribed.
3. **`premind:debug-status` is the debugger escape hatch.** It preserves the existing aggregate/session inventory, including internal maintenance fields, and is the only normal command that enumerates other sessions.
4. **Status remains useful when GitHub is unavailable.** Daemon/session health is rendered from local state; the open-PR section degrades independently with a short, actionable explanation.
5. **No special clickable UI in the first implementation.** Render stable `owner/repo#number` labels and URLs in plain text/Markdown where the host already supports it. Host-native affordances (for example, a Pi modal with selectable links) are a later enhancement and do not shape the first data contract.
6. **No hidden cross-repository search by default.** The default PR list is the authenticated viewer's open PRs in the current session's repository. A future dedicated PR-list command can add an explicit all-repositories scope after its rate-limit and privacy behavior are designed.

## Default Experience

`/premind:status` should read as a compact overview, not a log.

```text
premind: running · polling enabled · 1 watcher
current: jdtzmn/premind @ jacob/better-status · active/idle · 0 pending
branch PR: jdtzmn/premind#67 — Improve status output
watching: 2 PRs
  - jdtzmn/premind#67 — Improve status output
  - jdtzmn/premind#65 — Recover Pi sessions
my open PRs in jdtzmn/premind: 3
  - #67 Improve status output — https://github.com/jdtzmn/premind/pull/67
  - #65 Recover Pi sessions — https://github.com/jdtzmn/premind/pull/65
  - #61 …
2 other sessions hidden; use /premind:debug-status for daemon diagnostics.
```

Rules for the overview:

- The first line reports daemon reachability/running state, global polling state, and watcher count. A disabled daemon must say that no GitHub polling is occurring and point to the enable command.
- The current row always shows repository, branch, session state/busy state, and pending reminder count.
- `branch PR` appears only when a PR is associated with the active worktree/branch.
- `watching` contains active subscriptions for the current session, including manually subscribed PRs; it explicitly says `none` when there are no active subscriptions.
- `my open PRs` is ordered by most recently updated and has a bounded initial display (for example, 10 items) with a count. It is not a statement that every listed PR is being watched.
- If the current session cannot be resolved, show the daemon synopsis and `no premind session is attached to this agent`; do not guess from a different session. Omit the repository-scoped PR query.
- If GitHub lookup fails, retain all local sections and replace only the PR section with `my open PRs: unavailable (<concise cause>)`.
- Avoid protocol versions, client counts, reaping timestamps, long session identifiers, subscription write policies, and per-subscription pending-event counts in this view unless they directly explain a problem.

## Full Diagnostic Experience

`/premind:debug-status` is for debugging. It includes:

- the concise health synopsis;
- active clients, active/closed sessions, watchers, protocol, and last-reap information;
- a complete per-session table/list with host, shortened ID, repository/branch, PR association, lifecycle/busy state, pending count, worktree binding, and subscriptions including write policy/state;
- an explicit marker for the current session;
- the same current-repository open-PR list, so the normal and diagnostic paths do not disagree about the user's work.

`debug-status` is a separate, explicitly diagnostic command, not a flag on ordinary status. It must not create, attach, reactivate, or prune sessions.

## Data and Adapter Design

### 1. Add a typed status presentation model

Keep `debugStatus` as the raw daemon diagnostic response. Introduce a small shared projection/helper that accepts the raw response plus a resolved current session ID; adapters request either the current overview or the full diagnostic projection through separate user-facing commands/tools. It produces:

- daemon synopsis fields;
- the selected current-session summary or an explicit missing-session result;
- count of hidden sessions;
- all session summaries only for the explicit diagnostic projection.

This prevents Pi and OpenCode from independently deciding which daemon session is “current,” while preserving host-owned rendering and lifecycle behavior. The projection must not expose a session belonging to another host/session in default output.

### 2. Add an on-demand, viewer-scoped PR-list operation

The daemon already owns GitHub authentication and can obtain the authenticated login. Extend the GitHub client with a typed `listOpenPullRequestsForViewer(repo, options)` operation using a repository-scoped open-PR request filtered by the viewer. Return a minimal summary:

```ts
type OpenPullRequestSummary = {
  repo: string
  number: number
  title: string
  url: string
  draft: boolean
  updatedAt?: string
}
```

Expose it through a new versioned daemon IPC operation. It must:

- require an explicit `owner/repo` supplied from the resolved current session;
- filter to the authenticated viewer, not merely the current branch's PR author;
- request only open PRs, sort by most recently updated, and enforce a server-side page/display bound;
- leave watcher state, event queues, and discovery ETags untouched;
- return a typed, user-safe error boundary so adapters can show local status even if GitHub authentication/rate limiting fails.

Do not overload `debugStatus` with a network request. Debug status must remain cheap, local, and dependable for doctor/debugging scenarios.

### 3. Resolve the current session per host

Each adapter supplies its already-authoritative current-session identity to the shared status projection:

- **Pi:** the active `currentSessionId`, falling back to `getPiSessionId(ctx)` (the session JSONL path/cwd fallback) without attaching a new session just to inspect status.
- **OpenCode:** the command or tool's `ctx.sessionID`; never `lastPrimarySessionId` when the caller supplied an ID.
- **Codex:** its existing `resolveCodexSessionBinding` result, which already binds plugin data/session handle or cwd to a daemon session.
- **Claude:** retain its intentional aggregate/redacted constraints until it has a safe current-session binding. It may show daemon health and its own session state, but it must never receive the unredacted `premind:debug-status` inventory by accident.

The command-capability registry and generated capability documentation must describe any host-specific exception explicitly. If the feature is not available in a host, do not silently present the old all-sessions output as equivalent.

### 4. Render per host, using one vocabulary

Use a shared semantic model but preserve host rendering conventions:

- Pi: `/premind:status` and `premind_status` show the current session; `/premind:debug-status` and `premind_debug_status` show the full diagnostic inventory.
- OpenCode: `/premind-status` and `premind_status` use the invoking `sessionID`; `/premind:debug-status` and `premind_debug_status` explicitly show all sessions.
- Codex: `premind_status` uses the current binding and `premind_debug_status` requests the full projection (machine-readable JSON is fine for MCP results); no scope argument is needed on either tool.
- Agents should call `premind_status` for ordinary questions and `premind_debug_status` only when the user asks to inspect all sessions or troubleshoot daemon-wide state. Claude's redacted diagnostic surface must remain redacted; do not register an unredacted debug tool there until its access model is resolved.
- Existing doctor commands remain the place for adapter process/configuration diagnostics. Status must link users to doctor for an unreachable daemon rather than duplicating host process state.

For the first implementation, links should be emitted as the GitHub URL alongside the PR label. A follow-up can use host-native rendering where it is genuinely clickable/selectable:

- Pi: modal/list UI that opens selected PR URLs;
- OpenCode: rich Markdown links if the injected/system response path supports them;
- Codex/Claude: the client-visible Markdown/MCP presentation supported by those hosts.

## Delivery Phases

### Phase 1: Contract and current-session overview

1. Define separate current-overview and full-diagnostic presentation types with a pure projection/formatter API.
2. Update Pi and OpenCode status handlers/tools to pass their current session identities and render the current overview by default.
3. Register `/premind:debug-status` and `premind_debug_status` as explicit diagnostic surfaces and render the full inventory only for those calls.
4. Update command descriptions, capability registry/docs, and focused rendering tests.

**Checkpoint:** a user with several daemon sessions sees only their session from a normal status call; `/premind:debug-status` or `premind_debug_status` intentionally shows the actionable complete inventory.

### Phase 2: Viewer-owned open PRs

1. Add the GitHub client query, IPC request/response schemas, daemon router handler, client method, and focused tests for viewer filtering, empty results, ordering, and bounded results.
2. Call it only after resolving the current session and repository; render the separate `my open PRs` block in default and full views.
3. Treat PR-list failure independently from local status failure and verify the concise degraded copy.

**Checkpoint:** returning to a repository shows the user's current open stack even if only one of those PRs is subscribed; status still works when GitHub lookup is unavailable.

### Phase 3: Cross-host parity and diagnostics hardening

1. Port the shared projection and separate `premind_debug_status` MCP tool to Codex; explicitly decide/document Claude's safe session detail level.
2. Update generated plugin artifacts only through the repository's normal packaging/build workflow.
3. Confirm `premind:doctor` remains the adapter/config/process diagnostic command and status does not regress into a process dump.

**Checkpoint:** each host's documented status surface either provides current-session-first behavior or records a deliberate, tested privacy/host limitation.

### Phase 4: Optional rich PR presentation

Prototype host-native clickable PR lists without changing the underlying IPC model or text fallback. Ship only after each host can make the interaction discoverable, keyboard-accessible, and no worse than copying the displayed URL.

## Acceptance Criteria

- A normal status call never lists unrelated daemon sessions.
- It clearly identifies the current repository/branch, associated branch PR (when known), current session lifecycle/busy state, pending reminder count, watcher state, and global polling/daemon health.
- It separately lists active subscriptions and the authenticated user's open PRs for the current repository, so “watched” is never confused with “owned.”
- Where host privacy rules permit, `/premind:debug-status` and `premind_debug_status` let an operator or agent diagnose every daemon session and preserve the existing detail omitted from ordinary status; Claude remains intentionally redacted.
- A missing current-session binding and a failed GitHub PR lookup have concise, actionable, non-fatal output.
- Default status does not mutate daemon/session state or make a GitHub request when no current repository can be resolved.
- Tests cover selection/isolation, full-scope rendering, no watcher/no PR/paused/global-disabled cases, viewer filtering and URL/title display, GitHub failure degradation, and adapter command/tool wiring.
- Capability documentation and generated artifacts stay in sync with registrations.

## Non-Goals

- Automatically subscribing to every PR returned in `my open PRs`.
- A global “all my PRs across GitHub” search in the initial release.
- Replacing `premind:doctor` with status or moving process/configuration diagnosis into the normal overview.
- A new persistent UI, browser view, or modal in the first implementation.
- Changing reminder delivery, subscription write-policy, or ownership semantics.
