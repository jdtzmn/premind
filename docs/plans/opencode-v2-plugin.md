# Rewrite the OpenCode plugin for OpenCode V2

## Goal and scope

Rebuild premind's OpenCode integration on the OpenCode V2 plugin system, using
the Pi extension (`src/extension/index.ts`) as the model for what a good premind
integration feels like. V1 implementations do not run in OpenCode V2, so the
current plugin (`src/plugin-opencode/`) has to be rewritten, not ported.

Scope is **today's features, plus the OpenCode gaps tracked in #77**:
subscribe, unsubscribe, set-active-checkout and prune as commands, and the
`writePolicy` parameter on subscribe. Ideas that would take premind beyond Pi
(lasting PR context, urgency levels, user approval for `writePolicy`, forks
inheriting subscriptions, notifications) are tracked separately in #115 because
each one is a new cross-harness capability.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| V1 support | Dropped at cutover | V1 and V2 plugin APIs share no implementation surface; one package serving both would keep every V1 workaround alive. |
| Delay before a reminder starts a turn | None (`idleGraceMs` defaults to 0) | Matches Pi. The 60-second threshold, countdown toast and timer machinery go away. |
| When delivery is confirmed | When OpenCode accepts the synthetic message into its queue | Simpler than waiting for `session.inbox.delivered`, and a handoff cannot expire during a long run. The idempotent synthetic `id` prevents duplicates on retry. |
| Scope | Parity plus #77 | "Better than Pi" ideas are cross-harness work (#115). |
| End-to-end tests | Real daemon and real OpenCode server, fake GitHub and fake model | No secrets needed, so it runs on PRs. Other harnesses follow in #116. |

## What V2 replaces

| premind needs | V1 today | V2 surface |
|---|---|---|
| Reminder the user sees briefly and the model reads in full | Plain user prompt via `client.session.promptAsync` | `ctx.session.synthetic({ id, text, description, metadata, delivery, resume })` |
| Wait for current work, then start a turn | Idle threshold timers, countdown toast, busy re-checks | `delivery: "queue"` and `resume: true` (Pi's `followUp` and `triggerTurn`) |
| Busy and idle | `session.status`, `session.idle`, every `chat.message` | `session.execution.started` / `succeeded` / `failed` / `interrupted` |
| Slash commands | Marker templates in `config`, matched in `chat.message`, answered with a no-reply prompt, aborted by throwing `__PREMIND_HANDLED__` | `ctx.command.transform` on the server; slash and palette commands from the TUI part |
| Tools | V1 `tool()` with zod | `ctx.tool.transform` with a `premind` namespace |
| Skill | Unsupported (`opencode-no-skill-install`) | `ctx.skill.transform` |
| Colored status | Separate TUI plugin listed in `tui.json`, with its own daemon connection | `./tui` part of the same package; talks to the server part over `./rpc` |
| Lifecycle | `process.on("exit")` registered inside the `config` hook (repeatedly; async release never finishes) | `setup` returns a cleanup function; `location.shutdown` event |
| Settings | `~/.config/opencode/premind.jsonc` | `ctx.options` from the `plugins` entry |

## Design

### Package layout

One plugin, `id: "premind"`, loaded by one `plugins` entry:

- `exports["."]`: server part
- `exports["./tui"]`: TUI part
- `exports["./rpc"]`: RPC contract shared by both

During development the V2 plugin lives in `src/plugin-opencode-v2/` with V2's
bare-directory layout (`server.ts`, `tui.tsx`, `rpc.ts`), so the end-to-end
tests can load it by path. The cutover PR points the package exports at it.

### Delivery

1. Trigger on a session's execution ending, or on the status poll finding
   pending reminders while the session is idle.
2. Claim the whole bundle (`claimReminderBundle`).
3. Send one synthetic message:
   - `id`: derived from the handoff ID, so retries are idempotent
   - `description`: short label, for example `premind · 3 PR updates — CI failed: npm run check`
   - `text`: the full `<system-reminder>`
   - `metadata.premind`: `{ handoffId, events }`
   - `delivery: "queue"`, `resume: true`
4. `ackReminderBundle(confirmed)` once OpenCode accepts it; `ack(failed)` on any
   error after claiming.

The claim, single-flight, per-session generation, ack and poll-timeout logic
moves from the Pi extension into a shared controller in `src/shared/`. Each host
supplies only "send this bundle" and "is this session idle".

### Session lifecycle

- The daemon starts lazily on the first request; `setup` never spawns it.
- A session attaches on its first relevant event (`session.created`,
  `session.execution.started`, a tool call or a command).
- Child sessions (`parentID` set) and sessions from other locations are ignored.
- Cleanup and `location.shutdown` call `releaseSessionOwner`, leaving sessions
  dormant (#86). Only `session.deleted` calls `deleteSession`.
- On reload, sessions the daemon already knows for this location are
  re-attached.

### Tools and skill

- Registered through `ctx.tool.transform` under the `premind` namespace; names
  stay `premind_*`.
- `premind_probe` becomes `premind_doctor`; `premind_probe` stays as an alias.
- `premind_subscribe` gains `writePolicy`.
- The generated premind skill is registered through `ctx.skill.transform`.

### Commands

- The TUI part registers every canonical command as a slash and palette command
  that calls the server over RPC and shows the result in a dialog or toast,
  without a model turn: `premind:status`, `premind:debug-status`,
  `premind:doctor`, `premind:subscribe <pr> [repo]`, `premind:unsubscribe`,
  `premind:set-active-checkout <path>`, `premind:pause`, `premind:resume`,
  `premind:deliver`, `premind:enable`, `premind:disable`, `premind:prune`.
- The server part registers the same commands through `ctx.command.transform`
  for clients without the TUI (Desktop, web, `opencode run`).
- Old names (`premind-status`, `premind-enable`, `premind-disable`,
  `premind-send-now`) stay as aliases.

### TUI

- Footer indicator in `prompt.footer.status`, empty when healthy:
  ` N pending`, ` paused`, ` disabled`, ` error`. Driven by an RPC
  `status.changed` event, not polling.
- `/premind:status` opens a `session.panel` with live PR signals, reusing
  `getCurrentStatusLines` from `src/shared/status-view.ts`.

### Settings

Plugin options: `autoDeliver`, `idleGraceMs` (default 0), `showStatus`. The old
`premind.jsonc` is read for one release with a deprecation warning.

## Testing

### End-to-end harness

```
fake GitHub ─▶ real premind daemon ─▶ real OpenCode V2 server ─▶ fake model
 (HTTP stub)    (isolated state dir)   + premind from `npm pack`   (OpenAI-compatible stub
                                                                     that records requests)
```

- **Fake model**: an OpenAI-compatible provider pointed at a local stub that
  records requests and replies from a script, including scripted tool calls.
- **Fake GitHub**: the daemon gets a test-only setting for the GitHub API URL
  and token (`src/daemon/github/http.ts` already accepts `baseUrl`). Git
  detection falls back to the `origin` remote, so a temporary repo with a fake
  remote is enough.
- **Isolation**: temporary HOME/XDG directories, `PREMIND_STATE_DIR` and socket
  path; pinned OpenCode version; premind installed from the packed tarball.

Scenarios:

1. The plugin loads; its commands, tools and skill are listed.
2. A PR update while idle reaches the model; the transcript shows the short
   description; the daemon records the delivery as confirmed.
3. An update mid-run is delivered once, as one batch, after the run ends.
4. A scripted model call to `premind_subscribe` creates the subscription.
5. While paused nothing is delivered; after resume it is.
6. After a reload or restart the session re-attaches and nothing is delivered
   twice.
7. Deleting a session deletes it in the daemon; child sessions are ignored.

The TUI part is covered by unit tests against a fake TUI context and a VHS
recording attached to its PR.

### CI

- On PRs touching `src/plugin-opencode*/`, `src/daemon/` or `src/shared/`,
  against the pinned OpenCode version.
- Nightly against the latest OpenCode release.

`src/test/live-validation.ts` and its secrets-gated workflow are removed once
the harness covers them.

### Open questions for the spike (PR 4)

- How `description` renders in the TUI transcript.
- `queue` plus `resume: true` behavior, and inbox event order.
- Which locations the plugin's event stream covers.
- How a server command's output is shown.
- Whether server and TUI commands with the same name collide.
- Whether `ctx.skill.transform` registrations are visible to the agent.
- Plugin runtime (Bun or Node), which matters for `node:sqlite` in any code the
  plugin imports.

Findings are recorded here when the spike lands, and PRs 5–8 are adjusted
before they are written.

## PR stack

| # | PR | Proof |
|---|---|---|
| 1 | This plan | — |
| 2 | Shared delivery controller; Pi moved onto it with no behavior change | Pi tests unchanged; controller unit tests |
| 3 | Daemon test setting for the GitHub API URL; reusable fake GitHub | Daemon polls the fake |
| 4 | End-to-end harness, V2 skeleton, spike checks, CI workflow | Skeleton loads in a real server |
| 5 | V2 server lifecycle and delivery | Scenarios 2, 3, 6, 7 |
| 6 | V2 tools and skill | Scenarios 1, 4 |
| 7 | RPC contract and server commands | Scenarios 1, 5 |
| 8 | TUI part | Unit tests; VHS recording |
| 9 | Cutover: package exports, capability registry, cross-adapter driver, README, migration note | Full contract suites; e2e against installed package |
| 10 | Remove V1, `live-validation.ts`, its workflow; move `daemon-launcher.ts` to `src/client/` | Nothing imports old paths |

`main` stays releasable throughout: nothing user-facing changes until PR 9, and
the capability contract tests keep checking V1 until then.

## Per-harness coverage

| Harness | Change | Notes |
|---|---|---|
| Pi | Refactored onto the shared delivery controller (PR 2) | No behavior change; existing tests must pass unchanged. |
| Claude Code | None | Delivery stays at the Stop hook. |
| OpenCode | Rewritten for V2 (PRs 4–10) | Closes the #77 gaps for OpenCode and removes the `opencode-no-skill-install` host limitation. |
| Codex | None | Its #77 gaps stay deferred. |

The capability registry changes at cutover (PR 9) only remove OpenCode
exceptions; no new exceptions are added for any harness.
