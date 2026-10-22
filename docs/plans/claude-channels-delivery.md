# Claude Channels Delivery Transport

## Status

**Research proposal only.** Do not implement or release this transport until Claude Code Channels leaves research preview and this plan's protocol-validation gate has passed. Premind's supported Claude delivery path remains the existing Stop-boundary handoff.

## Purpose

Evaluate an opt-in Claude Code Channels transport that delivers a queued Premind pull-request update into an already-open Claude session without waiting for a Stop hook. This transport must preserve Premind's per-session cursors, durable batching, and safety framing without requiring Claude to call an acknowledgement tool.

## Research basis

- [Claude Code Channels](https://code.claude.com/docs/en/channels) describes Channels as a research-preview MCP capability that injects external events into an open Claude session.
- [Channels reference](https://code.claude.com/docs/en/channels-reference) specifies `experimental["claude/channel"]` and `notifications/claude/channel`.
- `plugin-claude/bin/lib.mjs` currently uses a Stop-hook two-phase handoff.
- `plugin-claude/bin/mcp-server.mjs` is the long-lived, environment-bound stdio MCP server suitable to bridge local Premind state to Claude.
- `StateStore.claimReminderBundle` and `StateStore.ackReminderBundle` already provide atomic durable claim, confirmation, retry, cursor advancement, and stale-handoff recovery.

## Decision record

### Scope

Add Channels only as a Claude-specific, explicitly enabled preview transport. It must never change the default experience or require model-visible acknowledgement calls.

### Delivery contract

A successful `notifications/claude/channel` transport write is considered delivery. The plugin then confirms the exact claimed bundle in SQLite.

This is intentionally weaker than the current Stop continuation contract:

- A successful transport write does **not** prove that Claude displayed, read, or acted on the update.
- If the process or daemon fails after the transport write but before persistence confirms it, stale-handoff recovery may retry and duplicate the update.
- If Claude Channels accepts but drops an event because it was not registered or is blocked by policy, Premind cannot observe that loss.

The trade-off is acceptable only as an opt-in research feature. It removes model-tool friction while retaining the existing Stop transport as the supported fallback.

### Non-goals

- Replacing Premind's daemon, GitHub polling, persistent event store, or canonical renderer.
- Adding a public webhook listener.
- Adding a model-callable acknowledgement or `send_now` tool.
- Delivering into a closed Claude session.
- Making Channels the default before Anthropic stabilizes the protocol.
- Adding daemon-to-plugin streaming IPC in the first experiment.

## Existing architecture and seams

```text
GitHub polling
  -> StateStore persists PR events
  -> PullRequestWatcher builds per-subscription reminder batches
  -> Claude transport claims the durable bundle
  -> Claude receives rendered reminder text
  -> transport confirms or fails the same handoff
```

Today, `plugin-claude/bin/lib.mjs` claims a bundle at a Stop hook, stores its handoff token locally, emits `additionalContext`, and confirms on the next continuation Stop hook.

The proposed Channel path reuses the same durable bundle operations:

```text
built
  -> claimReminderBundle
  -> handed_off
  -> Channel notification write
  -> ackReminderBundle(confirmed)
  -> confirmed
```

No new SQLite state, migration, or daemon protocol is required for the first version. The daemon's Unix socket is request/response only, so the MCP process should poll the local daemon at a modest interval rather than introduce a long-lived subscription protocol.

## Proposed implementation

### 1. Protocol-validation spike

Before changing Premind production code, create a disposable local Channel server and validate against an authenticated, supported Claude CLI.

Verify:

1. The exact initialize capability declaration and notification payload accepted by the installed Claude version.
2. The correct local development launch syntax for a plugin-provided MCP server and the `--dangerously-load-development-channels` bypass.
3. That the MCP process remains alive and can inject an event while Claude is idle.
4. Behavior while Claude is busy, after Stop, after `/clear`, on resume, after plugin reload, and with concurrent sessions.
5. The meaning of a successful stdout write, backpressure, transport failure, and process shutdown.
6. That hook `session_id` and MCP `CLAUDE_CODE_SESSION_ID` still correlate for a Channel-bearing process.
7. Organization-policy and unavailable-Channel behavior, including fallback to Stop delivery.

Record the exact CLI and results in this plan before moving beyond the spike. The current local Claude installation must first be repaired; it reported that its native binary was not installed.

### 2. Add a plugin-local Channel delivery helper

Create a small helper under `plugin-claude/bin/`, with injected IPC, scheduler, and stdout writer dependencies for deterministic tests.

Responsibilities:

- Start only when `PREMIND_CLAUDE_CHANNEL=1` is explicitly set.
- Bind only to `CLAUDE_CODE_SESSION_ID`; do not accept a session identifier from model input.
- Serialize ticks so one process never has overlapping claims or interleaved JSONL frames.
- Poll `claimReminderBundle(sessionId)` at a bounded preview interval.
- Combine a claimed bundle's existing canonical `reminderText` values without re-rendering PR data.
- Emit one `notifications/claude/channel` event per claimed bundle.
- Wait for stdout callback/drain completion before confirming the bundle.
- Confirm with the exact `handoffId` using `ackReminderBundle(..., state: "confirmed")`.
- On an error before a successful write, fail the exact bundle using `ackReminderBundle(..., state: "failed")`.
- On an error after a successful write but before confirmation, leave the bundle handed off for existing stale-handoff recovery.
- Stop timers and avoid further claims when stdin closes or the MCP process shuts down.

The helper must emit no PR-derived values in Channel metadata. Use the stored canonical reminder text as the event content; metadata, if necessary, may contain only static transport information.

### 3. Extend the MCP server

Update `plugin-claude/bin/mcp-server.mjs` to:

1. Advertise the experimental Channel capability only under the explicit preview flag and only after the spike confirms the protocol.
2. Start the Channel delivery helper after initialization.
3. Continue serving the existing status, probe, global-control, checkout, and subscription tools.
4. Serialize standard JSON-RPC replies and asynchronous notification frames to stdout.
5. Report whether the process is Stop-only or Channel-preview enabled.

Do not make Channel delivery a model tool. The MCP server's own local loop is the bridge.

### 4. Preserve Stop handoff ownership

The Channel pump and Stop hook share `claimReminderBundle`; SQLite atomically ensures only one can own a bundle. A Stop event that loses the race sees no claim and does nothing; a Channel tick that loses the race does the same.

Audit and narrow compatibility paths in `plugin-claude/bin/lib.mjs` before enabling Channels. In particular, a tokenless legacy continuation confirmation must not be able to confirm a Channel-owned handoff. Preserve compatibility only for explicitly identifiable legacy daemon responses.

When Channels are disabled, rejected, or unavailable, do not start the pump. Existing Stop behavior remains unchanged.

### 5. Documentation and release posture

Update the Claude README section, doctor/probe wording, and Claude support plan to state:

- Channels are experimental and require explicit launch-time opt-in.
- Local development may require Claude's preview development-channel flag.
- Premind can push only into an open session.
- Successful transport acceptance is not model-processing confirmation.
- Stop-boundary delivery remains the supported default and fallback.

Correct the local plugin instructions to use `claude --plugin-dir …`; `claude plugin install <path>` expects a configured marketplace and is not valid for this checkout.

Do not publish, enable by default, or advertise this transport as stable while Channels remains a research preview.

## Failure semantics

| Condition | Required behavior |
| --- | --- |
| Preview flag absent | No Channel capability, timer, or daemon claim; Stop delivery only. |
| No pending batch | No state change. |
| Claim + write + confirm succeeds | Confirm bundle; advance only that session's cursor. |
| Serialization or write fails before acceptance | Mark exact bundle failed; permit retry. |
| Write succeeds but confirm fails | Leave bundle handed off; stale recovery may duplicate rather than lose it. |
| Channel process exits after claim | Existing stale-handoff recovery returns it to retryable state. |
| Stop and Channel race | Exactly one atomic claim succeeds. |
| Mismatched or missing environment session ID | Do not claim, send, or confirm. |

## Test plan

### Unit tests

Extend `plugin-claude/test/mcp-server.test.mjs` and add helper tests for:

1. Disabled mode declares no Channel capability and never claims.
2. Enabled mode starts only after MCP initialization and stops on shutdown.
3. No batch produces no notification.
4. A multi-batch claim emits one notification with unchanged canonical reminder text.
5. Confirmation uses the claimed `handoffId`, not a model-provided value.
6. Concurrent ticks are serialized.
7. stdout backpressure waits for drain before confirmation.
8. Write failure marks the bundle failed.
9. Post-write confirmation failure leaves the bundle handed off.
10. JSON-RPC response frames and notification frames never interleave or corrupt JSONL.
11. Missing or mismatched `CLAUDE_CODE_SESSION_ID` cannot access a session.

### Reliability and isolation tests

Extend `plugin-claude/test/hooks.test.mjs` and `src/test/harness/adapters/claude.ts` to assert:

1. A Channel-confirmed bundle advances the cursor exactly once.
2. A stale Channel handoff becomes retryable through the existing recovery path.
3. A Stop hook can deliver a Channel-write failure's batch.
4. Stop and Channel paths cannot cross-confirm each other's handoff.
5. One Claude session cannot claim or settle another session's update.
6. Manual-subscription authorization and unverified-history guards remain in the delivered text.
7. Renderer framing remains safe when PR-derived text contains fake instructions, delimiters, links, comment text, or CI output.

### Live validation

After the protocol spike, add an opt-in, non-CI `test:claude:live-channels` command. It must skip clearly when Claude is absent, unauthenticated, or Channels are unavailable. It should prove that a local event reaches the intended open session and that Stop delivery still works when the preview transport is disabled.

## Verification

For an implementation following this plan:

```sh
bun run check
bun run test:claude
bun run test:harness
bun run test
bun run build:claude-runtime  # only if bundled daemon/shared sources change
bun run test:claude:live-channels  # opt-in, authenticated local validation
```

## Acceptance criteria

- An explicitly enabled Channel transport can deliver a persisted PR update to an open Claude session without waiting for Stop.
- Claude never needs to invoke an acknowledgement tool.
- Default Claude installs retain current Stop-boundary behavior.
- Each successful normal Channel delivery advances only its own session's cursor exactly once.
- Known pre-write failures are retryable, and post-write crash ambiguity favors a duplicate over data loss.
- Channel metadata contains no untrusted PR-derived content.
- The real Claude protocol and invocation are documented from a local proof, not inferred from preview documentation.
- The feature remains opt-in and clearly labeled research-preview until Anthropic stabilizes Channels.
