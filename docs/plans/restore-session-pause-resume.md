# Restore Session Pause/Resume

## Goal

Restore Pi's `/premind:pause` and `/premind:resume` commands and the
`premind_pause` / `premind_resume` model tools. They are a **per-session
reminder-delivery gate**, not subscription controls: pausing must retain the
session's worktree binding, automatic subscription, manual subscriptions,
watchers, event history, and delivery cursors.

## Behavior contract

- `/premind:pause` marks only the current session paused and confirms that
  subscriptions are still being watched. Repeating it is harmless.
- While paused, Premind continues polling every subscription and persists new
  events, but neither automatic lifecycle delivery nor `/premind:deliver` may
  claim or send a reminder for that session. Previously built batches remain
  pending.
- The pause survives a host reload or re-registration of the same session;
  only an explicit resume lifts it.
- `/premind:resume` restores the session to active without re-registering,
  recreating, removing, or changing any subscription. Repeating it is
  harmless.
- After resume, normal safe-boundary delivery applies again; it must not bypass
  the host's idle/busy safeguards or force an interruption. The user may run
  `/premind:deliver` after resuming when immediate delivery is wanted.
- Global `/premind:disable` remains separate: it stops polling for every
  session, while pause only suppresses delivery for one session.

## Global-control safety

`/premind:disable` and `/premind:enable` are daemon-wide controls, not pause/resume aliases. Make their model tools require an explicit `confirmGlobal: true` parameter and state in their tool descriptions that they may be called only after the user explicitly requests the corresponding global action. Refuse calls without the confirmation rather than silently changing polling for every session and project. Keep the slash commands user-initiated, but make their descriptions and result text say “globally, across all sessions and projects.”

Add equivalent safeguards to every adapter's model tool, update the generated capability descriptions/documentation, and test both rejected unconfirmed calls and confirmed calls. Do not use the global controls as part of pause/resume implementation.
## Implementation

1. **Make the daemon gate claims, not watchers.**
   In `src/daemon/persistence/store.ts`, keep paused sessions in the existing
   watcher-count and polling-target queries (`active`, `paused`), and add a
   session-status check at the start of `claimReminderBundle`. Return no bundle
   while paused before inspecting built batches or constructing new ones. This
   closes the current hole where a batch built before pause could still be
   claimed by a status poll or forced deliver. Keep `setSessionPaused` as the
   only status mutation; do not touch `session_subscriptions`, worktree
   bindings, or delivery cursors.

2. **Expose the existing protocol through Pi.**
   In `src/extension/index.ts`, use the already-declared
   `DaemonClientLike.pauseSession` and `.resumeSession` methods to add the two
   slash commands and model tools. Both must use `ensurePiSessionAttached` so
   they address the live session, refresh the status bar, and report clear
   session-scoped results/errors. Update `deliverPendingReminders` only if
   needed for a local fast-path; correctness belongs in the daemon claim gate.

3. **Declare the Pi-only surface deliberately.**
   Add `pause` and `resume` as `adapter-specific` capabilities in
   `src/shared/command-capabilities.ts`, each with Pi command/tool names and
   empty Claude/OpenCode surfaces. This preserves the enforced capability
   contract without implying unsupported controls in other adapters. Regenerate
   `docs/command-capabilities.md` from the capability renderer.

4. **Cover the contract and regressions.**
   - In `src/extension/__tests__/index.test.ts`, assert both registrations,
     their daemon calls, idempotent notifications, and unchanged subscription
     operations.
   - In daemon persistence/router tests, prove paused sessions still count
     toward watcher targets and accumulate events, but cannot claim either an
     old built batch or a newly accumulated batch; after resume, the same
     subscriptions and pending events can be claimed normally.
   - Update `src/shared/command-capabilities.test.ts` and
     `src/test/command-capability-contract.test.ts` expectations through the
     declared capability surface rather than hard-coding an exception.

## Verification

Run the targeted daemon persistence/router tests, Pi extension tests, and the
command-capability contract/documentation tests. Confirm manually that
`/premind:status` shows the session as `paused` with its subscriptions still
listed and their pending counts increasing, then shows the same subscriptions
as `active` after resume.
