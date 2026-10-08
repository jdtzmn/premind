# Restore Session Pause/Resume

## Goal

Give every supported harness a per-session pause and resume. Pause is a
**reminder-delivery gate** for one session. It is not a subscription control.
While paused, the session keeps its worktree binding, automatic and manual
subscriptions, watchers, event history, and delivery cursors. Only reminder
handoff stops.

Also guard the daemon-wide enable and disable controls, so an agent cannot
mistake them for pause and resume.

## Behavior contract

- Pause marks only the current session as paused. Repeating it is harmless.
- While paused, Premind still polls every subscription and stores new events.
  The daemon does not hand any reminder to the session, including a batch built
  before the pause. This covers automatic lifecycle delivery and the
  `/premind:deliver` command.
- The pause survives every lifecycle transition until an explicit resume:
  - a host reload or restart;
  - Codex dormancy;
  - a Claude Code `SessionEnd`;
  - stale-session reaping.
- Resume returns the session to normal delivery. It does not re-register,
  recreate, remove, or change any subscription. Queued updates then arrive at
  the next safe boundary, under the host's normal idle and busy safeguards.
- Global enable and disable stay separate. They stop or start polling for every
  session and project.

## Design

### Durable pause state

Before this change, a pause was stored as `sessions.status = 'paused'`. Every
lifecycle transition overwrote that value:

- Pi deletes its session row on `session_shutdown`, including `/reload`, and
  re-registers it as active on `session_start`.
- Claude Code's `SessionEnd` marks the session closed.
- Codex's `SessionEnd` and `Interrupt` mark it dormant.
- The stale-session reaper marks it closed.

The pause is now stored in a separate `session_pauses` table, keyed by session
ID. The table has no foreign key, so the pause outlives Pi's delete and
re-register cycle. `isSessionPaused` checks the table, and also checks the
legacy `status = 'paused'` value, so existing rows keep working.

The pause gates every handoff path:

- `claimReminderBundle`
- `claimReminder` (the Claude Code and Codex claim path)
- the handoff registry's `getPendingReminder`
- `buildReminderBatch`
- the legacy `built → handed_off` acknowledgement, so a batch fetched just
  before a pause cannot be handed off after it

Status output reports a live paused session as `paused`. A pause whose session
never returns is pruned together with closed sessions, after the same
retention period.

### Harness surfaces

| Harness | Commands | Model tools | Session identity |
| --- | --- | --- | --- |
| Pi | `/premind:pause`, `/premind:resume` | `premind_pause`, `premind_resume` | current Pi session |
| Claude Code | `/premind:pause`, `/premind:resume` (prompt files) | `pause`, `resume` (MCP) | `CLAUDE_CODE_SESSION_ID` |
| OpenCode | `/premind:pause`, `/premind:resume` | `premind_pause`, `premind_resume` | current OpenCode session |
| Codex | none (unsupported: Codex plugins have no slash commands) | `premind_pause`, `premind_resume` (MCP) | required `sessionHandle` |

The tool descriptions come from each capability's `toolGuidance` in
`src/shared/command-capabilities.ts`. They tell agents to use pause and resume,
not the global controls. The shared result text lives in
`src/shared/session-pause.ts`. The Claude Code MCP server is plain JavaScript,
so it keeps its own copy of that text, and a test compares the two.

### Global-control safety

The enable and disable model tools require `confirmGlobal: true`. Without it,
they refuse the call before reaching the daemon. Their canonical guidance says
to call them only when the user explicitly asks for the global action, and to
use pause or resume for one session. User-invoked slash commands keep working
without the flag. Claude Code's command files pass it, because the user invoking
the command is the explicit request. Codex has no enable or disable tools yet;
#77 tracks that gap.

## Per-harness coverage

| Change | Pi | Claude Code | OpenCode | Codex |
| --- | --- | --- | --- | --- |
| Pause/resume commands | ✅ | ✅ | ✅ | unsupported (no slash commands) |
| Pause/resume model tools | ✅ | ✅ | ✅ | ✅ |
| Pause survives restart and reaping | ✅ | ✅ | ✅ | ✅ |
| Paused delivery withheld at the host boundary | ✅ | ✅ | ✅ | ✅ |
| `confirmGlobal` guard on enable/disable tools | ✅ | ✅ | ✅ | deferred (#77: no enable/disable tools) |
| Skill guidance | ✅ | ✅ | not applicable (no OpenCode skills) | ✅ |

## Verification

The shared capability scenarios in `src/test/capability-scenarios.test.ts` run
each check below through every harness's real tools and lifecycle. They use a
real router and state store:

- Pause withholds a queued reminder at the host's delivery boundary and leaves
  subscriptions unchanged. Resume delivers the reminder.
- A pause survives the host's real restart sequence and stale-session reaping.
- Unconfirmed global enable and disable calls are refused without a daemon
  write. Confirmed calls toggle the daemon-wide switch.

Daemon tests cover each lifecycle transition, the legacy-acknowledgement race,
and pruning of orphaned pauses. Adapter tests cover registrations, messages,
and the Claude Code mirror text.
