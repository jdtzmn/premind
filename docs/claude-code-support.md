# Plan: Add Claude Code support to premind

## Goal

Ship Claude Code support as a self-contained `plugin-claude/` plugin. It reuses Premind's daemon, SQLite state, GitHub polling, and IPC protocol. In v0.2, reminders arrive only at a Claude turn boundary through a `Stop` hook; Premind cannot wake an otherwise inactive Claude session.

## Settled decisions

1. **Plugin root:** `plugin-claude/` is the installable Claude plugin root. Its manifest, hooks, MCP configuration, runtime, and executables remain below that directory.
2. **Runtime:** ship a committed, reproducibly generated Node bundle at `plugin-claude/runtime/premind-daemon.mjs`. It contains the daemon and required application dependencies; Claude installs must not require a checkout, `tsx`, Bun, or repository-root `node_modules`. Require a Node version compatible with Premind's `node:sqlite` usage (Node 22+).
3. **Daemon launcher:** plugin-local `ensure-daemon.mjs` probes the shared Premind socket, uses a shared-state startup lock, double-checks after obtaining it, spawns the bundled Node daemon detached, waits briefly for IPC readiness, and fails open. It reuses a protocol-compatible daemon started by Pi or OpenCode; package-version differences alone do not trigger a restart.
4. **Delivery:** v0.2 uses Stop-boundary feedback via `hookSpecificOutput.additionalContext`, never a wall-clock idle timer or `decision: "block"` error.
5. **Claude identity:** use the shared Claude session key directly. Hooks receive `session_id`; local stdio MCP processes receive `CLAUDE_CODE_SESSION_ID`. At startup, hooks assert these values match and register `host = "claude"`, `host_session_id = <Claude ID>`. MCP tools derive their session from the environment rather than accepting a model-supplied session ID.
6. **Mismatch safety:** if a hook/MCP session identity mismatch is observed, session-scoped tools fail closed and instruct the user to reload/restart the plugin. Do not guess based on cwd, MCP connection IDs, or a process-global map.
7. **Session lifecycle:** persist an explicit session host/origin. Lease-orphan pruning applies only to lease-backed hosts (OpenCode/Pi). Claude sessions close through `SessionEnd` and stale-session reaping; active Claude sessions and their queued reminders must survive generic lease pruning.
8. **Reminder acknowledgement:** use two-phase confirmation. A Stop hook atomically claims a batch as `handed_off` and emits it. On the next Stop event with `stop_hook_active: true`, atomically confirm that same session's prior handoff. If that continuation never happens, stale-handoff recovery makes the batch retryable. Never confirm merely because hook output was prepared.
9. **MCP tools:** plugin MCP names are platform-owned (`mcp__plugin_premind_premind__<tool>`). v0.2 ships `status`, `probe`, `enable`, `disable`, `activate_worktree`, `subscribe`, and `unsubscribe`; it does not ship `send_now`. Status/probe redact unrelated session metadata. Keep enable/disable model-callable for Pi/OpenCode parity and make their daemon-wide effect explicit in descriptions/results.
10. **Config migration:** prefer `~/.config/premind/premind.jsonc`; fall back to the OpenCode path through v0.2 and remove fallback in v0.3. A valid empty new config masks legacy settings. A malformed new config logs a warning and uses a valid legacy file during the grace release. `idleDeliveryThresholdMs` is OpenCode-only.
11. **User UX:** ship `/premind:status`, `/premind:doctor`, `/premind:enable`, `/premind:disable`, `/premind:subscribe`, and `/premind:unsubscribe`. Doctor reports Node/runtime compatibility, plugin version/root, daemon/socket protocol reachability, config source, and Stop-boundary semantics. The first Claude reminder briefly explains that inactive sessions are not woken in v0.2.

## Phase 0 evidence

Tested locally with Claude Code **2.1.267** using a temporary plugin with a SessionStart hook and stdio MCP tool:

| Scenario | Hook `session_id` | Hook `CLAUDE_CODE_SESSION_ID` | MCP `CLAUDE_CODE_SESSION_ID` |
| --- | --- | --- | --- |
| Fresh headless session | Same UUID | Same UUID | Same UUID |
| Explicit `--resume <id>` | Same UUID | Same UUID | Same UUID |

The fresh and explicit-resume paths support direct shared-key binding without a model-visible capability token. Before release, also test `--continue`, `/clear`, interactive `/resume`, concurrent sessions, plugin/MCP reload, and daemon restart. A failure in any mismatch scenario must fail session-scoped calls closed.

## External constraints

- [Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks): command hooks receive JSON on stdin; `Stop` can continue a conversation; `stop_hook_active` prevents endless hook loops; Claude ends a turn after eight consecutive blocks.
- [Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins) and [plugin reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference): installed plugin components cannot escape the plugin root.
- [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp): plugin MCP tools are namespaced and stdio servers are not automatically restarted after exit.
- [Environment variables](https://code.claude.com/docs/en/env-vars): verify `CLAUDE_CODE_SESSION_ID` behavior against every supported Claude lifecycle mode.

MCP Channels are out of scope for v0.2; they are a research-preview, opt-in alternative for future event-driven delivery.

## Architecture

### Existing canonical components

- `src/daemon/`: lifecycle, persistence, polling, reminders, and Unix-socket IPC.
- `src/shared/`: schemas, IPC protocol, constants, and configuration.
- `src/plugin-opencode/`: OpenCode adapter after the Phase 1 rename.
- `src/extension/`: Pi adapter; update imports during the rename.

### Claude package

```text
plugin-claude/
  .claude-plugin/plugin.json
  hooks/hooks.json
  .mcp.json
  commands/
  bin/
    ensure-daemon.mjs
    session-start.mjs
    user-prompt-submit.mjs
    stop.mjs
    session-end.mjs
    mcp-server.mjs
  runtime/
    premind-daemon.mjs
  package.json
```

`ensure-daemon.mjs` uses an exec-form Node invocation and a common Premind state/socket location. The startup lock belongs in the shared Premind state directory—not plugin-version data—so concurrent hooks and different hosts cannot launch duplicate daemons.

### Claude sessions

Represent the identity as `UNIQUE(host, host_session_id)`, where Claude sessions use `("claude", CLAUDE_CODE_SESSION_ID)`. The host marker prevents collisions and lets cleanup distinguish lease-backed hosts from Claude's hook-driven lifecycle.

- `SessionStart`: assert ID correlation, ensure daemon, register/reattach the Claude session, and discover its Git context.
- `UserPromptSubmit`: touch the session as busy.
- `Stop`: touch it as idle, confirm a prior handoff only when `stop_hook_active` is true, otherwise atomically claim and deliver one pending batch.
- `SessionEnd`: close the session and revoke its worktree/subscription demand.

### Reminder handoff state machine

```text
pending/failed
  → claimClaudeReminder (atomic)
  → handed_off
  → Stop additionalContext
  → next Stop with stop_hook_active
  → confirmClaudeHandoff (atomic)
  → confirmed
```

A daemon crash, hook failure, or missing follow-up Stop leaves the batch recoverable. Stale-handoff recovery returns it to a retryable state. A retry preserves the same batch identity/text and is labelled as a retry internally; it never advances delivery cursors twice.

### MCP server

The plugin-bundled stdio MCP server is a thin IPC proxy. It reads `CLAUDE_CODE_SESSION_ID` at process startup and derives the active Claude session from it. It does not own watchers, reminders, leases, or a server-generated session ID.

- `status` returns aggregate, redacted daemon information.
- `probe` reports plugin/daemon/config/runtime health without unrelated session details.
- `enable` and `disable` change the existing daemon-wide polling switch and state their global effect.
- `activate_worktree`, `subscribe`, and `unsubscribe` act only on the validated environment-derived Claude session.
- `send_now` is deferred because it conflicts with Stop-only delivery acknowledgement.

## Implementation phases

### Phase 1 — Multi-host restructure and config migration

- Rename `src/plugin/` to `src/plugin-opencode/`.
- Preserve the root OpenCode package export; update scripts, tests, README, package metadata, and Pi imports.
- Add explicit session host/origin persistence and migrate existing rows safely.
- Implement ordered new/legacy config candidates, valid-empty masking, malformed-primary fallback, v0.3 removal warning, and OpenCode-only idle-setting labels.

**Validation:** typecheck, complete existing suite, migration tests, config precedence tests, and extension/package import tests.

### Phase 2 — Core Claude lifecycle and recoverable handoffs

- Add dedicated IPC schema/router operations for registering/touching/closing Claude sessions, atomic claim, and post-continuation confirmation.
- Restrict lease-orphan pruning to lease-backed session hosts.
- Reuse existing stale-session and stale-handoff recovery with Claude-specific regression tests.

**Validation:** persistence/IPC tests for concurrent sessions, pruning preservation, daemon restart, failed handoff, stale retry, and no duplicate cursor advancement.

### Phase 3 — Bundle and launch the daemon

- Add a reproducible bundle command producing committed `plugin-claude/runtime/premind-daemon.mjs`.
- Implement the lock/probe/spawn/readiness launcher.
- Add protocol compatibility checks and installed-copy tests that run without repository paths or `tsx`.

**Validation:** fresh temporary plugin copy, simultaneous launcher invocations, stale socket, compatible daemon reuse, incompatible protocol failure, and Node-version failure tests.

### Phase 4 — Claude hooks, MCP, and commands

- Implement hooks using exec-form commands rooted at `${CLAUDE_PLUGIN_ROOT}`.
- Implement environment-derived MCP binding and mismatch guards.
- Add the safe/redacted tool surface and namespaced command markdown.
- Add hook/MCP protocol tests and real Claude lifecycle fixtures.

**Validation:** `claude plugin validate`, fresh session, resume, continue, clear, concurrent session, plugin reload, and daemon restart tests.

### Phase 5 — Documentation and release

- Update README for Claude installation, Node requirement, commands, namespaced MCP tools, daemon startup, Stop-only delivery, and troubleshooting.
- Document exact config migration/removal behavior and OpenCode-only timer setting.
- Add first-reminder wording and `/premind:doctor` guidance.
- Bump version only after all compatibility checks pass.

## Non-goals for v0.2

- Mid-idle/wall-clock reminder injection.
- Native Claude countdown toasts.
- MCP Channels.
- Subagent-specific delivery.
- Codex or Gemini adapters.

## Release risks

| Risk | Mitigation |
| --- | --- |
| Plugin cannot start a daemon after installation | Committed Node bundle, shared-state launcher, and installed-copy tests. |
| Claude hook/MCP identity drifts | Tested lifecycle matrix and fail-closed session-scoped tools. |
| Claude session pruning loses queued reminders | Persist host/origin and exclude active Claude sessions from lease-orphan cleanup. |
| Reminder is terminally confirmed before Claude continues | Atomic claim plus post-continuation confirmation and stale retry. |
| Claude users expect OpenCode idle delivery | Explain Stop-only behavior in first reminder, doctor output, README, and config docs. |
| Config migration silently changes settings | Ordered candidates, explicit warnings, regression tests, and v0.3 removal date. |
