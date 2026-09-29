# Plan: Current-Session Status and PR Links

## Goal

Resolve [#62](https://github.com/jdtzmn/premind/issues/62) and [#66](https://github.com/jdtzmn/premind/issues/66) with one current-session-first status experience: show the current branch, which PRs this session watches (with URLs), what needs attention, and whether premind is running. When a developer asks which PRs were created during the work, these associated/watchlisted links are what they need—not a search of all PRs they have ever opened.

`/premind:debug-status` is the separate all-session diagnostic view. Agents use `premind_status` for the current session and `premind_debug_status` only for daemon-wide troubleshooting. Do **not** add a general `/premind:prs` command, an all-authored-PR query, or a new GitHub search API for this plan; other tools already serve that need.

## Normal Status: One Session, Only Its Watched PRs

Illustrative output (interactive hosts color the signal glyph and its label; unstyled text remains readable):

```text
premind · running · polling on · 3 watchers
jdtzmn/premind @ jacob/better-status · active/idle · 0 pending

Watching 4 PRs · branch PR #67
  ✗ #67 Improve status · CI failing, conflicts — https://github.com/jdtzmn/premind/pull/67
  ○ #65 Recover Pi sessions · draft — https://github.com/jdtzmn/premind/pull/65
  ◆ #64 Earlier change · merged — https://github.com/jdtzmn/premind/pull/64
  ✓ #63 Fix checks · ready to merge — https://github.com/jdtzmn/premind/pull/63

2 other sessions: /premind:debug-status
```

The daemon's `3 watchers` and this session's `4 PRs` are deliberately different metrics: terminal PRs can remain subscribed even when they are no longer polled. No PR is included merely because the authenticated user authored it. The branch PR is identified **once** in the heading, not with repeated `[branch]` badges; when it is not subscribed, say `branch PR #67 (not watched)` and do not smuggle it into the watched list. Show `Watching 0 PRs` when appropriate. The final hint points only to other-session diagnostics and is omitted when there are no other sessions.

Every watched PR gets one row, deduplicated by `repo#number`, regardless of whether it is automatic, manual, foreign-authored, or in another repository. Qualify cross-repo entries with `owner/repo#number`; use the current repo as implicit context for local entries. Show title when known and a full raw URL, clickable wherever the host recognizes links. When no snapshot has arrived, derive the canonical `https://github.com/owner/repo/pull/number` link from a validated subscription repo/number, but show `status unknown` rather than guessing title or health. A merged/closed PR remains visible only while its subscription is active; no blanket list of historical PRs.

The header keeps daemon reachability, global polling state, and watcher count. The context row keeps repository, branch, session lifecycle/busy state, and pending reminder count. If globally disabled, say `polling off · /premind:enable`; if the daemon is unreachable, show a short failure plus `/premind:doctor`. If no current session can be resolved, show daemon health and `no premind session attached` rather than choosing another session. Status must be local and useful when GitHub is unavailable: it does **not** issue a new GitHub API request, attach a session, or mutate subscriptions.

### PR signal vocabulary

Use **one primary glyph per PR** (the most important applicable state) followed by short, explicit text. Additional simultaneous problems remain visible as words: `✗ CI failing, conflicts`, not two undecipherable symbols. Put the signal beside the PR title; do not add a separate legend to every status call. Order watched PRs with the branch PR first, then actionable blockers, then other active PRs, then terminal PRs; keep the ordering deterministic and do not cap away watched PRs silently.

| Signal | Meaning / source | Required interactive color |
| --- | --- | --- |
| `✗ conflicts` | Open PR with confirmed current merge conflict (`mergeStateStatus: DIRTY`). | Red |
| `✗ CI failing` | At least one current-head check has a failing conclusion; retain `conflicts` too if both apply. | Red |
| `! changes requested` | Current review decision requests changes; not equivalent to a CI failure. | Amber |
| `○ draft` | Open PR with `isDraft: true`; suppress any `ready` claim. | Muted |
| `… checks pending` | Current checks still running/pending; not a failure. | Amber |
| `! blocked` / `! review needed` | GitHub says blocked/behind or review required; show the verified cause if known. | Amber |
| `✓ ready to merge` | Open, non-draft, recent verified `CLEAN` merge state, passing/complete checks, no blocking review; never inferred just from an absence of known failures. | Green |
| `◆ merged` | Verified terminal `MERGED` state; historical CI/review problems must not masquerade as current blockers. | Purple |
| `○ closed` | Verified closed without merge; different from merged. | Muted |
| `? status unknown` | Missing/stale snapshot or GitHub `UNKNOWN`/insufficient evidence; never green by default. | Neutral |

Precedence for a **fresh** snapshot's primary glyph: merged/closed > conflicts/CI failures > changes requested/other blockers > draft > pending > ready > unknown. Keep relevant secondary facts as words, except historical blockers after a terminal state. A draft with failing CI therefore reads `✗ CI failing, draft`; a conflicting PR with failing CI reads `✗ conflicts, CI failing`. For missing, stale, or `mergeStateStatus: UNKNOWN` evidence, prefer `? status unknown` and optionally show a clearly labeled **last known** state rather than claiming a current blocker or `ready`; a verified `MERGED` terminal state remains terminal. Use the snapshot's `fetchedAt` and define/test a freshness threshold tied to watcher cadence before asserting current health.

GitHub's [`MergeStateStatus` definitions](https://docs.github.com/en/graphql/reference/pulls#enum-mergestatestatus) distinguish `CLEAN`, `DIRTY`, `DRAFT`, `BLOCKED`, `BEHIND`, `UNSTABLE`, and `UNKNOWN`; do not collapse them into a single green/red flag. The daemon already stores a watched PR's title, URL, state, draft flag, merge state, review decision, checks, and snapshot timestamp. Its current `debugStatus` response exposes only session/subscription identifiers and counts, **not** those PR details. Add a read-only, typed local projection of cached snapshots for the current session's watched PRs, with optional/missing fields when no snapshot exists. Do not perform one synchronous GitHub request per PR merely to draw status.

### Color, Unicode, and accessibility

Common text glyphs `✗ ✓ ○ ◆ ! ? …` and their semantic colors are **required in interactive host rendering**; no emoji or Nerd Font dependency. Always include words (`CI failing`, `merged`, `draft`, etc.), so a monochrome screen reader transcript or agent tool result retains meaning. Render glyph and state words in red/amber/green/purple/muted/neutral using each host's supported theme or text-styling API, with an explicit accessible palette/fallback for hosts without a theme API. The unstyled tool/JSON/non-TTY representation remains a necessary transport fallback, not a product choice to omit colors from the interactive status UI. Never leak raw ANSI escapes into MCP/tool responses, logs, redirected output, or links; a terminal renderer must honor `NO_COLOR`/non-TTY behavior. Test both colored interactive rendering and unstyled output with intact URLs.

## Full Diagnostics: A Separate Command

`/premind:debug-status` / `premind_debug_status` show the daemon synopsis plus active clients, active/closed sessions, protocol, last reap, and all sessions with host, shortened ID, repo/branch, lifecycle/busy state, pending count, worktree binding, subscription write policy/state, and a marker for the current session. It can reuse the same **cached** watched-PR signals; it should not call the network. This is the only surface that normally enumerates unrelated sessions. `/premind:doctor` remains for adapter configuration/process troubleshooting. Neither status command creates, attaches, reactivates, or prunes sessions.

## Host and Data Contract

- Keep the existing `debugStatus` operation as cheap local diagnostic state. New clients explicitly request cached PR summaries with `includeSnapshots: true`; the empty-payload response must retain its legacy strict-schema shape for already-running older clients. Fall back to the legacy request when an older daemon rejects the opt-in. Never add network fetches to status; build a pure projection/renderer with current-session ID and explicit overview/diagnostic views.
- Pi resolves the active session using `currentSessionId` or `getPiSessionId(ctx)` without attaching just to inspect. OpenCode uses the invoking `ctx.sessionID`, not `lastPrimarySessionId` when an ID is supplied. Codex uses its existing session binding. Claude retains its intentional aggregate/redacted privacy boundary until its own safe session identity is available; never expose an unredacted all-sessions view there by accident.
- Register the two status capabilities in the command-capability registry, update generated docs/host names, and give model tools matching descriptions: `premind_status` for watched current-session PRs and `premind_debug_status` for daemon-wide inspection. Document host-specific privacy or surface exceptions explicitly.
- Preserve a readable unstyled renderer for tools/non-interactive modes and add a **colored interactive renderer** for each host that supports status UI; Pi uses its theme, and other hosts use their native styling path or accessible terminal palette where applicable. If a host cannot render colored status within its current surface, choose a supported interactive surface rather than silently dropping the requirement. First implementation remains text-based; an interactive PR picker is a later, optional enhancement.

## Reference Patterns

- [`gh pr status`](https://cli.github.com/manual/gh_pr_status) leads with the current branch and separates other PRs by relevance; `gh pr checks` is a separate drill-down. Premind keeps the same contextual priority but limits *status* to subscriptions.
- [`gh-dash`](https://gh-dash.dev/configuration/theme/) offers compact colored status cues, but [requires a Nerd Font for its icons](https://gh-dash.dev/getting-started); premind uses common glyphs and redundant words instead.
- [Graphite's `gt log`](https://graphite.com/docs/visualize-stack) visualizes verified branch stacks. Premind's watched PRs do not by themselves encode dependencies; do not draw a tree or claim stack topology without supporting data.
- The GitHub CLI documents [`NO_COLOR` and TTY behavior](https://cli.github.com/manual/gh_help_environment); use similar conventions if a terminal-native renderer is ever added.

## Delivery Phases

1. **Current session and diagnostics.** Implement the read-only current-session projection, watched-only overview, separate debug command/tool, plain-text PR rows, current/other-session selection, and focused tests. Initially unknown PR details must render honestly. Validate and commit this slice.
2. **Verified PR signals and required colors.** Expose cached snapshot summaries, derive glyph/word states from current evidence, apply conservative `ready` and freshness rules, and test merged/closed/draft/conflict/failing/pending/review/stale combinations. Render semantic colors in interactive hosts, retaining a readable unstyled transport fallback. Validate and commit this slice.
3. **Adapter parity and polish.** Align Codex and Claude with their documented capabilities/privacy boundaries, update generated plugin artifacts using normal packaging, and check command-capability documentation. Optional clickable modal work is explicitly out of scope. Validate and commit this slice.

## Acceptance Criteria

- Normal status lists **only active subscriptions of the current session**, not all of the viewer's open PRs or another daemon session's PRs. It still reports the current branch PR association even when that PR is not watched.
- The compact header retains daemon/polling/watcher state, repo/branch, session state, pending count, and a truthful count of other sessions. Each watched PR has one row, a URL, and a word-labeled signal; foreign/cross-repo subscriptions remain visible.
- Confirmed CI failures, conflicts, merged, closed, draft, review blockers, pending checks, ready, and unknown states render with their specified glyph, word label, and **required interactive semantic color**, deterministic precedence, and no false `ready` from incomplete or stale data. Unstyled/monochrome tool output remains intelligible.
- Issue #66 is satisfied by the linked, session-associated PR list in ordinary status; no authored-PR inventory, viewer search, or new PR-list command is added.
- `/premind:debug-status` preserves all-session diagnostic detail without making ordinary status noisy. Missing session binding, missing/stale snapshots, and disabled polling each have honest, actionable output; GitHub outages do not suppress cached watched-PR links.
- Tests cover current-session isolation, deduplication, terminal-vs-historical blockers, dual blockers, status freshness, render fallback, URL integrity, host command/tool wiring, and capability-doc drift.
