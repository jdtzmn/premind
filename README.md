# premind

OpenCode plugin that keeps sessions up to date with pull request changes.

When a PR receives new comments, review feedback, check results, or merge conflicts, premind detects the changes and injects a `<system-reminder>` into your active OpenCode session at the next idle window — so the assistant resumes with the latest context without you switching tabs.

## Install

### From GitHub (recommended)

Add `premind` to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:jdtzmn/premind"]
}
```

OpenCode will install it automatically on next startup.

### From npm

If published to npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["premind"]
}
```

### From local checkout

Clone the repo and symlink or copy the plugin into your OpenCode plugin directory:

```sh
git clone https://github.com/jdtzmn/premind.git
cd premind && bun install

# Option A: symlink into global plugins
ln -s "$(pwd)/src/plugin/index.ts" ~/.config/opencode/plugins/premind.ts

# Option B: symlink into project plugins
ln -s "$(pwd)/src/plugin/index.ts" .opencode/plugins/premind.ts
```

## How it works

1. When OpenCode loads premind, the plugin starts a local daemon process.
2. The daemon discovers the open PR for your current branch.
3. It polls GitHub for new comments, reviews, check results, merge conflicts, and other changes.
4. When changes arrive while the session is busy, they are queued.
5. When the session becomes idle, premind injects a single `<system-reminder>` message with the incremental changes.
6. OpenCode processes the reminder like a normal follow-up prompt, and your existing notification setup fires when the model completes.

## Configuration

Premind's config lives in a sibling file next to `opencode.jsonc`:

- **macOS / Linux:** `~/.config/opencode/premind.jsonc`

The file is created with a commented-out template the first time premind starts. Configuration is deliberately **not** put into `opencode.jsonc` — opencode's schema validator rejects unknown top-level keys as a hard startup failure.

### Available settings

| Field | Type | Default | Env var |
| --- | --- | --- | --- |
| `idleDeliveryThresholdMs` | integer (ms, min 5000) | `60000` | `PREMIND_IDLE_DELIVERY_THRESHOLD_MS` |

More fields will be added as they become real features.

### Example

```jsonc
// ~/.config/opencode/premind.jsonc
{
  // Wait 15 seconds of idle before delivering PR updates.
  "idleDeliveryThresholdMs": 15000
}
```

### Precedence

Each field's effective value is resolved in this order (highest wins):

1. Environment variable (`PREMIND_<FIELD_IN_UPPER_SNAKE>`)
2. `~/.config/opencode/premind.jsonc`
3. Schema default

Malformed files and invalid env values are logged once and ignored — premind will keep running on defaults rather than fail to start.

### Migration note

Earlier versions documented a top-level `premind` key inside `opencode.jsonc`. That location was never actually usable — opencode's schema validator treats unknown top-level keys as a configuration error and refuses to start. If you previously tried to set premind config there and saw an error, this release is the fix: move your settings to `~/.config/opencode/premind.jsonc`.

## Commands

premind registers these slash commands automatically:

- `/premind-status` — show current daemon state, attached sessions, and pending reminder counts
- `/premind-pause` — pause reminders for the current session (events still accumulate)
- `/premind-resume` — resume reminders for the current session
- `/premind-send-now` — send pending PR updates to the current session immediately, skipping the idle countdown
- `/premind-disable` — disable premind globally (stops GitHub polling across all sessions and projects — useful if you hit API rate limits)
- `/premind-enable` — re-enable premind globally; polling resumes on the next scheduler tick

These also work as tools that the model can call directly (e.g., if you ask "show premind status" or "disable premind — I'm hitting rate limits").

`/premind-disable` is a daemon-wide kill switch: the daemon stays up and sessions keep registering, but no GitHub API calls are made until you re-enable. The flag is persisted in SQLite, so it survives daemon restarts. Queued events are preserved and delivered as normal once you re-enable.

premind also exposes a `premind_probe` tool that returns runtime diagnostics. This is useful if you want to verify that the plugin actually initialized even when slash commands are not showing up yet.

## Debugging

premind writes plugin runtime state to:

- macOS: `~/Library/Application Support/premind/plugin-runtime.json`

This file records whether the plugin initialized, whether the daemon started, whether the client registered, and whether commands were registered.

If you're debugging a local install, useful checks are:

```sh
cat ~/Library/Application\ Support/premind/plugin-runtime.json
ls ~/.cache/opencode/node_modules/premind/
ls /var/folders/*/*/*/T/premind.sock 2>/dev/null
```

## Requirements

- OpenCode
- `gh` CLI authenticated with access to your repository
- `bun` or `tsx` available in PATH (for the daemon process)

## Architecture

See [PLAN.md](./PLAN.md) for the full design document.

The system has two runtime components:

- **Plugin** — thin OpenCode hook that registers sessions, observes idle/busy transitions, registers commands/tools, and injects reminders
- **Daemon** — local background process that polls GitHub, diffs PR snapshots, and manages per-session event queues with SQLite persistence

Multiple OpenCode sessions on the same PR share one daemon watcher. Each session has its own delivery cursor so reminders are incremental per session.

## Development

```sh
bun install
bun run check    # typecheck
bun run test     # all tests
bun run daemon   # start daemon manually
```
