# Native agent lifecycle harness

## Goal and scope

Build one reusable native-test framework for Premind's four supported coding-agent
surfaces: Pi, Claude Code, OpenCode, and Codex. Prove that real installed integrations
remain attached and consume reminders after lifecycle transitions and failures.
Start with a working Pi vertical slice, onboard a second host early, then extend the
same scenarios across all four. Infrastructure increments are not claims of native
coverage for hosts or scenarios that have not actually run.

Keep the existing adapter/Router tests: they give fast, deterministic coverage of
business rules. Native tests add the missing composition boundary; do not relabel
simulated callbacks, intercepted delivery methods, or direct Router calls as native.
This effort does not itself wire the separately planned session-recovery runtime.

## Architecture

Shared infrastructure owns:

- Short-lived isolated home, agent configuration, workspace, Premind state, and
  artifacts. Never copy personal agent directories, credentials, or secret env files.
- An explicit environment allowlist; no inherited provider credentials, agent
  sessions, Premind overrides, or user startup hooks. Give each run a unique socket
  and database. Paths must fit Unix socket limits on Linux and macOS.
- Process supervision, bounded readiness/operation deadlines, exit diagnostics,
  graceful shutdown followed by bounded forced termination, and idempotent cleanup.
- Real production daemon subprocess, SQLite persistence, and Unix socket transport.
  Reuse production entrypoints; no test-only production bypasses or alternate router.
- Scripted provider and GitHub fixtures. Only external services are fake. The model
  receipt must depend on a unique reminder marker actually present in its request;
  an unconditional canned answer is not evidence of consumption.
- Scenario orchestration, delivery/identity assertions, injected faults, and artifacts.

Native host drivers own:

- Installing/loading the packed production integration, launching the real host,
  adapting its provider wire format, and controlling it through its public protocol.
- Obtaining native identity and performing native resume, reload, session switch,
  child-session, and shutdown operations. Use a narrow PTY driver where RPC cannot
  exercise an interactive path. Never substitute directly invoked lifecycle callbacks.
- Observing model-context consumption and host-specific confirmation boundaries.
  Transport acceptance alone does not prove reminder consumption.
- Host-specific diagnostics and additional scenarios for meaningful native differences.

Extract shared interfaces from working drivers, not hypothetical host APIs. Prefer
small modules to a generic event bus or large inheritance hierarchy. Shared scenarios
express what correctness means; drivers express how each host reaches the boundary.

## Per-harness coverage table

This table is a delivery plan, not an exception registry or a claim of passing tests.
No harness is excused from production capability requirements. When native execution
is unavailable, report that distinctly; never add a capability exception to get green.

| Harness | Native control / evidence to establish | Common contract | Host-specific lifecycle focus |
| --- | --- | --- | --- |
| Pi | Real CLI RPC; PTY for interactive-only operations | Baseline, resume, identity isolation, daemon/network recovery, pause | Extension reload, session switch, parent/child lifetime |
| Claude Code | Real CLI public streaming protocol and installed hooks/MCP | Same common contract | Retained MCP process, new/resumed parent identity, child hook identity |
| OpenCode | Real server process and public SDK/event stream | Same common contract | Server/session lifetime, reconnect, parent/child relationships |
| Codex | Real supported native protocol and packaged plugin/hooks | Same common contract | Turn continuation, dormant/resumed sessions, child lifecycle and receipt boundary |

Record tested binary versions and actual supported operations. A missing native
operation is an explicit coverage gap requiring investigation, not simulated success.
All new user-facing runtime behavior, if needed, must cover every harness in the
same change under the repository's command-capability rules.

## Scenarios and proof obligations

Baseline: launch host and daemon; subscribe through the actual integration tool;
produce a unique upstream update; observe it in the host's next model request;
observe a marker-dependent receipt; verify production handoff confirmation.

Repeat a fresh control operation and a fresh update after every perturbation:

1. Leave and resume the intended session, including restarting the host process.
2. Switch between two sessions and return; prove no cross-session delivery.
3. Start, finish, and cancel child agents; parent identity and delivery remain intact.
4. Reload/restart the integration through the host's native lifecycle.
5. Kill and restart the daemon while the host survives; reconnect automatically.
6. Break the socket and restore it; retries and operation durations remain bounded.
7. Inject upstream timeout, rate limit, and transient outage; state survives recovery.
8. Pause before transitions; no delivery until explicit resume.
9. End/delete while recovery is pending; no session resurrection or stale updates.

Assert expected native/daemon identity, checkout, subscription and cursor continuity,
no duplicate confirmed delivery, and correct retry identity for unconfirmed handoffs.
Do not promise exactly-once delivery across an ambiguous host crash. Add negative
controls: a wrong/absent marker must fail consumption assertions, a dead process must
fail readiness, and a wrong session must never satisfy another session's receipt.

Use condition-based waits with diagnostic deadlines, not fixed sleeps as evidence.
Seeded longer sequences must print the seed and support reproducing a minimal trace.

## Incremental PR stack

Each layer has its own branch, targeted validation, commit, and dependent PR.

1. **Plan** — this document and explicit acceptance boundaries.
2. **Shared native runtime foundation** — isolated sandbox, environment isolation,
   process supervision, deadline helpers, bounded diagnostic artifacts, and regression
   tests using real subprocesses. Establish shared outcome vocabulary for all four
   hosts. Prove cleanup and timeout behavior before introducing model complexity.
3. **Real daemon fixture** — production daemon over real socket/database, explicit
   state isolation and restart control. Exercise real IPC before any host assertions.
4. **Deterministic native baseline** — scripted model/upstream and packed artifact;
   actual Pi host baseline, leave/resume, and daemon-restart scenarios. Add an early
   second-host baseline (OpenCode unless investigation shows a stronger choice) to
   validate the seam. Keep host coverage outcomes explicit throughout the rollout.
5. **Four-host drivers and lifecycle matrix** — Claude/Codex native baseline, then
   common scenarios plus native-specific extensions. Extend shared scenario contracts
   rather than maintaining disconnected copies of the same test.
6. **CI and resilience expansion** — named native checks, nightly fault sequences,
   pinned/version-matrix canaries, redacted artifacts and documentation. Add production
   doctor/timeline improvements only as separately scoped four-harness changes.

A partial stack may be published while implementation continues. PR descriptions
must state the exact proof added and remaining native gaps. Do not mark the whole
initiative complete after only infrastructure tests pass.

## Validation and CI

- Per increment: smallest relevant tests, package/type checks for touched boundaries;
  use existing CI for comprehensive validation rather than duplicating full suites.
- Required fast PR lane: infrastructure tests and deterministic native scenarios as
  each host is onboarded. Adjust current main-only PR workflow filtering so dependent
  stack PRs receive checks too. Pin host versions and document upgrade policy.
- Nightly: longer seeded lifecycle/fault combinations and supported-version matrix.
- Release canary: separately labelled authenticated provider checks. No credentials in
  deterministic tests; credential absence cannot silently turn a required test green.
- Missing host executable, unsupported operation, skipped coverage, and failed
  assertions are distinct outcomes. Required lanes fail on missing prerequisites.
  Optional discovery may report unavailable, but must never claim a native pass.
- CI owns job-level timeouts; the runner also enforces per-operation bounds and cleans
  up on failure. Artifact upload runs on failure, is bounded, and contains only fixture
  metadata and sanitized timelines, not arbitrary prompts, environments or secrets.

## Diagnostics and completion

Failure artifacts should identify host/version, scenario/seed, process exits, native
and daemon identity, and ordered registration/reconnect/handoff/confirmation events.
Keep fixture logs bounded; make failures useful without dumping unrestricted state.
Retain failure artifacts deliberately and remove disposable state after processes end.

The initiative is complete only when all four real hosts pass the agreed baseline and
lifecycle matrix in CI, negative controls demonstrate meaningful assertions, failures
produce usable artifacts, and documentation distinguishes this evidence from adapter
and optional live-provider checks. Adding drivers or green unit tests alone is not
completion.
