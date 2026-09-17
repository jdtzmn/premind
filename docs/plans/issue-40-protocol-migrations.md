# Graceful Client-Daemon Protocol Migrations

## Context

[Issue #40](https://github.com/jdtzmn/premind/issues/40) exposed that `protocolVersion: 1` does not identify a stable wire contract. Request and response schemas changed while the version stayed fixed, clients parse responses directly into the newest domain schema, and capability detection is inferred from `BAD_REQUEST` fallbacks. A newly loaded Pi or OpenCode extension, or a short-lived Claude hook, can therefore encounter an older daemon and fail on an unrelated command.

The immediate regression is a pre-host-tracking `debugStatus` response whose `sessions[]` entries omit `host`. A new Pi client reaches that response after `/premind:flush` finds no reminder and refreshes the status bar, then fails while parsing the response.

Mixed versions are normal:

- Pi and OpenCode extensions can reload while their sessions continue.
- Claude hooks are independent short-lived processes.
- Several host versions can share premind state at once.
- A user may keep one session alive across many premind releases.

A protocol compatibility window is necessary, but it must not leave a compatible old daemon running forever. The product should use compatibility adapters while a new daemon becomes ready, move live sessions to it without restarting those sessions, and let old daemons drain only the sessions that have not moved.

## User-visible behavior

After the bridge release described below, upgrading premind should behave like a rolling server deployment:

1. A newly loaded client initializes against the daemon currently serving its session and continues using the negotiated old protocol.
2. If its packaged daemon build is newer, it starts that daemon alongside the old one on a unique socket.
3. The new daemon becomes discoverable only after its socket, protocol codecs, and database compatibility checks are ready.
4. At the next safe host boundary, the client claims the **same session ID** on the new daemon. The conversation, subscriptions, cursors, pending reminders, and worktree association do not restart.
5. The old daemon keeps responding for sessions that have not moved. It is fenced from mutating a session after that session's ownership generation changes.
6. An old daemon exits after it owns no live session leases, reminder handoffs, in-flight requests, or background coordinator lease, followed by a short rollback grace period.

Normally the user sees nothing. A status surface may briefly report `premind updating…` or `premind reconnecting…`; it must not ask the user to restart a healthy host session. If several releases arrive before a safe boundary, the client moves directly to the newest ready compatible daemon rather than visiting every intermediate build.

A dead session cannot pin an old daemon forever. Pi and OpenCode renew **session-scoped** leases; a process-wide client heartbeat does not renew all sessions. Claude hooks claim a session only for the invocation and do not hold a lease between hooks. When a session lease expires, ownership is cleared but durable session state remains available for a later reclaim.

## Recommended approach

Keep the existing newline-delimited JSON transport, Zod, and SQLite WAL database. Add:

- an LSP/MCP-style `initialize` handshake for protocol and capability negotiation;
- immutable versioned wire DTOs and centralized legacy adapters;
- per-daemon instance sockets and an atomic discovery registry;
- database-backed session leases with monotonically increasing fencing generations;
- one database-backed, fenced background-coordinator lease so only one daemon runs schedulers and maintenance at a time;
- expand/contract database migrations compatible with side-by-side daemon versions;
- `semver` for build ordering and downgrade prevention;
- `proper-lockfile` for deduplicating concurrent launches of the same build, not for enforcing a singleton daemon.
- `fast-check` model-based commands for the bounded lease state-machine invariant test, with reproducible seeds and shrinking.

Do **not** migrate to JSON-RPC, Protocol Buffers, gRPC, or MCP transport in this issue. Those transports do not supply rolling ownership, session fencing, or migration safety. Protocol Buffers would improve unknown-field behavior, but introducing code generation and a second encoding across TypeScript and the committed Claude runtime is much larger than the local protocol problem. Existing Zod codecs can provide the required guarantees when wire versions are immutable.

## Protocol contract

### Bootstrap handshake

Reserve a small bootstrap contract independent of normal protocol versions:

```json
{
  "type": "initialize",
  "bootstrapVersion": 1,
  "payload": {
    "client": { "host": "pi", "version": "0.2.0", "commit": "abc123" },
    "protocols": { "min": 1, "max": 2 }
  }
}
```

A bridge-aware daemon returns:

```json
{
  "ok": true,
  "bootstrapVersion": 1,
  "result": {
    "daemon": {
      "instanceId": "uuid",
      "pid": 1234,
      "version": "0.2.0",
      "commit": "def456",
      "socketPath": "/tmp/premind-501/d-uuid.sock"
    },
    "protocols": { "min": 1, "max": 2, "selected": 2 },
    "capabilities": {
      "operations": ["registerClient", "debugStatus"],
      "rollingSessions": true
    },
    "storage": { "schemaCapabilities": ["base", "session-leases-v1"] }
  }
}
```

The client verifies the selected protocol is in its offered range and stores an immutable connection profile keyed by daemon `instanceId`. It renegotiates after `SESSION_MOVED`, transport loss, or instance change. A short-lived Claude hook initializes once per invocation.

A pre-handshake daemon rejects `initialize` with its protocol-v1 `BAD_REQUEST` envelope. The client recognizes that exact historical envelope and selects a documented `legacy-v1` profile instead of applying current schemas.

### Version guarantees

`protocolVersion` identifies the complete request and response wire contract for normal operations. Once released, a version's schemas and semantics are immutable.

| Change | Rule |
| --- | --- |
| Internal fix without wire or semantic change | No bump |
| New operation | Same version only when capability-advertised and old clients remain unaffected |
| Optional response field | Same version only when every reader for that version already ignores unknown fields; otherwise bump |
| New or changed request field | Bump because older strict daemons may reject it |
| Required response field, type/removal/rename, or acknowledgment/error semantic change | Bump |
| Bootstrap change | Add a bootstrap version while continuing to accept bootstrap v1 |

Protocol v1 is explicitly legacy because incompatible variants already shipped under that number. Protocol v2 becomes the first immutable contract. New clients prefer their packaged daemon and newest protocol, but retain supported older codecs for the published compatibility window.

### Wire and domain separation

Create versioned wire modules under `src/shared/protocol/`:

- `bootstrap.ts` — stable initialization and typed incompatibility errors;
- `v1.ts` — supported historical v1 request/response variants;
- `v2.ts` — the first immutable canonical contract;
- `adapters.ts` — wire-to-domain normalization;
- `capabilities.ts` — operation, rolling-session, and storage capabilities.

Response codecs use Zod stripping so unknown additive fields do not break readers. Request codecs remain strict. Host code consumes normalized domain objects and never parses the newest wire schema directly.

For the immediate regression, the legacy v1 `debugStatus` adapter accepts missing `sessions[].host` and normalizes it into a diagnostic domain type whose host union includes `"unknown"`. Registration and v2 wire schemas still accept only real hosts (`pi`, `opencode`, `claude`).

### Stable errors

Keep `{ ok, protocolVersion, error: { code, message } }` parseable for legacy requests and add structured data only where old readers ignore it. Define:

- `PROTOCOL_UNSUPPORTED` — no protocol overlap;
- `CLIENT_UPGRADE_REQUIRED` — a legacy request is too ambiguous to serve safely;
- `DAEMON_UPGRADE_REQUIRED` — the operation needs a newer daemon;
- `DAEMON_STARTING` — an instance exists but is not ready;
- `SESSION_MOVED` — the request used a stale instance/generation and must rediscover;
- `SESSION_BUSY` — a non-replayable request or handoff is preventing cutover;
- `SCHEMA_UNSUPPORTED` — the daemon cannot safely use the current database schema.

The envelope echoes the request protocol version so an old client can parse a clear rejection.

## Daemon discovery and selection

### Instance registry

Each daemon binds a short, unique Unix socket such as `/tmp/premind-<uid>/d-<id>.sock`. Socket directories use owner-only permissions and stay short enough for platform Unix-socket limits.

After readiness, the daemon atomically writes an instance descriptor under `PREMIND_STATE_DIR/instances/` containing its instance ID, socket path, package version, commit, supported protocol range, schema capabilities, lifecycle state, and last heartbeat. A descriptor is only a discovery hint: clients probe the socket and verify the initialization response before trusting it.

Clients select in this order:

1. the newest ready build with protocol and schema overlap;
2. for equal package versions, an exact commit match to avoid switching between incomparable development builds;
3. the currently serving compatible instance while a newer packaged daemon starts;
4. otherwise an actionable incompatibility error.

A draining, quiescent (except for its explicitly authorized rollback session), stale, unreachable, protocol-incompatible, or schema-incompatible instance is never selected for a new claim. An older client never launches its older daemon merely because a newer compatible daemon is already running. `semver` compares released versions; an exact version+commit match resolves local/development ties without attempting to order commit hashes.

`proper-lockfile` uses a lock keyed by version+commit to prevent two hosts from launching duplicate instances of the same build. Different builds are intentionally allowed to coexist.
A client launches its packaged daemon only when that build is newer than every compatible ready instance, or when no compatible ready instance exists. It never launches a lower version to match a downgraded client.

### Rapid releases

Five breaking contracts in one week may produce protocol versions v3 through v7. Compatibility retention keeps old clients functional, but it does not pin updated clients to old daemons:

- if the session reaches a safe boundary after each release, it rolls to each exact packaged daemon;
- if releases accumulate while the session is busy, intermediate ready daemons receive no session leases and drain, while the client moves directly to v7;
- sessions whose clients did not update remain on their old daemons until they move, end, or their leases expire.

## Session ownership and rolling cutover

Store ownership separately from durable session state:

```text
session_daemon_leases
  session_id             primary key
  owner_instance_id
  generation             monotonically increasing
  lease_expires_at
```

### Claim and fencing rules

- Pi and OpenCode renew each live session lease explicitly. Their generic client heartbeat proves process health only.
- Claude hooks atomically claim for one invocation and release at its end; inactivity between hooks never pins a daemon.
- A clean session end releases ownership immediately.
- A crashed or silently deleted session stops renewing. After `lease_expires_at`, a compare-and-swap clears ownership while preserving the session, subscriptions, cursors, worktree binding, and reminders.
- Claiming on another daemon increments `generation` transactionally. Every session-scoped mutation and reminder settlement validates `owner_instance_id` and `generation` in the same transaction as its write.
- A stale daemon cannot renew, unregister, acknowledge, or mutate a migrated session. It returns `SESSION_MOVED` and the client rediscovers.
- Transfer occurs at a host safe boundary. If a non-replayable mutation or reminder handoff is in flight, the client continues on the old daemon and retries after settlement instead of forcing cutover.

When an old daemon loses its final live session, it enters `quiescent` for a short rollback grace: it serves in-flight work and permits only a fenced reclaim by a session that just left it, but accepts no unrelated new claims. After grace it enters `draining` and exits once its remaining work and coordinator lease clear. This lets a client roll back if the new instance fails immediately without allowing the old daemon to attract fresh sessions indefinitely.

## Shared background work

Side-by-side daemons must not run duplicate GitHub polling and maintenance loops. Use one fenced `background-coordinator` lease in SQLite:

```text
coordinator_lease
  resource_key           primary key
  owner_instance_id
  generation
  lease_expires_at
```

Only the lease holder starts branch discovery, PR polling, reaping, and cleanup schedulers. Scheduler writes validate the coordinator generation. A newer ready daemon may request leadership transfer independently of session movement; otherwise leadership changes when the lease is released or expires. Watcher state is reconstructed from SQLite as it is after a restart today.

An old daemon is drainable only when it has:

- no unexpired session leases;
- no in-flight IPC requests;
- no unsettled reminder handoffs;
- no background-coordinator lease;
- and no rollback-grace timer remaining.

Rows for dormant sessions do not count. Therefore a crashed session delays shutdown by at most its session lease TTL plus drain grace, not forever.

## Database evolution

SQLite already runs in WAL mode, which supports concurrent readers and a serialized writer. Rolling daemons additionally require application-level migration discipline:

1. **Expand:** add tables, columns, indexes, and dual-read/dual-write support that every daemon in the compatibility window tolerates.
2. Roll clients and daemons while old and new versions coexist.
3. **Contract:** remove old representations only after their protocol/build support window expires and no registered live instance requires them.

Track named schema capabilities/migrations rather than treating one latest `PRAGMA user_version` as permission for destructive change. Apply migrations once under a database migration lease/transaction. A daemon checks required and unsupported capabilities before claiming sessions or coordinator leadership. An older binary encountering an incompatible contracted schema returns `SCHEMA_UNSUPPORTED` before mutation; it never attempts an automatic downgrade.

## Legacy bridge exception

A pre-bridge singleton daemon uses the well-known socket and does not participate in session fencing or coordinator leases. It cannot safely share SQLite with a bridge-aware active daemon. The first upgrade therefore remains a one-time exception:

1. the new client uses legacy v1 adapters while the old daemon remains live;
2. at a safe boundary, it requests graceful shutdown if supported, or presents a clear manual restart instruction if not;
3. only after the legacy socket owner and database connection are gone does the first bridge daemon start and register the session;
4. every later upgrade uses side-by-side rolling cutover.

Never kill an unidentified PID or unlink a reachable legacy socket.

## Supported compatibility matrix

| Client | Daemon | Behavior |
| --- | --- | --- |
| Current client | Pre-handshake v1 singleton | Use explicit legacy profile; perform the one-time bridge cutover only through safe shutdown/manual recovery |
| Current client | Older bridge-aware daemon | Continue temporarily, start exact packaged daemon, then move the session at a safe boundary |
| Current client | Exact current daemon | Reuse it and negotiate the highest common protocol |
| Current client | Future compatible daemon | Use it without launching an older daemon |
| Old client | Its old daemon | Continue while its live session lease is renewed |
| Old client | New compatible daemon | Negotiate a retained protocol or receive a parseable upgrade error for ambiguous v1 operations |
| No protocol overlap | Any bridge-aware fleet | Start/select a compatible packaged instance only if the database schema overlaps; otherwise return an actionable error |
| Downgraded package | Newer compatible daemon | Use the newer daemon; never replace it with an older build |
| Downgraded package | Contracted newer schema | Reject before any database mutation |

Pi and OpenCode background refreshes surface compact health state without crashing the host. User commands include actionable detail. Claude lifecycle hooks continue to fail open, while Claude commands and MCP diagnostics report incompatibility.

## Implementation phases

### Phase 1 — Pin historical v1 and the immediate regression

- Capture raw fixtures from the last pre-host daemon, the pre-bundle daemon, the first bundle daemon, and the current tokenized-bundle daemon, with source commit metadata.
- Add versioned v1 decoders and diagnostic-domain normalization.
- Prove Pi `/premind:flush` can receive no reminder, refresh a pre-host `debugStatus`, and finish without error.
- Preserve existing bundle/session-control fallbacks behind the v1 adapter rather than host code.

**Validation:** historical fixture contract test and targeted Pi/OpenCode/Claude adapter tests. Commit.

### Phase 2 — Add initialization and immutable protocol v2

- Add `src/shared/protocol/{bootstrap,v1,v2,adapters,capabilities}.ts`.
- Split permissive header/bootstrap parsing from strict versioned request parsing.
- Include build, instance, protocol, operations, rolling-session, and schema capabilities in initialization.
- Move wire response parsing out of daemon-client methods.
- Replace `BAD_REQUEST` feature inference with negotiated capabilities.

**Validation:** codec/negotiation table tests for legacy fallback, overlap selection, no overlap, additive response fields, malformed selection, and stable errors. Commit.

### Phase 3 — Add daemon instances and deterministic discovery

- Add per-instance sockets, atomic descriptors, descriptor heartbeats, and stale-descriptor cleanup.
- Add `semver` selection and `proper-lockfile` launch deduplication keyed by build.
- Replace boolean `probeDaemon` with typed discovery states: `starting`, `ready`, `quiescent`, `draining`, `stale`, `incompatible`, or `legacy`.
- Spawn the packaged build only when it is newer than all compatible ready instances, or when no compatible ready instance exists.
- Bind the unique socket before opening SQLite or publishing readiness.

**Validation:** discovery selection table and concurrent same-build launch test. Commit.

### Phase 4 — Add fenced session ownership and rolling cutover

- Add session lease storage, generation compare-and-swap, expiry, clean release, and durable dormant state.
- Require owner generation on every session mutation and reminder settlement.
- Move `PremindDaemonClient` into `src/shared/` and implement rediscovery after `SESSION_MOVED`.
- Migrate at safe host boundaries without treating ordinary active session leases as blockers.
- Keep the old instance alive through rollback grace and let it serve unmigrated sessions.

**Validation:** two-session rolling scenario, stale-writer fencing race, dead-session expiry, and cutover-during-handoff scenario. Commit.

### Phase 5 — Lease background coordination and make migrations rolling-safe

- Add the fenced singleton background-coordinator lease and leadership transfer.
- Start schedulers only while holding the live generation; reconstruct them from SQLite after transfer.
- Introduce named schema capabilities and an expand/contract migration policy.
- Gate session claims and coordinator leadership on schema compatibility.
- Reject downgrade before mutation.

**Validation:** concurrent leader election/failover and old/new expand-schema coexistence tests. Commit.

### Phase 6 — Apply the shared runtime to every host

- Pi and OpenCode renew session-scoped leases and move at their safe lifecycle boundaries.
- Generate the Claude protocol/discovery client from shared TypeScript; remove hand-maintained protocol constants and parsing from `plugin-claude/bin/lib.mjs`.
- Make each Claude invocation select the newest ready compatible instance without leaving a persistent session lease.
- Add user-visible `updating`, `reconnecting`, and actionable failure diagnostics without noisy success notifications.
- Add a generated-artifact drift check.

**Validation:** one parameterized adapter contract suite over Pi, OpenCode, and Claude, plus packaging/generated-runtime checks. Commit.

### Phase 7 — Cross-version CI, lifecycle cleanup, and release documentation

- Add a dedicated `test:protocol-compat` script and CI job.
- Add the minimally spanning scenario suite below over real Unix sockets and temporary SQLite databases.
- Document protocol bump rules, rolling lifecycle, support window, downgrade behavior, and manual legacy recovery in `docs/protocol.md`.
- Build daemon, Pi, OpenCode, and Claude artifacts from one tag with the same embedded version/commit.

**Validation:** `bun run check`, `bun run test:protocol-compat`, `bun run test:harness`, `bun run test:claude`, and the existing CI suite. Commit.

## Minimally spanning test plan

The suite should cover behavioral boundaries, not every client-version × daemon-version × host Cartesian product. Use fake clocks and explicit readiness/barrier promises; do not use timing sleeps. Reuse the existing adapter-driver registry so host coverage is parameterized rather than copied.

### Invariants

1. **Continuity:** moving a session never changes its durable identity, subscriptions, cursor, worktree binding, or pending reminders.
2. **Single owner:** at most one daemon generation may mutate a session.
3. **Dead sessions drain:** an unrenewed session cannot pin a daemon beyond lease TTL plus grace.
4. **Live old sessions continue:** moving one session does not interrupt another session on the old daemon.
5. **Delivery conservation:** a reminder is confirmed once or remains retryable across cutover/crash.
6. **Single coordinator:** at most one live generation runs background polling/maintenance.
7. **Ready-before-move:** a client never leaves a healthy old daemon for an unready candidate.
8. **No downgrade mutation:** incompatible older code performs no database writes.
9. **Bounded fleet:** instances with no live ownership/coordinator work eventually disappear.
10. **Host parity:** Pi, OpenCode, and Claude use the same negotiation and ownership rules despite different lifecycles.

### Core scenarios

#### T1 — Historical v1 boundary

Drive the current shared client against raw historical socket fixtures:

- pre-host `debugStatus` without `sessions[].host`;
- no pending reminder followed by status refresh;
- single-reminder claim/ack;
- old bundle response/ack;
- current tokenized bundle response/ack.

Assert normalized domain results and exact outgoing legacy wire shapes. Replay representative old requests into the current daemon and assert either the historical response shape or a v1-parseable `CLIENT_UPGRADE_REQUIRED` error.

**Covers:** immediate regression, legacy detection, bidirectional v1 behavior.

#### T2 — Discovery and build selection table

One table-driven test supplies descriptors for exact, newer, older, starting, quiescent, draining, stale, unreachable, protocol-incompatible, and schema-incompatible instances. Assert that the client:

- chooses the newest compatible ready build;
- uses the exact commit only as a same-version tie-breaker;
- ignores descriptor claims not confirmed by handshake;
- ignores quiescent instances for new claims but permits a matching fenced rollback authorization;
- remains on its healthy old instance while an exact candidate starts;
- never launches an older daemon when a newer compatible daemon exists;
- launches at most one copy of the same build under concurrent clients.

**Covers:** deterministic selection, readiness, downgrade prevention, launch deduplication.

#### T3 — Two sessions split across a rolling update

Start daemon A with sessions S1 and S2. Start ready daemon B, move only S1, and assert:

- S1 keeps all durable state and is served by B;
- A rejects a late S1 mutation with `SESSION_MOVED`;
- S2 continues normal requests and reminder delivery through A;
- A remains alive while S2's lease is live;
- ending S2 releases immediately and A exits only after handoffs/coordinator ownership and rollback grace clear.

**Covers:** continuity, fencing, old-daemon availability, graceful drain.

#### T4 — Dead session with a live host process

Register S1 and S2 through one long-lived OpenCode/Pi client process. Continue the generic client heartbeat and S1 lease renewal, but stop S2 renewal without sending session-end. Advance the fake clock and assert:

- S2 ownership expires despite the process heartbeat;
- S2's durable rows remain;
- the owning daemon can drain if S2 was its final live lease;
- a later S2 event claims it on the newest daemon with a higher generation and preserved cursor/reminders.

**Covers:** the orphaned-session case explicitly; proves client heartbeat cannot pin dead sessions.

#### T5 — Atomic claim and stale-writer race

Pause daemon A after it reads S1 ownership but before its write. Claim S1 on daemon B, incrementing generation, then release A. Assert A's conditional mutation, heartbeat, acknowledgment, and unregister all fail without changing data, while B's equivalent operations succeed. Race two claimers and assert exactly one generation wins.

**Covers:** split-brain prevention and compare-and-swap correctness.

#### T6 — Cutover during reminder delivery

Exercise the two meaningful cutover points:

1. before handoff claim: move immediately and let B claim/deliver;
2. after handoff claim but before confirmation: keep S1 on A until confirmation or failed/stale recovery, then move.

Assert one confirmed delivery, no duplicate injection, and no lost batch in both cases. Do not enumerate every acknowledgment state already covered by reminder-handoff unit tests.

**Covers:** delivery conservation at the only non-replayable session boundary.

#### T7 — Five rapid breaking releases

Model bridge-aware builds/protocols v2 through v7 with one persistent session:

- first, allow a safe boundary after each release and assert five transparent generation changes with unchanged session state;
- then queue all five releases before one safe boundary and assert the session moves once from v2 directly to v7;
- assert unused intermediate instances acquire no session lease and drain;
- keep a second v2 client live and assert its session remains served throughout.

**Covers:** the motivating product scenario, compatibility retention, coalescing, and bounded fleet size.

#### T8 — Candidate failure and rollback

Cover the two distinct failure boundaries:

1. B fails readiness before claim: client stays on A and no ownership changes;
2. B crashes after claim: its lease expires, the client reports `reconnecting`, and its rollback authorization lets quiescent A (or another compatible ready instance) reclaim with a newer generation.

Assert durable state and pending reminders survive, unhealthy B is not immediately reselected, and no two owners write concurrently.

**Covers:** ready-before-move and post-cutover recovery without multiplying failure permutations.

#### T9 — Background coordinator transfer

Start A and B concurrently against one temporary WAL database. Assert exactly one coordinator generation starts schedulers. Pause the old leader at a fenced write, transfer/expire leadership to B, then release A and assert:

- A's stale write is rejected;
- B reconstructs watcher state and continues polling;
- one source update produces one persisted event/reminder, not duplicates;
- A can exit after its sessions and grace clear.

**Covers:** global split-brain prevention and scheduler continuity.

#### T10 — Expand/contract and downgrade safety

Apply an additive migration with A still live, start B, and prove both versions can execute their supported operations. Attempt the contract migration while A is registered and assert it is refused. After A drains and the support gate allows contraction, apply it once. Then start an older binary and assert `SCHEMA_UNSUPPORTED` occurs before any write, recovery, or scheduler startup.

**Covers:** rolling database compatibility, migration serialization, and downgrade safety.

#### T11 — Host lifecycle contract

Run one parameterized contract through the existing Pi, OpenCode, and Claude adapter drivers:

- initialize/discover newest ready daemon;
- preserve host session identity across a move;
- deliver one persisted reminder after the move;
- cleanly release ownership.

Add only host-specific assertions that differ:

- Pi/OpenCode renew a session-scoped lease and move at their safe lifecycle boundary;
- Claude selects per hook invocation and leaves no persistent lease.

**Covers:** host parity without repeating the daemon state-machine scenarios three times.

#### T12 — Legacy bridge transition

Run a real pre-bridge fixture daemon on the well-known socket. Assert a bridge-aware client does not start a competing active daemon or open SQLite concurrently. Verify compatible legacy operation first, then:

- graceful legacy shutdown path when supported;
- clear manual-restart result when unsupported.

After shutdown, start the first bridge daemon, reattach the same session, and prove subsequent B→C migration uses rolling cutover.

**Covers:** the one unavoidable singleton transition and proves it does not leak into later upgrades.

### Why this set is sufficient

The twelve scenarios each cross a distinct correctness boundary: historical wire parsing, discovery, multi-session draining, orphan expiry, fencing, non-replayable handoff, rapid releases, rollout failure, global leadership, storage evolution, host lifecycle, and the legacy bridge. Removing any scenario leaves one named invariant untested. Expanding every scenario across every host or adjacent version would repeat shared logic without increasing boundary coverage.

Add one bounded `fast-check` model-based test over the store-level lease model using commands for `claim`, `renew`, `move`, `expire`, `release`, and `crash`. Its only properties are the ten invariants above. Record the seed and shrunk minimal command sequence on failure; keep socket/subprocess tests deterministic and non-randomized.

## Compatibility and release policy

Ship a bridge release before any further incompatible payload change:

1. The bridge introduces initialization, protocol v2, instance discovery, fencing, rolling-safe schema expansion, and shared generated clients.
2. The pre-bridge singleton transition uses the explicit legacy exception once.
3. Every later release starts side by side and moves sessions individually.
4. Retain a protocol generation and adapters for at least two published minor releases and at least 90 days, whichever is longer. Rapid releases therefore accumulate supported codecs; they do not force active users through manual restarts.
5. A live old session may remain on its daemon throughout that window. Dead leases expire normally. End-of-support behavior must be announced and return an actionable upgrade error before an old daemon stops renewing an otherwise live session.
6. Historical fixtures remain permanently even after an adapter is removed.
7. Publish daemon, Pi, OpenCode, and generated Claude artifacts from the same tag and embedded version/commit.

## Acceptance criteria

Issue #40 is complete when deterministic tests and documentation demonstrate that:

- a new client identifies a legacy daemon before applying current schemas;
- pre-host `debugStatus` no longer breaks Pi `/premind:flush`;
- protocol and operation support come from initialization, not failure probing;
- protocol v2 wire schemas are immutable and separate from domain models;
- a new daemon becomes ready beside an old daemon before any session moves;
- moving one session does not interrupt sessions that remain on the old daemon;
- stale generations cannot mutate, renew, unregister, or acknowledge a moved session;
- a dead session expires without deletion and cannot pin a daemon beyond lease TTL plus grace;
- reminders are confirmed once or remain retryable across move and crash boundaries;
- exactly one coordinator generation performs polling and maintenance;
- five rapid breaking releases preserve one continuous session and coalesce when appropriate;
- failed candidates leave the old daemon usable or recover through a newer fenced claim;
- expand/contract migrations permit supported coexistence and refuse downgrade before mutation;
- Pi, OpenCode, and Claude share the same negotiation/ownership implementation;
- old daemons drain after their last live lease/work item rather than after their last durable session row;
- generated Claude runtime files come from the same protocol sources and release tag;
- and the support window, end-of-support behavior, downgrade behavior, and legacy recovery path are documented.

## Non-goals

- Replacing the Unix socket transport.
- Supporting arbitrary combinations of unreleased commits.
- Automatically killing an unidentified legacy daemon.
- Running destructive database migrations while an old supported daemon remains live.
- Migrating a non-replayable in-flight operation by force.
