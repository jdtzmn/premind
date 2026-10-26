# Pi registration-loss recovery

## Scope and approval

The user explicitly approved a Pi-first recovery PR with shared safety checks on 2026-10-26. This narrows the runtime scope of [the shared recovery plan](shared-session-recovery.md); it does not waive its lifecycle or authority fences. Other harnesses are deferred under [#103](https://github.com/jdtzmn/premind/issues/103), recorded in `src/shared/command-capabilities.ts`. No host limitation is added.

| Harness | This change | Remaining proof |
| --- | --- | --- |
| Pi | Bounded live-incarnation repair for eligible session controls | Actual packed-host red–green regression and lifecycle-negative controls |
| Claude Code | Deferred, #103 | Native hook/MCP incarnation authority and shared-path integration |
| OpenCode | Deferred, #103; existing reattach behavior is not equivalent coverage | Shared fenced path and native recovery proof |
| Codex | Deferred, #103 | Native hook/MCP incarnation authority and shared-path integration |

## Native regression

`src/test/native/pi-registration-loss.native.ts` starts the actual installed Pi, extracted Premind package, real daemon, Unix socket, and SQLite database in isolated state. A scripted model invokes the production subscribe tool successfully. A deliberate SQL fault removes only the session row, retaining the live ownership lease and durable subscription state. The same still-running Pi then invokes subscribe again.

The pre-fix artifact fails with `SESSION_NOT_FOUND` from the real second tool invocation. This is not an absent transcript, fake host callback, mocked router, or GitHub error. The SQL connection registers the storage epoch function required by production fencing triggers; it asserts epoch one and does not change authority epochs or create registration state. Scripted model and GitHub services are the only external-service replacements.

## Repair policy

Reuse `createSessionRecovery`, one controller per live Pi lifecycle incarnation. Only `SESSION_NOT_FOUND` from an eligible control operation permits repair. Repair is single-flight and replay is bounded to one attempt. Do not add claim, acknowledgement, settlement, deletion, or cleanup to the allowlist. Ordinary daemon errors are not transport failures.

The adapter must retain its exact session identity, client, and lifecycle generation. Invalidate before shutdown, reload, or replacement. Check current ownership at each dispatch; an asynchronous eligibility result is not an enduring grant.

## Shared authority fence

Recovery is not an ordinary registration. It must use a still-valid retained session lease and remembered registration; it must never claim or reacquire authority. The daemon validates the lease and performs the recovery mutation under the same transaction. An older daemon must reject the new request shape, not silently downgrade to ordinary registration.

End and explicit deletion revoke recovery authority even when the session row is already missing. A late request cannot recreate a row after revocation, pruning, lease transfer, or authority replacement. Existing live rows retain their persisted metadata and delivery state. Missing-row repair must not clear separate pause, subscription, worktree-binding, cursor, or handoff state. This does not reconstruct an erased database.

## Incremental delivery

1. Commit the native failing regression and its focused typecheck.
2. Validate and commit shared daemon/client authority fencing and negative controls.
3. Validate and commit Pi wiring and lifecycle/command/tool tests.
4. Build a fresh immutable package, run the same native regression green, and retain the red artifact identity separately.
5. Review the final diff independently, run targeted compatibility checks, and open a PR stacked on the native baseline.

## Acceptance and limitations

- The same host PID and session identity survive the missing-row fault; a subsequent real subscribe succeeds and creates its durable subscription.
- Ended, deleted, superseded, expired, and replaced-authority contexts fail closed; repair cannot reclaim their leases.
- Commands and model tools share the repair policy. Concurrent controls do not multiply repairs.
- Preserve pause, subscriptions, worktree bindings, delivery cursors, and handoff evidence; do not promise globally exactly-once delivery.
- The native test is a required-host lane: missing prerequisites fail rather than skip to green.
- This change does not claim recovery for the other three harnesses, full database loss, or every network failure. Their follow-up remains #103.
