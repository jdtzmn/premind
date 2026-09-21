---
description: Subscribe the current Claude Code session to a pull request with Premind.
---

# Subscribe with Premind

Use the `mcp__plugin_premind_premind__subscribe` tool to subscribe the current Claude Code session to the requested pull request. The plugin binds the operation to this session through Claude Code's `CLAUDE_CODE_SESSION_ID`; do not request or supply a session ID.

`writePolicy` is optional. Omit it to let Premind verify whether the authenticated GitHub user authored the PR on the session's active checkout; it remains observation-only until verified. Use `user-authorized` only for explicit user authorization, or `observe-only` to prevent automatic escalation.
