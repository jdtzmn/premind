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

Compatibility adapters must keep old clients working without pinning updated clients to old daemons. After a one-time bridge from the current singleton, exactly one daemon serves every session. A newer build replaces it through a cooperative handover: the old daemon drains and exits, the new daemon starts, and sessions reconnect to it without restarting their host conversations.

## Product decisions

1. **Transport:** keep newline-delimited JSON, Zod, and SQLite WAL. Do not migrate to JSON-RPC, Protobuf, gRPC, or MCP transport.
2. **Upgrade model:** run one daemon per state directory, enforced by the lifetime daemon lock (#79). A strictly newer build takes over through a cooperative handover; two builds never serve side by side. See [Decision: one daemon with cooperative handover](#decision-one-daemon-with-cooperative-handover).
3. **Reminder guarantee:** guarantee no durable reminder loss and exactly-once cursor/settlement. Host injection is at-least-once in the crash window after injection but before confirmation; a visible duplicate is preferable to silent loss.
4. **Legacy quarantine:** move modern authoritative state to a new storage epoch/path. While modern code runs, keep a safe-v1 proxy on the historical socket. Do not install an OS service. After reboot, a pre-bridge client that starts before the proxy fails closed against a quarantined historical state path; the coding session continues with an update-required Premind error.
5. **Old-client support:** the single daemon retains normal-protocol adapters for supported old clients. An old client never keeps an old daemon alive or launches one beside a newer daemon. Announce end-of-support at least 30 days before rejecting lease renewal. Most users update and never see this warning.
6. **Session retention:** process/plugin shutdown detaches and preserves state. Only explicit logical session deletion starts retention. After full state is pruned, retain a lightweight identity/generation tombstone.
7. **Session ownership:** lease tokens are per session, not process-global, so one OpenCode process can hold independent leases for several logical sessions. Every session routes to the single daemon.
8. **Coordinator:** the single daemon owns GitHub polling and maintenance. The fenced coordinator lease still prevents a paused predecessor from committing effects after a handover.
9. **Storage evolution:** keep schema changes additive while an older supported daemon could still start against the database. Raise the minimum-daemon floor before any destructive change, then contract.

## Decision: one daemon with cooperative handover

`main` adopted a lifetime daemon lock in #79 after roughly 70 daemons started against one state directory and saturated the CPU. Side-by-side daemon builds would require deliberately relaxing that lock and adding session movement between daemons, cross-daemon routing, and coordinator transfer. Several processes writing one SQLite database is where the hardest correctness bugs live.

A cooperative handover keeps one writer. Because the new daemon retains older normal protocols, sessions from older plugins keep working after the handover; the only cost is a brief reconnect while the old daemon exits and the new one starts. A session whose plugin is too old for any retained protocol receives an actionable update-required error rather than a daemon of its own. Mature local updaters use the same shape, with one active process and a short handover (for example Chromium's updater and Envoy hot restart).

Descriptors, bootstrap, session leases, epochs, and coordinator fencing remain useful in this model: they let clients find the current daemon, reject stale owners after a handover, and keep a paused predecessor from committing effects.

## User-visible behavior

After the bridge release, a normal update behaves like a fast service restart:

1. A newly loaded client sends the bootstrap handshake to the historical socket and learns the running daemon's build.
2. If its packaged daemon build is strictly newer, its launcher takes the daemon start lock and asks the running daemon to hand over.
3. The old daemon stops its schedulers, finishes in-flight requests, releases its leases, sockets, and daemon lock, and exits.
4. The launcher starts its packaged daemon. Startup recovery clears the predecessor's session leases.
5. Each live client finds its route gone, repeats the handshake, re-registers its client and sessions, and reclaims session leases at a higher generation. Conversation identity, subscriptions, cursors, pending reminders, and worktree association are preserved.
6. A client whose packaged build is older than the running daemon attaches to it when a normal protocol overlaps; otherwise it reports that the plugin must be updated.

Normally the user sees nothing beyond a reconnect lasting a few seconds. A status surface may briefly report `premind reconnecting…`; it must not ask the user to restart a healthy host session.

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
      "rollingSessions": false
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

Each daemon binds a short, unique owner-only Unix socket such as `/tmp/premind-<uid>/d-<id>.sock`. After readiness it atomically writes one descriptor under `PREMIND_STATE_DIR/instances/` containing fixed v1 fields: descriptor format, instance ID, socket path, package version, commit, protocol range, storage epoch/capabilities, lifecycle state, and heartbeat time. It refreshes the heartbeat while running, withdraws the descriptor on shutdown, and prunes descriptors of unreachable daemons.

Descriptor v1 and its root/file naming are permanent additive discovery surfaces. Clients strip unknown fields, reject unknown lifecycle states for selection, and always verify the socket's bootstrap response. A descriptor is never proof of liveness or identity by itself. With one daemon at a time, the historical socket's bootstrap answer is the authoritative route; descriptors serve diagnostics and stale-socket cleanup.

Lifecycle states are:

- `starting` — not selectable;
- `ready` — selectable;
- `draining` — handing over or shutting down; no new work;
- stale/unreachable — ignored and later cleaned.

### Build ordering

Order builds by package version with `semver`. For equal versions, order by the commit time of the build, because Premind is commonly installed from git checkouts whose package version rarely changes. A build whose commit time is unknown is ordered only by version. Equal or unordered builds never hand over: the running daemon wins.

### Launch and handover

A launcher may start its packaged daemon only when no daemon is reachable, or after a running daemon has handed over to it. It asks for a handover only when its packaged build is strictly newer than the running build reported by bootstrap. A persisted minimum-daemon floor, service-support deadline, and storage capabilities must still permit the build before any read-write database open.

An older package attaches to a newer daemon if a retained normal protocol overlaps; otherwise it reports plugin update required. It never launches an old daemon beside a newer live instance.

### Cooperative handover

`requestHandover` is a capability-advertised protocol-v2 operation; it is not part of the frozen protocol-v1 surface.

```json
{
  "type": "requestHandover",
  "protocolVersion": 2,
  "payload": { "version": "0.3.0", "buildTime": 1791000000 }
}
```

The running daemon accepts only from a strictly newer build and answers `{ "accepted": true }`, or `{ "accepted": false, "reason": "..." }` otherwise. After accepting it enters `draining` and performs its normal graceful shutdown: stop schedulers, close the historical guard, release the coordinator and daemon-instance leases, withdraw its descriptor, close its instance socket, and release the daemon lock.

The launcher holds the daemon start lock from the request until its own daemon is serving, so concurrent older launchers wait rather than restarting the old build. It waits a bounded time (10 seconds) for the old daemon to release the daemon lock and historical socket. On timeout it releases the start lock and keeps using the running daemon; it never kills a daemon.

A daemon that predates `requestHandover` cannot be asked to hand over, but every Premind daemon since the lifetime daemon lock (#79) shuts down gracefully on SIGTERM: it stops its schedulers, releases its leases and the daemon lock, closes its socket, and exits. A strictly newer launcher sends that signal only to an identified Premind daemon: a live process that holds this state directory's daemon lock, whose command line is a Premind daemon entry point, and whose socket answers a Premind status probe. Anything less, including a daemon older than the daemon lock, is left running for manual recovery. When the signalled daemon predates the storage bridge, the new daemon runs the bridge on startup.

## Illustrative package scenarios

### Two active v2 sessions, then a new v3 session

Assume two Pi processes or two existing OpenCode processes loaded package v2 and send activity every five seconds. A third process starts with package v3.

The v3 launcher bootstraps against daemon v2, sees that its packaged build is newer, and requests a handover. Daemon v2 finishes in-flight requests and exits; the v3 launcher starts daemon v3. The two v2 clients notice their route is gone, repeat the handshake against daemon v3, negotiate protocol v2 (which v3 retains), re-register their sessions, and reclaim leases at a higher generation. Their pending reminders and cursors are unchanged. The v3 session negotiates its newest protocol. Five-second message frequency is not a blocker: the reconnect happens on the next request after the old daemon exits.

If v3 had dropped protocol v2, the two v2 sessions would instead receive an update-required error at the handshake. Their coding sessions continue without Premind until the plugin updates.

### Dormant v2 session revived after v7 owns the state

Assume S1 last ran with a bridge-aware v2 plugin. Its lease expired, daemon v2 was replaced long ago, and a year later daemon v7 serves S2.

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

The client keeps one lease token per session rather than one process-global lease, and remembers each registered session so it can re-register it after a handover or daemon restart.

### Lease lifecycle

- Pi and OpenCode renew each live session lease explicitly. Generic process heartbeat proves process health only.
- Claude claims for an invocation and releases invocation ownership afterward; it does not pin a daemon between hooks.
- Plugin/process shutdown detaches: release ownership, preserve durable state.
- Explicit logical deletion starts retention and leaves an identity/generation tombstone after full state is pruned.
- Silent death stops session renewal. Expiry immediately fences the token; a later compare-and-swap reaper clears ownership without deleting durable state or starting retention.
- Reclaiming after a handover increments generation transactionally.
- A stale lease returns `SESSION_MOVED`; the client repeats the handshake and reclaims that session.

### End-of-support renewal

Keep a service-support floor/deadline distinct from the destructive storage floor. Every bridge-aware process checks it from the reconciled compatibility marker **before** any read-write database open, instance readiness, recovery action, session claim/renewal, or coordinator eligibility. A release may announce that version vN stops receiving service at a timestamp no sooner than the compatibility policy permits and at least 30 days after warning begins.

Before expiry, the daemon continues serving the deprecated client and reports a deduplicated warning. At expiry it rejects that client's new work and renewal with `SUPPORT_EXPIRED`; a dormant expired package fails before opening modern state read-write or publishing readiness. The host conversation continues, but Premind pauses until the plugin updates.

## Reminder delivery and handoff semantics

Persist an opaque, stable `handoffId`/delivery key with claimant instance, session generation, and settlement state. Settlement is idempotent and leaves a tombstone long enough for duplicate confirmations to return the original result.

Separate the stable public settlement token from a short-lived internal execution claim. If the claimant expires, crashes, or hands over, the next daemon may transactionally take over the unsettled handoff with a higher handoff generation while preserving the same `handoffId`/delivery key; stale execution generations cannot inject or mutate it. A late public confirmation may settle the still-pending handoff exactly once regardless of current execution owner. If takeover already retried injection, the visible result remains subject to the documented duplicate window. Once execution ownership is transferred or released, the origin daemon is no longer pinned by that handoff.

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

Claude confirmation may arrive in a later hook process after a handover. Any compatible daemon can resolve and idempotently settle the opaque handoff token against its stored claimant/generation. An unsettled handoff blocks a new delivery claim for that session but does not require routing the later hook to the originating socket.

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

The running daemon claims it at startup and releases it during graceful shutdown, including a handover. Failed renewal immediately self-demotes.

External GitHub reads may overlap with a predecessor that paused mid-request. The invariant is not "one process executes"; it is **at most one coordinator generation may commit scheduler or maintenance effects**. Every async task captures the generation before dispatch and validates it in the final database transaction. Shared-file cleanup is similarly generation-fenced or idempotent.

## Database evolution

With one daemon at a time, a schema change never has two live writers. An older daemon can still start against the database later, for example after a downgrade or when an older host launches the daemon while no newer one runs. Schema evolution therefore uses these states:

1. `expanded` — add compatible tables/columns/indexes; older supported daemons ignore them.
2. `backfilled` — populate the new representation; the old representation stays valid for older supported daemons.
3. `floor-raised` — durably raise the minimum-daemon floor in the compatibility marker so older daemons can no longer open the database read-write.
4. `contracted` — remove the old representation.

New enum values, JSON payloads, and row semantics need an old-readable form until the floor is raised; DDL compatibility alone is insufficient.

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

Pre-bridge code knows only the well-known socket and historical database path. It does not understand descriptors, session fencing, epochs, or the compatibility marker. The first transition must therefore establish a permanent quarantine boundary before handover is enabled.

### Cooperative bridge path

Under a global bridge lock:

The bridge also acquires the historical daemon-start lock understood by the supported legacy fixture and holds it through guard binding. A still-older launcher that does not honor that lock is outside automatic cutover: quarantine still protects modern state, but socket contention requires manual recovery.

1. detect every reachable legacy owner and use only a documented cooperative shutdown path: `requestHandover`, or SIGTERM to an identified Premind daemon that predates it (see [Cooperative handover](#cooperative-handover));
2. if safe quiescence cannot be established, stop and require manual recovery rather than killing an unidentified PID;
3. after all legacy database connections close, migrate/copy authoritative state into a new epoch path unknown to pre-bridge code;
4. replace the historical database path with a quarantine tombstone/blocker so a legacy daemon cannot reopen modern state;
5. bind a small stable guard/proxy to the historical socket before releasing compatible historical startup coordination;
6. start the modern daemon against the new epoch.

### Frozen safe-v1 proxy surface

The proxy recognizes the captured `pre-host`, `pre-bundle`, `first-bundle`, and `tokenized-bundle` variants before dispatch. `v1.ts` plus golden fixtures freeze each allowed operation's request, success, and historical error envelope; responses are projected back to the caller's variant. Unknown operations and payload variants are denied with that variant's parseable historical `BAD_REQUEST`/update-required form.

The allowlist is fixed to: `registerClient`, `heartbeatClient`, `releaseClient`, `registerSession`, `ensureSessionControl`, `registerClaudeSession`, `touchClaudeSession`, `claimClaudeReminder`, `confirmClaudeHandoff`, `suspendClaudeSession`, `registerCodexSession`, `claimReminder`, `settleReminderClaim`, `releaseSessionOwner`, `updateSessionState`, `unregisterSession`, `pauseSession`, `resumeSession`, `activateWorktree`, `subscribe`, `unsubscribe`, `claimReminderBundle`, `ackReminderBundle`, `getPendingReminder`, `ackReminder`, `setGlobalDisabled`, `getGlobalDisabled`, and `debugStatus`. `pruneClosedSessions` and every future or ambiguous operation are rejected; pruning belongs to the fenced modern coordinator. Legacy `releaseClient`, `unregisterSession`, and `suspendClaudeSession` translate conservatively to detach, never logical deletion.

On legacy registration the proxy creates a durable, TTL-bound proxy incarnation and modern lease mapping for the legacy client/session identity. A repeated registration rotates the incarnation and claims a higher session generation. Every later tokenless v1 mutation resolves through that mapping and is issued with the current modern epoch/lease token; stale or duplicate legacy incarnations cannot write. Multiple distinct legacy clients remain independent. Proxy restart reloads unexpired mappings; an unmapped request must re-register rather than receiving ambient authority.

The historical socket is also the stable discovery endpoint. The guard answers the permanent bootstrap-v1 `initialize` handshake on behalf of the modern server, whose descriptor advertises its unique, owner-only instance socket (`premind-<uid>/d-<id>.sock` beside the historical socket, or under `/tmp` when that path would exceed the Unix socket length limit). Both sockets are created owner-only (`0600`). Current clients send the handshake to the historical socket and all later protocol-v2 traffic to the advertised socket; on a socket error they re-run the handshake. Clients that never send `initialize`, and pre-bridge daemons that reject it, stay on protocol v1. With one daemon at a time, the handshake always advertises the running daemon.

### No OS service

The guard is owned by modern Premind processes, not launchd/systemd. After a reboot, a pre-bridge plugin may start before any modern guard. Its historical state path is quarantined, so its daemon fails closed rather than opening modern data. The coding session continues with a Premind update-required error. When modern Premind starts, it cleans any stale historical socket and restores the safe-v1 proxy.

This guarantees modern-state safety, not perpetual service for unupdated pre-bridge clients.

## Compatibility matrix

| Client | Available daemon/state | Behavior |
| --- | --- | --- |
| Current client | Pre-bridge singleton | Use legacy adapter; bridge only after cooperative global quiescence or manual recovery |
| Current client | Older bridge-aware daemon with `requestHandover` | Hand over, start the packaged daemon, reconnect |
| Current client | Older identified daemon without `requestHandover` | Stop it with SIGTERM, start the packaged daemon (bridging legacy storage if needed), reconnect |
| Current client | Unidentified process on the socket | Attach if a protocol overlaps; never signal it |
| Current client | Exact or newer daemon | Attach; never hand over |
| Old supported client | Newer daemon with retained protocol | Attach to the newer daemon; do not launch the old packaged daemon |
| Old client mid-session | Its daemon hands over to a newer build | Reconnect to the newer daemon if a protocol overlaps; otherwise update-required |
| Dormant old client | Newer daemon without protocol overlap | Bootstrap update-required; never launch old packaged daemon |
| Dormant old client | No live daemon, newer persisted storage floor or expired service deadline | `DAEMON_DOWNGRADE_BLOCKED`/`SUPPORT_EXPIRED` before SQLite read-write open |
| Pre-bridge client after modern reboot | Quarantined historical path, no guard yet | Legacy daemon fails closed; coding session continues |
| Downgraded package | Contracted newer storage | Fail before recovery, migration, or scheduler startup |

Pi and OpenCode background refreshes surface compact health state without crashing the host. User commands include actionable details. Claude lifecycle hooks fail open while commands/diagnostics report incompatibility.

## Per-harness coverage

| Behavior | Pi | OpenCode | Claude Code | Codex |
| --- | --- | --- | --- | --- |
| Bootstrap and protocol negotiation | Shared client (`src/client/daemon-client.ts`) | Shared client | Protocol v1 through the frozen proxy on the historical socket (`plugin-claude/bin/lib.mjs`) | Shared client |
| Handover from an older daemon | `src/plugin-opencode/daemon-launcher.ts` | Same launcher as Pi | `plugin-claude/bin/ensure-daemon.mjs` via generated `daemon-startup.mjs` | `src/client/daemon-launcher.ts` |
| Reconnect after a handover | Shared client re-registers its client and remembered sessions | Same as Pi | Each hook re-registers its session, so nothing to replay | Hooks re-register per event; the long-lived MCP server uses the shared client |
| Update-required surface | Status bar and command errors | Toast and command errors | Hooks fail open; `probe`/commands report it | Hook diagnostics and MCP tool errors |

All four launchers share one handover routine in `src/shared/daemon-startup.ts`.

## Implementation phases

Phases 1–4 and per-instance sockets/descriptors shipped in #43; Phase 4's schema-evolution states are deferred until the first schema change needs them.

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

### Phase 3 — Build fencing

- Add daemon-instance leases, storage epoch, expiring session tokens with incarnation nonce, coordinator generation, and transferable handoff execution claims plus stable settlement tombstones.
- Require epoch plus ownership predicates in every write transaction.
- Scope every recovery/startup side effect.
- Implement detach versus explicit delete/tombstone semantics.

**Validation:** ABA/incarnation races, stale writes, scoped recovery, detach/delete, and handoff idempotency. Commit.

### Phase 4 — Make storage and the legacy transition safe

- Add the frozen marker/lock paths and bytes, monotonic DB reconciliation, and pre-open service-support enforcement.
- Establish the new storage epoch, historical path quarantine, global bridge/startup locks, and frozen safe-v1 proxy allowlist with durable identity-to-lease mappings.
- Prove legacy restart attempts cannot open modern state.
- Deferred: schema-evolution states and the floor-raise barrier.

**Validation:** marker races/corruption, paused open connection, two-client legacy cutover, and cold pre-bridge restart. Commit.

### Phase 5 — Cooperative handover (done: #43, #89, #91, #92)

- Give each daemon a unique owner-only socket and a heartbeated descriptor.
- Add build ordering and the `requestHandover` operation; on acceptance, drain through the normal graceful shutdown.
- Replace identified daemons that predate `requestHandover` with SIGTERM, and stamp the build into installed bundles.
- Add one shared launcher handover routine and call it from every launcher.
- Have the shared client re-register its client and remembered sessions after reconnecting.
- Report update-required when a newer daemon shares no protocol with the client.

**Validation:** build-ordering table, handover with two live sessions, refused and timed-out handovers, a pre-handover daemon, concurrent launchers, and a successor that fails to start.

### Phase 6 — Apply shared behavior to every host (done: #94, #95)

- Claude's hooks stay hand-written JavaScript on protocol v1 through the frozen proxy. Generating them from shared TypeScript would move them to protocol v2, which needs a session lease per short-lived hook process and risks `SESSION_BUSY` after a hook crashes. Instead, a contract test drives the shipped hooks over a real historical socket (#94); it found that the proxy rejected Claude's reminder claims.
- Claude cross-hook handoffs settle by their opaque handoff token (already in place before this plan).
- Every host's diagnostics show the running daemon's build next to the plugin's (#95). A live "reconnecting" indicator is not built: a handover reconnect takes about 250 ms. End-of-support warnings wait for real support floors.
- Generated artifacts are no longer committed (#70); `validate:package-runtime` rebuilds and checks them in CI.

**Validation:** the Claude wire contract and per-host diagnostic tests.

### Phase 7 — Cross-version CI and release documentation (done: this change)

- `test:protocol-compat` and the **Protocol compatibility** CI job check out released daemon builds (#82, #43, #89) from git history and require the current launcher to replace each one, keep its sessions and subscriptions, serve its old clients, and give current clients protocol v2.
- `docs/protocol.md` documents protocol rules, the handover lifecycle, delivery semantics, support windows, downgrade behavior, and manual recovery.
- Installed bundles embed their version, commit, and build time (#91). Publishing every package from one release tag is left for when Premind has a release process.

### Remaining

- Raise real minimum-daemon and service-support floors, and add end-of-support warnings, once Premind has releases to retire.
- Schema-evolution states and the floor-raise barrier, when the first destructive schema change needs them.
- Hardening: peer-credential checks on the historical socket, bounded compatibility-marker transitions, and lease expiry that tolerates clock jumps and suspend.

## Minimally spanning test plan

Cover behavioral boundaries, not a host × version Cartesian product. Use fake clocks and explicit readiness/barrier promises rather than sleeps. Reuse the adapter-driver registry.

### Invariants

1. **Continuity:** a handover preserves retained durable session state.
2. **Single session owner:** only the current unexpired lease token may commit session effects; expiry cannot be renewed in place.
3. **Epoch safety:** no stale daemon/storage generation may commit any write.
4. **Dead sessions expire:** unrenewed session tokens are rejected at expiry and never block a handover.
5. **Live sessions reconnect:** every live session on the old daemon reconnects to the new one without a host restart.
6. **Delivery conservation:** settlement/cursor is exactly once; host injection is at-least-once in the documented ambiguous window.
7. **Coordinator effects:** only one coordinator generation may commit effects.
8. **One daemon:** the old daemon releases the daemon lock before its successor starts; a refused or timed-out handover leaves the old daemon serving.
9. **No zombie downgrade:** unsupported or expired code never opens modern state read-write below a live or persisted storage/service floor.
10. **Host parity:** all hosts share negotiation/fencing while preserving lifecycle differences.

### T1 — Historical v1 boundary

Drive the current client against raw fixtures for pre-host status, no-reminder status refresh, single claim/ack, old bundle, and tokenized bundle. Replay representative old requests into the current daemon and assert historical output or a v1-parseable upgrade error. Add permanent bootstrap/descriptor fixtures with future additive fields and unknown lifecycle states.

### T2 — Build ordering and handover decisions

Table-drive newer/older/equal/unordered builds (version and commit time), handover support, protocol/schema overlap, and persisted floors. Assert:

- handover is requested only by a strictly newer build;
- no trust without bootstrap verification;
- old v2 attaches to live v7 when v2 is retained;
- old v2 receives update-required, without launching, when live v7 has no overlap;
- a daemon without `requestHandover` keeps serving and is never killed;
- concurrent launchers of the same newer build start one daemon.

### T3 — Handover with two live sessions

Start A with S1 and S2 from two clients. Launch a newer build B. Assert A drains and exits before B starts, both clients reconnect to B, re-register, and reclaim leases at a higher generation, S1/S2 state and pending reminders are preserved, and a reminder persisted before the handover is delivered exactly once afterwards. Repeat with a refused handover (B not newer) and a timed-out one (A never exits), and assert A keeps serving in both.

### T4 — Dead session with a live process

Register S1/S2 through one process. Continue process heartbeat and S1 renewal but stop S2 renewal without session-end. Advance the fake clock. Assert S2's token is rejected immediately at expiry even before reaping, renewal cannot revive it, durable state remains indefinitely, and a later S2 claim succeeds with a higher generation. Then explicitly delete S2, advance through retention, assert only the tombstone remains, and prove revival is a fresh attachment with monotonic generation.

### T5 — Session-token and ABA races

Pause the S1 owner at gen1 before a write, hand over so S1 is reclaimed at gen2, then reclaim again at gen3. Release gen1 and assert its mutation, renewal, acknowledgment, release, and unregister all fail. Race two claimers and assert one winner. Start two plugin incarnations for one session and prove the old nonce cannot affect the new lease. In one OpenCode process, prove S1's lease never authorizes an S2 operation.

### T6 — Reminder crash windows and Claude cross-hook settlement

Exercise:

1. crash before injection — one eventual visible injection;
2. crash after injection before confirmation — retry same handoff key, exactly-once settlement, duplicate visible injection allowed without host deduplication;
3. crash after confirmation — tombstone makes retries no-ops.

Then claim through one Claude hook, hand over so the origin daemon exits with the execution claim outstanding, and transactionally take over the same handoff key on the successor. Confirm through a later hook by the stable opaque token while racing the takeover retry. Assert stale execution fencing, no lost batch, one cursor advancement, idempotent settlement, at most one live execution claim, and only the documented possibility of duplicate visible injection.

### T7 — Five rapid releases and EOL

Model v2 through v7 with one persistent session. With a launch after each release, assert five transparent handovers and generation changes. With only the v7 launch, assert one direct v2→v7 handover. Keep another v2 client active and prove it reconnects to each successor while a retained protocol overlaps. Then announce its support deadline, advance through the 30-day warning window, assert deduplicated warning/status behavior, and finally assert `SUPPORT_EXPIRED` pauses only Premind for that client. With no newer process live, start an expired dormant v2 package and prove the persisted service deadline blocks read-write open, recovery, readiness publication, session claim, and coordinator leadership.

### T8 — Successor failure

After A accepts a handover and exits, fail B's startup. Assert no daemon is left holding the lock, the next launcher of any build starts a daemon, pending reminders survive, and no two daemons ever write concurrently.

### T9 — Stale predecessor after handover

Pause A after it dispatches a GitHub request, hand over to B, and release A's old response. Assert it cannot commit or perform unfenced shared-file cleanup. Prove B reconstructs watchers, one source update yields one durable event/reminder, and failed renewal self-demotes A.

### T10 — Storage migration, epoch, and marker safety

Cover in one focused migration suite:

- additive expansion read correctly by an older supported daemon started later;
- backfill correctness;
- floor raise before contraction;
- suspended old process with an open connection resuming after epoch raise;
- racing marker writers (cross-build lock and read-max-write prevent regression);
- golden byte parsing, additive unknown fields, and rejection of duplicate keys/trailing bytes/unknown format;
- crashes before and after temporary-file fsync, atomic rename, directory fsync, and SQLite mirror commit;
- monotonic repair when exactly one v1 copy is missing/corrupt/stale, plus fail-closed behavior for two invalid copies or immutable/format disagreement;
- crash after reconciled floor/epoch publication but before contraction;
- old v2 launcher with no live v7 blocked before read-write open;
- one successful contraction after the floor is raised.

### T11 — Host lifecycle and routing contract

Parameterize Pi, OpenCode, Claude, and Codex over initialize, claim, handover reconnect, one reminder, detach, explicit delete, and reclaim. Assert Pi/OpenCode session renewal and re-registration after a handover, process shutdown detaches without starting retention, explicit host deletion starts retention/tombstone, and Claude invocation release leaves no persistent session lease while handoff settlement remains possible by token.

### T12 — Legacy quarantine and bridge

Run a real pre-bridge fixture daemon plus two live legacy clients. Under the bridge and historical startup locks, attempt cutover while one supported client tries to restart; prove it waits for the guard and no competing modern database access occurs. Also exercise a nonparticipating older launcher and the unsupported/manual-recovery path. After migration, prove:

- every allowlisted operation round-trips through each captured variant's frozen request/success/error envelope;
- `pruneClosedSessions`, unknown operations, and malformed/ambiguous variants receive their parseable historical rejection;
- two concurrent legacy clients receive independent proxy incarnations/session tokens; a same-ID restart rotates generation, stale requests fail, and guard restart reloads only unexpired mappings;
- an old-client restart attempt cannot bind/open modern state;
- a dormant pre-bridge launch after all modern processes stop fails closed on the quarantined path;
- a later bridge-aware B→C update uses the normal handover.

### Property model scope

Use bounded `fast-check` model commands only for `claim`, `renew`, `handover`, `expire`, `release`, and `crash`. Assert ownership uniqueness, generation monotonicity, expiry/drain, and retained-state continuity. Record seed and shrunk command sequence on failure. Do not claim this model proves reminder, coordinator, readiness, storage, or host invariants; those belong to deterministic scenarios above.

The twelve categories remain minimally spanning: historical wire, build ordering, multi-session handover, orphan expiry, lease ABA, external-delivery ambiguity, rapid/EOL releases, successor failure, stale predecessors, storage epochs, host lifecycle, and legacy quarantine. Strengthen these categories rather than multiplying every case across every host/version pair.

## Compatibility and release policy

1. Ship the bridge before any further incompatible payload change.
2. Keep bootstrap v1, descriptor v1, marker format v1, and safe-v1 proxy semantics as permanent narrow compatibility surfaces.
3. Retain normal protocol adapters for at least two minor releases and at least 90 days, whichever is longer.
4. Run one daemon per state directory. A strictly newer build takes over by cooperative handover; an older build never runs while a newer build is live.
5. Announce EOL at least 30 days before rejecting renewal. Updated clients never see the warning; expired dormant code is rejected from the reconciled marker before read-write open, readiness, recovery, or coordinator eligibility.
6. Raise destructive storage floors only after every supported older build has reached EOL.
7. Keep historical fixtures permanently.
8. Publish daemon, Pi, OpenCode, and generated Claude artifacts from one tag and embedded version/commit.

## Acceptance criteria

Issue #40 is complete when deterministic tests and documentation demonstrate that:

- legacy responses are identified before current schemas apply;
- pre-host `debugStatus` no longer breaks Pi `/premind:flush`;
- bootstrap/discovery remain parseable across years and no-overlap failures are actionable;
- protocol v2 base operations are immutable and capability additions do not mutate existing messages;
- modern state is permanently quarantined from pre-bridge launchers, and the frozen safe-v1 allowlist maps tokenless identities to fenced modern leases;
- every write validates storage epoch and its ownership generation/token;
- per-session incarnation tokens prevent ABA and same-process cross-session mutation;
- a strictly newer build takes over through a cooperative handover, and an older or equal build never does;
- the old daemon releases the daemon lock before its successor starts, and a refused or timed-out handover leaves it serving;
- every live session reconnects to the successor with its durable state, and older clients keep working while a protocol overlaps;
- dead session tokens are rejected immediately at expiry and state persists without explicit deletion;
- detach versus explicit delete/retention is host-correct;
- durable reminder settlement/cursor is exactly once, with documented at-least-once visible injection after ambiguous crashes;
- Claude can settle a cross-invocation handoff by token after the origin daemon handed over;
- only one coordinator generation commits polling/maintenance effects;
- marker bytes/paths are frozen, updates are monotonic/durable, one-copy crash mismatches reconcile upward, and unrecoverable format/immutable conflicts fail closed;
- five rapid releases preserve one session through successive handovers;
- old active clients receive a low-noise 30-day warning and then pause only Premind at EOL, while expired dormant code is blocked before read-write open/readiness/recovery;
- year-dormant bridge-aware clients never resurrect an old daemon;
- a failed successor leaves no stranded lock and the next launch recovers;
- Pi, OpenCode, Claude, and Codex share generated negotiation/fencing and handover code;
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
- Running two daemon builds side by side against one state directory.
