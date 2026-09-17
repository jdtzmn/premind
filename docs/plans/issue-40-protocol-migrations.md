# Graceful Client-Daemon Protocol Migrations

## Context

[Issue #40](https://github.com/jdtzmn/premind/issues/40) exposed that `protocolVersion: 1` does not currently identify a stable wire contract. Request and response schemas have changed while the version stayed fixed, clients parse responses directly into the newest domain schema, and capability detection is inferred from `BAD_REQUEST` fallbacks. A newly loaded Pi or OpenCode extension, or a short-lived Claude hook, can therefore encounter a daemon built from an older package and fail on an unrelated command.

The immediate regression is a pre-host-tracking `debugStatus` response whose `sessions[]` entries omit `host`. A new Pi client reaches that response after `/premind:flush` finds no reminder and refreshes the status bar, then fails while parsing the response.

Mixed versions are normal: the daemon is detached and shared, hosts reload independently, Claude hooks are separate processes, and the generated Claude runtime may be older or newer than another installed host. The protocol must make that state explicit rather than treating socket reachability as compatibility.

## Recommended approach

Keep the existing newline-delimited JSON transport and Zod, but add a stable initialization handshake, immutable versioned wire DTOs, centralized compatibility adapters, and a coordinated daemon lifecycle.

This follows established practices without introducing a transport migration:

- Borrow the `initialize` lifecycle used by LSP/MCP: negotiate a protocol before normal operations and exchange capabilities once.
- Apply the tolerant-reader rule at the client boundary: response readers ignore unknown additive fields, while request writers emit only the negotiated schema.
- Use explicit current/previous protocol support and immutable historical fixtures, as is customary for rolling client-server upgrades.
- Replace the custom stale-lock implementation with the pure-JavaScript `proper-lockfile` package for heartbeat, stale-owner, and compromised-lock handling. The Unix socket bind remains the definitive ownership check.
- Continue using Zod for versioned codecs and domain normalization.

Do **not** migrate to JSON-RPC or Protocol Buffers in this issue. JSON-RPC standardizes calls and errors but does not solve schema compatibility or daemon ownership. Protobuf supplies excellent unknown-field behavior, but adopting code generation and a second encoding across TypeScript and the committed Claude runtime would be a much larger migration than the local protocol requires. The same compatibility guarantees can be established with the existing JSON transport and Zod.

## Protocol contract

### Bootstrap handshake

Reserve a small bootstrap contract that is independent of normal protocol versions and must remain backward compatible:

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

A new daemon returns:

```json
{
  "ok": true,
  "bootstrapVersion": 1,
  "result": {
    "daemon": {
      "instanceId": "uuid",
      "pid": 1234,
      "version": "0.2.0",
      "commit": "def456"
    },
    "protocols": { "min": 1, "max": 2, "selected": 2 },
    "capabilities": {
      "operations": ["registerClient", "debugStatus"],
      "gracefulUpgrade": true
    },
    "storage": { "schemaVersion": 3 }
  }
}
```

The client selects no version itself after the response; it verifies the daemon-selected version is within the offered range and stores an immutable connection profile for the process lifetime. It renegotiates after reconnect or daemon instance change. Short-lived Claude hooks initialize once per process.

A legacy daemon will reject `initialize` with its protocol-v1 `BAD_REQUEST` envelope. The client recognizes that envelope and selects a documented `legacy-v1` profile rather than guessing that the latest schemas apply.

### Version guarantees

`protocolVersion` identifies the complete request and response wire contract for normal operations. Once released, a version's schemas and semantics are immutable.

| Change | Rule |
| --- | --- |
| Fix internal behavior without changing wire data or semantics | No bump |
| Add a new operation | Same version only when advertised as a capability; old clients remain unaffected |
| Add an optional response field | Same version only after all clients for that version are tolerant readers; otherwise bump |
| Add or change any request field | Bump, because older strict daemons may reject it |
| Add a required response field, change a type, remove/rename a field, or change acknowledgment/error semantics | Bump |
| Change the bootstrap envelope | Add a bootstrap version while continuing to accept bootstrap v1 |

Protocol v1 is explicitly classified as legacy because several incompatible shapes already shipped under that number. Protocol v2 becomes the first immutable contract. New clients prefer v2 and use narrowly scoped v1 adapters only when initialization identifies a legacy daemon.

### Wire and domain separation

Create versioned wire modules under `src/shared/protocol/`:

- `bootstrap.ts` — stable initialization request/result and typed incompatibility errors.
- `v1.ts` — historical v1 request/response variants needed during the compatibility window.
- `v2.ts` — the canonical immutable contract.
- `adapters.ts` — converts a decoded wire result into the current host-neutral domain model.
- `capabilities.ts` — operation and lifecycle capability names.

Response codecs should use Zod's default stripping behavior (or explicit `.strip()`) so unknown additive fields do not break readers. Request codecs remain strict. Callers consume normalized domain objects and never parse a latest-version wire schema directly.

For the immediate regression, the legacy v1 `debugStatus` adapter accepts a missing `sessions[].host` and normalizes it into a distinct diagnostic domain type whose host union includes `"unknown"`. Registration and v2 wire schemas still accept only real hosts (`pi`, `opencode`, `claude`). This avoids inventing an incorrect host for historical sessions.

### Stable errors

Keep the current `{ ok, protocolVersion, error: { code, message } }` shape parseable for legacy requests. Add optional structured error data only where old readers will ignore it. Define at least:

- `PROTOCOL_UNSUPPORTED` — no overlapping protocol; includes supported range.
- `CLIENT_UPGRADE_REQUIRED` — a legacy request is too ambiguous to serve safely.
- `DAEMON_UPGRADE_REQUIRED` — the client cannot perform the requested operation against the daemon.
- `DAEMON_STARTING` — socket ownership exists but initialization is not complete.
- `DAEMON_BUSY` — safe replacement cannot proceed while incompatible active leases remain.

The response envelope echoes the request's protocol version. That lets an old v1 client parse a clear rejection from a newer daemon instead of failing on the envelope itself.

## Supported compatibility matrix

| Client | Daemon | Behavior |
| --- | --- | --- |
| Current client | Pre-handshake v1 daemon | Detect legacy `BAD_REQUEST`, select `legacy-v1`, normalize historical responses, and use only the known v1 operation set |
| Current client | Current daemon | Initialize, negotiate the highest common version, then gate operations by advertised capability |
| Current client | Future daemon | Continue on the highest common retained version |
| Future client | Current daemon | Negotiate down while the current version remains in the support window |
| Old v1 client | Current daemon | Serve only wire shapes that are unambiguous and historically compatible; otherwise return a v1 `CLIENT_UPGRADE_REQUIRED` error |
| No protocol overlap | Upgrade-capable older daemon | Replace only through the coordinated graceful-upgrade flow below |
| No protocol overlap | Legacy daemon without lifecycle capability | Never signal or overwrite an unknown process; report an actionable restart/degraded-mode error |
| Downgraded client package | Newer running daemon | Negotiate an older retained protocol; never automatically replace a newer daemon with an older binary |
| Downgraded client with no overlap | Newer daemon/database | Reject with instructions to restore a compatible package; do not risk a storage downgrade |

Pi and OpenCode background refreshes should surface a compact health error without crashing the host. User-invoked commands should return the full actionable message. Claude lifecycle hooks continue to fail open, while Claude MCP/user commands return the incompatibility diagnostic.

## Safe daemon ownership and replacement

Socket reachability and protocol compatibility must be separate results. A reachable incompatible daemon still owns the socket, so launchers must not spawn a competitor.

Refactor startup in this order:

1. Acquire a `proper-lockfile` daemon-ownership lock in `PREMIND_STATE_DIR`. Hold it for the daemon lifetime and treat `ECOMPROMISED` as fatal.
2. Resolve a stale socket only while holding that ownership lock.
3. Bind the Unix socket and establish exclusive ownership.
4. Only after the bind succeeds, construct `StateStore`, inspect `PRAGMA user_version`, run transactional migrations/restart recovery, and start schedulers.
5. Treat a connected-but-not-initialized socket as `starting`: reject normal operations if they are handled, and have launchers wait rather than spawn when connection succeeds but initialization has not produced a handshake yet.
6. On shutdown, enter draining mode, close the listener to reject new connections, finish in-flight requests, stop schedulers, close SQLite, unlink the socket, then release the ownership lock.

This requires removing `new StateStore()` from `IpcServer` constructor defaults and making service initialization explicit. No losing process may open or mutate SQLite.

For an incompatible but upgrade-capable daemon:

1. The client calls `prepareUpgrade` with the daemon `instanceId`, the replacement build identity, and its supported range.
2. The daemon rejects with `DAEMON_BUSY` if incompatible active clients/sessions are still leased; the client may degrade or wait, but must not force replacement.
3. If accepted, the daemon enters draining mode, begins closing the listener so no new connections are accepted, finishes the upgrade response and other in-flight requests, stops schedulers, closes SQLite, unlinks the socket, releases ownership, and exits.
4. The client waits for that exact `instanceId` to disappear, starts its packaged daemon, and waits for a new initialized instance with an overlapping protocol.
5. Existing compatible clients reconnect and re-register through their normal retry path.

Never use an unverified PID kill as the upgrade mechanism. A pre-handshake legacy daemon is adapted when possible and otherwise requires a manual host/daemon restart.

Add an explicit SQLite schema version and supported reader range. Migrations remain forward-only and transactional. Automatic daemon downgrade is prohibited; an older binary must reject a newer unsupported database before mutation.

## Implementation phases

### Phase 1 — Pin the regression with historical wire fixtures

- Capture immutable raw request/response fixtures from the last pre-host-tracking daemon, with source commit/package metadata.
- Include pre-host `debugStatus`, no-pending-reminder delivery, single-reminder claim/ack, the earlier bundle shape, and the current tokenized bundle shape.
- Add a socket-level fixture daemon test proving a current Pi `/premind:flush` can receive “no pending reminders,” refresh status from a response without `sessions[].host`, and finish without a schema error.
- Add the v1 debug-status wire decoder and diagnostic-domain normalizer; do not make the v2 wire field optional or apply a global schema default.

**Validation:** targeted protocol fixture test and `src/extension/__tests__/index.test.ts`. Commit.

### Phase 2 — Introduce initialization and immutable protocol v2

- Add `src/shared/protocol/{bootstrap,v1,v2,adapters,capabilities}.ts`.
- Split the server's parsing into a permissive header/bootstrap decoder followed by version-specific strict request decoding.
- Add build version/commit, daemon `instanceId`, protocol range, operation capabilities, lifecycle capabilities, and storage schema version to initialize results.
- Move response parsing out of individual daemon-client methods into a negotiated codec/adapter layer.
- Keep legacy-v1 detection explicit; remove feature inference from generic `BAD_REQUEST` strings.

**Validation:** negotiation tests for highest overlap, no overlap, malformed selection, legacy fallback, unknown additive response fields, and unsupported operations. Commit.

### Phase 3 — Make the daemon client host-neutral

- Move `PremindDaemonClient` from `src/plugin-opencode/` into `src/shared/` and have Pi/OpenCode consume the same negotiated client.
- Centralize current reminder-bundle and session-control compatibility logic in the v1 adapter rather than host methods.
- Model reconnect as: transport failure → inspect owner → initialize → re-register client/session → retry only if the operation is safe to retry.
- Replace boolean `probeDaemon` with a typed inspection result such as `absent`, `starting`, `compatible`, `incompatible`, or `legacy`; `ensureDaemonRunning` spawns only for `absent`.

**Validation:** existing OpenCode daemon-client tests, Pi extension tests, and new reconnect/profile-change tests. Commit.

### Phase 4 — Establish exclusive ownership before persistence

- Add `proper-lockfile` (and typings if needed) and replace the bespoke start-lock/stale-PID code.
- Split socket ownership from router/store construction so bind precedes every database open, migration, recovery, prune, or scheduler start.
- Add SQLite `user_version` checks and transactional migration boundaries.
- Implement `prepareUpgrade`, daemon draining, exact-instance waiting, and restart with the initiating package's daemon entrypoint.
- Reject automatic downgrade and replacement while incompatible active leases exist.

**Validation:** subprocess tests race two daemon starts against temporary socket/state paths and assert exactly one owner and one recovery/migration; upgrade tests assert the old store closes before the new store opens; downgrade tests assert zero database writes. Commit.

### Phase 5 — Apply the negotiated client to every host artifact

- Pi and OpenCode initialize on session/client registration and reuse the profile until daemon `instanceId` changes.
- Generate a shared Claude protocol client runtime from the TypeScript source with `scripts/build-claude-runtime.mjs`; `plugin-claude/bin/lib.mjs` should not maintain a separate protocol constant or parser.
- Make Claude `ensure-daemon` distinguish incompatibility from absence and use the same upgrade policy.
- Preserve Claude's fail-open hook behavior, but return actionable errors from MCP commands and diagnostics.
- Add a generated-artifact drift check so CI fails when committed Claude runtime files are not rebuilt.

**Validation:** `bun run test:claude`, Pi/OpenCode adapter suites, packaging tests, and clean generated-runtime diff. Commit.

### Phase 6 — Cross-version CI and release policy

- Add `src/test/protocol-compatibility.test.ts` and a dedicated `test:protocol-compat` script/CI job.
- Run current-client/historical-daemon and historical-client/current-daemon fixture matrices over the real Unix-socket framing.
- Test both debug status and reminder delivery for Pi, OpenCode, and Claude boundaries.
- Add `docs/protocol.md` with the bump rules, matrix, error guidance, compatibility window, and manual recovery/downgrade instructions.
- Build every host and generated runtime from one tagged source revision. Embed the same root package version/commit in daemon, Pi, OpenCode, and Claude artifacts instead of independently maintained versions.

**Validation:** `bun run check`, `bun run test:protocol-compat`, `bun run test:harness`, `bun run test:claude`, then the existing CI suite. Commit.

## Compatibility and release policy

Ship this as a bridge release before making another incompatible payload change:

1. The bridge release introduces initialization, protocol v2, v1 adapters, safe ownership, and a daemon that understands both v1 and v2.
2. All host artifacts from that tag prefer v2 but can use supported historical v1 daemons.
3. Subsequent releases may add protocol v3 only while retaining v2 in both client and daemon.
4. Retain a protocol generation and its adapters for at least two published minor releases and at least 90 days, whichever is longer. Removal requires a documented release note and preserved fixtures.
5. Historical fixtures remain permanently even after an adapter is removed, so accidental reuse of an old version number or wire shape is detectable.
6. Publish generated Claude artifacts and the npm/Pi/OpenCode package from the same tag. CI must verify embedded version/commit values and generated files before publication.

Because v1 already contains incompatible variants, current-daemon support for old v1 clients is best effort per operation: safely compatible operations continue; ambiguous operations return a parseable v1 `CLIENT_UPGRADE_REQUIRED`. Full bidirectional current/previous compatibility is guaranteed starting with v2.

## Acceptance criteria

Issue #40 is complete when tests and documentation demonstrate that:

- a new client identifies a legacy daemon before applying current response schemas;
- the pre-host `debugStatus` fixture no longer breaks Pi `/premind:flush`;
- operation availability comes from initialization capabilities, not probing via failures;
- protocol v2 wire schemas are immutable and separated from domain models;
- a reachable incompatible daemon never causes a competing daemon spawn;
- no process opens or mutates SQLite before exclusive socket ownership;
- compatible old clients receive supported v1 responses, while ambiguous v1 requests receive a clear parseable upgrade error;
- upgrade-capable incompatible daemons drain and hand off safely, and daemon downgrade is refused before database mutation;
- Pi, OpenCode, Claude hooks/runtime, and the daemon pass the historical cross-version matrix;
- generated Claude runtime files are built and released from the same protocol sources and tag;
- and the protocol support window, bump rules, downgrade behavior, and manual recovery path are documented.

## Non-goals

- Replacing the local Unix socket with HTTP, JSON-RPC, gRPC, or MCP.
- Supporting arbitrary combinations of unreleased commits.
- Automatically killing a legacy daemon that cannot identify itself or coordinate shutdown.
- Making old binaries read a newer incompatible SQLite schema.
