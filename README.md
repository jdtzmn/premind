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

## Commands

premind registers three slash commands automatically:

- `/premind-status` — show current daemon state, attached sessions, and pending reminder counts
- `/premind-pause` — pause reminders for the current session (events still accumulate)
- `/premind-resume` — resume reminders for the current session

These also work as tools that the model can call directly (e.g., if you ask "show premind status").

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
