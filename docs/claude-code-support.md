# Plan: Add Claude Code support to premind

## Goal

Ship Claude Code support as a self-contained `plugin-claude/` plugin that reuses Premind's daemon, SQLite state, GitHub polling, and IPC protocol. In v0.2, reminders are delivered at Claude's turn boundary through a `Stop` hook; they are not pushed into an otherwise idle session.

## Decisions

1. **Plugin root:** `plugin-claude/` is the Claude plugin root. Its manifest is `plugin-claude/.claude-plugin/plugin.json`; hooks, MCP configuration, and all executable files live beneath that directory. No plugin component may reference a file above the plugin root.
2. **Delivery model:** v0.2 uses Stop-boundary delivery. When Claude finishes a turn and Premind has a pending reminder, the Stop hook injects it as hook feedback and continues the conversation. This is deliberately different from OpenCode's `promptAsync` delivery.
3. **No idle-timer promise:** `idleDeliveryThresholdMs` remains an OpenCode behavior in v0.2. Claude delivery occurs only at a Stop boundary, so it must not claim to deliver after a wall-clock idle threshold while the session is inactive.
4. **MCP surface:** The Claude plugin bundles a stdio MCP server for model-callable Premind operations. The plugin provides lifecycle hooks and packaging; MCP provides tools.
5. **Tool naming:** Name both the plugin and its MCP server `premind`, and expose concise tool suffixes such as `status`, `subscribe`, and `send_now`. Claude Code owns the full plugin-MCP name, currently `mcp__plugin_premind_premind__<tool>`; documentation and tests must use that generated name rather than assuming `mcp__premind__<tool>`.
6. **Claude session ownership:** Claude hook processes are ephemeral. The daemon, not an in-memory hook process, owns Claude session leases and activity state.
7. **Config migration:** Prefer `~/.config/premind/premind.jsonc`; read the old OpenCode path only as a one-release fallback. Check both new and legacy files before creating a new template.

## External constraints

The implementation must follow the current official Claude Code documentation:

- [Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks): command hooks receive JSON on stdin; `Stop` can continue a conversation; `stop_hook_active` prevents endless hook-driven loops; Claude ends a turn after eight consecutive blocks.
- [Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins) and [plugin reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference): a plugin root contains `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, and executables. Installed plugin components cannot escape the plugin root.
- [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp): plugin MCP servers start with the plugin and their tool names receive plugin/server namespaces. A stdio server is not automatically restarted if it exits.
- [Settings](https://docs.anthropic.com/en/docs/claude-code/settings): project/user/managed settings have distinct precedence and workspace trust can gate project-provided executable configuration.

MCP Channels are not part of v0.2. They could support event-driven delivery in a future release, but are a research-preview feature requiring explicit channel enablement.

## Architecture

### Existing components that remain canonical

- `src/daemon/`: daemon lifecycle, polling, persistence, reminder batching, and the Unix-socket IPC server.
- `src/shared/`: schemas, IPC protocol, constants, and configuration.
- `src/plugin-opencode/`: OpenCode-specific adapter after the rename in Phase 1.
- `src/extension/`: Pi adapter. It imports plugin runtime helpers today and must be updated by the rename.

### Claude adapter

`plugin-claude/` contains the complete installable Claude plugin:

```text
plugin-claude/
  .claude-plugin/plugin.json
  hooks/hooks.json
  .mcp.json
  bin/
    session-start.mjs
    user-prompt-submit.mjs
    stop.mjs
    session-end.mjs
    mcp-server.mjs
  package.json
```

The executables must be runnable after plugin installation without assuming `tsx`, a repository-root `node_modules`, or source files outside `plugin-claude/`. Choose and validate one packaging strategy during Phase 0: committed bundled JavaScript, or a supported plugin-local dependency installation mechanism. The resulting launcher must start the matching Premind daemon safely.

Each hook reads the Claude event JSON from stdin and talks to the daemon over the existing IPC socket. Hook scripts have no authoritative in-memory state.

### Session and lease model

The current protocol ties `sessions.client_id` to `client_leases`; stale lease cleanup can remove a session and its reminder batches. A per-event random `PremindDaemonClient` is therefore not viable.

Add a daemon-owned Claude session registration model before implementing the hooks. It must:

- use Claude's `session_id` supplied to hooks as the stable session key;
- retain a persistent host/client identity or add an explicit daemon-side Claude lease;
- renew activity/lease state on `SessionStart`, `UserPromptSubmit`, and `Stop`;
- cleanly close the session on `SessionEnd`; and
- preserve the existing invariant that only active sessions receive reminders.

Avoid borrowing the OpenCode client's random UUID and interval heartbeat unchanged: its lifecycle assumes a long-lived plugin process.

### Stop-boundary reminder delivery

`Stop` is the only v0.2 delivery point:

1. Parse `session_id` and `stop_hook_active`.
2. Renew/touch the daemon-owned Claude session lease.
3. If `stop_hook_active` is true, permit stopping to avoid a loop.
4. Query `getPendingReminder(session_id)`.
5. When there is no batch, exit successfully with no output.
6. When a batch exists, atomically acknowledge it as `handed_off`, then return valid Stop-hook JSON using `hookSpecificOutput.additionalContext` with `hookEventName: "Stop"` and the reminder text.
7. Confirm the batch only after the handoff response has been successfully prepared; reset it to failed/retryable if preparation fails.

Use `additionalContext`, not `decision: "block"` plus an error-style `reason`, because a Premind reminder is normal contextual feedback rather than a failed-stop policy. The implementation must still test Claude's continuation behavior and the eight-continuation limit.

`UserPromptSubmit` marks the session busy before model execution. `SessionStart` registers or reattaches the session and detects the Git worktree. `SessionEnd` unregisters it. A `Notification` hook is out of scope; `idle_prompt` is not a reliable timer or delivery trigger.

### MCP server

The plugin-bundled stdio MCP server is a thin translation layer over daemon IPC. It must not own watcher or reminder state.

Initial tools:

- `status` — daemon-wide diagnostic status; no session identity required.
- `disable` / `enable` — daemon-wide polling control.
- `activate_worktree`, `subscribe`, `unsubscribe`, and `send_now` — session-scoped operations.
- `probe` — Claude-plugin runtime diagnostics.

Claude Code does not document a session ID automatically delivered to arbitrary MCP tool calls. Phase 0 must prove a safe session-binding design before session-scoped MCP tools ship. Acceptable designs must ensure a tool call cannot act on another Claude session. Do not expose a raw, model-supplied `session_id` without validating it against a registration/token established by the hooks. If no supported binding is available, defer session-scoped tools and ship only daemon-wide read/control tools plus documented Claude commands.

## Phases

### Phase 0 — Validate Claude runtime and packaging assumptions

Build a throwaway local plugin and record the results before restructuring production code.

- Verify `plugin-claude/` loads with `claude --plugin-dir ./plugin-claude`.
- Verify hook stdin schema contains `session_id` for `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd`.
- Verify `Stop` feedback via `hookSpecificOutput.additionalContext`, including behavior when `stop_hook_active` is true.
- Verify generated plugin-MCP tool names and determine whether a session-safe MCP binding is available.
- Verify the packaging/launcher works from an installed-plugin layout, not just the repository checkout.

**Exit criterion:** record exact Claude Code version, command output, and chosen packaging/session-binding design in this document. Do not begin Phase 2 or Phase 3 without a passing spike.

### Phase 1 — Restructure existing host adapters without behavioral change

- Rename `src/plugin/` to `src/plugin-opencode/`.
- Preserve the package root export (`"."`) as the OpenCode adapter for backwards compatibility; add a named OpenCode export only if useful. Do not publish a TypeScript source export as the Claude plugin interface.
- Update all imports, test paths, scripts, package metadata, documentation, and the Pi extension imports in `src/extension/`.
- Update the config loader to accept ordered candidate paths: new Premind `.jsonc`/`.json`, then legacy OpenCode `.jsonc`/`.json`.
- Emit a one-time deprecation warning only when a legacy path actually supplied configuration.
- Create a new config template only when none of the candidate files exists.

**Validation:** existing typecheck and test suite; focused config migration tests; package/extension import tests. Commit.

### Phase 2 — Add daemon support for Claude session leases

- Design and implement the daemon-owned Claude registration/lease API selected in Phase 0.
- Keep OpenCode and Pi client lease behavior unchanged.
- Add IPC schemas and router operations rather than letting hook scripts write persistence directly.
- Define retry, reattach, stale-session, daemon-restart, and SessionEnd behavior.
- Test lease renewal, reminder preservation, handoff recovery, and cleanup under fresh hook-process identities.

**Validation:** focused IPC/persistence/lease tests. Commit.

### Phase 3 — Build the MCP proxy and safe session binding

- Add the stdio MCP implementation selected in Phase 0.
- Translate MCP tool calls to existing daemon IPC operations; do not duplicate router or store business logic.
- Add a session-binding capability for session-scoped operations, or defer those operations if it cannot be implemented safely.
- Define tool input/output schemas and test errors as structured tool failures.
- Add end-to-end tests for MCP initialization, generated tool registration, and IPC round trips.

**Validation:** MCP protocol and daemon round-trip tests, plus a real Claude Code local-plugin smoke test. Commit.

### Phase 4 — Build Claude hooks and Stop-boundary delivery

- Implement the four hook executables and `hooks/hooks.json` with exec-form commands rooted at `${CLAUDE_PLUGIN_ROOT}`.
- Register/reattach on `SessionStart`; mark busy on `UserPromptSubmit`; touch session state on `Stop`; unregister on `SessionEnd`.
- Implement the handoff/confirmation state machine from the delivery design above.
- Test no batch, batch handoff, failed handoff, daemon unavailable, session restart, `stop_hook_active`, and repeated Stop events.
- Ensure Premind failures fail open: no valid reminder must be lost, and daemon/hook errors must not trap the user in a blocking loop.

**Validation:** unit/integration tests plus a live Claude Code session against a real PR. Commit.

### Phase 5 — Package, document, and release

- Validate the plugin with `claude plugin validate` and local `--plugin-dir` loading.
- Add Claude Code installation, generated MCP tool names, requirements, Stop-boundary semantics, and troubleshooting to `README.md`.
- Document config migration and the one-release legacy fallback.
- State clearly that v0.2 does not push reminders into an otherwise inactive Claude session and has no countdown toast.
- Bump the release version after compatibility and upgrade behavior are verified.

**Validation:** documentation read-through; local install, reload, and removal smoke tests. Commit.

## Non-goals for v0.2

- Mid-idle or wall-clock-triggered reminder injection.
- Countdown toasts or a native Claude TUI equivalent.
- MCP Channels; reconsider only after their preview status, opt-in requirements, and delivery semantics are stable.
- Subagent-specific reminder delivery.
- Codex or Gemini adapters.

## Risks

| Risk | Mitigation |
| --- | --- |
| Stop feedback changes model behavior unexpectedly | Phase 0 and live validation; fail open; use `stop_hook_active`. |
| Hook process lifetime conflicts with existing client leases | Daemon-owned Claude lease model and dedicated persistence tests. |
| MCP calls lack trusted Claude session identity | Prove a safe binding in Phase 0; otherwise defer session-scoped MCP tools. |
| Plugin cache cannot execute repository-relative scripts | Keep executables and their dependencies beneath `plugin-claude/`; test installed layout. |
| Config migration silently ignores legacy settings | Ordered candidate lookup and migration regression tests. |
| Claude Code hook/plugin behavior changes by version | Record supported Claude Code version and pin the tested behavior in release notes. |
