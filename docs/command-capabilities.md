# Premind Command Capabilities

This matrix is generated from `src/shared/command-capabilities.ts`. Harness-visible names may differ only when they are explicitly declared here.

| Capability | Classification | Scope | Pi | Claude Code | OpenCode |
| --- | --- | --- | --- | --- | --- |
| `status` | common | daemon | commands `/premind:status`<br>tools `premind_status` | commands `/premind:status`<br>tools `status` | commands `/premind-status`<br>tools `premind_status` |
| `doctor` | common | daemon | commands `/premind:doctor`<br>tools `premind_doctor` | commands `/premind:doctor`<br>tools `probe` | commands `/premind:doctor`<br>tools `premind_probe` |
| `deliver` | common | session | commands `/premind:deliver`, `/premind:flush`<br>tools `premind_deliver` | commands `/premind:deliver` | commands `/premind:deliver`, `/premind-send-now`<br>tools `premind_deliver`, `premind_send_now` |
| `enable` | common | daemon | commands `/premind:enable`<br>tools `premind_enable` | commands `/premind:enable`<br>tools `enable` | commands `/premind-enable`<br>tools `premind_enable` |
| `disable` | common | daemon | commands `/premind:disable`<br>tools `premind_disable` | commands `/premind:disable`<br>tools `disable` | commands `/premind-disable`<br>tools `premind_disable` |
| `set-active-checkout` | common | session | commands `/premind:set-active-checkout`<br>tools `premind_set_active_checkout` | tools `set_active_checkout` | tools `premind_set_active_checkout` |
| `subscribe` | common | session | commands `/premind:subscribe`<br>tools `premind_subscribe` | commands `/premind:subscribe`<br>tools `subscribe` | tools `premind_subscribe` |
| `unsubscribe` | common | session | commands `/premind:unsubscribe`<br>tools `premind_unsubscribe` | commands `/premind:unsubscribe`<br>tools `unsubscribe` | tools `premind_unsubscribe` |
| `prune` | adapter-specific | daemon | commands `/premind:prune` | — | — |

## Intentional exceptions

- `deliver` / claude / tools: Claude delivery remains owned by the Stop hook.
- `set-active-checkout` / claude / commands: Claude currently exposes this as a model tool.
- `set-active-checkout` / opencode / commands: OpenCode currently exposes this as a model tool.
- `subscribe` / opencode / commands: OpenCode currently exposes this as a model tool.
- `unsubscribe` / opencode / commands: OpenCode currently exposes this as a model tool.
- `prune` is Pi-specific administrative maintenance and is not model-callable.
- Claude status remains aggregate and redacted; Pi and OpenCode may expose session detail.
- Delivery mechanics remain harness-specific even though `/premind:deliver` is canonical.
