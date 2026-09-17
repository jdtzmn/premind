# Graceful Client-Daemon Protocol Migrations

## Context

[Issue #40](https://github.com/jdtzmn/premind/issues/40) exposed that `protocolVersion: 1` does not identify a stable wire contract. Request and response schemas changed while the version stayed fixed, clients parse responses directly into the newest domain schema, and capability detection is inferred from `BAD_REQUEST` fallbacks. A newly loaded Pi or OpenCode extension, or a short-lived Claude hook, can therefore encounter an older daemon and fail on an unrelated command.

The immediate regression is a pre-host-tracking `debugStatus` response whose `sessions[]` entries omit `host`. A new Pi client reaches that response after `/premind:flush` finds no reminder and refreshes the status bar, then fails while parsing the response.

Mixed versions are normal:

- Pi and OpenCode extensions can reload while their sessions continue.
- Claude hooks are independent short-lived processes.
- Several host versions can share premind state at once.
- A user may keep one session alive across many premind releases.
- A dormant session may be resumed years after its original plugin and daemon stopped.

Compatibility adapters must keep old clients working without pinning updated clients to old daemons. After a one-time bridge from the current singleton, new daemon builds should start side by side, sessions should move independently without restarting their host conversations, and old daemons should drain only after their live work leaves or expires.

## Product decisions

1. **Transport:** keep newline-delimited JSON, Zod, and SQLite WAL. Do not migrate to JSON-RPC, Protobuf, gRPC, or MCP transport.
2. **Upgrade model:** after the bridge release, use per-instance sockets and rolling session movement. Never stop a healthy old daemon merely because a newer daemon exists.
3. **Reminder guarantee:** guarantee no durable reminder loss and exactly-once cursor/settlement. Host injection is at-least-once in the crash window after injection but before confirmation; a visible duplicate is preferable to silent loss.
4. **Legacy quarantine:** move modern authoritative state to a new storage epoch/path. While modern code runs, keep a safe-v1 proxy on the historical socket. Do not install an OS service. After reboot, a pre-bridge client that starts before the proxy fails closed against a quarantined historical state path; the coding session continues with an update-required Premind error.
5. **Old-client support:** permit one daemon per actively used supported build. Announce end-of-support at least 30 days before rejecting lease renewal. Most users update and never see this warning.
6. **Session retention:** process/plugin shutdown detaches and preserves state. Only explicit logical session deletion starts retention. After full state is pruned, retain a lightweight identity/generation tombstone.
7. **OpenCode routing:** one OpenCode process may route different logical sessions to different daemon instances. Routing and lease tokens are per session, not process-global.
8. **Coordinator:** transfer GitHub polling and maintenance leadership to the newest ready daemon even while old daemons continue serving old sessions.
9. **Storage evolution:** keep the old representation authoritative while old writers exist. Maintain compatible projections, then perform final backfill and contraction only after prior writers are fenced and drained.

## User-visible behavior

After the bridge release, a normal update behaves like a rolling server deployment:

1. A newly loaded client initializes against the daemon currently serving its session and continues using the negotiated old protocol.
2. If its packaged daemon is newer than every live build, it starts that daemon alongside the old one on a unique socket.
3. The new daemon becomes discoverable only after its socket, protocol codecs, storage epoch, and schema capabilities are ready.
4. At the next safe host boundary, the client claims the **same session ID** on the new daemon. Conversation identity, subscriptions, cursors, pending reminders, and worktree association do not restart.
5. The old daemon keeps responding for sessions that have not moved. Fencing prevents it from mutating a session after ownership changes.
6. When an old daemon has no live session leases, unsettled handoffs, in-flight requests, or coordinator lease, it enters a short rollback grace and then exits.

Normally the user sees nothing. A status surface may briefly report `premind updating…` or `premind reconnecting…`; it must not ask the user to restart a healthy host session.

A compatibility-expiry warning is exceptional. It is shown only to a still-running deprecated plugin during the final 30 days before its published deadline, once when first observed and in status/diagnostics rather than on every renewal. At expiry the coding session continues, but Premind lease renewal is rejected until the plugin updates.

## Protocol contract

### Permanent bootstrap v1

Bootstrap v1 is a permanent, narrow compatibility surface. It is separate from normal protocol versions and must remain parseable by every bridge-aware client.

Request:

```json
{
  "type": "initialize",
  "bootstrapVersion": 1,
  "payload": {
    "client": {
      "host": "pi",
      "version": "0.2.0",
      "commit": "abc123",
      "incarnationNonce": "uuid"
    },
    "protocols": { "min": 1, "max": 2 }
  }
}
```

Success:

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
      "socketPath": "/tmp/premind-501/d-uuid.sock",
      "lifecycleState": "ready"
    },
    "protocols": { "min": 1, "max": 2, "selected": 2 },
    "capabilities": {
      "operations": ["registerClient", "debugStatus"],
      "rollingSessions": true
    },
    "storage": {
      "epoch": 2,
      "capabilities": ["base", "session-leases-v1"]
    }
  }
}
```

No-overlap failure has no selected normal protocol and therefore uses only the bootstrap envelope:

```json
{
  "ok": false,
  "bootstrapVersion": 1,
  "error": {
    "code": "PROTOCOL_UNSUPPORTED",
    "message": "Update the premind plugin to continue",
    "supported": { "min": 7, "max": 7 }
  }
}
```

Bootstrap v1 fixes required fields, success/failure envelopes, tolerant unknown-field handling, and lifecycle behavior. Unknown lifecycle states fail closed for selection. A pre-handshake daemon rejects `initialize` with its historical protocol-v1 `BAD_REQUEST`; the current client recognizes that exact fixture and selects `legacy-v1` rather than applying current schemas.

### Normal protocol versions

`protocolVersion` identifies immutable base envelopes and every existing operation's request, response, and semantics. Once released:

| Change | Rule |
| --- | --- |
| Internal fix without wire or semantic change | No bump |
| New capability-advertised operation | May remain on the version because existing messages do not change |
| Optional additive response data | Same version only when existing readers already strip unknown fields |
| New or changed request field | Bump because older strict daemons may reject it |
| Required response field, type/removal/rename, or acknowledgment/error semantic change | Bump |
| Bootstrap/discovery change | Add an optional field or a new bootstrap format while retaining v1 |

Protocol v1 is explicitly legacy because incompatible variants already shipped under that number. Protocol v2 becomes the first immutable normal contract.

### Wire and domain separation

Create versioned wire modules under `src/shared/protocol/`:

- `bootstrap.ts` — permanent initialization success/failure contracts;
- `descriptor.ts` — permanent additive instance-descriptor v1;
- `v1.ts` — supported historical v1 variants;
- `v2.ts` — the first immutable normal protocol;
- `adapters.ts` — wire-to-domain normalization;
- `capabilities.ts` — operation, rolling-session, and storage capabilities.

Response codecs strip unknown fields. Request codecs remain strict. Host code consumes normalized domain objects and never parses the newest wire schema directly.

For the immediate regression, the v1 `debugStatus` adapter accepts missing `sessions[].host` and normalizes it into a diagnostic domain type whose host union includes `"unknown"`. Registration and v2 wire schemas still accept only real hosts (`pi`, `opencode`, `claude`).

### Stable errors

Normal protocol errors retain `{ ok, protocolVersion, error: { code, message } }` and echo the request version. Bootstrap errors use the bootstrap envelope above. Define:

- `PROTOCOL_UNSUPPORTED` — no normal protocol overlap;
- `CLIENT_UPGRADE_REQUIRED` — historical behavior is too ambiguous to serve safely;
- `DAEMON_UPGRADE_REQUIRED` — an operation needs a newer daemon;
- `DAEMON_STARTING` — an instance exists but is not ready;
- `DAEMON_DOWNGRADE_BLOCKED` — the packaged daemon is below a live or persisted floor;
- `SESSION_MOVED` — a stale route/lease token must rediscover;
- `SESSION_BUSY` — an operation or handoff prevents cutover;
- `SCHEMA_UNSUPPORTED` — storage capabilities do not overlap;
- `SUPPORT_EXPIRED` — the plugin passed its announced renewal deadline.

## Instance discovery and launch ordering

### Permanent descriptor v1

Each daemon binds a short, unique owner-only Unix socket such as `/tmp/premind-<uid>/d-<id>.sock`. After readiness it atomically writes one descriptor under `PREMIND_STATE_DIR/instances/` containing fixed v1 fields: descriptor format, instance ID, socket path, package version, commit, protocol range, storage epoch/capabilities, lifecycle state, and heartbeat time.

Descriptor v1 and its root/file naming are permanent additive discovery surfaces. Clients strip unknown fields, reject unknown lifecycle states for selection, and always verify the socket's bootstrap response. A descriptor is never proof of liveness or identity by itself.

Lifecycle states are:

- `starting` — not selectable;
- `ready` — selectable;
- `quiescent` — only a specifically authorized rollback session may reclaim;
- `draining` — no new claims;
- stale/unreachable — ignored and later cleaned.

### Selection and launch

Clients maintain a per-session route map and select:

1. the newest ready build with normal-protocol and storage overlap;
2. for equal package versions, the exact commit only as a development-build tie-breaker;
3. the session's current compatible owner while a strictly newer packaged daemon starts;
4. otherwise an actionable bootstrap error.

Before considering normal-protocol overlap, the client probes **all** live bridge-aware instances through bootstrap. It may launch its packaged daemon only when:

- the packaged version is strictly newer than every comparable live build;
- no newer build is live, even if normal protocols do not overlap;
- the persisted minimum-daemon floor, service-support deadline, and storage capabilities permit the build before any read-write database open.

An older package attaches to a newer daemon if a retained protocol overlaps; otherwise it reports plugin update required. It never launches an old daemon beside a newer live instance. Equal-version, unequal development commits do not launch beside each other automatically; the current ready commit wins unless explicitly restarted in development.

Use `semver` for released build ordering. Use `proper-lockfile` keyed by version+commit only to deduplicate concurrent launches of the same build; it is not a singleton lock.

### New-session startup

If a brand-new session finds a compatible old daemon while its newer packaged daemon starts, it attaches immediately using the old codec and moves at the first safe boundary after the new instance becomes ready. If there is no compatible daemon, the coding session starts without blocking while Premind waits or reports a scoped error.

## Illustrative package scenarios

### Two active v2 sessions, then a new v3 session

Assume two Pi processes or two existing OpenCode processes loaded package v2 and send activity every five seconds. A third process starts with package v3.

The v3 client negotiates v2 with the old daemon while launching daemon v3 on a unique socket. The new session attaches temporarily to v2 if necessary, then claims on v3 when ready. The two old sessions continue on v2 and keep its leases live; they do not fail and daemon v2 does not drain. Coordinator leadership transfers to v3, which polls for sessions on both daemons through the shared database. Five-second message frequency is not a blocker because cutover occurs between completed operations, not after an inactivity period.

For OpenCode, package version is process-scoped. The mixed-version example therefore means the old sessions remain in one process while the new session starts in another or newly reloaded process. Within one OpenCode process, the per-session route map may still point logical sessions at different daemons during migration. Pi commonly has one process per session.

### Dormant v2 session revived after v7 owns the state

Assume S1 last ran with a bridge-aware v2 plugin. Its lease expired, daemon v2 drained, and a year later daemon v7 serves S2.

- If v7 still supports normal protocol v2, S1 attaches to v7 and never starts daemon v2.
- If v7 no longer supports v2, bootstrap v1 returns a parseable update requirement. The coding session continues without Premind until the plugin updates.
- If no v7 process is live, the reconciled compatibility marker's persisted storage floor or service deadline still prevents v2 from opening modern state read-write.
- If S1's full state survived retention, v7 reclaims it with a higher generation. If full state was pruned, the tombstone preserves identity/generation and S1 becomes a fresh Premind attachment.

Pruning is never a reason to resurrect daemon v2.

## Daemon, storage, and session fencing

### Daemon-instance lease and storage epoch

Every bridge-aware daemon owns a durable instance lease containing its instance ID, incarnation, storage epoch, generation, expiry, build, and capabilities. Merely having an open SQLite connection grants no authority.

Every read-write transaction must validate the expected storage epoch and the relevant ownership token **inside that transaction** before mutation:

- session writes validate the session lease token;
- handoff writes validate the handoff token;
- scheduler/maintenance writes validate the coordinator generation;
- recovery and migration validate daemon-instance/migration ownership.

A paused process with an old open connection is therefore fenced when it resumes. If it paused inside a transaction, its SQLite lock prevents contraction until that transaction finishes or the process is declared dead and the migration obtains its exclusive barrier.

Classify every existing startup side effect—`recoverFromRestart`, client cleanup, handoff reset, subscription suspension, reaping, pruning, detail cleanup, and scheduler startup—as owner- or coordinator-scoped. No candidate daemon may run singleton-style recovery merely because it opened the database.

### Session lease token

Store ownership separately from durable session state:

```text
session_daemon_leases
  session_id                 primary key
  owner_instance_id
  generation                 monotonically increasing
  client_incarnation_nonce
  opaque_lease_token_hash
  lease_expires_at
```

`claimSession` returns an opaque token bound to `{sessionId, ownerInstanceId, generation, clientIncarnationNonce}`. Every mutation, renewal, handoff claim, release, and unregister carries it and includes all binding fields plus `lease_expires_at > transactionNow` in the same SQL predicate as the write. Expiry invalidates the token immediately, even before a reaper deletes the row; renewal after expiry requires a new claim and higher generation.

This prevents:

- stale A(gen1) after A→B→A returns ownership to A(gen3);
- two plugin incarnations for the same session on the same daemon;
- one OpenCode session unregistering another session's ownership;
- late acknowledgments from a prior owner.

The client keeps `sessionId -> {connectionProfile, leaseToken}` rather than one process-global daemon route.

### Lease lifecycle

- Pi and OpenCode renew each live session lease explicitly. Generic process heartbeat proves process health only.
- Claude claims for an invocation and releases invocation ownership afterward; it does not pin a daemon between hooks.
- Plugin/process shutdown detaches: release ownership, preserve durable state.
- Explicit logical deletion starts retention and leaves an identity/generation tombstone after full state is pruned.
- Silent death stops session renewal. Expiry immediately fences the token; a later compare-and-swap reaper clears ownership without deleting durable state or starting retention.
- Moving to another daemon increments generation transactionally.
- A stale route returns `SESSION_MOVED`; the client resolves the owner and updates only that session's route.

When an old daemon loses its final live session, it enters `quiescent` for rollback grace. It accepts only a fenced reclaim authorized for a session that just left it, then enters `draining` and exits after remaining work and leadership clear.

### End-of-support renewal

Keep a service-support floor/deadline distinct from the destructive storage floor. Every bridge-aware process checks it from the reconciled compatibility marker **before** any read-write database open, instance readiness, recovery action, session claim/renewal, or coordinator eligibility. A release may announce that version vN stops receiving service at a timestamp no sooner than the compatibility policy permits and at least 30 days after warning begins.

Before expiry, the old daemon continues serving and reports a deduplicated warning. At expiry an already-running daemon self-demotes, rejects new work/renewal with `SUPPORT_EXPIRED`, and drains; a dormant expired package fails before opening modern state read-write or publishing readiness. The host conversation continues, but Premind pauses until the plugin updates. A live old client may keep one old daemon alive only until this deadline, so bounded-fleet guarantees are conditional on the published support window.

## Reminder delivery and handoff semantics

Persist an opaque, stable `handoffId`/delivery key with claimant instance, session generation, and settlement state. Settlement is idempotent and leaves a tombstone long enough for duplicate confirmations to return the original result.

Separate the stable public settlement token from a short-lived internal execution claim. If the claimant expires, crashes, or drains, any compatible daemon may transactionally take over the unsettled handoff with a higher handoff generation while preserving the same `handoffId`/delivery key; stale execution generations cannot inject or mutate it. A late public confirmation may settle the still-pending handoff exactly once regardless of current execution owner. If takeover already retried injection, the visible result remains subject to the documented duplicate window. Once execution ownership is transferred or released, the origin daemon is no longer pinned by that handoff.

Guarantees:

- every persisted reminder is either durably settled once or remains retryable;
- cursor advancement occurs exactly once with durable settlement;
- only one live handoff may be claimed for a session/delivery key;
- visible host injection is at-least-once if the adapter crashes after injection but before confirmation.

Crash windows:

1. **Before injection:** retry the same handoff key; one visible injection.
2. **After injection, before confirmation:** retry the same key; a host without durable deduplication may show a duplicate.
3. **After confirmation:** the settlement tombstone makes retries no-ops.

Pi/OpenCode/Claude should include the stable key where their APIs permit, but the plan does not claim host-visible exactly-once unless the host durably deduplicates it.

Claude confirmation may arrive in a later hook process after session movement. Any compatible daemon can resolve and idempotently settle the opaque handoff token against its stored claimant/generation. An unsettled handoff blocks a new delivery claim for that session but does not require routing the later hook to the originating socket.

## Shared background coordinator

Use one fenced `background-coordinator` lease:

```text
coordinator_lease
  resource_key               primary key
  owner_instance_id
  generation
  storage_epoch
  lease_expires_at
```

The newest ready daemon requests leadership transfer independently of session ownership. The old leader stops dispatching new work, drains local tasks, and releases. Failed renewal immediately self-demotes.

External GitHub reads may overlap during transfer. The invariant is not “one process executes”; it is **at most one coordinator generation may commit scheduler or maintenance effects**. Every async task captures the generation before dispatch and validates it in the final database transaction. Shared-file cleanup is similarly generation-fenced or idempotent.

An old daemon is drainable only when it has:

- no unexpired session leases;
- no in-flight IPC requests;
- no live handoff execution claim or local delivery task (durable unsettled handoffs may remain after takeover/release);
- no coordinator lease or local coordinator tasks;
- no rollback-grace timer.

Dormant session rows do not count.

## Rolling-safe database evolution

SQLite WAL supports concurrent readers and a serialized writer, but rolling versions require application migration states:

1. `expanded` — add compatible tables/columns/indexes.
2. `backfilling` — populate the new representation while the old remains authoritative.
3. `dual-read` — new code can read either; old writes are projected through compatible triggers/change capture.
4. `authoritative-new` — only after all old writers are fenced, run a final backfill and switch authority.
5. `contractible` — after support and rollback windows, remove the old representation.

An already-shipped old daemon cannot be taught to dual-write. Therefore the old representation remains authoritative while any old writer is allowed. New enum values, JSON payloads, and row semantics must have an old-readable projection; DDL compatibility alone is insufficient.

### Monotonic compatibility marker

Freeze the filesystem surface as `PREMIND_STATE_DIR/compatibility-v1.json` guarded by `PREMIND_STATE_DIR/compatibility-v1.lock`, plus one mirrored SQLite row. Marker v1 is at most 16 KiB of UTF-8 without a BOM: exactly one JSON object followed by `\n`. Required fields have frozen names/types; duplicate keys, trailing data, unsafe integers, and invalid semver are corruption; unknown fields are ignored. Golden byte fixtures define both successful and failed parsing.

Required data is:

- `markerFormat: 1`;
- highest daemon version seen;
- minimum daemon version;
- service-support floor and not-before deadline;
- storage epoch;
- marker generation.

All bridge-aware writers serialize through the cross-build lock. They read both copies, compute monotonic maxima for ordered fields, preserve the later not-before deadline, increment generation, fsync the temporary file, atomically rename, fsync the parent directory, and then commit the SQLite mirror. Destructive floor/epoch publication is therefore filesystem-first. Neither copy may be lowered.

The file and database cannot update atomically, so a mismatch after a crash is a recoverable intermediate state rather than automatic corruption. Ordinary startup remains fail-closed while they disagree. Under the same lock, a bridge-aware reconciler opens SQLite initially read-only, derives monotonic maxima from every valid v1 copy, and first proves that its own build meets those effective storage/service floors. Only then may it open the minimum write path needed to repair a stale/missing/corrupt copy; normal recovery, readiness, and coordinator work remain disabled until reconciliation completes. An unknown marker format, inconsistent immutable field, or absence of both valid copies beside an established bridge-era database requires manual recovery. Initial bridge creation is the only both-absent case.

Before contraction:

1. raise and durably reconcile the minimum-daemon floor and storage epoch;
2. wait for or fence every prior daemon-instance generation and open transaction;
3. acquire the exclusive migration barrier;
4. perform final backfill and contraction;
5. publish the resulting schema capabilities.

A crash after raising the floor may conservatively block old code, but can never permit it to mutate contracted state. Test crash points before and after each file rename/fsync and SQLite mirror commit.

## Legacy bridge and quarantine

Pre-bridge code knows only the well-known socket and historical database path. It does not understand descriptors, session fencing, epochs, or the compatibility marker. The first transition must therefore establish a permanent quarantine boundary before rolling coexistence is enabled.

### Cooperative bridge path

Under a global bridge lock:

The bridge also acquires the historical daemon-start lock understood by the supported legacy fixture and holds it through guard binding. A still-older launcher that does not honor that lock is outside automatic cutover: quarantine still protects modern state, but socket contention requires manual recovery.

1. detect every reachable legacy owner and use only a documented cooperative shutdown path;
2. if safe quiescence cannot be established, stop and require manual recovery rather than killing an unidentified PID;
3. after all legacy database connections close, migrate/copy authoritative state into a new epoch path unknown to pre-bridge code;
4. replace the historical database path with a quarantine tombstone/blocker so a legacy daemon cannot reopen modern state;
5. bind a small stable guard/proxy to the historical socket before releasing compatible historical startup coordination;
6. start the modern fleet against the new epoch.

### Frozen safe-v1 proxy surface

The proxy recognizes the captured `pre-host`, `pre-bundle`, `first-bundle`, and `tokenized-bundle` variants before dispatch. `v1.ts` plus golden fixtures freeze each allowed operation's request, success, and historical error envelope; responses are projected back to the caller's variant. Unknown operations and payload variants are denied with that variant's parseable historical `BAD_REQUEST`/update-required form.

The allowlist is fixed to: `registerClient`, `heartbeatClient`, `releaseClient`, `registerSession`, `ensureSessionControl`, `registerClaudeSession`, `touchClaudeSession`, `claimClaudeReminder`, `confirmClaudeHandoff`, `suspendClaudeSession`, `updateSessionState`, `unregisterSession`, `pauseSession`, `resumeSession`, `activateWorktree`, `subscribe`, `unsubscribe`, `claimReminderBundle`, `ackReminderBundle`, `getPendingReminder`, `ackReminder`, `setGlobalDisabled`, `getGlobalDisabled`, and `debugStatus`. `pruneClosedSessions` and every future or ambiguous operation are rejected; pruning belongs to the fenced modern coordinator. Legacy `releaseClient`, `unregisterSession`, and `suspendClaudeSession` translate conservatively to detach, never logical deletion.

On legacy registration the proxy creates a durable, TTL-bound proxy incarnation and modern lease mapping for the legacy client/session identity. A repeated registration rotates the incarnation and claims a higher session generation. Every later tokenless v1 mutation resolves through that mapping and is issued with the current modern epoch/lease token; stale or duplicate legacy incarnations cannot write. Multiple distinct legacy clients remain independent. Proxy restart reloads unexpired mappings; an unmapped request must re-register rather than receiving ambient authority.

### No OS service

The guard is owned by modern Premind processes, not launchd/systemd. After a reboot, a pre-bridge plugin may start before any modern guard. Its historical state path is quarantined, so its daemon fails closed rather than opening modern data. The coding session continues with a Premind update-required error. When modern Premind starts, it cleans any stale historical socket and restores the safe-v1 proxy.

This guarantees modern-state safety, not perpetual service for unupdated pre-bridge clients.

## Compatibility matrix

| Client | Available daemon/state | Behavior |
| --- | --- | --- |
| Current client | Pre-bridge singleton | Use legacy adapter; bridge only after cooperative global quiescence or manual recovery |
| Current client | Older bridge-aware daemon | Use it temporarily, launch newer packaged daemon, move at a safe boundary |
| Current client | Exact/newer compatible daemon | Use newest compatible ready instance |
| Old supported client | Its old daemon | Continue until movement, clean end, lease expiry, or announced support deadline |
| Old supported client | Newer daemon with retained protocol | Attach to the newer daemon; do not launch old packaged daemon |
| Dormant old client | Newer daemon without protocol overlap | Bootstrap update-required; never launch old packaged daemon |
| Dormant old client | No live daemon, newer persisted storage floor or expired service deadline | `DAEMON_DOWNGRADE_BLOCKED`/`SUPPORT_EXPIRED` before SQLite read-write open |
| Newer client with no overlap | Older fleet and compatible storage | Launch the strictly newer packaged daemon and move |
| Pre-bridge client after modern reboot | Quarantined historical path, no guard yet | Legacy daemon fails closed; coding session continues |
| Downgraded package | Contracted newer storage | Fail before recovery, migration, or scheduler startup |

Pi and OpenCode background refreshes surface compact health state without crashing the host. User commands include actionable details. Claude lifecycle hooks fail open while commands/diagnostics report incompatibility.

## Implementation phases

Side-by-side behavior is feature-gated until every required fence exists. The order below must not expose a unique-socket candidate that can run singleton recovery against a live daemon.

### Phase 1 — Pin historical v1 and the immediate regression

- Capture pre-host, pre-bundle, first-bundle, and tokenized-bundle raw fixtures with source commits.
- Add v1 decoders and diagnostic normalization.
- Prove Pi `/premind:flush` survives pre-host `debugStatus`.
- Centralize existing fallbacks in the v1 adapter.

**Validation:** fixture contracts and targeted Pi/OpenCode/Claude adapter tests. Commit.

### Phase 2 — Add permanent bootstrap/descriptor contracts and protocol v2

- Add `bootstrap.ts`, `descriptor.ts`, `v1.ts`, `v2.ts`, adapters, and capabilities.
- Freeze bootstrap success/failure and descriptor v1 golden fixtures, including future additive fields and unknown lifecycle values.
- Separate permissive bootstrap/header parsing from strict normal-protocol decoding.
- Move wire parsing out of host methods.

**Validation:** legacy fallback, overlap/no-overlap, stable errors, unknown fields/states, and malformed selection. Commit.

### Phase 3 — Build fencing in singleton mode

- Add daemon-instance leases, storage epoch, expiring session tokens with incarnation nonce, coordinator generation, and transferable handoff execution claims plus stable settlement tombstones.
- Require epoch plus ownership predicates in every write transaction.
- Scope every recovery/startup side effect.
- Add per-session client routing while still targeting one daemon.
- Implement detach versus explicit delete/tombstone semantics.

**Validation:** ABA/incarnation races, stale writes, scoped recovery, detach/delete, and handoff idempotency. Commit.

### Phase 4 — Make storage and legacy transition rolling-safe

- Add migration states, old-authoritative projections, final backfill, and contraction barrier.
- Add the frozen marker/lock paths and bytes, monotonic DB reconciliation, and pre-open service-support enforcement.
- Establish the new storage epoch, historical path quarantine, global bridge/startup locks, and frozen safe-v1 proxy allowlist with durable identity-to-lease mappings.
- Prove legacy restart attempts cannot open modern state.

**Validation:** marker races/corruption, paused open connection, old writes during backfill, two-client legacy cutover, and cold pre-bridge restart. Commit.

### Phase 5 — Enable daemon instances and rolling cutover

- Add unique sockets, descriptor heartbeats, lifecycle states, and same-build launch deduplication.
- Implement all-live-instance launch ordering and newest-ready coordinator transfer.
- Enable side-by-side mode only when fencing/storage capabilities prove Phases 3–4 are present.
- Add session owner resolution, safe movement, quiescent rollback, and bounded drain.

**Validation:** discovery table, two-session split, rapid releases, coordinator transfer, candidate failure/rollback. Commit.

### Phase 6 — Apply shared behavior to every host

- Pi/OpenCode renew session leases and route by session token.
- OpenCode supports multiple daemon routes in one process.
- Generate Claude discovery/protocol code from shared TypeScript.
- Settle Claude cross-hook handoffs by opaque token.
- Add low-noise updating/reconnecting/EOL diagnostics and generated-artifact drift checks.

**Validation:** one parameterized adapter contract with only host-specific lifecycle assertions. Commit.

### Phase 7 — Cross-version CI and release documentation

- Add `test:protocol-compat` and a dedicated CI job.
- Run the minimally spanning suite below over real sockets and temporary databases.
- Document protocol rules, rolling lifecycle, delivery semantics, support deadlines, downgrade behavior, and legacy recovery in `docs/protocol.md`.
- Build all host/runtime artifacts from one tag and embedded version/commit.

**Validation:** `bun run check`, `bun run test:protocol-compat`, `bun run test:harness`, `bun run test:claude`, and existing CI. Commit.

## Minimally spanning test plan

Cover behavioral boundaries, not a host × version Cartesian product. Use fake clocks and explicit readiness/barrier promises rather than sleeps. Reuse the adapter-driver registry.

### Invariants

1. **Continuity:** movement preserves retained durable session state.
2. **Single session owner:** only the current unexpired lease token may commit session effects; expiry cannot be renewed in place.
3. **Epoch safety:** no stale daemon/storage generation may commit any write.
4. **Dead sessions drain:** unrenewed sessions cannot pin a daemon past TTL plus grace.
5. **Live old sessions continue:** moving one session does not interrupt another.
6. **Delivery conservation:** settlement/cursor is exactly once; host injection is at-least-once in the documented ambiguous window.
7. **Coordinator effects:** only one coordinator generation may commit effects.
8. **Ready-before-move:** a client stays on a healthy old route until the candidate is ready.
9. **No zombie downgrade:** unsupported or expired code never opens modern state read-write below a live or persisted storage/service floor.
10. **Host parity:** all hosts share negotiation/fencing while preserving lifecycle differences.

### T1 — Historical v1 boundary

Drive the current client against raw fixtures for pre-host status, no-reminder status refresh, single claim/ack, old bundle, and tokenized bundle. Replay representative old requests into the current daemon and assert historical output or a v1-parseable upgrade error. Add permanent bootstrap/descriptor fixtures with future additive fields and unknown lifecycle states.

### T2 — Discovery and launch ordering

Table-drive exact/newer/older/equal-dev, starting/ready/quiescent/draining/stale/unreachable, protocol/schema overlap, and persisted floors. Assert:

- newest compatible selection and exact-commit tie behavior;
- no trust without bootstrap verification;
- old v2 attaches to live v7 when v2 is retained;
- old v2 receives update-required, without launching, when live v7 has no overlap;
- new v7 may launch beside old v2 when storage permits;
- same-build concurrent clients launch one instance;
- quiescent rollback is authorized only for the matching session/token.

### T3 — Two sessions split across a rolling update

Start A with S1/S2. Start B, move only S1, and transfer coordinator leadership to B. Assert S1 state continuity on B, stale A rejection for S1, uninterrupted S2 requests/reminders through A, and A liveness while S2 renews. Have B persist a new update through the old-authoritative representation and prove old A can deliver it to S2. End S2 and prove A drains after remaining work/grace.

### T4 — Dead session with a live process

Register S1/S2 through one process. Continue process heartbeat and S1 renewal but stop S2 renewal without session-end. Advance the fake clock. Assert S2's token is rejected immediately at expiry even before reaping, renewal cannot revive it, durable state remains indefinitely, A can drain if appropriate, and later S2 claims on the newest daemon with a higher generation. Then explicitly delete S2, advance through retention, assert only the tombstone remains, and prove revival is a fresh attachment with monotonic generation.

### T5 — Session-token and ABA races

Pause A(gen1) before write, move S1 to B(gen2), then authorize rollback to A(gen3). Release gen1 and assert its mutation, renewal, acknowledgment, release, and unregister all fail. Race two claimers and assert one winner. On the same daemon, start two plugin incarnations for one session and prove the old nonce cannot affect the new lease. In one OpenCode process, route S1 and S2 to different daemons and prove operations never cross routes.

### T6 — Reminder crash windows and Claude cross-hook settlement

Exercise:

1. crash before injection — one eventual visible injection;
2. crash after injection before confirmation — retry same handoff key, exactly-once settlement, duplicate visible injection allowed without host deduplication;
3. crash after confirmation — tombstone makes retries no-ops.

Then claim through one Claude hook, let the origin's execution claim expire, transactionally take over the same handoff key on another daemon, and prove the origin drains before settlement. Confirm through a later hook by the stable opaque token while racing the takeover retry. Assert stale execution fencing, no lost batch, one cursor advancement, idempotent settlement, at most one live execution claim, and only the documented possibility of duplicate visible injection.

### T7 — Five rapid releases and EOL

Model v2 through v7 with one persistent session. With boundaries after each release, assert five transparent generation changes. Without boundaries, assert direct v2→v7 movement and unused intermediate drain. Keep another v2 client active and prove service continues. Then announce its support deadline, advance through the 30-day warning window, assert deduplicated warning/status behavior, and finally assert `SUPPORT_EXPIRED` pauses only Premind and allows the old daemon to drain. With no newer process live, start an expired dormant v2 package and prove the persisted service deadline blocks read-write open, recovery, readiness publication, session claim, and coordinator leadership.

### T8 — Candidate failure and rollback

Before claim, fail B readiness and prove the client remains on A. After claim, crash B and use the matching rollback authorization to reclaim quiescent A (or another compatible ready daemon) with a newer generation. Assert unhealthy B is not immediately reselected, pending reminders survive, and no concurrent owner writes.

### T9 — Coordinator transfer and stale async result

Start A/B against one WAL database and elect one coordinator. Pause A after dispatching a GitHub request, transfer leadership to B, and release A's old response. Assert it cannot commit or perform unfenced shared-file cleanup. Prove B reconstructs watchers, one source update yields one durable event/reminder, failed renewal self-demotes A, and A drains after local tasks finish.

### T10 — Storage migration, epoch, and marker safety

Cover in one focused migration suite:

- additive expansion with A/B both operating;
- old-daemon writes during backfill and trigger/projection correctness;
- final backfill after old writers fence;
- suspended old process with an open connection resuming after epoch raise;
- racing marker writers (cross-build lock and read-max-write prevent regression);
- golden byte parsing, additive unknown fields, and rejection of duplicate keys/trailing bytes/unknown format;
- crashes before and after temporary-file fsync, atomic rename, directory fsync, and SQLite mirror commit;
- monotonic repair when exactly one v1 copy is missing/corrupt/stale, plus fail-closed behavior for two invalid copies or immutable/format disagreement;
- crash after reconciled floor/epoch publication but before contraction;
- old v2 launcher with no live v7 blocked before read-write open;
- one successful contraction after every prior generation is fenced.

### T11 — Host lifecycle and routing contract

Parameterize Pi, OpenCode, and Claude over initialize, claim/move, one reminder, detach, explicit delete, and reclaim. Assert Pi/OpenCode session renewal, OpenCode multi-route behavior, process shutdown detaches without starting retention, explicit host deletion starts retention/tombstone, and Claude invocation release leaves no persistent session lease while handoff settlement remains possible by token.

### T12 — Legacy quarantine and bridge

Run a real pre-bridge fixture daemon plus two live legacy clients. Under the bridge and historical startup locks, attempt cutover while one supported client tries to restart; prove it waits for the guard and no competing modern database access occurs. Also exercise a nonparticipating older launcher and the unsupported/manual-recovery path. After migration, prove:

- every allowlisted operation round-trips through each captured variant's frozen request/success/error envelope;
- `pruneClosedSessions`, unknown operations, and malformed/ambiguous variants receive their parseable historical rejection;
- two concurrent legacy clients receive independent proxy incarnations/session tokens; a same-ID restart rotates generation, stale requests fail, and guard restart reloads only unexpired mappings;
- an old-client restart attempt cannot bind/open modern state;
- a dormant pre-bridge launch after all modern processes stop fails closed on the quarantined path;
- later bridge-aware B→C movement uses normal rolling cutover.

### Property model scope

Use bounded `fast-check` model commands only for `claim`, `renew`, `move`, `expire`, `release`, and `crash`. Assert ownership uniqueness, generation monotonicity, expiry/drain, and retained-state continuity. Record seed and shrunk command sequence on failure. Do not claim this model proves reminder, coordinator, readiness, storage, host, or fleet invariants; those belong to deterministic scenarios above.

The twelve categories remain minimally spanning: historical wire, discovery, multi-session rolling, orphan expiry, lease ABA, external-delivery ambiguity, rapid/EOL releases, rollback, coordinator fencing, storage epochs, host lifecycle, and legacy quarantine. Strengthen these categories rather than multiplying every case across every host/version pair.

## Compatibility and release policy

1. Ship the bridge before any further incompatible payload change.
2. Keep bootstrap v1, descriptor v1, marker format v1, and safe-v1 proxy semantics as permanent narrow compatibility surfaces.
3. Retain normal protocol adapters for at least two minor releases and at least 90 days, whichever is longer.
4. Permit one daemon per actively used supported build; bounded-fleet cleanup applies after movement, lease expiry, or published EOL.
5. Announce EOL at least 30 days before rejecting renewal. Updated clients never see the warning; expired dormant code is rejected from the reconciled marker before read-write open, readiness, recovery, or coordinator eligibility.
6. Raise destructive storage floors only after all supported old writers have drained or reached EOL.
7. Keep historical fixtures permanently.
8. Publish daemon, Pi, OpenCode, and generated Claude artifacts from one tag and embedded version/commit.

## Acceptance criteria

Issue #40 is complete when deterministic tests and documentation demonstrate that:

- legacy responses are identified before current schemas apply;
- pre-host `debugStatus` no longer breaks Pi `/premind:flush`;
- bootstrap/discovery remain parseable across years and no-overlap failures are actionable;
- protocol v2 base operations are immutable and capability additions do not mutate existing messages;
- modern state is permanently quarantined from pre-bridge launchers, and the frozen safe-v1 allowlist maps tokenless identities to fenced modern leases;
- side-by-side mode cannot activate before recovery, session, coordinator, handoff, and storage fencing are present;
- every write validates storage epoch and its ownership generation/token;
- per-session routing and incarnation tokens prevent ABA and same-process cross-session mutation;
- a new daemon becomes ready beside an old daemon before movement;
- moving one session does not interrupt another remaining on the old daemon;
- dead session tokens are rejected immediately at expiry, state persists without explicit deletion, and expired sessions cannot pin a daemon;
- detach versus explicit delete/retention is host-correct;
- durable reminder settlement/cursor is exactly once, with documented at-least-once visible injection after ambiguous crashes;
- Claude can settle a cross-invocation handoff by token after execution-claim takeover while the origin daemon drains;
- only one coordinator generation commits polling/maintenance effects;
- newest leadership can coexist with old session-serving daemons;
- old-authoritative projections remain correct under old writes and contraction waits for every prior generation;
- marker bytes/paths are frozen, updates are monotonic/durable, one-copy crash mismatches reconcile upward, and unrecoverable format/immutable conflicts fail closed;
- five rapid releases preserve one session and coalesce appropriately;
- old active clients receive a low-noise 30-day warning and then pause only Premind at EOL, while expired dormant code is blocked before read-write open/readiness/recovery;
- year-dormant bridge-aware clients never resurrect an old daemon;
- failed candidates leave the old route usable or recover through fenced rollback;
- Pi, OpenCode, and Claude share generated negotiation/fencing code;
- generated artifacts and all packages come from the same release tag;
- and manual legacy recovery, downgrade, EOL, retention, and duplicate-delivery behavior are documented.

## Non-goals

- Replacing the Unix socket transport.
- Supporting arbitrary combinations of unreleased commits.
- Installing or managing launchd/systemd services.
- Automatically killing an unidentified legacy daemon.
- Guaranteeing host-visible exactly-once injection without host deduplication support.
- Running destructive migrations while an old supported writer remains live.
- Migrating a non-replayable in-flight operation by force.
