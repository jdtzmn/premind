---
description: Subscribe the current Claude Code session to a pull request with Premind.
---

# Subscribe with Premind

Use the `mcp__plugin_premind_premind__subscribe` tool to subscribe the current Claude Code session to the requested pull request. The plugin binds the operation to this session through Claude Code's `CLAUDE_CODE_SESSION_ID`; do not request or supply a session ID.

`writePolicy` is optional. Omit it for safe observation-only tracking; use `user-authorized` only when the user explicitly authorizes writes, and `owned-active` only for an automatically discovered PR owned by the authenticated account.
