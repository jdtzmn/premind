# Shared, lifecycle-safe session recovery

## Goal and scope

Recover a live, verified host session when Premind loses its registration, without
requiring a reload and without four independently maintained retry loops. Cover
Pi, Claude Code, OpenCode, and Codex in the same implementation change. This is a
plan only; no runtime changes are included in this commit.

The motivating symptom is `premind_subscribe` returning `SESSION_NOT_FOUND` for a
Pi session whose JSONL file still exists. That error identifies a missing daemon
record, not a missing transcript or a GitHub failure. The initiating loss of the
record is not yet established; recovery must not pretend to explain it.

## Current evidence

- `src/extension/index.ts`: `ensurePiSessionAttached` returns cached identifiers;
  `premind_subscribe` does not reattach if the daemon has forgotten the session.
- `src/plugin-opencode/index.ts`: `withReattach` already retries once and rejects
  child/nonexistent host sessions. Its reattachment also resets idle timing and
  restarts delivery polling; those lifecycle effects must survive consolidation.
- `plugin-claude/bin/mcp-server.mjs`: session tools send requests directly using
  `CLAUDE_CODE_SESSION_ID`. `plugin-claude/bin/lib.mjs` registers on SessionStart,
  but later touch/control calls do not share missing-session recovery.
- `src/codex/mcp-server.ts` and `session-binding.ts`: tools resolve opaque handles
  against active daemon sessions before sending requests. A missing row therefore
  normally fails handle resolution before reaching `subscribe`.
- `src/codex/lifecycle.ts`: hooks already re-register at delivery boundaries, but
  Stop/compact must not reactivate ended sessions. SessionEnd releases ownership.
- `src/client/daemon-client.ts`: reconnect replays remembered registrations after
  socket failures; an application-level `SESSION_NOT_FOUND` is not a socket error.
- The daemon already owns durable subscriptions, pause state, cursors, bindings,
  and leases. Normal stale reaping detaches rows; it does not delete them. A normal
  daemon restart should not be described as necessarily losing durable records.

## Design decision

Create one deep recovery module, provisionally `src/shared/session-recovery.ts`.
It owns error classification, eligibility, one retry, single-flight recovery,
registration-generation tracking, invalidation, and bounded failure reporting.
Adapters supply only host evidence, registration/lease operations, and lifecycle
integration. Do not put a Pi-specific catch around subscribe, or copy OpenCode's
wrapper into the other adapters.

Do not make the daemon create sessions from arbitrary `subscribe` payloads.
A session ID alone does not prove a live host session or establish its checkout.
Do not turn the low-level transport's generic retry loop into a blanket retry of
all session operations.

### Shared interface and packaging

A host-scoped controller exposes `run(operation, context, action)` and lifecycle
invalidation. Context is a verified identity plus a lifecycle generation; it is
not an unvalidated session ID. Internal adapters supply `verifyCurrent`,
`reattach`, and an optional post-reattach host lifecycle action. Exact names can
change during implementation, but retry policy must remain hidden in the module.

- Resolve identity before running; never select an arbitrary session by cwd.
- Retry only a positively identified missing-registration failure, on an audited
  operation list. Validate daemon handlers reject before side effects.
- Share one in-flight attachment per host/session/generation/daemon incarnation.
  Failed callers use an attachment revision so a late old failure does not cause
  another attachment after a peer already repaired the same registration.
- Recheck generation and host eligibility before attachment, after every awaited
  attachment step, and before retry or delivery side effects. Shutdown invalidates
  first. A newer lifecycle must not be overwritten by stale recovery completion.
- At most one attachment attempt and one replay per caller. No recursive recovery,
  retry-on-timeout, or retry-on-arbitrary-error. Clear failed single-flight entries
  in `finally`; a later independent request may recover again.
- Preserve structured daemon error codes in the TypeScript client and Claude
  transport. Normalize legacy `CODE: message` errors at a single compatibility
  seam; do not scatter message substring tests among adapters.
  Prerequisite: split transport and daemon error domains before adding `.code`.
  Today's client treats any error with `code` as a socket failure. Narrow that
  classifier to actual transport errors and explicitly exclude daemon responses.
  Missing/inactive/busy/moved daemon errors must cause zero transport reconnects
  or attached-session replay; only the controller may repair eligible absence.
- Compile the same TypeScript recovery module to a Node-compatible Claude runtime
  export using `scripts/build-runtime.mjs`; Claude's handwritten MJS entrypoints
  import that artifact. Extend artifact validation and packaging tests. Do not
  maintain a second handwritten JS implementation or require Bun in Claude.

### Shared durable attach semantics

Reuse and, where necessary, deepen the daemon's existing registration/store
transactions rather than create a second source of durable state in adapters.
Factor a shared internal ensure-registration path used by the four host entry
points. Keep their wire contracts and host validation intact; do not weaken
Codex's active-session gate or protocol-v2 lease ownership.

Attachment must:

1. Preserve existing subscription policies, pause state, checkout binding,
   delivery cursors, opt-outs, and pending handoff evidence. Refresh host ownership
   without interpreting recovery as a request to resume, mark idle, or overwrite
   the checkout with the launch cwd.
2. If the row is genuinely absent, recreate only from verified current host
   context. Reuse surviving pause data. New subscription cursors start at the
   current event high-water mark rather than replaying historical events.
3. Restore the last explicitly activated checkout if its durable binding is gone
   and a trusted current-generation recovery context retains it. Track successful
   checkout changes, including changes through command and tool surfaces. If an
   older context has no trustworthy checkout, fail clearly rather than guess.
4. Be idempotent and transactionally safe across processes. An in-memory
   single-flight promise is an optimization, not the cross-process correctness
   mechanism. Use existing daemon leases and Codex lifecycle locks where relevant.
5. Distinguish reattachment from destructive data loss: deleted subscriptions and
   lost reminder evidence cannot be reconstructed from a bare session ID. Restore
   what is authoritatively available, replay the requested operation, and report
   unavailable state rather than claim full recovery or invent old subscriptions.

Keep shared store logic internal, but add negotiated lifecycle/authority fields
where conditional daemon mutation requires them. Extend schemas, negotiation,
the legacy proxy allowlist, and compatibility tests together. An old peer that
cannot enforce fencing must fail actionably for recovery rather than silently
fall back to unconditional registration. Preserve safe diagnostic and existing
non-recovery behavior where compatible; do not downgrade deletion protection.

## Per-harness coverage

| Harness | Identity / liveness evidence | Integration and lifecycle obligations |
| --- | --- | --- |
| Pi | Current sessionManager identity and extension generation, not transcript existence alone | Route tools and slash commands through the controller; integrate busy/status/delivery lookups where safe; invalidate before shutdown/reload/new/resume/fork; re-register on the next session_start; preserve selected checkout and busy state. |
| Claude Code | Session ID from the supported host contract; hook event/environment agreement; current lifecycle evidence | Share the generated controller in MCP and hooks; persist only the minimal recovery context needed across processes, using atomic writes and lifecycle fencing; SessionEnd invalidates before suspend; Stop remains delivery owner and cannot revive an ended session. |
| OpenCode | Existing session.get primary-session validation and cached lifecycle evidence | Replace local retry mechanics with the controller; keep child/nonexistent-session exclusion, session-deletion invalidation, and post-reattach idle window/poll scheduling. All delivery paths still honor pause/end state. |
| Codex | Opaque handle bound to current host lifecycle evidence, not cwd or a stale binding file alone | Resolve verified local identity separately from daemon registration; share controller for tools and hooks; lifecycle lock/fencing prevents MCP recovery racing SessionEnd; Stop/compact cannot reactivate an ended session; reconnect registers only eligible active sessions. |

### Cross-process identity and end-state gate

Claude hooks/MCP and Codex hooks/MCP do not share one process. Persist a minimal
host recovery context under their existing private plugin state directories:
identity/handle, lifecycle generation and active/ended state, verified checkout,
and metadata needed for reattachment. Do not copy subscription or delivery state
out of the daemon. Use existing locks where possible; define a compatible lock
for Claude if required. An atomic rename alone does not serialize end/recovery.

Publish eligibility at real SessionStart/UserPromptSubmit boundaries, invalidate
it at SessionEnd before daemon cleanup, and require matching current evidence to
recover. Compaction and Stop are not proof of reactivation. A stale/legacy handle
without lifecycle evidence must fail closed with restart/resume guidance until a
real host boundary refreshes it. Explicit user deletion must not be treated as a
recoverable transient absence; invalidate corresponding eligibility too.

Before adding storage, check whether existing binding/lifecycle records can carry
these fields compatibly. Avoid a parallel store if those records suffice. Test
crash/stale-lock cleanup and mixed-version readers; do not infer liveness merely
from an old file's presence. A single directory may contain several sessions.

### Authoritative deletion and lifecycle mutation ordering

Add daemon-owned lifecycle authority separate from the disposable registration
row: host identity/incarnation, monotonic generation, active/ended/deleted reason,
and a conditional-mutation revision. Explicit delete writes a tombstone in the
same transaction that closes the session. Registration pruning must not remove
that evidence; retain it until an explicitly authorized new lifecycle supersedes
it. An ordinary Claude end/resume is distinct from explicit user deletion.
Recovery, touch/update, reconnect replay, release, and suspend must compare the
expected incarnation/generation transactionally. A stale request cannot mutate a
newer generation even if it finishes after the caller's timeout.

The linearization point is the daemon transaction, not a post-await client check.
Publish end intent durably under host lifecycle coordination before bounded
cleanup. If lock acquisition or IPC times out, retain that intent for reconciliation;
do not silently grant recovery because cleanup failed. Begin/ensure consult end
intent before mutation. Move Codex registration into lifecycle coordination (it
currently precedes lock acquisition); fence cleanup as well as registration.
Keep output fenced against local end intent; do not hold a SQLite transaction
across host IPC/output. Reuse existing locks/leases, but do not assume they already
provide host-generation fencing. This requires additive negotiated protocol
support and a migration; old clients must not be able to bypass protected deletion
or generation checks. Specify legacy mutation handling and verify it explicitly.

If the entire daemon state, including tombstones, is lost, prior deletion is
unknowable. Fail closed for automatic recreation from an old recovery context;
require a fresh real host lifecycle boundary and reset guidance. Never promise
perfect deletion remembrance after total state loss. A changed database authority
epoch invalidates old recovery credentials; a normal restart retains the epoch.

### Concrete host evidence and Codex preflight

Keep the controller storage/host-API neutral. Host adapters must implement this
evidence contract, proven in phase 1 before enabling recovery:

- Pi: a live extension instance observes session_start and binds a fresh
  incarnation to that sessionManager identity. OpenCode: bind an incarnation to
  the plugin's verified primary host session and invalidate on host deletion.
- Claude/Codex: real SessionStart or UserPromptSubmit publishes a current
  incarnation under lifecycle coordination. Bind each MCP launch to that exact
  incarnation through a host-supported launch token or a validated live host
  process/launch relationship; never let it adopt a newer generation merely by
  rereading a session-ID-keyed file. Codex's handle must include/match the lifecycle
  evidence, not just its reusable legacy UUID. Authenticate evidence publication
  through supported host input, not a caller-supplied arbitrary session ID.
- Record the verified host owner identity with process start identity (not PID
  alone) where supported. Recovery verifies that owner is still live and bound
  to the launch. An active file or recent timestamp alone does not prove liveness.
  Crash without End revokes eligibility when the owner is gone; stale MCP cannot
  inherit successor authority after same-ID resume.
- MCP-before-Start waits for a real boundary or fails with actionable guidance;
  no guessed cwd/session fallback. Compact/Stop preserve an existing incarnation
  but never mint reactivation authority. Real resume/start may establish a new
  incarnation; delayed old cleanup is rejected by the generation fence.
- Context files are owner-only, atomically published under the existing private
  state directory; validate schema, path, identity, and process evidence. Keep
  unsupported or legacy evidence fail-closed until refreshed by a real boundary.

Phase 1 must demonstrate the actual launch/incarnation mechanism for both hook
hosts against their supported contracts. If a host cannot supply a reliable
launch/owner relationship, do not substitute old file presence: stop that design
slice, report the evidence gap, and design a supported handshake before shipping
the all-host change. This is a verification gate, not a harness exception.

Codex preflight separates local handle verification from daemon lookup and returns
one of three states to the same shared controller:

1. Verified current handle + active/paused row of the correct host: operate.
2. Verified current lifecycle + genuinely absent row + valid authority epoch and
   no deletion/end tombstone: authorize one bounded repair.
3. Inactive/dormant/detached/closed/wrong-host row, unknown or ambiguous handle,
   stale generation, or missing evidence: fail closed; do not catch generic handle
   resolution errors and turn them into registration.

Status does not repair. Non-reactivating Stop/compact registration on an absent
row must return inactive/no-op unless the shared policy has independently
authorized repair using current evidence. `reactivate:false` must not by itself
create a new active row, as the current handler does.

## Operation policy

- Initial recovery allowlist: subscribe, unsubscribe, activate checkout, pause,
  resume, and advisory state/status operations whose missing-session rejection is
  verified to occur before mutation. A pause/resume request is applied after
  reattachment, not accidentally undone by it.
- Status must still diagnose inactive/unbound sessions without automatically
  resurrecting them. Keep daemon-global tools outside session recovery.
- Delivery/polling paths use the same eligibility and registration controller to
  ensure a valid attachment, but claims, acknowledgements, settlements, and host
  message sends are NOT blindly replayed. Retain handoff tokens/receipts and
  existing idempotency rules. Never acknowledge or redeliver merely because a
  registration was repaired.
- Cleanup, explicit deletion, SessionEnd, release ownership, and suspension never
  trigger reattachment. SESSION_INACTIVE, lease conflict, invalid identity,
  authorization failure, and arbitrary transport failure are not SESSION_NOT_FOUND.
- Preserve concise host-appropriate diagnostics. Include recovery reason/outcome
  in existing debug logging without transcript contents, secrets, or noisy retries.

## Incremental implementation and validation

Each phase ends with focused validation and a commit. Keep the runtime feature
unexposed until all four adapters are integrated; do not ship a temporary harness
exception to make capability tests pass.

1. **Lock down the contract and reproduce.** Add a regression fixture that removes
   the registration after a successful attach, then invokes real adapter controls.
   Demonstrate current Pi failure and OpenCode recovery. Distinguish missing row,
   detached/closed row, missing client lease, and missing local identity. Inventory
   actual no-side-effect error sites and existing cross-process storage/locks.
   Prove hook/MCP launch-incarnation binding, owner liveness, startup ordering,
   and end intent before selecting new storage fields. If proof is unavailable,
   resolve that design blocker before implementation; do not weaken eligibility.
2. **Implement the shared module and durable attach invariants.** First separate
   transport/daemon error domains, then add typed errors, operation policy,
   generation-fenced single-flight, tombstones/authority epoch, and conditional
   store mutation. Unit tests cover concurrent/late failures, recovery errors,
   retry exhaustion, cancellation/end, timeout non-retry, preserved pause/cursors,
   and late server-side completion. Add the Claude build export and package-runtime
   test before adapter use. Split this phase into small validated commits.
3. **Integrate all four adapters.** Replace OpenCode's local mechanics; route Pi
   commands/tools/lifecycle, Claude MCP/hooks, and Codex MCP/hooks through the same
   controller. Add or extend private recovery context only as needed. Audit every
   delivery path and reconnect path, not just subscription tools. Validate each
   adapter's targeted tests before committing. Use small all-host integration
   slices (identity/lifecycle, controls, then delivery/reconnect) rather than a
   single broad adapter commit. Update the Claude shared-harness driver: it
   currently bypasses SessionStart and invokes MCP in-process, so it must exercise
   the real evidence publisher instead of fabricating eligibility.
4. **Cross-harness and installed-runtime verification.** Extend the shared
   capability scenarios and lifecycle/delivery scenarios to iterate all four
   harnesses. Confirm no adapter implements its own missing-session retry policy.
   Extend recovery scenarios for existing subscribe/pause/checkout capabilities
   in `src/shared/command-capabilities.ts` and its tests plus
   `src/test/command-capability-contract.test.ts`; do not invent a new public
   recovery capability. Include an installed Node subprocess hook-to-MCP-to-End
   test using an isolated shared state directory, not just in-process mocks.

Required acceptance cases, parameterized where possible:

- Live session + missing registration + subscribe succeeds exactly once.
- Parallel failures perform one attachment; a late failure uses its repaired
  revision; second missing-session failure terminates with a useful diagnostic.
- Non-missing errors do not re-register or replay anything.
- Existing pause, subscription policy, opt-outs, cursors, checkout, and handoff
  evidence are unchanged; newly recreated subscriptions are future-events-only.
- Active checkout differs from startup cwd; recovery retains the active checkout.
- Shutdown, reload, new/fork/resume, SessionEnd, explicit deletion, and host session
  disappearance race with recovery without reactivating or messaging old sessions.
- Claude/Codex hook and MCP processes race on recovery and end-state; multiple
  sessions in one cwd and stale handles cannot cross-bind or resurrect sessions.
- Paused/inactive sessions remain undelivered through polls, Stop, turn-end,
  reconnect, and manual delivery paths, according to their existing contracts.
- Restart/handover with intact DB preserves durable data; missing DB does not
  falsely claim restoration; protocol-v1/v2 compatibility and leases remain safe.
- Installed Claude Node runtime imports the shared artifact; both Codex package
  layouts include their updated runtime; Pi/OpenCode ship the same shared source.
- Structured missing/inactive/busy/moved daemon errors trigger zero transport
  reconnects or registration replay; real socket failures retain bounded recovery.
- Delete from another client while the original host remains live, then prune;
  original tools/poll/reconnect cannot repair over the tombstone. Claude normal
  end/resume differs from explicit deletion; total DB loss requires fresh proof.
- Deferred registration executes after End, cleanup lock exceeds its timeout,
  old release/suspend executes after new Start, and timed-out IPC finishes late:
  assert final daemon state AND absence of stale host output.
- Codex handle matrix: absent, active, paused, dormant, detached, closed, wrong-host,
  unknown, and ambiguous; absent-row Stop/compact never independently activates.
- Crash without End; stale MCP survives same-ID resume; MCP starts before hooks;
  hook/environment mismatch; multiple identities share one state directory.
  No process may acquire successor authority merely by rereading a context file.
- Old protocol clients cannot bypass lifecycle fences or delete tombstones;
  unsupported recovery is actionable and never an unconditional fallback.

Run fast targeted tests locally using repository-supported invocations and an
isolated test state directory; use CI for the comprehensive matrix. Include
`src/client/daemon-client.test.ts`, store/router tests, adapter reattach/lifecycle
and MCP tests, Claude wire/runtime packaging tests, shared capability tests, and
cross-harness delivery-conservation coverage. Do not reset or mutate the user's
live daemon/database to reproduce this failure.

## Non-goals and remaining uncertainty

No new public command is needed. No generic retry framework, delivery protocol
rewrite, full Claude transport rewrite, or claim of recovering erased history.
The exact cause of the originally missing row remains a separate diagnosis.
Implementation should estimate its size after phase 1: cross-process lifecycle
fencing makes a complete four-host fix larger than a catch-and-retry patch.

## Review

Independent read-only sub-agent review completed. Accepted all five findings:

1. Add authoritative daemon deletion evidence rather than assume local
   eligibility is invalidated by another client's delete.
2. Fence mutations transactionally and retain end intent through cleanup timeout;
   client post-await checks and existing leases/locks alone are insufficient.
3. Make Codex preflight distinguish absent registration from inactive identity,
   and prevent non-reactivating absent-row Stop/compact from creating active rows.
4. Require a demonstrated MCP/host incarnation contract, not an old active file.
5. Separate transport and daemon error domains before introducing typed codes.

Also accepted the real Claude subprocess validation requirement and the
simplifications: keep the controller host/storage neutral, extend existing
capability scenarios rather than add a public recovery command, and use small
integration commits. The revised plan has been source-reference/coverage checked;
no runtime tests were run for this documentation-only change.

Phase 1's host-contract experiment remains an explicit implementation gate, not
a claim that supported launch/incarnation evidence has already been demonstrated.
If that experiment fails, revise the handshake design before enabling recovery.
