# Plan: Current-Session-First Status and Open PR List

## Goal

Make premind's normal status answer the question a returning developer actually has:

> What branch am I on, is this session watching it, what PRs do I have open, and is premind healthy?

This plan resolves [#62](https://github.com/jdtzmn/premind/issues/62) and [#66](https://github.com/jdtzmn/premind/issues/66) as one product surface. It deliberately distinguishes a **normal, current-session view** from an **explicit diagnostic view of every daemon session**.

## Product Decisions

1. **`premind:status` is current-session first.** It must not dump every daemon session in the ordinary case.
2. **The default view contains both session state and the user's open PRs in the current repository.** “Watching” and “mine open” are distinct facts even when displayed on one PR row:
   - watching is the set of subscriptions that can deliver reminders to this session;
   - open PRs is a live, author-filtered GitHub query and is useful for recovering a stack even when every PR is not subscribed.
3. **`premind:debug-status` is the debugger escape hatch.** It preserves the existing aggregate/session inventory, including internal maintenance fields, and is the only normal command that enumerates other sessions.
4. **Status remains useful when GitHub is unavailable.** Daemon/session health and watched PRs are rendered from local state; only the owned-open PR portion degrades, with a short explanation.
5. **No special clickable UI in the first implementation.** Render stable `owner/repo#number` labels and URLs in plain text/Markdown where the host already supports it. Host-native affordances (for example, a Pi modal with selectable links) are a later enhancement and do not shape the first data contract.
6. **No hidden cross-repository search by default.** The default PR list is the authenticated viewer's open PRs in the current session's repository. A future dedicated PR-list command can add an explicit all-repositories scope after its rate-limit and privacy behavior are designed.
7. **Compact by grouping, not deleting facts.** The default view preserves daemon health, polling, watcher count, repo/branch, session state, pending count, branch PR, watched subscriptions, owned open PRs, links, and hidden-session count. Shared PRs appear once with explicit `[branch]` and `[watched]` annotations; exceptions are listed separately.
8. **Words are the compatibility baseline.** Optional host-specific colors/icons may decorate status, but never convey meaning alone. Plain-text command notifications and agent-tool output must retain labels and raw URLs; avoid emoji-dependent glyph widths, ANSI escapes, and table alignment.

## Default Experience

`/premind:status` should read as a compact overview, not a log.

```text
premind · running · polling on · 1 watcher
jdtzmn/premind @ jacob/better-status · active/idle · 0 pending

PRs · 3 mine open · 2 watched
  #67 Improve status output [branch, watched] — https://github.com/jdtzmn/premind/pull/67
  #65 Recover Pi sessions [watched] — https://github.com/jdtzmn/premind/pull/65
  #61 Another change — https://github.com/jdtzmn/premind/pull/61

2 other sessions · /premind:debug-status
```

Rules for the overview:

- First line: daemon reachability, global polling state, and watcher count. When polling is disabled, say `polling off` and include `/premind:enable`; when unreachable, say so and point to `/premind:doctor`. Do not mistake zero watchers for an unhealthy daemon.
- Second line: current repository, branch, session lifecycle/busy state, and pending reminder count. The PR section uses that repository as its default context; qualify `owner/repo#number` whenever a subscription belongs to another repository.
- Group PRs by identity, not by source. The heading gives separate counts for **mine open** (viewer-authored GitHub results in this repo) and **watched** (active subscriptions for this session). Each listed PR has its title when known, a full raw URL (clickable where the host supports links), and independent `[branch]` and `[watched]` tags as applicable. A branch PR not in the open/owned set and an external or foreign watched PR still get their own row. Deduplicate shared PRs without hiding either relationship.
- Order my open PRs by most recently updated. Keep the initial display bounded (for example, 10 results); if more exist, show a truthful `+N more` count or `showing first 10` when the total is unknown. Do not imply that every owned PR is being watched. When the PR is draft, label it `draft`. A watched or branch PR must never disappear solely because the owned-PR display is capped.
- Show `0 watched` or `0 mine open` in the heading for empty categories; avoid redundant `none` lines. Show the hidden-session count and diagnostic command only when other sessions exist.
- If the current session cannot be resolved, show daemon health and `no premind session is attached to this agent`; do not guess from a different session or make a repository-scoped PR query.
- If GitHub lookup fails, retain the local context, branch PR, and watched entries. Replace only the owned-open count/list with `mine open unavailable (<concise cause>)` rather than hiding or mislabeling watched PRs.
- Preserve all product-level facts, but keep protocol versions, client counts, reaping timestamps, long session IDs, subscription write policies, and per-subscription pending-event counts in `/premind:debug-status` unless a specific problem needs surfacing.

## Reference Patterns and Presentation Choice

- [`gh pr status`](https://cli.github.com/manual/gh_pr_status) leads with the current branch, then groups PRs created by the viewer and review requests. Its number/title lines carry compact status hints; detailed checks are a separate `gh pr checks` action. Borrow the **current-context-first hierarchy**, not additional CI/review claims we do not yet fetch.
- [`gh-dash` PR sections](https://gh-dash.dev/configuration/pr-section/) separate viewer-focused PR lists into named, bounded sections; its [theme](https://gh-dash.dev/configuration/theme/) can make rows compact and color states. But [its icons require a Nerd Font](https://gh-dash.dev/getting-started). Borrow semantic labels and bounded density, not font-dependent glyphs or an interactive dashboard for a one-shot status response.
- [Graphite's `gt log`](https://graphite.com/docs/visualize-stack) offers a scoped stack view and includes PR links/status for submitted branches. A dependency tree would be useful for stack recovery, but premind's current open-PR query does not establish parent/child relationships. Do **not** draw a tree or call the list a stack until that topology is available.

**Recommendation:** Ship a two-line health/context header and one deduplicated PR list with compact word tags. Keep full URLs visible for link detection, and keep the same plain-text fallback in notifications and agent-tool responses. If a host offers a reliable, accessible theming API, it may color existing text (`running`, `polling off`, `pending`) as a secondary cue; never emit raw ANSI sequences or rely on emoji/Nerd Font icons. Follow established CLI practice of honoring `NO_COLOR`/non-TTY behavior for any future terminal-specific color output ([GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)).
## Full Diagnostic Experience

`/premind:debug-status` is for debugging. It includes:

- the concise health synopsis;
- active clients, active/closed sessions, watchers, protocol, and last-reap information;
- a complete per-session table/list with host, shortened ID, repository/branch, PR association, lifecycle/busy state, pending count, worktree binding, and subscriptions including write policy/state;
- an explicit marker for the current session;
- the same deduplicated PR overview for the current repository (plus external/foreign watched PRs), so normal and diagnostic paths do not disagree about the user's work.

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
2. Call it only after resolving the current session and repository; merge viewer-owned PRs, branch association, and active subscriptions by `repo#number` into the compact PR list in default and full views without losing separate counts or tags.
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
- A compact, deduplicated PR list retains distinct owned-open, branch-PR, and actively watched meanings via counts and annotations; foreign/external and non-open PRs remain visible when associated or watched.
- Where host privacy rules permit, `/premind:debug-status` and `premind_debug_status` let an operator or agent diagnose every daemon session and preserve the existing detail omitted from ordinary status; Claude remains intentionally redacted.
- A missing current-session binding and a failed GitHub PR lookup have concise, actionable, non-fatal output.
- Default status does not mutate daemon/session state or make a GitHub request when no current repository can be resolved.
- Tests cover selection/isolation; deduplication of an owned, branch-associated, watched PR; external and foreign subscriptions; capped owned results without dropping watched PRs; plain-text/URL compatibility; disabled polling; no watcher/no PR/paused states; GitHub failure degradation; and adapter command/tool wiring.
- Capability documentation and generated artifacts stay in sync with registrations.

## Non-Goals

- Automatically subscribing to every PR returned in `my open PRs`.
- A global “all my PRs across GitHub” search in the initial release.
- Replacing `premind:doctor` with status or moving process/configuration diagnosis into the normal overview.
- A new persistent UI, browser view, or modal in the first implementation.
- Changing reminder delivery, subscription write-policy, or ownership semantics.
