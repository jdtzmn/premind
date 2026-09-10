import os from "node:os"
import path from "node:path"

export const PREMIND_PROTOCOL_VERSION = 1
export const PREMIND_SOCKET_PATH =
  process.env.PREMIND_SOCKET_PATH ?? path.join(os.tmpdir(), "premind.sock")
export const PREMIND_STATE_DIR =
  process.env.PREMIND_STATE_DIR ??
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "premind")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "premind"))
export const PREMIND_DB_PATH = path.join(PREMIND_STATE_DIR, "premind.db")
export const PREMIND_DATABASE_BUSY_TIMEOUT_MS = 5_000
export const PREMIND_EVENT_DETAIL_DIR = path.join(PREMIND_STATE_DIR, "event-details")
export const PREMIND_CLIENT_HEARTBEAT_MS = 10_000
export const PREMIND_CLIENT_LEASE_TTL_MS = 30_000
export const PREMIND_IDLE_SHUTDOWN_GRACE_MS = 15_000
export const PREMIND_IDLE_DELIVERY_THRESHOLD_MS = 60_000
export const PREMIND_SESSION_STALE_MS = 6 * 60 * 60 * 1000
// A handoff that never reaches confirmed/failed (adapter crash, stale extension
// context, hung injection) would otherwise pin its subscription's only batch row
// forever. Abandoned handoffs older than this are returned to `failed` so the
// handoff registry retries them without waiting for a daemon restart.
export const PREMIND_REMINDER_HANDOFF_STALE_MS = 5 * 60 * 1000
// Canonical PR watchers stay warm briefly after their final subscriber leaves.
export const PREMIND_PR_WATCHER_IDLE_GRACE_MS = 5 * 60 * 1000
// Durable PR streams and inactive subscription cursors outlive their actors.
export const PREMIND_PR_STREAM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const PREMIND_SUBSCRIPTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// How long a closed session row is retained before being permanently deleted.
export const PREMIND_CLOSED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000
// Daemon log file. Entries are appended here for post-hoc diagnosis.
export const PREMIND_DAEMON_LOG_PATH = path.join(PREMIND_STATE_DIR, "daemon.log")
// Rotate the log file when it exceeds this size.
export const PREMIND_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024
