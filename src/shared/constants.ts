import os from "node:os"
import path from "node:path"

export const PREMIND_PROTOCOL_VERSION = 1
export const PREMIND_SOCKET_PATH = path.join(os.tmpdir(), "premind.sock")
export const PREMIND_STATE_DIR =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "premind")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "premind")
export const PREMIND_DB_PATH = path.join(PREMIND_STATE_DIR, "premind.db")
export const PREMIND_EVENT_DETAIL_DIR = path.join(PREMIND_STATE_DIR, "event-details")
export const PREMIND_CLIENT_HEARTBEAT_MS = 10_000
export const PREMIND_CLIENT_LEASE_TTL_MS = 30_000
export const PREMIND_IDLE_SHUTDOWN_GRACE_MS = 15_000
export const PREMIND_IDLE_DELIVERY_THRESHOLD_MS = 60_000
export const PREMIND_SESSION_STALE_MS = 6 * 60 * 60 * 1000
