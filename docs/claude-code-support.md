# Plan: Add Claude Code support to premind

Add a Claude Code plugin adapter alongside the existing OpenCode adapter, sharing the daemon, IPC layer, and shared modules unchanged.

## Decisions

1. **Delivery model:** Stop-hook injection. The Claude Code adapter intercepts the `Stop` event, queries the daemon for a pending reminder, and returns it as a `decision: "block"` with the reminder text as the reason, causing Claude to continue with the PR context loaded.
2. **Command surface:** MCP server. The daemon (or a thin proxy) exposes premind's operations (`status`, `pause`, `resume`, `send_now`, `disable`, `enable`, `probe`) as MCP tools. Claude Code calls them as `mcp__premind__status` etc.
3. **Config location:** Move to `~/.config/premind/premind.jsonc`. Keep a one-release fallback that reads `~/.config/opencode/premind.jsonc` and logs a deprecation notice.

## Architecture context

Premind is already structured for multi-host support:

- **Daemon** (`src/daemon/`) — host-agnostic. Polls GitHub, persists state in SQLite, manages reminder queues, runs an IPC server over a Unix socket at `/tmp/premind.sock`. Nothing in here references OpenCode.
- **Shared** (`src/shared/`) — IPC schemas, config loader, constants. Host-agnostic.
- **Plugin** (`src/plugin/`) — the only OpenCode-specific code. Receives lifecycle events, registers slash commands and tools, injects reminders via `client.session.promptAsync(...)`, renders countdowns via `client.tui.showToast(...)`, and spawns the daemon process.

Only the plugin layer needs a Claude Code counterpart.

## Capability mapping

| Need | OpenCode mechanism | Claude Code mechanism |
|---|---|---|
| Detect session start | `event: session.created` | `SessionStart` hook |
| Detect session end | `event: session.deleted` | `SessionEnd` hook |
| Detect idle | `event: session.idle` / `session.status` | `Stop` hook (turn end), `Notification` hook (`idle_prompt`) |
| Detect busy | `event: session.status` (busy) | `UserPromptSubmit` / `PreToolUse` hooks |
| Register slash commands | `config.command[...]` | `commands/` or `skills/` markdown files |
| Register model-callable tools | `tool: {...}` | MCP server |
| Inject mid-session reminders | `client.session.promptAsync(...)` | **No direct equivalent.** Closest: `Stop` hook returning `decision: "block"` with reminder text as `reason`; or `monitors/` stdout fed as notifications |
| Render countdown UI | `client.tui.showToast(...)` | **No equivalent.** Drop the countdown toast entirely |
| Spawn daemon | Plugin module runs Node code freely | Hook command spawned per event; or `monitors/monitors.json` for long-running background processes |

## Key obstacles

### 1. No `promptAsync` equivalent → reminder delivery model changes

In OpenCode, premind interrupts an idle session by pushing a new turn into it via the SDK. Claude Code's hooks return JSON to influence the *current* event; they can't push new user messages into a running CLI session.

**Solution:** `Stop` hook injection. When the model finishes responding, the hook returns `decision: "block"` with `reason` containing the reminder text. Claude continues with the supplied context. The reminder rides on the *next* model turn boundary rather than being pushed from outside.

Implication: reminders arrive only at turn boundaries, never mid-think. This is a slightly different UX than OpenCode but aligns with how Claude Code's hooks work.

### 2. Hooks are stateless shell invocations, not a long-lived module

OpenCode loads `src/plugin/index.ts` once per opencode process and keeps state in closure variables (`ownedSessions`, `idleSince`, `deliveryTimers`, etc.). Claude Code spawns a fresh process for *each* hook fire. All that in-memory state has to move into the daemon or to disk.

**Solution:** Each hook is a small script that reads JSON from stdin, connects to the daemon via the existing IPC, translates the event, calls the corresponding daemon method, and returns a decision on stdout. The daemon already owns the canonical state. The plugin's in-memory caches in the OpenCode adapter are mostly performance optimizations (e.g. `knownChildSessions`) and reattach bookkeeping that don't apply (Claude Code doesn't have parent/child sessions in the same way).

### 3. Slash commands map differently

In OpenCode, premind registers commands that emit a sentinel marker (`[PREMIND_STATUS]`) into the prompt, and a `chat.message` handler intercepts those markers to execute the command logic in-process.

**Solution:** Expose premind's operations as an MCP server. The daemon speaks MCP (JSON-RPC over stdio), and Claude Code calls `mcp__premind__status`, `mcp__premind__pause`, etc. The existing `tool: {...}` block in `src/plugin/index.ts` maps almost 1:1 to MCP tool definitions.

## What carries over unchanged

- All of `src/daemon/`.
- All of `src/shared/` (with one update to the config loader for the new path with fallback).
- The daemon launcher logic in `src/plugin/daemon-launcher.ts` — only the path-anchoring base changes (resolves under `${CLAUDE_PLUGIN_ROOT}` instead of opencode's install path); the `findExecutable` walk and runner selection are reusable as-is.

## Phases

### Phase 1 — Restructure for multi-host (no behavior changes)

- Rename `src/plugin/` → `src/plugin-opencode/`.
- Update `package.json` `exports`:
  - `"./opencode"` → `./src/plugin-opencode/index.ts`
  - `"./claude"` → `./src/plugin-claude/index.ts` (added in phase 3)
- Update `src/shared/config-loader.ts` to check `~/.config/premind/premind.jsonc` first, then fall back to `~/.config/opencode/premind.jsonc` with a one-time deprecation warning logged to the daemon log.
- All existing tests stay green; this is a pure restructure.

**Validation:** `bun run check && bun run test`. Commit.

### Phase 2 — MCP server in the daemon

- Add `src/daemon/mcp/server.ts` that exposes the existing IPC operations as MCP tools over stdio.
- Reuse `src/daemon/ipc/router.ts` logic — the MCP tool handlers call into the same store/operations.
- The MCP server runs as a stdio-spawned child process (one per Claude Code session) that proxies to the daemon over the existing Unix socket. State stays canonical in the daemon; the MCP server is a thin translation layer.
- Tool surface mirrors the existing OpenCode `tool: {...}` block: `premind_status`, `premind_pause`, `premind_resume`, `premind_send_now`, `premind_disable`, `premind_enable`, `premind_probe`.
- Add tests covering tool registration and the round-trip from MCP call → daemon op → response.

**Validation:** New `src/daemon/mcp/server.test.ts`. Commit.

### Phase 3 — Claude Code plugin adapter

Layout:

```
src/plugin-claude/
  hooks/
    session-start.ts        # registers session with daemon
    user-prompt-submit.ts   # marks session busy, cancels delivery
    stop.ts                 # the main event: query daemon, deliver if pending
    session-end.ts          # unregisters session
    notification.ts         # optional, idle_prompt matcher
  daemon-launcher.ts        # adapted from src/plugin-opencode/daemon-launcher.ts
  mcp-launcher.ts           # spawns the daemon's MCP server
  plugin/                   # the installable plugin directory
    .claude-plugin/plugin.json
    hooks/hooks.json
    .mcp.json
```

Each hook is a small Node/tsx script that reads JSON from stdin, calls the daemon via the existing `PremindDaemonClient`, and writes a decision to stdout.

`Stop` hook logic (the meaningful one):

1. Read `session_id` from stdin.
2. Ensure daemon is running (`ensureDaemonRunning`); spawn if not.
3. Call `daemon.getPendingReminder(sessionID)`.
4. If no batch → exit 0 (don't block).
5. If batch and idle threshold elapsed:
   - Ack as `handed_off`.
   - Write JSON to stdout: `{ decision: "block", reason: pending.batch.reminderText }`.
   - Ack as `confirmed`.
6. If batch but threshold not yet elapsed → exit 0 (next Stop hook fire will retry).
7. On daemon error → exit 0 silently. Never block on premind failure.

`SessionStart` registers the session with the daemon. `SessionEnd` unregisters it. `UserPromptSubmit` marks the session busy and cancels any pending delivery scheduling.

Drop the toast countdown UI entirely (no Claude Code equivalent). The idle delivery threshold still applies — the Stop hook just checks elapsed-idle-time before serving the reminder.

**Validation:** New `src/plugin-claude/__tests__/` mirroring the OpenCode compatibility tests. Commit per hook.

### Phase 4 — Plugin packaging

- Author `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`.
- `hooks/hooks.json` wires each event to its hook script under `${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/hooks/*.ts` using exec form with `tsx` as the command.
- `.mcp.json` declares the premind MCP server, pointing at the daemon's MCP entry script.
- Test loading via `claude --plugin-dir ./src/plugin-claude/plugin`.

Example `hooks/hooks.json`:

```json
{
  "description": "Keeps Claude Code sessions up to date with PR changes",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx",
            "args": ["${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/hooks/session-start.ts"]
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx",
            "args": ["${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/hooks/stop.ts"]
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx",
            "args": ["${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/hooks/user-prompt-submit.ts"]
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tsx",
            "args": ["${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/hooks/session-end.ts"]
          }
        ]
      }
    ]
  }
}
```

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "premind": {
      "command": "tsx",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/plugin-claude/mcp-launcher.ts"]
    }
  }
}
```

**Validation:** Manual smoke test in a Claude Code session against a real GitHub PR. Commit.

### Phase 5 — Docs & release

- Update README with a separate install section for Claude Code (`/plugin install` workflow once published, plus `--plugin-dir` instructions for local development).
- Document the delivery model difference (Stop-hook injection vs. promptAsync) so users understand *when* reminders arrive in Claude Code.
- Bump version to `0.2.0`; note the config-path migration with a fallback for one release.

**Validation:** Read-through of README. Commit.

## Estimated effort

| Task | Estimate | Risk |
|---|---|---|
| Phase 1 restructure | 0.5 day | Low |
| Phase 2 MCP server in daemon | 1.5 days | Low |
| Phase 3 Stop-hook delivery | 2 days | **Medium** — depends on real-world UX of `decision: "block"` reason |
| Phase 3 SessionStart / SessionEnd / busy hooks | 1 day | Low |
| Phase 3 daemon-launcher adaptation | 0.5 day | Low |
| Phase 4 packaging | 0.5 day | Low |
| Phase 3/4 tests (compat tests mirroring OpenCode) | 2 days | Low |
| Phase 5 docs | 0.5 day | Low |
| **Total** | **~8.5 days** | |

## Risks and unknowns

- **Stop-hook UX in practice.** Returning `decision: "block"` with reminder text *should* cause Claude to continue with the loaded context, but the actual model behavior — and whether Claude treats long reminder text as an extension of its turn or as a new user message — needs to be validated in a real session. **Mitigation:** Phase 3 includes a small live-validation script analogous to `src/test/live-validation.ts` to verify the round-trip end-to-end before declaring done.
- **MCP server lifecycle.** Claude Code spawns one MCP server process per session. All of them should share state through the daemon (which they do via the existing IPC socket), not maintain independent state. The MCP server must be a thin proxy to the daemon — not a peer with its own state.
- **Daemon launcher path resolution.** `${CLAUDE_PLUGIN_ROOT}` is a different anchor than opencode's `~/.cache/opencode/node_modules/premind/`. The `findExecutable` walk in `src/plugin/daemon-launcher.ts:150` already walks up directories until the filesystem root, so it should work as-is from anywhere; needs a quick sanity check against where Claude Code actually installs plugins.
- **Hook script startup cost.** Each hook spawns a fresh Node/tsx process. A `Stop` hook firing on every turn end has to be fast (< 200ms). The existing IPC is local socket → SQLite query, which is well under that, but worth measuring once.

## Out of scope for v0.2

- A native Claude Code "TUI toast" replacement — there's no API, so we drop countdowns rather than fake them.
- Subagent / Task event integration. Claude Code has richer subagent events (`SubagentStart`, `TaskCreated`), but premind doesn't model child sessions anyway.
- A Codex / Gemini CLI adapter. Same daemon, different adapter; out of scope but cleanly enabled by this restructure.
