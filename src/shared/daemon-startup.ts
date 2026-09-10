import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PREMIND_PROTOCOL_VERSION,
  PREMIND_SOCKET_PATH,
  PREMIND_STATE_DIR,
} from "./constants.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_STALE_LOCK_MS = 10_000;

export const CLAUDE_REQUIRED_DAEMON_OPERATIONS = [
  "registerClaudeSession",
  "touchClaudeSession",
  "claimClaudeReminder",
  "confirmClaudeHandoff",
  "suspendClaudeSession",
] as const;

export const CODEX_REQUIRED_DAEMON_OPERATIONS = [
  "registerCodexSession",
  "claimReminder",
  "settleReminderClaim",
  "releaseSessionOwner",
] as const;

export const PREMIND_DAEMON_OPERATIONS = [
  ...CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  ...CODEX_REQUIRED_DAEMON_OPERATIONS,
] as const;
type StartLockOwner = {
  pid: number;
  createdAt: number;
  token: string;
};

export type DaemonStartLock = StartLockOwner & {
  fd: number;
  path: string;
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLockOwner = (lockPath: string): StartLockOwner | undefined => {
  try {
    const [pid, createdAt, token] = fs
      .readFileSync(lockPath, "utf8")
      .split(":");
    const parsedPid = Number(pid);
    const parsedCreatedAt = Number(createdAt);
    return Number.isSafeInteger(parsedPid) &&
      Number.isSafeInteger(parsedCreatedAt) &&
      token
      ? { pid: parsedPid, createdAt: parsedCreatedAt, token }
      : undefined;
  } catch {
    return undefined;
  }
};

const lockIsStale = (lockPath: string, staleLockMs: number) => {
  const owner = readLockOwner(lockPath);
  if (owner && isProcessAlive(owner.pid)) return false;
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
};

export const acquireDaemonStartLock = ({
  stateDir = PREMIND_STATE_DIR,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
}: {
  stateDir?: string;
  staleLockMs?: number;
} = {}): DaemonStartLock | undefined => {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "daemon-start.lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const owner = {
        pid: process.pid,
        createdAt: Date.now(),
        token: randomUUID(),
      };
      fs.writeFileSync(fd, `${owner.pid}:${owner.createdAt}:${owner.token}`);
      return { ...owner, fd, path: lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lockIsStale(lockPath, staleLockMs)) return undefined;
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
          return undefined;
      }
    }
  }

  return undefined;
};

export const releaseDaemonStartLock = (lock: DaemonStartLock) => {
  try {
    fs.closeSync(lock.fd);
  } catch {
    // The descriptor may already have been closed during shutdown.
  }
  try {
    if (readLockOwner(lock.path)?.token === lock.token)
      fs.unlinkSync(lock.path);
  } catch {
    // A stale-lock cleanup may have already removed or replaced the lock.
  }
};

export const isSocketReachable = (
  socketPath = PREMIND_SOCKET_PATH,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
) =>
  new Promise<boolean>((resolve) => {
    const connection = net.createConnection(socketPath);
    const done = (reachable: boolean) => {
      clearTimeout(timer);
      connection.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    connection.once("connect", () => done(true));
    connection.once("error", () => done(false));
  });

export type DaemonProbeResult =
  | {
      status: "compatible";
      protocolVersion: number;
      operations: string[];
    }
  | {
      status: "incompatible";
      protocolVersion?: number;
      operations?: string[];
      missingOperations: string[];
      reason: string;
    }
  | { status: "unresponsive"; reason: string }
  | { status: "unreachable" };

export const inspectDaemon = (
  socketPath = PREMIND_SOCKET_PATH,
  requiredOperations: readonly string[] = [],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
) =>
  new Promise<DaemonProbeResult>((resolve) => {
    const connection = net.createConnection(socketPath);
    let buffer = "";
    let connected = false;
    let settled = false;
    const done = (result: DaemonProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        done(
          connected
            ? {
                status: "unresponsive",
                reason: "daemon probe timed out",
              }
            : { status: "unreachable" },
        ),
      timeoutMs,
    );
    connection.setEncoding("utf8");
    connection.once("error", () =>
      done(
        connected
          ? {
              status: "unresponsive",
              reason: "daemon closed the probe connection",
            }
          : { status: "unreachable" },
      ),
    );
    connection.once("close", () => {
      if (settled) return;
      done(
        connected
          ? {
              status: "unresponsive",
              reason: "daemon closed the probe connection",
            }
          : { status: "unreachable" },
      );
    });
    connection.once("connect", () => {
      connected = true;
      connection.write(
        `${JSON.stringify({
          type: "debugStatus",
          protocolVersion: PREMIND_PROTOCOL_VERSION,
          payload: {},
        })}\n`,
      );
    });
    connection.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        const protocolVersion = response?.result?.daemon?.protocolVersion;
        const operations = response?.result?.daemon?.operations;
        if (
          response?.ok !== true ||
          response?.protocolVersion !== PREMIND_PROTOCOL_VERSION ||
          protocolVersion !== PREMIND_PROTOCOL_VERSION ||
          (operations !== undefined &&
            (!Array.isArray(operations) ||
              !operations.every(
                (operation: unknown) => typeof operation === "string",
              )))
        ) {
          done({
            status: "incompatible",
            ...(typeof protocolVersion === "number" ? { protocolVersion } : {}),
            missingOperations: [...requiredOperations],
            reason: "daemon protocol response is incompatible",
          });
          return;
        }
        const typedOperations = Array.isArray(operations)
          ? (operations as string[])
          : [];
        const missingOperations = requiredOperations.filter(
          (operation) => !typedOperations.includes(operation),
        );
        done(
          missingOperations.length === 0
            ? {
                status: "compatible",
                protocolVersion,
                operations: typedOperations,
              }
            : {
                status: "incompatible",
                protocolVersion,
                operations: typedOperations,
                missingOperations,
                reason: `daemon is missing operations: ${missingOperations.join(", ")}`,
              },
        );
      } catch {
        done({
          status: "incompatible",
          missingOperations: [...requiredOperations],
          reason: "daemon returned invalid JSON",
        });
      }
    });
  });

export const probeDaemon = async (
  socketPath = PREMIND_SOCKET_PATH,
  requiredOperations: readonly string[] = [],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
) =>
  (await inspectDaemon(socketPath, requiredOperations, timeoutMs)).status ===
  "compatible";

export const waitForDaemon = async (
  socketPath = PREMIND_SOCKET_PATH,
  requiredOperations: readonly string[] = [],
  timeoutMs = 2_000,
  retryMs = 50,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon(socketPath, requiredOperations)) return true;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return false;
};
