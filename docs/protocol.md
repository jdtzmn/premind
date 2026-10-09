# Client–daemon protocol and upgrades

Premind runs one background daemon per user state directory. Every host plugin (Pi, OpenCode, Claude Code, and Codex) talks to it over a Unix socket using newline-delimited JSON. Plugins and the daemon update independently, so a session that started on one release often meets a daemon from another. This page describes how they stay compatible and how a newer daemon takes over. The design rationale is in [the issue #40 plan](plans/issue-40-protocol-migrations.md).

## Sockets and discovery

- **Historical socket** (`PREMIND_SOCKET_PATH`, default `$TMPDIR/premind.sock`). Every release has connected here, so it is the permanent entry point. A small guard owned by the daemon answers it. The guard is owner-only (`0600`).
- **Instance socket** (`premind-<uid>/d-<id>.sock` beside the historical socket, or under `/tmp` when that path would exceed the Unix socket length limit). The daemon serves the current protocol here, also owner-only.
- **Descriptor** (`$PREMIND_STATE_DIR/instances/<instance-id>.json`). The daemon publishes its identity, build, protocols, and socket here, refreshes it while running, and removes it on shutdown. Descriptors are diagnostic hints; clients always confirm through the handshake.

A current client sends the bootstrap handshake to the historical socket, learns the instance socket and the selected protocol, and sends all later requests there. If a request fails because the daemon went away, the client repeats the handshake.

## Bootstrap handshake

The handshake (`type: "initialize"`, `bootstrapVersion: 1`) is permanent. Its required fields and envelopes never change; new fields may be added and unknown fields are ignored.

```json
{ "type": "initialize", "bootstrapVersion": 1,
  "payload": { "client": { "host": "pi", "version": "0.2.0", "commit": "abc123", "incarnationNonce": "<uuid>" },
               "protocols": { "min": 1, "max": 2 } } }
```

A success response names the daemon (instance ID, version, commit, build time, socket, lifecycle state), the selected protocol, the supported operations, and storage capabilities. When the client and daemon share no protocol, the response is a bootstrap error, `PROTOCOL_UNSUPPORTED`, telling the user to update the plugin. A daemon that predates the handshake rejects it with a protocol-v1 `BAD_REQUEST`; the client then stays on protocol v1.

## Protocol versions

| Version | Status | Where it is served |
| --- | --- | --- |
| 1 | Frozen. Several incompatible shapes shipped under this number, so it is legacy. | The historical socket, through a frozen proxy |
| 2 | Current. The first immutable normal protocol. | The instance socket |

Once a protocol version is released, its request and response envelopes and the meaning of every existing operation are fixed:

- An internal fix with no wire or semantic change needs no new version.
- A new operation can be added to the current version when it is advertised in the handshake's `operations` list.
- Optional response data can be added only when existing readers already ignore unknown fields.
- Any new or changed request field, removed or renamed field, or change to acknowledgement or error meaning needs a new version.

Protocol v2 session operations carry a session lease (below). Released clients keep using protocol v1. The proxy on the historical socket accepts a fixed allowlist of v1 operations, translates them to the current daemon, and maps each legacy client to a durable lease. Operations outside the allowlist, including `pruneClosedSessions`, `deleteSession`, and `requestHandover`, are rejected there.

## Session ownership

Pi and OpenCode clients hold a lease per session. Each lease has a generation that increases on every new claim, so a request from a superseded owner fails with `SESSION_MOVED` and the client claims again. Leases expire 30 seconds after their last renewal; an expired lease is rejected immediately, and the session's state is kept. Claude and Codex sessions are host-owned: their hooks register them by host session ID and need no lease.

Every database write also checks a storage epoch, so a daemon left running against an older storage generation cannot change the current one.

## Reminder delivery

Delivery is exactly once for the durable record and at least once for what the host shows:

- A claim hands a reminder bundle to the host under a stable handoff ID. Claude's hooks persist that ID between the Stop hook that shows reminders and the next Stop hook that confirms them.
- Confirming a handoff advances the session's delivery cursor exactly once. A repeated confirmation returns the original result.
- If the host crashes after showing reminders but before confirming them, the same bundle is offered again, and the user may see it twice. Premind prefers a visible duplicate to a lost reminder.

## Upgrading the daemon

Only one daemon runs per state directory; a lifetime lock (`daemon.lock`) enforces this. A launcher starts its packaged daemon when none is running, and replaces a running daemon only when its own build is strictly newer:

- Builds are ordered by package version, then by the commit time of the build. Installed bundles carry both, stamped in at build time.
- A launcher whose build is unknown never replaces a daemon. A running daemon whose build is unknown, or that predates `requestHandover`, is older than any known build.
- A daemon that supports `requestHandover` is asked to hand over. It accepts only from a strictly newer build, then shuts down gracefully.
- A daemon that predates `requestHandover` is sent SIGTERM, which it handles as a graceful shutdown, but only after it is identified as a Premind daemon: a live process holds this state directory's daemon lock, its command line is a Premind daemon entry point, and its socket answers a Premind status probe. Anything else is left running.

The launcher holds a start lock while it waits for the old daemon to release the daemon lock and socket (up to 10 seconds), then starts its own daemon. It never kills a daemon: a refusal or a timeout leaves the old daemon serving. If the new daemon fails to start, nothing is left holding the locks and the next launch tries again.

On startup the new daemon detaches every Pi and OpenCode session. Their clients reconnect on their next request, repeat the handshake, re-register their sessions, and claim new leases. Subscriptions, cursors, pending reminders, pauses, and worktree bindings are kept. A client whose plugin is too old for any protocol the new daemon supports gets an update-required error; its coding session continues without Premind.

Each host's diagnostics report the running daemon's build next to the plugin's: Pi and OpenCode `/premind:doctor`, Claude's `probe` tool, and Codex's `premind_debug_status`.

## The one-time storage bridge

Daemons before #43 kept their database at `$PREMIND_STATE_DIR/premind.db`. The first daemon from #43 or later to start copies it to `epochs/1/premind.db` with a consistent snapshot, keeps the original as `premind.db.bridge-v1.sqlite`, and replaces the old path with a small quarantine file. An older daemon started later fails on that file instead of opening current data.

The bridge refuses to run while another daemon answers the historical socket. A current launcher normally stops the old daemon first, as described above.

## Downgrades and support windows

A daemon from before the bridge cannot open quarantined storage. The compatibility marker (`compatibility-v1.json` plus a copy in the database) records the highest daemon version seen, a minimum daemon version, and a service-support floor. A daemon below those floors refuses to open the database read-write. Today every floor is `0.0.0`, so no release is blocked yet; the planned policy is to retain old protocols for at least two minor releases and 90 days, and to warn a deprecated plugin for 30 days before it stops being served.

## Manual recovery

- **A daemon older than the lifetime lock (#79), or any process the launcher cannot identify,** is never stopped automatically. Stop it yourself (it handles SIGTERM), and the next host action starts the current daemon.
- **To return to a release from before the bridge,** stop every daemon, restore `premind.db.bridge-v1.sqlite` to `premind.db`, and move `epochs/` aside. Otherwise the next current daemon keeps its existing copy instead of bridging again. Changes made since the bridge are not in the restored copy.

## Testing

`bun run test:protocol-compat` runs the cross-version suite, which also runs in CI:

- Real released daemon builds (#82, #43, and #89) are checked out from git history and replaced by the current launcher, which must keep their sessions and subscriptions, serve their old clients, and give current clients protocol v2.
- Claude's real hooks complete a delivery over the real historical socket.
- The bootstrap, descriptor, compatibility-marker, proxy, and storage-bridge contracts.
