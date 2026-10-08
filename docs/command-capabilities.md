# Premind Command Capabilities

This matrix is generated from `src/shared/command-capabilities.ts`. Every harness must expose each canonical surface; any missing or renamed surface is declared below as an `unsupported`, `deferred`, or `host-naming` exception.

| Capability | Classification | Scope | Canonical | Pi | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `status` | common | daemon | commands `/premind:status`<br>tools `premind_status` | commands `/premind:status`<br>tools `premind_status` | commands `/premind:status`<br>tools `status` | commands `/premind-status`<br>tools `premind_status` | tools `premind_status` |
| `doctor` | common | daemon | commands `/premind:doctor`<br>tools `premind_doctor` | commands `/premind:doctor`<br>tools `premind_doctor` | commands `/premind:doctor`<br>tools `probe` | commands `/premind:doctor`<br>tools `premind_probe` | — |
| `deliver` | common | session | commands `/premind:deliver`<br>tools `premind_deliver` | commands `/premind:deliver`<br>tools `premind_deliver`<br>deprecated command aliases `/premind:flush` | commands `/premind:deliver` | commands `/premind:deliver`<br>tools `premind_deliver`<br>deprecated command aliases `/premind-send-now`<br>deprecated tool aliases `premind_send_now` | — |
| `enable` | common | daemon | commands `/premind:enable`<br>tools `premind_enable` | commands `/premind:enable`<br>tools `premind_enable` | commands `/premind:enable`<br>tools `enable` | commands `/premind-enable`<br>tools `premind_enable` | — |
| `disable` | common | daemon | commands `/premind:disable`<br>tools `premind_disable` | commands `/premind:disable`<br>tools `premind_disable` | commands `/premind:disable`<br>tools `disable` | commands `/premind-disable`<br>tools `premind_disable` | — |
| `set-active-checkout` | common | session | commands `/premind:set-active-checkout`<br>tools `premind_set_active_checkout` | commands `/premind:set-active-checkout`<br>tools `premind_set_active_checkout` | tools `set_active_checkout` | tools `premind_set_active_checkout` | tools `premind_set_active_checkout` |
| `subscribe` | common | session | commands `/premind:subscribe`<br>tools `premind_subscribe` | commands `/premind:subscribe`<br>tools `premind_subscribe` | commands `/premind:subscribe`<br>tools `subscribe` | tools `premind_subscribe` | tools `premind_subscribe` |
| `unsubscribe` | common | session | commands `/premind:unsubscribe`<br>tools `premind_unsubscribe` | commands `/premind:unsubscribe`<br>tools `premind_unsubscribe` | commands `/premind:unsubscribe`<br>tools `unsubscribe` | tools `premind_unsubscribe` | tools `premind_unsubscribe` |
| `pause` | common | session | commands `/premind:pause`<br>tools `premind_pause` | commands `/premind:pause`<br>tools `premind_pause` | commands `/premind:pause`<br>tools `pause` | commands `/premind:pause`<br>tools `premind_pause` | tools `premind_pause` |
| `resume` | common | session | commands `/premind:resume`<br>tools `premind_resume` | commands `/premind:resume`<br>tools `premind_resume` | commands `/premind:resume`<br>tools `resume` | commands `/premind:resume`<br>tools `premind_resume` | tools `premind_resume` |
| `prune` | adapter-specific | daemon | commands `/premind:prune` | commands `/premind:prune` | — | — | — |

## Deferred gaps

- `doctor` / Codex / tools: Codex does not yet expose a doctor MCP tool. (tracked in #77)
- `deliver` / Codex / tools: Codex does not yet expose a deliver MCP tool; lifecycle hooks may need to own delivery as Claude's Stop hook does. (tracked in #77)
- `enable` / Codex / tools: Codex does not yet expose an enable MCP tool. (tracked in #77)
- `disable` / Codex / tools: Codex does not yet expose a disable MCP tool. (tracked in #77)
- `set-active-checkout` / Claude Code / commands: Claude currently exposes this only as a model tool. (tracked in #77)
- `set-active-checkout` / OpenCode / commands: OpenCode currently exposes this only as a model tool. (tracked in #77)
- `subscribe` / OpenCode / commands: OpenCode currently exposes this only as a model tool. (tracked in #77)
- `unsubscribe` / OpenCode / commands: OpenCode currently exposes this only as a model tool. (tracked in #77)
- `prune` / Claude Code / commands: Only Pi exposes prune today. (tracked in #77)
- `prune` / OpenCode / commands: Only Pi exposes prune today. (tracked in #77)
- `subscribe` / OpenCode / parameter `writePolicy`: OpenCode subscriptions do not accept an explicit write policy yet. (tracked in #77)
- `subscribe` / Codex / parameter `writePolicy`: Codex subscriptions do not accept an explicit write policy yet. (tracked in #77)

## Other exceptions

- `status` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `status` / OpenCode / commands (host-naming): OpenCode retains its established hyphenated status command.
- `status` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `doctor` / Claude Code / tools (host-naming): Claude retains the existing probe MCP tool name.
- `doctor` / OpenCode / tools (host-naming): OpenCode retains the existing premind_probe tool name.
- `doctor` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `deliver` / Claude Code / tools (unsupported): Claude delivery remains owned by the Stop hook.
- `deliver` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `enable` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `enable` / OpenCode / commands (host-naming): OpenCode retains its established hyphenated enable command.
- `enable` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `disable` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `disable` / OpenCode / commands (host-naming): OpenCode retains its established hyphenated disable command.
- `disable` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `set-active-checkout` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `set-active-checkout` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `subscribe` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `subscribe` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `unsubscribe` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `unsubscribe` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `pause` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `pause` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `resume` / Claude Code / tools (host-naming): Claude MCP tools omit the premind_ prefix.
- `resume` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- `prune` / Codex / commands (unsupported): Codex plugins expose MCP tools and skills, not slash commands.
- skills / OpenCode (unsupported): OpenCode's npm plugin cannot install into OpenCode's skill discovery directories.

## Notes

- Claude status remains aggregate and redacted; Pi, OpenCode, and Codex may expose session detail.
- `pause` / `resume` act on one session and never change subscriptions; `enable` / `disable` act on every session, and their model tools refuse calls without `confirmGlobal: true`.
- Delivery mechanics remain harness-specific even though `/premind:deliver` is canonical.
