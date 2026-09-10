# Plan: Support Codex Plugins in premind

## 1. Goal

Add a first-class Codex Agent Plugin adapter to premind while retaining the existing daemon as the single owner of GitHub polling, worktree bindings, subscriptions, reminder batching, persistence, and delivery cursors.

Codex support will use **durable turn-boundary delivery**:

- an update detected during an active turn is injected by the `Stop` hook;
- an update detected after Codex is already idle remains queued and is injected at the next `UserPromptSubmit` or `SessionStart` boundary;
- no update is silently discarded if no hook is currently running.

This issue does not attempt to wake an idle Codex thread.

## 2. Accepted Decisions

1. **Normal plugin experience.** Users install premind as a Codex plugin and launch Codex normally. They do not need to run a premind-controlled App Server.
2. **No idle-wake claim.** Codex plugin hooks cannot independently create a turn after the stock CLI is already idle. The product copy must say that delivery occurs at the next safe lifecycle boundary.
3. **Three delivery hooks.** `SessionStart`, `UserPromptSubmit`, and `Stop` are the required hooks. `Interrupt` and `SessionEnd` are best-effort cleanup hooks only.
4. **No `PostToolUse` hook.** Premind will not spawn a process after every command, edit, or MCP call merely to reduce reminder latency.
5. **Immediate delivery at `Stop`.** The Codex adapter does not apply Pi/OpenCode's idle delay. Once `Stop` returns, another hook is not guaranteed until the next user action.
6. **One reminder per continuation chain.** `stop_hook_active` prevents recursively draining another batch after a premind-triggered continuation.
7. **At-least-once delivery target.** A crash should cause a duplicate rather than loss. Codex does not acknowledge hook-context consumption, so the remaining process-exit ambiguity must be documented and bounded rather than presented as an absolute guarantee.
8. **Portable package format.** Use root `plugin.json`, root `mcp.json`, `hooks/hooks.json`, and `skills/`. Do not make `.codex-plugin/plugin.json` the canonical manifest.
9. **Explicit controls through MCP.** Keep the current worktree and subscription controls available as MCP tools, but lifecycle delivery must not depend on the model calling them correctly.
10. **App Server is out of scope.** A remote-TUI/App Server integration may be explored in a separate issue if automatic idle revival is later required.

## 3. Codex Capability Mapping

| Premind need | Codex mechanism | v1 behavior |
| --- | --- | --- |
| Register/reconcile a root thread | `SessionStart` | Ensure daemon, register namespaced session ID, reconcile `cwd`, and recover prior delivery receipts. |
| Handle startup/resume/clear/compact | `SessionStart.source` | Use idempotent handling for every source supported by the pinned Codex release. `compact` performs lifecycle reconciliation only and never claims a reminder because it may fire mid-turn. |
| Mark an active turn busy | `UserPromptSubmit` | Reconcile the session, mark busy, then claim and inject one idle-period reminder as additional context. |
| Detect normal turn completion | `Stop` | Mark idle, confirm a prior continuation, and inject at most one newly claimed batch. |
| Avoid continuation loops | `Stop.stop_hook_active` | Confirm the prior continuation but do not claim another batch. |
| Handle interruption | `Interrupt` | Best-effort mark idle within Codex's three-second maximum; never inject a reminder. |
| Handle eventual teardown | `SessionEnd` | Best-effort close the session; correctness cannot depend on prompt teardown because the event may be delayed. |
| Activate another worktree | MCP tool | Explicit `premind_activate_worktree`; never infer durable activation from a shell command containing `cd`. |
| Add/remove PR subscriptions | MCP tools | `premind_subscribe` and `premind_unsubscribe` using the existing IPC operations. |
| Inspect state | MCP tool | `premind_status`, with current session resolution rules below. |
| Wake an already-idle stock CLI thread | No plugin mechanism | Leave the reminder durable and deliver at the next start/prompt/stop boundary. |
| Show a countdown toast | No equivalent | Omit it. |

### Why async hooks are not a wake mechanism

Codex can run command hooks asynchronously, but an async result produced while no turn is active waits until the next user turn. Finishing the hook does not create a turn. Async hooks also cannot control the operation that launched them.

### Why App Server is not part of v1

Codex App Server exposes `turn/start` and can drive a remote Codex TUI, but it changes the launch and ownership model: premind would become another Codex client responsible for connection lifecycle, thread routing, streamed events, and approvals. That is a valid separate product mode, not a prerequisite for a useful plugin.

## 4. Delivery Protocol

The existing `getPendingReminder` followed by `ackReminder("handed_off")` is not sufficient for stateless concurrent hooks. Two hook processes could read the same built batch before either acknowledgement wins, and a process that dies after handoff can leave a batch stuck while the daemon remains alive.

Add an atomic leased-claim protocol before implementing Codex hooks.

### 4.1 New daemon operations

Add IPC operations equivalent to:

```ts
type ClaimPendingReminderPayload = {
  sessionId: string
  boundary: "session_start" | "user_prompt_submit" | "stop"
}

type ClaimPendingReminderResult = {
  batch: ReminderBatch | null
  handoffId: string | null
  leaseExpiresAt: number | null
}

type SettleReminderClaimPayload = {
  sessionId: string
  batchId: string
  handoffId: string
  outcome: "confirmed" | "failed"
  failureReason?: string
}
```

`claimPendingReminder` must transactionally:

1. select one built or retryable batch for the session;
2. transition it to `handed_off`;
3. assign a unique `handoffId` and lease expiration;
4. return the claimed batch;
5. return `null` to every concurrent loser.

`settleReminderClaim` must reject a stale or mismatched handoff token. Expired handoffs return to a retryable state without requiring a daemon restart.

### 4.2 Adapter delivery receipts

Codex does not acknowledge that hook context was consumed. Persist one namespaced receipt per `sessionId` and `handoffId` under `PLUGIN_DATA` to record the strongest evidence available:

```ts
type CodexDeliveryReceipt = {
  sessionId: string
  batchId: string
  handoffId: string
  boundary: "session_start" | "user_prompt_submit" | "stop"
  sourceTurnId?: string
  outputFlushedAt: number
}
```

For each claim, use this order:

1. render and validate the complete hook response in memory;
2. write it to stdout and await the stream write/drain callback;
3. atomically persist the receipt with temporary-file-plus-rename;
4. perform no further fallible work and exit successfully.

If the process dies before step 3, the lease expires and the batch is retried, even if that can duplicate already-written context. The narrow crash window after receipt persistence but before successful process exit cannot be eliminated without a Codex host acknowledgement; document it explicitly.

Receipts must use safe encoded filenames and separate records per session/handoff. Serialize lifecycle handling with an exclusive per-session lock that has bounded stale-lock recovery. Settlement and deletion use compare-and-delete semantics so one hook cannot consume another hook's receipt.

Confirmation is boundary-specific:

- a `stop` receipt is confirmed only by a later `Stop` with `stop_hook_active: true` for the same session;
- a `user_prompt_submit` receipt is confirmed by the downstream `Stop` with the same `turn_id`;
- a `session_start` receipt is confirmed only after the next root turn reaches `Stop`;
- an unrelated start or prompt event never confirms a prior receipt.

If the expected proof never arrives, leave the claim unsettled and allow its lease to expire for retry.

### 4.3 Boundary ordering

#### `SessionStart`

1. Validate the Codex input.
2. Ensure the daemon is running.
3. Register/reconcile `codex:<session_id>`.
4. Acquire the per-session lifecycle lock and reconcile expired receipts without confirming unrelated claims.
5. Reconcile the current `cwd` as the active worktree when appropriate for the start source.
6. If `source` is `compact`, stop after lifecycle reconciliation because compaction may occur mid-turn.
7. Otherwise claim at most one batch.
8. Render and flush `hookSpecificOutput.additionalContext`, then persist its receipt.
9. Fail open on all premind errors.

#### `UserPromptSubmit`

1. Validate input and reconcile the session in case a long idle period made it stale.
2. Acquire the per-session lock and reconcile expired receipts without confirming unrelated claims.
3. Mark the session busy.
4. Claim at most one batch queued during idle.
5. Render and flush `hookSpecificOutput.additionalContext`, recording the current `turn_id`, then persist its receipt.
6. Never block the user's prompt because premind is unavailable.

#### `Stop`

1. Validate input and reconcile the session.
2. Acquire the per-session lock and mark the session idle even when `stop_hook_active` is true.
3. Confirm only receipts proven by this boundary: the same-turn prompt receipt, the prior root-session start receipt, or the outstanding Stop receipt when `stop_hook_active` is true.
4. If `stop_hook_active` is true, return empty success.
5. Otherwise claim at most one batch.
6. Render and flush `{ "decision": "block", "reason": reminderText }`, then persist its receipt.
7. Leave updates arriving after the claim queued for the next boundary.

#### `Interrupt`

Mark idle on a best-effort basis. Do not claim a batch because Interrupt output cannot restart the turn.

#### `SessionEnd`

Release the current owner and mark the root session dormant on a best-effort basis. Do not call destructive `unregisterSession`; Codex may emit `SessionEnd` after a thread has merely been unopened, so durable subscriptions, cursors, batches, and bindings must remain available for resume.

## 5. Long-Idle Behavior

Codex threads can remain idle longer than premind's current six-hour stale-session threshold, while current closed-session cleanup can delete the session and its reminder batches later. Recreating a deleted session at the current event high-water mark would skip the intervening updates.

Separate session liveness from durable delivery state:

1. Add a dormant Codex session state that stops contributing active watcher demand but retains worktree binding, subscriptions, delivery cursor, batches, and the last canonical PR snapshot.
2. `SessionEnd` releases the current owner and marks the session dormant; it must not call the destructive `unregisterSession` path.
3. On `UserPromptSubmit` or non-compact `SessionStart`, reactivate the dormant session and reconcile the PR from its retained snapshot/cursor rather than baselining at the current high-water mark.
4. Dormant sessions do not require continuous GitHub polling. The first resumed turn may trigger reconciliation, so a newly discovered update may arrive at that turn's `Stop` rather than before its prompt.
5. Automatic deletion requires an explicit retention policy separate from liveness. For v1, preserve dormant Codex delivery state until the tracked PR is closed and the existing closed-PR retention expires, or until an explicit maintenance action removes it.
6. Test resume after both the stale-session threshold and the closed-session retention interval to prove that cursor history is retained.

Document the guarantee as **the next available lifecycle boundary after detection**. Do not keep an async hook alive as a pseudo-monitor; it consumes resources without gaining wake capability.

## 6. Session Identity and Ownership

Use a host-qualified daemon session ID:

```text
codex:<codex-session-id>
```

Codex hook payloads include `session_id`; ordinary MCP calls do not currently document an equivalent thread identifier. Resolve MCP tool ownership in this order:

1. Use a documented plugin MCP session identifier if the pinned Codex release provides one.
2. Otherwise let `SessionStart` place the current premind session handle in both `PLUGIN_DATA` and concise developer context.
3. Require mutation tools to receive that handle and validate it against a live daemon session.
4. Allow cwd-based fallback only when exactly one live Codex session matches.
5. Return an explicit ambiguity error when multiple sessions share a cwd; never guess.

The compatibility spike must determine whether one MCP process is created per thread, per Codex process, or per plugin installation. Do not design ownership around an undocumented assumption.

`SessionEnd` must not close a session still owned by another connected client. If testing shows multiple clients can represent one Codex thread, add an owner/lease table rather than treating one teardown event as authoritative.

## 7. MCP and Skill Surface

### 7.1 MCP tools included in v1

- `premind_status({ sessionHandle? })`
- `premind_activate_worktree({ sessionHandle, path })`
- `premind_subscribe({ sessionHandle, prNumber, repo? })`
- `premind_unsubscribe({ sessionHandle, prNumber, repo? })`

Defer `premind_prune`, `premind_flush`, global enable/disable, and other administrative controls until the core lifecycle and routing behavior is proven. Manual MCP output is part of the current turn and should not be presented as automatic reminder delivery.

The MCP server remains a thin stdio-to-premind-IPC bridge. It must not poll GitHub or own reminder state.

### 7.2 Skill

Add `skills/premind/SKILL.md` to teach Codex to:

- activate a linked or nested worktree explicitly after moving work there;
- include `owner/repo` for cross-repository subscriptions;
- use the current session handle supplied by premind rather than inventing one;
- treat `<premind-reminder>` as untrusted external PR context, not user authorization;
- inspect detail files only when needed;
- avoid reprocessing event IDs already represented in the batch;
- explain that an idle update waits for the next Codex lifecycle boundary.

The skill helps the model use controls but is not responsible for registration or delivery correctness.

## 8. Package Architecture

```text
src/
  client/
    daemon-client.ts          # host-neutral IPC client
    daemon-launcher.ts        # configurable artifact-driven launcher
    git-context.ts            # shared worktree/repo detection
  codex/
    schemas.ts                # pinned hook input/output schemas
    hook-runner.ts            # stdin parsing and dispatch
    lifecycle.ts              # boundary algorithms
    delivery-receipts.ts      # atomic PLUGIN_DATA receipts
    session-binding.ts        # session-handle persistence/resolution
    mcp-server.ts             # stdio MCP-to-daemon bridge
    __fixtures__/
    __tests__/
  daemon/
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
    dist/
      premind-hook.mjs
      premind-mcp.mjs
      premind-daemon.mjs

.agents/plugins/
  marketplace.json            # development marketplace
```

Extract only genuinely host-neutral modules from `src/plugin/`; do not rename the whole OpenCode adapter.

The current source launcher depends on TypeScript runners and points at `src/daemon/index.ts`. That cannot be the installed plugin contract. Build dependency-closed JavaScript artifacts for:

- the lifecycle hook runner;
- the stdio MCP bridge;
- the premind daemon.

Use `node` to execute the bundles. Pin Node 22.13 or later so `node:sqlite` works without the earlier `--experimental-sqlite` flag. Enforce the same minimum in `package.json.engines`, launcher preflight, documentation, and clean-cache tests.

The JavaScript bundles are dependency-closed, but the existing runtime still shells out to `git` and authenticated GitHub CLI (`gh`). Treat both as explicit external prerequisites: preflight their availability and `gh auth status`, return actionable setup errors, document them in onboarding, and include clean-install tests for missing or unauthenticated executables.

Keep stdout protocol-only. Send diagnostics to the premind log or stderr where the relevant Codex event permits it.

## 9. Plugin Manifests

### `plugins/premind/plugin.json`

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "premind",
  "version": "0.2.0",
  "description": "Bring new pull request context into Codex at safe turn boundaries.",
  "repository": "https://github.com/jdtzmn/premind",
  "license": "MIT",
  "extensions": {
    "com.openai": {
      "hooks": "./hooks/hooks.json",
      "interface": {
        "displayName": "premind",
        "shortDescription": "Bring new PR context into Codex turns",
        "category": "Developer Tools"
      }
    }
  }
}
```

Do not advertise broad `Read`/`Write` capabilities unless schema validation and the actual implementation require them.

### `plugins/premind/hooks/hooks.json`

```json
{
  "description": "Synchronize Codex lifecycle with premind.",
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/dist/premind-hook.mjs\" SessionStart",
        "timeout": 10,
        "statusMessage": "Connecting premind"
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/dist/premind-hook.mjs\" UserPromptSubmit",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/dist/premind-hook.mjs\" Stop",
        "timeout": 10,
        "statusMessage": "Checking for PR updates"
      }]
    }],
    "Interrupt": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/dist/premind-hook.mjs\" Interrupt",
        "timeout": 3
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/dist/premind-hook.mjs\" SessionEnd",
        "timeout": 3
      }]
    }]
  }
}
```

The compatibility spike must verify the exact supported start-source values. If the pinned release adds values such as `fork`, either include them deliberately or allow an unfiltered idempotent start hook.

There must be no `PostToolUse` entry.

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

Portable MCP configuration expands `PLUGIN_ROOT` in arguments and cwd, not in the executable field.

## 10. Implementation Phases

### Phase 0 — Pin and prove the Codex contract

Create a minimal fixture using only `SessionStart`, `UserPromptSubmit`, and `Stop`.

Prove against an exact Codex version:

- portable plugin installation from a local marketplace;
- hook discovery and `/hooks` trust review;
- sanitized input shapes and supported `SessionStart.source` values;
- exact accepted `additionalContext` output for start/prompt hooks;
- exact accepted `Stop` continuation output;
- `stop_hook_active` behavior on the continuation;
- `PLUGIN_ROOT` and `PLUGIN_DATA` expansion;
- MCP process scope and any available session identity;
- command behavior from paths containing spaces;
- maximum practical reminder output before Codex spills it to disk;
- startup latency of the bundled hook.

Assert that the fixture contains no `PostToolUse` hook.

**Validation:** one trusted fixture session injects context at non-compact SessionStart, UserPromptSubmit, and Stop; compact performs no delivery; Stop produces exactly one continuation.

### Phase 1 — Add atomic reminder claims

Change:

- `src/shared/schema.ts`
- `src/shared/ipc.ts`
- `src/daemon/ipc/router.ts`
- `src/daemon/reminders/reminder-handoff-registry.ts`
- `src/daemon/persistence/store.ts`
- `src/plugin/daemon-client.ts` or its extracted replacement

Implement:

- atomic claim tokens;
- handoff leases and live expiry;
- settle-by-token validation;
- recovery after hook crash and daemon restart;
- dormant Codex sessions that preserve subscriptions, cursor, batches, and PR snapshots without contributing watcher demand;
- a non-destructive owner-release operation for `SessionEnd`;
- protocol/capability negotiation for a daemon started by an older Pi/OpenCode package.

Never fall back silently to non-atomic read-plus-ack when Codex delivery requires a claim.

**Validation:** simultaneous claimers, stale settlement, abandoned lease, retry, restart, mixed-version daemon behavior, and resume after both stale and closed-session retention thresholds. Commit.

### Phase 2 — Build a packageable host-neutral runtime

- Extract the IPC client, configurable launcher, and reusable git context into `src/client/`.
- Separate adapter diagnostics from launcher mechanics.
- Update Pi and OpenCode imports without behavior changes.
- Add a deterministic bundler configuration for hook, MCP, and daemon entry points.
- Add the Node version check and actionable failure message.
- Define how the global socket handles old/new daemon coexistence.

**Validation:** existing Pi/OpenCode tests, typecheck, bundle smoke tests, and daemon launch from a directory without repository `node_modules`. Commit.

### Phase 3 — Implement the Codex lifecycle adapter

- Add strict schemas generated or transcribed from the pinned Codex contract fixture.
- Implement the boundary ordering from Section 4.
- Add namespaced session IDs and one atomic delivery receipt per session/handoff under `PLUGIN_DATA`.
- Add exclusive per-session lifecycle locks with stale-lock recovery and compare-and-delete settlement.
- Flush protocol output before persisting an emission receipt, then perform no fallible work before successful exit.
- Correlate prompt receipts by `turn_id` and settle Stop receipts only from `stop_hook_active`.
- Keep errors fail-open and output protocol-valid.
- Reactivate dormant sessions on non-compact start/prompt boundaries; compact performs lifecycle reconciliation without delivery.
- Ensure Interrupt and SessionEnd stay within their timeout budgets and use non-destructive owner release.

**Validation:** malformed input, daemon unavailable, every start source, prior-receipt confirmation, concurrent boundaries, `stop_hook_active`, crash before output, crash after output, oversized reminder, and timeout tests. Commit.

### Phase 4 — Add MCP controls and skill

- Implement the thin stdio MCP bridge.
- Resolve session identity using the proven Phase 0 process model.
- Add explicit ambiguity errors.
- Expose status, activate-worktree, subscribe, and unsubscribe only.
- Add the premind skill and its untrusted-context guidance.

**Validation:** MCP discovery and IPC round-trip tests; two sessions in one cwd must never cross-route. Commit.

### Phase 5 — Package the portable plugin

- Add root plugin, MCP, and hook manifests under `plugins/premind/`.
- Add the repository-local development marketplace.
- Produce version-synchronized dependency-closed bundles.
- Include `plugins/` in `package.json.files` and package tests.
- Validate manifests against their published schemas.
- Pin Node 22.13+ consistently in package metadata, launcher preflight, and documentation.
- Preflight and document `git`, GitHub CLI, and `gh auth` as external prerequisites.
- Document hook trust, network access, writable directories, cache refresh, and uninstall behavior.

**Validation:** install into a clean Codex home from the local marketplace using only Node 22.13+, `git`, and authenticated `gh`; no source checkout, Bun, `tsx`, or repository `node_modules` may be required. Verify actionable failures when each prerequisite is absent. Commit.

### Phase 6 — End-to-end acceptance and release docs

Test with real PR events:

1. An update detected during a busy turn is claimed once and delivered by `Stop`.
2. An update detected after Stop remains queued and is injected by the next `UserPromptSubmit`.
3. A pending update is injected by non-compact `SessionStart` on resume.
4. `SessionStart(source: "compact")` reconciles lifecycle state but does not claim or inject a reminder.
5. A premind continuation does not recursively drain another batch.
6. A crash before stdout flush retries without loss.
7. A crash after stdout flush may duplicate; test and document the narrow post-receipt/pre-exit ambiguity.
8. Concurrent boundaries for one session cannot claim or settle each other's handoff.
9. Concurrent hooks for different sessions cannot overwrite receipts or locks.
10. A dormant session resumed after both retention thresholds reconstructs from its durable cursor without skipping events.
11. Two Codex sessions share one PR watcher but keep independent cursors.
12. Two sessions in one cwd cannot cross-route MCP operations.
13. Linked-worktree activation preserves manual subscriptions.
14. An older daemon produces an actionable compatibility result rather than silent fallback.
15. Hook trust changes are recoverable through `/hooks`.
16. Missing Node, `git`, `gh`, or GitHub authentication produces an actionable preflight failure.
17. The manifest contains no `PostToolUse` hook and documentation contains no idle-wake promise.

**Validation:** targeted live test, complete unit suite, typecheck, manifest validation, and package dry run. Commit.

## 11. Acceptance Criteria

Codex plugin support is complete when:

- the plugin installs from a local/repo marketplace using the portable manifest;
- users can review and trust its hooks;
- Pi and OpenCode behavior remains unchanged;
- registration and worktree reconciliation are idempotent;
- pending updates survive hook, daemon, and Codex restarts;
- an active-turn update produces at most one Stop continuation;
- an idle-period update is delivered at the next available lifecycle boundary after it is detected;
- leased claims and correlated receipts target at-least-once delivery while documenting the irreducible Codex process-exit acknowledgement gap;
- MCP mutations route to the intended Codex root session or fail as ambiguous;
- bundled scripts run from Codex's plugin cache with Node 22.13+, `git`, and authenticated `gh` as the only external runtime prerequisites;
- no `PostToolUse` hook is installed;
- the docs clearly describe turn-boundary delivery and its long-idle limitation.

## 12. Popular Plugin Source Review

| Plugin/source | What it does | Pattern to reuse or avoid |
| --- | --- | --- |
| [OpenAI Figma](https://github.com/openai/plugins/tree/main/plugins/figma) | Combines focused design skills, HTTP MCP, app/UI metadata, commands, scripts, and a draft `PostToolUse` parity reminder. | Useful full-package layout, but its draft hook is not evidence of production delivery. Avoid cwd-relative commands. |
| [Build Web Apps](https://github.com/openai/plugins/tree/main/plugins/build-web-apps) | Composes six narrow frontend, React, shadcn, Stripe, and Supabase skills without observed hooks or MCP. | Keep the skill small and focused; executable hooks should exist only for deterministic lifecycle work. |
| [Superpowers](https://github.com/openai/plugins/tree/main/plugins/superpowers) | Implements planning, TDD, debugging, worktrees, review, and verification primarily through skills. | Skills can shape workflow but cannot replace premind's durable delivery protocol. |
| [Plugin Eval](https://github.com/openai/plugins/tree/main/plugins/plugin-eval) | Routes skills into a deterministic local CLI with fixtures, tests, and isolated evaluation workspaces. | Separate deterministic contract tests from live Codex validation. |
| [context-mode](https://github.com/mksglu/context-mode) | Uses Codex-native Node hooks for session, prompt, tool, compaction, and stop events plus a bundled MCP server. | Best lifecycle packaging reference. Premind should deliberately use fewer hooks and no `PostToolUse`. |
| [CrowdStrike Foundry](https://github.com/CrowdStrike/foundry-skills) | Provides hub-and-spoke development skills with references and scripts; its shell hooks are documented as Claude-specific. | Do not assume Claude compatibility merely because Codex uses similarly named events. |
| [Qodo](https://github.com/qodo-ai/qodo-skills/tree/main/codex-packages/qodo) | Ships host-specific skills with explicit CLI setup and authentication. | Keep installation, authentication, and subscription as separate user-visible steps. |

## 13. Risks

- **Hook contract drift:** pin a minimum Codex version and retain the fixture as a compatibility test.
- **No idle ingress:** state the compromise plainly; queue until the next boundary.
- **Duplicate delivery:** use leased claims and receipts; prefer duplicate context over silent loss.
- **Long-idle watcher gaps:** reconcile on every boundary and document that detection may happen during the resumed turn.
- **Hook trust friction:** make `/hooks` part of onboarding and troubleshooting.
- **MCP session ambiguity:** require a validated handle or fail when cwd resolution is not unique.
- **Global daemon version skew:** negotiate capabilities and never use unsafe fallback delivery.
- **Packaging:** bundle the daemon as well as adapters and test from a clean plugin cache.
- **Security:** PR content is untrusted external data, not authorization for code changes or other side effects.

## 14. Out of Scope

- Automatic wake-up of an already-idle stock Codex CLI thread.
- Codex App Server or remote-TUI orchestration.
- `PostToolUse`, `PreToolUse`, compaction, permission, or subagent hooks.
- Countdown UI.
- Public Plugins Directory submission; initial distribution is through local/repo marketplaces.
- Administrative MCP tools beyond the four controls listed for v1.

## 15. Sources

- [Build plugins](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Use plugins in Codex](https://developers.openai.com/codex/plugins)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Agent Plugins MCP server schema](https://agent-plugins.org/plugin-authors/mcp-servers)
- [OpenAI plugin examples](https://github.com/openai/plugins)
- [Codex issue: native event-driven session wake](https://github.com/openai/codex/issues/20312)
- [Codex issue: inbound MCP notifications](https://github.com/openai/codex/issues/15299)
- [Codex issue: inject into existing sessions](https://github.com/openai/codex/issues/11415)
