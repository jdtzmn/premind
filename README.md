# premind

OpenCode plugin that keeps sessions up to date with pull request changes.

When a PR receives new comments, review feedback, check results, or merge conflicts, premind detects the changes and injects a `<system-reminder>` into your active OpenCode session at the next idle window — so the assistant resumes with the latest context without you switching tabs.

## Install

### OpenCode

Premind targets OpenCode 2. Add it to `plugins` in `opencode.json(c)`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:jdtzmn/premind"]
}
```

Use `"premind"` instead once it is published to npm. One entry loads every part of the plugin: the server part (session tracking, delivery, tools, commands and the skill) and the TUI part (slash and palette commands that answer in a dialog or toast without starting a model turn). There is no separate TUI companion to install.

From a local checkout, point the entry at the checkout instead:

```sh
git clone https://github.com/jdtzmn/premind.git
cd premind && bun install
```

```json
{ "plugins": ["/absolute/path/to/premind"] }
```

#### Upgrading from OpenCode 1

OpenCode 1 plugins do not run in OpenCode 2, and this release drops the OpenCode 1 plugin. Move the entry from the old `plugin` key to `plugins`, and remove any `tui.json` entry for `src/plugin-opencode/tui.ts` or symlinks into `~/.config/opencode/plugins/`. Reminders now arrive as soon as the session goes idle, so `~/.config/opencode/premind.jsonc` and its `idleDeliveryThresholdMs` setting are no longer read; delete the file. Daemon state, subscriptions and pauses carry over.

## Claude Code plugin (v0.2)

Install the self-contained Claude plugin from a checkout or released package root:

```sh
claude plugin install /path/to/premind/plugin-claude
```

When installing directly from a source checkout, run `bun run build:runtime` before `claude plugin install`. Released package contents already include the generated bundles.

The plugin requires **Node 22.13+** for `node:sqlite`. Its hooks start or reuse a shared local daemon from `plugin-claude/generated/premind-daemon.mjs`; a Claude install does not need Bun, `tsx`, a repository checkout, or repository-root `node_modules` at runtime. The launcher probes the shared socket, coordinates startup with a state-directory lock, and fails open if the daemon cannot start.

Claude reminders are delivered only at a `Stop` boundary. A delivered batch is confirmed on Claude's next continuation Stop hook; interrupted handoffs become retryable, so duplicates are preferred to lost reminders. Inactive Claude sessions are not woken in v0.2.

The plugin exposes namespaced MCP tools for `status`, `probe`, global `enable`/`disable`, and session-scoped `pause`, `resume`, `set_active_checkout`, `subscribe`, and `unsubscribe`. Set the active checkout at the start of any PR work—including when already in the startup checkout—and again after switching branches before creating or following a PR. Session-scoped tools derive the session solely from `CLAUDE_CODE_SESSION_ID`; missing or mismatched hook/MCP identity fails closed and asks you to reload the plugin. Claude commands are `/premind:status`, `/premind:doctor`, `/premind:deliver`, `/premind:pause`, `/premind:resume`, `/premind:enable`, `/premind:disable`, `/premind:subscribe`, and `/premind:unsubscribe`. `/premind:deliver` ends its command turn immediately so the normal Stop hook can deliver queued reminders safely.

For an opt-in authenticated Claude CLI compatibility check (not part of CI), run:

```sh
bun run test:claude:live-contract
```

It creates a temporary plugin and verifies fresh and resumed hook/MCP session IDs. It reports a skip when the Claude CLI is unavailable or unauthenticated.

## Codex plugin (v0.1)

Install Premind from the repository-local marketplace or from the same layout in a released package:

```sh
codex plugin marketplace add /path/to/premind
codex plugin add premind@premind
```

The marketplace installs the Codex compatibility package from `plugins/codex/premind`. It supports **Codex CLI 0.155.1 or newer**. The portable Agent Plugins package remains available at `plugins/premind`; keeping the two entrypoints separate lets current Codex releases load lifecycle hooks through `.codex-plugin/plugin.json` while preserving the universal package for hosts that support it.

Review and trust Premind's lifecycle hooks before enabling them. The plugin uses `SessionStart`, `UserPromptSubmit`, `Stop`, `Interrupt`, and `SessionEnd`; it deliberately does **not** install `PostToolUse`. If hooks are not running, open Codex's hook-management UI, review the commands, and trust the current plugin definition.

The installed plugin runs dependency-closed Node bundles from its own `generated/` directory. It requires **Node 22.13+**, `git`, and an authenticated GitHub CLI (`gh auth login`). Bun, `tsx`, a source checkout, and repository `node_modules` are not runtime prerequisites. Hooks use Codex-managed `PLUGIN_DATA` for local receipts and session handles; on Codex versions that do not inject it into plugin MCP processes, Premind resolves the same Codex-managed data directory from the installed plugin path. Premind only uses network access for GitHub polling.

Codex cannot wake an already-idle stock CLI thread. Updates found while idle remain durable and arrive at the next available `SessionStart`, `UserPromptSubmit`, or `Stop` boundary. An interrupted delivery may be shown again rather than silently lost.

After changing a local checkout, refresh the marketplace/plugin installation and re-review hooks. Remove the plugin with `codex plugin remove premind@premind`, then remove its marketplace source if it is no longer needed.
For a source checkout modified locally, run `bun run build:runtime` before refreshing so the marketplace sees updated bundles.

### Agent skills

Premind ships task-scoped Agent Skills for Codex (portable and compatibility plugins), Pi (`skills/premind` in the Pi package), the Claude Code plugin (`plugin-claude/skills/premind`), and the OpenCode plugin (`src/plugin-opencode-v2/skills/premind`, registered with OpenCode when the plugin loads). Each `SKILL.md` loads subscription and reminder guidance from its own `references/` only when relevant.

These files are generated, not hand-edited. After changing host control metadata in `src/shared/command-capabilities.ts` or `src/codex/mcp-server.ts`, or updating the shared guidance in `scripts/generate-premind-skills.ts`, run `bun run generate:skill` and `bun run test:skills` and commit the output. CI checks for drift.

For an opt-in model-based check of triggering and selective reference reads, run `bun run test:skills:live` (or append `codex` / `claude` to test those files through Pi's read-only skill runner). It uses an authenticated Pi model, makes no Premind tool calls, and is not a substitute for native Claude/Codex installation checks.

## How it works

1. When an OpenCode session first runs, the plugin starts a local daemon process if one is not already running.
2. The daemon discovers the open PR for your current branch and automatically watches it only when it was authored by the GitHub account Premind is authenticated as.
3. It polls watched PRs for new comments, reviews, check results, merge conflicts, and other changes.
4. When changes arrive while the session is busy, they are queued.
5. When the session becomes idle, premind queues a single `<system-reminder>` message with the incremental changes, labelled "Premind: pull request updates" in the transcript.
6. OpenCode processes the reminder like a normal follow-up prompt, and your existing notification setup fires when the model completes.

## Configuration

OpenCode passes plugin options from the `plugins` entry:

```json
{
  "plugins": [{ "package": "premind", "options": { "autoDeliver": false } }]
}
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `autoDeliver` | boolean | `true` | When `false`, updates wait for `/premind:deliver` or the `premind_deliver` tool instead of arriving when the session goes idle. |

## Commands

In the OpenCode TUI these commands answer in a dialog or toast and never start a model turn. In OpenCode Desktop, web and `opencode run`, the server registers the same commands; their result joins the transcript on the next turn.

- `/premind:status` — current-session watched PRs
- `/premind:debug-status` — daemon-wide all-session diagnostics (also available as `premind_debug_status` to agents)
- `/premind:doctor` — diagnose plugin, configuration, and daemon health
- `/premind:deliver` — deliver queued PR updates immediately at the earliest safe harness boundary
- `/premind-send-now` — deprecated OpenCode alias for `/premind:deliver`
- `/premind:subscribe <pr> [owner/repo]`, `/premind:unsubscribe <pr> [owner/repo]` — watch or stop watching a PR in this session
- `/premind:set-active-checkout <path>` — point this session at another checkout
- `/premind:prune` — remove closed sessions and their delivered reminder batches
- `/premind:pause` — pause reminders for this session only; subscriptions keep being watched
- `/premind:resume` — resume reminders for this session without changing subscriptions
- `/premind:disable` — disable GitHub polling globally
- `/premind:enable` — re-enable GitHub polling globally
- `/premind-status`, `/premind-enable`, `/premind-disable` — deprecated OpenCode aliases

The complete cross-harness command and tool matrix, including intentional exceptions, is documented in [Command Capabilities](docs/command-capabilities.md).

How plugins and the daemon stay compatible across releases, and how a newer daemon takes over, is documented in [Client–daemon protocol and upgrades](docs/protocol.md).

Pi and OpenCode expose `premind_set_active_checkout`, `premind_subscribe`, and `premind_unsubscribe` model tools plus `/premind:set-active-checkout`, `/premind:subscribe`, and `/premind:unsubscribe` commands. Set the active checkout at the start of any PR work—including when already in the startup checkout—and again after switching branches before creating or following a PR. Automatic watches are limited to PRs authored by Premind's authenticated GitHub account. Manual subscriptions may intentionally target an external `owner/repo`; their reminders include a guard that changes require explicit user instruction, and status/reminders use fully qualified `owner/repo#number` identities.

Every harness can pause and resume one session. Pi, Claude Code, and OpenCode provide `/premind:pause` and `/premind:resume`. Every harness provides model tools: `premind_pause` and `premind_resume`, or `pause` and `resume` in Claude Code's MCP server. Codex's tools take the session handle from lifecycle context. Pausing withholds reminders from the current session only. Every subscription stays watched, PR updates keep accumulating, and the pause lasts until you resume, including across a host reload or restart. Pause is not a substitute for the global `disable` / `enable` controls.

The global `enable` / `disable` model tools require `confirmGlobal: true` and refuse unconfirmed calls, so agents cannot mistake them for session controls. Codex does not have these tools yet (#77). `/premind:disable` is a daemon-wide kill switch: the daemon stays up and sessions keep registering, but no GitHub API calls are made until you re-enable. The flag is persisted in SQLite, so it survives daemon restarts. Queued events are preserved and delivered as normal once you re-enable.

premind also exposes a `premind_doctor` tool (`premind_probe` in older OpenCode releases, still accepted) that returns runtime diagnostics. This is useful if you want to verify that the plugin actually initialized even when slash commands are not showing up yet.

## Debugging

Run `/premind:doctor` (or ask the agent to call `premind_doctor`) for the plugin version, daemon lock and daemon build. `/premind:debug-status` lists every session the daemon knows about. The daemon socket lives at:

```sh
ls /var/folders/*/*/*/T/premind.sock 2>/dev/null
```

## Requirements

- OpenCode 2.4 or later
- `gh` CLI authenticated with access to your repository
- OpenCode/Pi: Node 22.5+ with the package's `tsx` dependency for the source daemon launcher
- Claude Code/Codex: Node 22.13+; Codex CLI 0.155.1+; installed plugins use self-contained generated bundles and do not require Bun, `tsx`, or repository `node_modules` at runtime

## Architecture

See [the initial implementation plan](./docs/plans/initial-implementation.md) for the full design document.

The system has two runtime components:

- **Plugin** — thin OpenCode plugin that registers sessions, observes idle/busy transitions, registers commands, tools and the skill, and queues reminders as synthetic messages
- **Daemon** — local background process that polls GitHub, diffs PR snapshots, and manages per-session event queues with SQLite persistence

Multiple OpenCode sessions on the same PR share one daemon watcher. Each session has its own delivery cursor so reminders are incremental per session.

## Development

```sh
bun install
bun run check    # typecheck
bun run test     # all tests
bun run daemon   # start daemon manually
```
