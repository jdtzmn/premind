# Plan: Support Codex Plugins in premind

## 1. Goal

Add a Codex Agent Plugin adapter for premind without duplicating the existing daemon, GitHub polling, worktree binding, subscription, or reminder-queue logic.

The plugin should support Codex CLI and Codex in the ChatGPT desktop app where local plugins and hooks are available. The Codex IDE extension does not currently support plugins.

The first release must be explicit about a platform limitation: a plugin hook can inject context while Codex is processing a lifecycle event, but it cannot wake an already-idle stock Codex CLI session when a later PR event arrives. Premind can therefore provide reliable **turn-boundary delivery** in a normal Codex plugin. True idle-session revival requires a separate Codex App Server integration or a future Codex ingress API.

## 2. Recommendation

Ship Codex support in two layers:

1. **Plugin mode (v1):** a portable Agent Plugin containing lifecycle hooks, a small premind skill, and a local stdio MCP bridge. It registers the Codex thread, manages worktree/PR subscriptions, and drains reminders at session and turn boundaries.
2. **Harness mode (future):** an optional premind-owned Codex App Server client for users who need Pi-equivalent automatic revival. It can call `turn/start` for an idle thread and `turn/steer` for an active turn, but it is a separate integration rather than a capability of plugin hooks.

Do not claim automatic idle wake-up for plugin mode.

## 3. What Codex Plugins Provide

A current portable plugin uses a root `plugin.json` with the Agent Plugins schema. It may include:

- `skills/` for reusable instructions;
- `mcp.json` for bundled MCP servers;
- `hooks/` for Codex lifecycle commands;
- assets and OpenAI-specific presentation metadata under `extensions.com.openai`.

Codex still accepts `.codex-plugin/plugin.json` as a compatibility fallback, but new premind packaging should use the portable root manifest.

Installed plugin hooks are non-managed hooks. Codex skips them until the user reviews and trusts the current hook definition. Trust is tied to the hook definition hash, so changing a command or configuration requires renewed review.

Hook commands:

- receive one JSON object on stdin;
- run with the session `cwd`;
- receive `PLUGIN_ROOT` and writable `PLUGIN_DATA` paths;
- also receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` compatibility variables;
- may return structured JSON on stdout;
- should be dependency-closed and fast.

## 4. Lifecycle Capability Mapping

| Premind need | Codex event/mechanism | Support level | Design |
| --- | --- | ---: | --- |
| Register a root session | `SessionStart` | Native | Ensure the daemon, register the Codex `session_id`, reconcile the current `cwd`, and return concise setup/context information. |
| Handle resume/clear/compact | `SessionStart.source` | Native | Make registration idempotent. Treat `startup`, `resume`, and `clear` as full reconciliation; treat `compact` as a lightweight refresh. |
| Mark a turn busy | `UserPromptSubmit` | Native | Update daemon session state before the prompt proceeds. Also drain an older queued reminder into `additionalContext` so it is not delayed another turn. |
| Detect normal turn completion | `Stop` | Native | Mark idle, claim one pending batch, and return `decision: "block"` with the reminder text to create one continuation turn. |
| Prevent reminder loops | `Stop.stop_hook_active` | Native | If true, do not inject another reminder in the same continuation chain; leave additional batches queued. |
| Handle interrupted work | `Interrupt` | Native, advisory | Best-effort mark the root session idle. Keep execution below the event's three-second maximum. |
| End/cleanup a session | `SessionEnd` | Native, delayed | Unregister the root session. Codex may emit this on close/archive/delete or after roughly 30 minutes with no connected client; switching threads is not an immediate end signal. |
| Distinguish subagents | `SubagentStart` / `SubagentStop` | Native | Ignore for v1. Premind subscriptions belong to the root session, and Codex supplies the parent session ID to subagent hooks. |
| Activate a different worktree | MCP tool or skill-guided helper | Native when explicit | Expose `premind_activate_worktree`. Do not infer a durable worktree change from a shell command containing `cd`. |
| Subscribe/unsubscribe PRs | MCP tools | Native | Expose `premind_subscribe` and `premind_unsubscribe` over the existing daemon IPC operations. |
| Show status/prune | MCP tools | Native | Expose `premind_status` and `premind_prune`. |
| Inject a reminder already queued when a turn stops | `Stop` continuation | Native | Deliver immediately at the boundary; acknowledge the batch only after the hook has produced valid output. |
| Wake an idle session for a later PR event | None in stock plugin/CLI | **Unsupported** | Queue durably and deliver on the next `SessionStart`, `UserPromptSubmit`, or `Stop`. Offer App Server mode later. |
| Show Pi/OpenCode-style countdown UI | None | Unsupported | Omit it rather than simulate it with noisy messages. |

### Why async hooks do not solve idle wake-up

An async command hook can finish after its triggering operation, but Codex only makes its informational output available at a later safe point. If no turn is active, the result waits for the next user turn; completion does not start a new turn. Async hooks also cannot block or rewrite the operation that launched them.

### Why MCP notifications do not solve it

Codex can call MCP tools, but the stock interactive CLI does not currently provide a documented route that converts arbitrary inbound MCP notifications into a new user turn. Open requests in `openai/codex` track both an idle wake primitive and inbound MCP notification delivery.

## 5. Reminder Delivery Contract

Plugin mode should use at-least-once durable queueing with at-most-one continuation per turn boundary.

### `SessionStart`

1. Parse and validate `session_id`, `cwd`, and `source`.
2. Ensure the premind daemon is running.
3. Idempotently register or reconcile the root session.
4. Activate `cwd` as the current worktree for `startup`, `resume`, and `clear`.
5. Check for an older pending batch.
6. If one exists, return it as `hookSpecificOutput.additionalContext` and acknowledge successful hook emission.
7. Fail open on premind errors, returning an optional concise `systemMessage` rather than preventing Codex startup.

### `UserPromptSubmit`

1. Mark the session busy.
2. Check for a queued reminder that arrived while Codex was idle.
3. If found, attach it as `hookSpecificOutput.additionalContext` before the user's prompt reaches the model.
4. Acknowledge delivery only after valid hook output is ready.
5. Never block the user's prompt because premind is unavailable.

### `Stop`

1. Mark the session idle.
2. If `stop_hook_active` is true, return an empty success to prevent recursive continuation.
3. Claim one pending reminder from the daemon.
4. If none exists, allow the turn to stop immediately.
5. Mark the batch `handed_off`.
6. Return `{ "decision": "block", "reason": reminderText }` so Codex creates a continuation prompt.
7. Mark the batch confirmed when the hook command has successfully emitted the accepted JSON. If process or IPC completion fails, mark it failed for retry.

Do not retain the current idle delivery threshold in Codex plugin mode. Once `Stop` returns, no future event is guaranteed before the next user prompt, so waiting for a threshold would strand the reminder. The Codex adapter should deliver any batch already pending at `Stop` immediately. A Codex-specific config option may disable automatic continuation, in which case all batches wait for the next user prompt or manual flush.

### `Interrupt`

Best-effort update the session to idle with a strict timeout. Do not fetch or inject reminders because `Interrupt` output cannot restart the turn.

### `SessionEnd`

Mark the session closed and release any adapter-owned resources. The daemon's durable session and subscription state remains authoritative if the hook does not run or times out.

## 6. Session Identity and MCP Tools

Codex hook payloads include `session_id`; ordinary MCP tool calls do not document an equivalent thread identifier. This must be resolved before implementing the MCP control surface.

Use this safe resolution order:

1. Prefer a documented Codex-provided thread/session identifier if the target version supplies one to plugin MCP processes.
2. Otherwise have `SessionStart` persist a binding under `PLUGIN_DATA` and inject a concise opaque premind session handle into developer context.
3. MCP tools accept that handle and validate it against the daemon.
4. If the handle is omitted, resolve by `cwd` only when exactly one live root session matches.
5. If multiple sessions share a worktree, return an explicit ambiguity error; never guess.

The initial MCP tool surface should match the implemented Pi controls:

- `premind_status`
- `premind_activate_worktree({ path })`
- `premind_subscribe({ prNumber, repo? })`
- `premind_unsubscribe({ prNumber, repo? })`
- `premind_prune`
- `premind_flush` (manual turn-boundary drain; it cannot independently wake an idle thread)

Keep the MCP process a thin stdio-to-Unix-socket bridge. GitHub polling, state, and reminder construction stay in the daemon.

## 7. Proposed Source and Package Layout

```text
src/
  client/
    daemon-client.ts          # extracted host-neutral IPC client
    daemon-launcher.ts        # extracted host-neutral launcher
    git-context.ts            # shared worktree/repo detection
  codex/
    hook-runner.ts            # stdin parsing and event dispatch
    lifecycle.ts              # SessionStart/UserPromptSubmit/Stop/etc.
    mcp-server.ts             # stdio MCP-to-daemon bridge
    session-binding.ts        # PLUGIN_DATA handle persistence/resolution
    output.ts                 # exact Codex hook response builders
    __tests__/
  daemon/                     # unchanged except narrowly required IPC additions
  extension/                  # Pi adapter
  plugin/                     # OpenCode adapter

plugins/
  premind/
    plugin.json
    mcp.json
    hooks/
      hooks.json
    skills/
      premind/
        SKILL.md
    assets/
    dist/
      premind-hook.mjs        # bundled, dependency-closed runtime
      premind-mcp.mjs         # bundled, dependency-closed runtime

.agents/plugins/
  marketplace.json            # repository-local development marketplace
```

Extract only the genuinely host-neutral files from `src/plugin/`; do not rename the entire OpenCode adapter. Update imports in `src/plugin/` and `src/extension/` as a behavior-preserving refactor.

Bundle the Codex hook and MCP entries into dependency-closed JavaScript. A marketplace installed from Git or a copied local directory cannot assume `tsx`, Bun, a package install step, or repository `node_modules`. Use `node` as the manifest command and `${PLUGIN_ROOT}` only in arguments, because the portable MCP schema does not expand it in `command`.

## 8. Manifest Sketches

### `plugins/premind/plugin.json`

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "premind",
  "version": "0.2.0",
  "description": "Keep Codex sessions up to date with pull request changes.",
  "repository": "https://github.com/jdtzmn/premind",
  "license": "MIT",
  "extensions": {
    "com.openai": {
      "hooks": "./hooks/hooks.json",
      "interface": {
        "displayName": "premind",
        "shortDescription": "Bring new PR context into Codex turns",
        "category": "Developer Tools",
        "capabilities": ["Read", "Write"]
      }
    }
  }
}
```

### `plugins/premind/hooks/hooks.json`

```json
{
  "description": "Synchronize Codex session lifecycle with premind.",
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "node ${PLUGIN_ROOT}/dist/premind-hook.mjs SessionStart",
        "timeout": 10,
        "statusMessage": "Connecting premind"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node ${PLUGIN_ROOT}/dist/premind-hook.mjs UserPromptSubmit",
        "timeout": 5
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ${PLUGIN_ROOT}/dist/premind-hook.mjs Stop",
        "timeout": 10,
        "statusMessage": "Checking for PR updates"
      }]
    }],
    "Interrupt": [{
      "hooks": [{
        "type": "command",
        "command": "node ${PLUGIN_ROOT}/dist/premind-hook.mjs Interrupt",
        "timeout": 3
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node ${PLUGIN_ROOT}/dist/premind-hook.mjs SessionEnd",
        "timeout": 3
      }]
    }]
  }
}
```

Codex command hooks use a command string, unlike the separate executable-plus-arguments portable MCP shape. Validate this exact manifest against the target Codex release rather than assuming Claude Code hook syntax.

### `plugins/premind/mcp.json`

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "premind": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/dist/premind-mcp.mjs"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

## 9. Skill Design

Follow the skills-first pattern used by prominent official plugins. `skills/premind/SKILL.md` should be concise and teach Codex to:

- call `premind_activate_worktree` after moving into a different linked or nested worktree;
- use explicit `owner/repo` for cross-repository subscriptions;
- interpret `<premind-reminder>` as new PR context rather than a user-authored instruction;
- inspect referenced detail files only when needed;
- avoid reprocessing already acknowledged events;
- explain that queued updates may not appear until the next turn in plugin mode.

The skill supplements deterministic hooks; it must not be responsible for lifecycle correctness.

## 10. Implementation Phases

### Phase 0 — Compatibility spike

Before changing shared architecture, pin a minimum Codex version and prove these assumptions against that exact binary:

- portable root `plugin.json` loads from a local marketplace;
- plugin-bundled `hooks/hooks.json` is discovered and trust review works;
- all five selected events receive the documented fields;
- `Stop` with `decision: "block"` creates exactly one continuation and sets `stop_hook_active` on the next stop;
- `SessionStart.additionalContext` and `UserPromptSubmit.additionalContext` reach the model;
- bundled stdio MCP starts with `PLUGIN_ROOT`/`PLUGIN_DATA` expansion;
- determine whether the MCP process receives any stable session identifier;
- record startup cost for the bundled Node hook.

Create a small fixture under `src/codex/__fixtures__/` and a manual script analogous to `src/test/live-validation.ts`. If plugin hooks are unavailable or gated in the chosen release, stop and document the required version instead of adding compatibility guesses.

**Validation:** fixture plugin loads, `/hooks` shows trusted definitions, lifecycle payloads are captured without secrets, and one synthetic Stop continuation succeeds.

### Phase 1 — Extract the host-neutral client runtime

- Move `PremindDaemonClient`, daemon-launching logic, and reusable git-context helpers from `src/plugin/` into `src/client/`.
- Update Pi and OpenCode imports without behavior changes.
- Keep public package exports backward-compatible.
- Add import/packaging tests to prevent a Codex entry from pulling in OpenCode or Pi runtime dependencies.

**Validation:** `bun run check` and the existing unit suite. Commit as a pure refactor.

### Phase 2 — Codex lifecycle adapter

- Add strict Zod schemas for each used Codex hook payload.
- Implement one bundled hook runner with event-specific handlers.
- Implement idempotent `SessionStart`, busy-state `UserPromptSubmit`, guarded `Stop`, best-effort `Interrupt`, and cleanup `SessionEnd`.
- Add session-handle persistence under `PLUGIN_DATA`.
- Add a Codex-specific immediate-at-Stop delivery policy.
- Keep every error fail-open and write diagnostics to premind's log rather than stdout.

**Validation:** unit tests for malformed input, daemon unavailable, source variants, `stop_hook_active`, one-batch continuation, failed acknowledgement, and three-second teardown/interrupt budgets. Commit.

### Phase 3 — MCP bridge and skill

- Implement a dependency-light stdio MCP bridge over `PremindDaemonClient`.
- Add safe session resolution and ambiguity errors.
- Expose status, activate-worktree, subscribe, unsubscribe, prune, and flush.
- Add `skills/premind/SKILL.md` with the explicit-worktree and turn-boundary guidance.

**Validation:** protocol tests for tool discovery and each IPC round trip; two sessions in the same cwd must fail ambiguous lookup rather than cross-route. Commit.

### Phase 4 — Portable packaging and marketplace

- Add `plugins/premind/plugin.json`, `mcp.json`, hooks, assets, and bundled runtime artifacts.
- Add a repository-local `.agents/plugins/marketplace.json` entry for development.
- Add deterministic build and manifest-schema validation scripts.
- Add `npm pack --dry-run` assertions for every runtime file.
- Document hook trust, Node requirements, GitHub authentication, network use, writable paths, and uninstall behavior.

**Validation:** install from the local marketplace into a clean Codex home, start a new session, trust hooks, list MCP tools, and verify no repository `node_modules` dependency. Commit.

### Phase 5 — End-to-end delivery and hardening

Test against a real PR in at least these scenarios:

1. PR update arrives while a Codex turn is busy and is delivered by `Stop`.
2. PR update arrives while Codex is idle and is delivered as context on the next user prompt.
3. A pending reminder exists when a session resumes and is delivered by `SessionStart`.
4. Stop continuation does not recurse.
5. Hook process crashes after handoff and the batch retries without loss.
6. Two Codex sessions share one PR watcher but maintain independent cursors.
7. Two sessions share one cwd without MCP cross-routing.
8. Linked-worktree activation changes only the automatic subscription and preserves manual subscriptions.
9. Daemon restart does not duplicate a confirmed reminder.
10. Untrusted or changed hooks are visibly skipped and documented recovery uses `/hooks`.

**Validation:** targeted live test plus the complete test suite. Commit.

### Phase 6 — Optional App Server wake mode

Treat this as a separate feature after plugin mode is stable.

- Run or connect to `codex app-server` over a local Unix socket or authenticated WebSocket.
- Let premind own the client connection and thread subscriptions.
- On a reminder, call `turn/start` when the target thread is idle or `turn/steer` when policy permits during an active turn.
- Preserve dedupe, approval, sandbox, and user-visible provenance.
- Do not attempt to attach to an arbitrary already-running stock TUI unless Codex documents that capability.

This mode can eventually match Pi's `triggerTurn: true` behavior, but it changes how the Codex client is launched and operated.

## 11. Tests and Acceptance Criteria

Codex plugin support is ready when:

- the plugin installs from a local/repo marketplace using the portable manifest;
- Codex discovers and allows the user to trust the bundled hooks;
- session registration and cleanup are idempotent;
- startup, prompt submission, normal stop, interruption, and session end cannot crash or block Codex when premind fails;
- worktree activation and manual subscription tools route to the correct root session;
- a PR update queued during a busy turn produces one Stop continuation;
- an update queued while idle appears on the next session/prompt boundary;
- delivery acknowledgements survive daemon and hook-process failures without silent loss;
- bundled scripts run from the plugin cache without source checkout dependencies;
- documentation clearly says plugin mode does not wake an idle stock Codex session;
- Pi and OpenCode behavior and tests remain unchanged.

## 12. Popular Plugin Source Review

The implementation should borrow patterns, not code, from these public examples:

| Plugin/source | Observed pattern | Lesson for premind |
| --- | --- | --- |
| [OpenAI Figma plugin](https://github.com/openai/plugins/tree/main/plugins/figma) | Skills, HTTP MCP, app/UI metadata, commands, scripts, and a `PostToolUse` parity-check hook. The hook script labels itself a draft example. | Useful full-layout reference, but not proof of production lifecycle reliability. Use plugin-root-anchored commands rather than cwd-relative scripts. |
| [OpenAI Build Web Apps](https://github.com/openai/plugins/tree/main/plugins/build-web-apps) | Six narrow, composable skills and no observed hooks or MCP server. | Prefer a small skills-first surface; add executable hooks only for deterministic lifecycle needs. |
| [Superpowers package](https://github.com/openai/plugins/tree/main/plugins/superpowers) / [upstream](https://github.com/obra/superpowers) | Broad workflow behavior implemented primarily as skills; the packaged manifest has an empty hooks object. | Instructions alone can be powerful, but premind's durable registration/delivery still requires hooks. |
| [Plugin Eval](https://github.com/openai/plugins/tree/main/plugins/plugin-eval) | Skills invoke a deterministic local CLI; includes tests, fixtures, and isolated evaluation workspaces. | Separate deterministic protocol/manifest tests from live Codex benchmarks. |
| [context-mode](https://github.com/mksglu/context-mode) | Codex-native plugin with `SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, and `Stop` Node hooks plus a bundled MCP server. | Best lifecycle packaging reference. Premind should use a much smaller hook surface and audit every executable path. |
| [CrowdStrike Foundry skills](https://github.com/CrowdStrike/foundry-skills) | Hub-and-spoke skills with colocated references/scripts; its shell hooks are documented as Claude-specific rather than exposed by its Codex manifest. | Keep host capabilities explicit and do not assume a Claude hook works in Codex merely because event names overlap. |
| [Qodo skills](https://github.com/qodo-ai/qodo-skills/tree/main/codex-packages/qodo) | Host-specific generated package, focused skills, explicit CLI setup and authentication. | Separate installation, authentication, and subscription; installing premind must not silently grant access or subscribe to PRs. |

At the research snapshot, `openai/plugins` was the authoritative curated collection. Popularity numbers are volatile and should not drive architecture; official inclusion, actual source layout, and lifecycle behavior are more useful signals.

## 13. Risks

- **No native idle ingress:** the principal product gap. Mitigate with honest plugin-mode semantics and a separate App Server track.
- **Hook feature/version drift:** hooks and plugin loading have changed quickly. Pin and test a minimum Codex version.
- **Trust friction:** installs do not imply hook trust. Make `/hooks` review part of onboarding and troubleshooting.
- **Session identity ambiguity:** do not route MCP actions by cwd when multiple sessions match.
- **Hook timeout and latency:** bundle JavaScript, avoid spawning `tsx`, and keep lifecycle IPC bounded.
- **Delivery acknowledgement semantics:** hook output acceptance is weaker than proof that the model acted on it. Preserve durable IDs and at-least-once retry behavior.
- **Plugin cache updates:** Codex loads installed copies from its plugin cache. Document restart/reinstall steps for local development.
- **Public directory constraints:** premind depends on local scripts and a local daemon. Local/repo marketplaces are the initial distribution target; public submission may require a different hosted architecture or explicit OpenAI support for local MCP execution.
- **Security:** reminder text and PR content are untrusted external input. Label their provenance and never treat arrival as authorization for side effects.

## 14. Source References

- [Build plugins](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Use plugins in Codex](https://developers.openai.com/codex/plugins)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Agent Plugins MCP server schema](https://agent-plugins.org/plugin-authors/mcp-servers)
- [OpenAI plugin examples](https://github.com/openai/plugins)
- [Codex issue: native event-driven session wake](https://github.com/openai/codex/issues/20312)
- [Codex issue: inbound MCP notifications](https://github.com/openai/codex/issues/15299)
- [Codex issue: inject into existing sessions](https://github.com/openai/codex/issues/11415)
