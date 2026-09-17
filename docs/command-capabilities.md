# Premind Command Capabilities

This matrix is generated from `src/shared/command-capabilities.ts`. Harness-visible names may differ only when they are explicitly declared here.

| Capability | Classification | Scope | Canonical | Pi | Claude Code | OpenCode |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | common | daemon | commands `/premind:status`<br>tools `premind_status` | commands `/premind:status`<br>tools `premind_status` | commands `/premind:status`<br>tools `status` | commands `/premind-status`<br>tools `premind_status` |
| `doctor` | common | daemon | commands `/premind:doctor`<br>tools `premind_doctor` | commands `/premind:doctor`<br>tools `premind_doctor` | commands `/premind:doctor`<br>tools `probe` | commands `/premind:doctor`<br>tools `premind_probe` |
| `deliver` | common | session | commands `/premind:deliver`<br>tools `premind_deliver` | commands `/premind:deliver`<br>tools `premind_deliver`<br>deprecated command aliases `/premind:flush` | commands `/premind:deliver` | commands `/premind:deliver`<br>tools `premind_deliver`<br>deprecated command aliases `/premind-send-now`<br>deprecated tool aliases `premind_send_now` |
| `enable` | common | daemon | commands `/premind:enable`<br>tools `premind_enable` | commands `/premind:enable`<br>tools `premind_enable` | commands `/premind:enable`<br>tools `enable` | commands `/premind-enable`<br>tools `premind_enable` |
| `disable` | common | daemon | commands `/premind:disable`<br>tools `premind_disable` | commands `/premind:disable`<br>tools `premind_disable` | commands `/premind:disable`<br>tools `disable` | commands `/premind-disable`<br>tools `premind_disable` |
| `set-active-checkout` | common | session | commands `/premind:set-active-checkout`<br>tools `premind_set_active_checkout` | commands `/premind:set-active-checkout`<br>tools `premind_set_active_checkout` | tools `set_active_checkout` | tools `premind_set_active_checkout` |
| `subscribe` | common | session | commands `/premind:subscribe`<br>tools `premind_subscribe` | commands `/premind:subscribe`<br>tools `premind_subscribe` | commands `/premind:subscribe`<br>tools `subscribe` | tools `premind_subscribe` |
| `unsubscribe` | common | session | commands `/premind:unsubscribe`<br>tools `premind_unsubscribe` | commands `/premind:unsubscribe`<br>tools `premind_unsubscribe` | commands `/premind:unsubscribe`<br>tools `unsubscribe` | tools `premind_unsubscribe` |
| `prune` | adapter-specific | daemon | commands `/premind:prune` | commands `/premind:prune` | — | — |

## Intentional exceptions

- `status` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `status` / opencode / commands: OpenCode retains its established hyphenated status command.
- `doctor` / claude / tools: Claude retains the existing probe MCP tool name.
- `doctor` / opencode / tools: OpenCode retains the existing premind_probe tool name.
- `deliver` / claude / tools: Claude delivery remains owned by the Stop hook.
- `enable` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `enable` / opencode / commands: OpenCode retains its established hyphenated enable command.
- `disable` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `disable` / opencode / commands: OpenCode retains its established hyphenated disable command.
- `set-active-checkout` / claude / commands: Claude currently exposes this as a model tool.
- `set-active-checkout` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `set-active-checkout` / opencode / commands: OpenCode currently exposes this as a model tool.
- `subscribe` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `subscribe` / opencode / commands: OpenCode currently exposes this as a model tool.
- `unsubscribe` / claude / tools: Claude MCP tools omit the premind_ prefix.
- `unsubscribe` / opencode / commands: OpenCode currently exposes this as a model tool.
- `prune` is Pi-specific administrative maintenance and is not model-callable.
- Claude status remains aggregate and redacted; Pi and OpenCode may expose session detail.
- Delivery mechanics remain harness-specific even though `/premind:deliver` is canonical.
