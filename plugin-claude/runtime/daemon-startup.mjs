// src/shared/daemon-startup.ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path2 from "node:path";

// src/shared/constants.ts
import os from "node:os";
import path from "node:path";
var PREMIND_PROTOCOL_VERSION = 1;
var PREMIND_SOCKET_PATH = process.env.PREMIND_SOCKET_PATH ?? path.join(os.tmpdir(), "premind.sock");
var PREMIND_STATE_DIR = process.env.PREMIND_STATE_DIR ?? (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "premind") : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "premind"));
var PREMIND_DB_PATH = path.join(PREMIND_STATE_DIR, "premind.db");
var PREMIND_EVENT_DETAIL_DIR = path.join(PREMIND_STATE_DIR, "event-details");
var PREMIND_SESSION_STALE_MS = 6 * 60 * 60 * 1000;
var PREMIND_REMINDER_HANDOFF_STALE_MS = 5 * 60 * 1000;
var PREMIND_PR_WATCHER_IDLE_GRACE_MS = 5 * 60 * 1000;
var PREMIND_PR_STREAM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var PREMIND_SUBSCRIPTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var PREMIND_CLOSED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
var PREMIND_DAEMON_LOG_PATH = path.join(PREMIND_STATE_DIR, "daemon.log");
var PREMIND_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;

// src/shared/daemon-startup.ts
var DEFAULT_PROBE_TIMEOUT_MS = 250;
var DEFAULT_STALE_LOCK_MS = 1e4;
var CLAUDE_REQUIRED_DAEMON_OPERATIONS = [
  "registerClaudeSession",
  "touchClaudeSession",
  "claimClaudeReminder",
  "confirmClaudeHandoff",
  "suspendClaudeSession"
];
var isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
var readLockOwner = (lockPath) => {
  try {
    const [pid, createdAt, token] = fs.readFileSync(lockPath, "utf8").split(":");
    const parsedPid = Number(pid);
    const parsedCreatedAt = Number(createdAt);
    return Number.isSafeInteger(parsedPid) && Number.isSafeInteger(parsedCreatedAt) && token ? { pid: parsedPid, createdAt: parsedCreatedAt, token } : undefined;
  } catch {
    return;
  }
};
var lockIsStale = (lockPath, staleLockMs) => {
  const owner = readLockOwner(lockPath);
  if (owner && isProcessAlive(owner.pid))
    return false;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
};
var acquireDaemonStartLock = ({
  stateDir = PREMIND_STATE_DIR,
  staleLockMs = DEFAULT_STALE_LOCK_MS
} = {}) => {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path2.join(stateDir, "daemon-start.lock");
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const owner = { pid: process.pid, createdAt: Date.now(), token: randomUUID() };
      fs.writeFileSync(fd, `${owner.pid}:${owner.createdAt}:${owner.token}`);
      return { ...owner, fd, path: lockPath };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      if (!lockIsStale(lockPath, staleLockMs))
        return;
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT")
          return;
      }
    }
  }
  return;
};
var releaseDaemonStartLock = (lock) => {
  try {
    fs.closeSync(lock.fd);
  } catch {}
  try {
    if (readLockOwner(lock.path)?.token === lock.token)
      fs.unlinkSync(lock.path);
  } catch {}
};
var isSocketReachable = (socketPath = PREMIND_SOCKET_PATH, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) => new Promise((resolve) => {
  const connection = net.createConnection(socketPath);
  const done = (reachable) => {
    clearTimeout(timer);
    connection.destroy();
    resolve(reachable);
  };
  const timer = setTimeout(() => done(false), timeoutMs);
  connection.once("connect", () => done(true));
  connection.once("error", () => done(false));
});
var probeDaemon = (socketPath = PREMIND_SOCKET_PATH, requiredOperations = [], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) => new Promise((resolve) => {
  const connection = net.createConnection(socketPath);
  let buffer = "";
  const done = (compatible) => {
    clearTimeout(timer);
    connection.destroy();
    resolve(compatible);
  };
  const timer = setTimeout(() => done(false), timeoutMs);
  connection.setEncoding("utf8");
  connection.once("error", () => done(false));
  connection.once("connect", () => connection.write(`${JSON.stringify({
    type: "debugStatus",
    protocolVersion: PREMIND_PROTOCOL_VERSION,
    payload: {}
  })}
`));
  connection.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes(`
`))
      return;
    try {
      const response = JSON.parse(buffer.slice(0, buffer.indexOf(`
`)));
      const operations = response?.result?.daemon?.operations;
      done(response?.ok === true && response?.protocolVersion === PREMIND_PROTOCOL_VERSION && response?.result?.daemon?.protocolVersion === PREMIND_PROTOCOL_VERSION && requiredOperations.every((operation) => Array.isArray(operations) && operations.includes(operation)));
    } catch {
      done(false);
    }
  });
});
var waitForDaemon = async (socketPath = PREMIND_SOCKET_PATH, requiredOperations = [], timeoutMs = 2000, retryMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(socketPath, requiredOperations))
      return true;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return false;
};
export {
  waitForDaemon,
  releaseDaemonStartLock,
  probeDaemon,
  isSocketReachable,
  acquireDaemonStartLock,
  CLAUDE_REQUIRED_DAEMON_OPERATIONS
};
