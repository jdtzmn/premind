# Pi registration-loss recovery

## Scope and approval

The user explicitly approved a Pi-first recovery PR with shared safety checks on 2026-10-26. This narrows the runtime scope of [the shared recovery plan](shared-session-recovery.md); it does not waive its lifecycle or authority fences. Other harnesses are deferred under [#103](https://github.com/jdtzmn/premind/issues/103), recorded in `src/shared/command-capabilities.ts`. No host limitation is added.

| Harness | This change | Remaining proof |
| --- | --- | --- |
| Pi | Bounded live-incarnation repair; packed-host registration-loss red–green and lifecycle-negative controls pass | Broader native lifecycle/fault matrix |
| Claude Code | Deferred, #103 | Native hook/MCP incarnation authority and shared-path integration |
| OpenCode | Deferred, #103; existing reattach behavior is not equivalent coverage | Shared fenced path and native recovery proof |
| Codex | Deferred, #103 | Native hook/MCP incarnation authority and shared-path integration |

## Native regression

`src/test/native/pi-registration-loss.native.ts` starts the actual installed Pi, extracted Premind package, real daemon, Unix socket, and SQLite database in isolated state. A scripted model invokes the production subscribe and pause tools successfully. A deliberate SQL fault removes only the session row, retaining the live ownership lease and durable subscription state. The same still-running Pi then invokes subscribe again.

The pre-fix artifact fails with `SESSION_NOT_FOUND` from the real second tool invocation. This is not an absent transcript, fake host callback, mocked router, or GitHub error. The SQL connection registers the storage epoch function required by production fencing triggers; it asserts epoch one and does not change authority epochs or create registration state. Scripted model and GitHub services are the only external-service replacements.

The corrected artifact passes that identical test. It checks the unchanged host PID and session identity, successful second tool result, new durable subscription, and unchanged retained lease identity, pause, worktree binding, prior subscription, and cursor. Native registration recovery is separate from the baseline reminder-consumption test: it does not itself assert that a new reminder reaches model context.

## Repair policy

Reuse `createSessionRecovery`, one controller per live Pi lifecycle incarnation. Only `SESSION_NOT_FOUND` from an eligible control operation permits repair. Repair is single-flight and replay is bounded to one attempt. Do not add claim, acknowledgement, settlement, deletion, or cleanup to the allowlist. Ordinary daemon errors are not transport failures.

The adapter retains its exact session identity, client, and lifecycle generation. Invalidate before shutdown, reload, or replacement. Check current ownership at each dispatch; an asynchronous eligibility result is not an enduring grant. Failed initial attachment may be retried only by the still-current incarnation. Shutdown fences late discovery and settles already-dispatched registration before terminal cleanup without adopting a replacement client.

## Shared authority fence

Recovery is not an ordinary registration. It uses a still-valid retained session lease and remembered registration; it never claims or reacquires authority. The daemon validates the lease and performs the recovery mutation under the same transaction. An older daemon rejects the new request shape rather than silently downgrading to ordinary registration.

End and explicit deletion revoke recovery authority even when the session row is already missing. Cleanup uses only captured authority and cannot reconnect/reclaim to obtain a newer owner's lease. Tokenless legacy cleanup cannot revoke a leased owner. Lease rows are bound to the storage epoch; historical rows without that binding are not recovery authority. Both closed-session pruning paths revoke authority transactionally before removing the row, retaining the generation tombstone.

A late request cannot recreate a row after revocation, pruning, lease transfer, or authority replacement. Existing live rows retain their persisted metadata and delivery state. Missing-row repair does not clear separate pause, subscription, worktree-binding, cursor, or handoff state. This does not reconstruct an erased database.

## Incremental delivery

1. Commit the native failing regression and its focused typecheck.
2. Validate and commit shared daemon/client authority fencing and negative controls.
3. Validate and commit Pi wiring and lifecycle/command/tool tests.
4. Build a fresh immutable package, run the same native regression green, and retain the red artifact identity separately.
5. Review the final diff independently, run targeted compatibility checks, and open a PR stacked on the native baseline.

## Recorded verification

The identical native regression was run against two separately packed, dependency-installed artifacts on Pi **1.4.0**, Node **26.0.0**:

| Result | Package source commit | Tarball SHA-256 |
| --- | --- | --- |
| Expected red: second tool reports `SESSION_NOT_FOUND` | `ccdaac256ec8efb2b8a9e0c87865eb26ce6b211d` | `757e7e66c71693b38b5dbd4b25cb8f91dfccf9dfc0125b39fb15a459049b4993` |
| Green: recovery and retained-state assertions pass | `40c4b39561c7459747e8f9af861189cd2967fa47` | `d7bff9051dedc4db5825b2f525d6fa96f1ccaf21996556d139751554d21b74f8` |

Run with `PREMIND_NATIVE_PACKAGE` pointing to either extracted, dependency-installed artifact:

```sh
node --import tsx --test src/test/native/pi-registration-loss.native.ts
```

Independent Pi review passed 40 focused recovery tests and found no remaining concrete issues. Independent shared post-fix source review found no remaining concrete issues in stale-End, epoch, and pruning fences. Targeted client/router/storage compatibility and negative-control tests, existing lifecycle scenarios, Codex lifecycle tests, and `npm run check` passed. Six existing exclusions in the broader scenario/contract run remain skips; they are not counted as recovery coverage. Shared fixtures iterating four host labels do not prove the adapters' native cleanup paths. Comprehensive CI and native recovery for the other three harnesses remain outside this local evidence.

## Acceptance and limitations

- The same host PID and session identity survive the missing-row fault; a subsequent real subscribe succeeds and creates its durable subscription.
- Ended, deleted, superseded, expired, and replaced-authority contexts fail closed; repair cannot reclaim their leases.
- Commands and model tools share the repair policy. Concurrent controls do not multiply repairs.
- Preserve pause, subscriptions, worktree bindings, delivery cursors, and handoff evidence; do not promise globally exactly-once delivery.
- The native test is a required-host lane: missing prerequisites fail rather than skip to green.
- This change does not claim recovery for the other three harnesses, full database loss, automatic idle delivery, or every network failure. Their follow-up remains #103.
