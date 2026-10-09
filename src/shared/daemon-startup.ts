import { execFileSync } from "node:child_process";
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
  "claimReminderBundle",
  "ackReminderBundle",
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

// A launcher holds the start lock while its daemon boots, so it hands the
// lock token to that daemon. Startup steps that must exclude every other
// launcher accept a lock held under the inherited token as their own.
export const DAEMON_START_LOCK_TOKEN_ENV = "PREMIND_DAEMON_START_LOCK_TOKEN";

export const isDaemonStartLockHeldBy = (
  token: string,
  { stateDir = PREMIND_STATE_DIR }: { stateDir?: string } = {},
): boolean =>
  readLockOwner(path.join(stateDir, "daemon-start.lock"))?.token === token;

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

// The daemon lock is held by one daemon for its entire lifetime, from before
// startup work until shutdown. Unlike the short-lived start lock, it proves a
// daemon exists even while that daemon is too busy starting to answer probes,
// which is what stops launchers and new daemons from piling on.
const DAEMON_LOCK_FILE = "daemon.lock";
// A live owner this young is treated as starting, even if it is unreachable.
export const DAEMON_STARTUP_GRACE_MS = 60_000;
const DAEMON_LOCK_SERVING_PROBE_MS = 1_000;

export type DaemonLock = DaemonStartLock;
export type DaemonLockOwner = StartLockOwner;

const daemonLockPath = (stateDir: string) => path.join(stateDir, DAEMON_LOCK_FILE);

export const readDaemonLockOwner = (
  stateDir = PREMIND_STATE_DIR,
): DaemonLockOwner | undefined => readLockOwner(daemonLockPath(stateDir));

/**
 * True while a live process holds the daemon lock and is still inside its
 * startup grace period. Launchers wait for such a daemon instead of spawning.
 */
export const isDaemonStarting = (
  stateDir = PREMIND_STATE_DIR,
  now = Date.now(),
  startupGraceMs = DAEMON_STARTUP_GRACE_MS,
) => {
  const owner = readDaemonLockOwner(stateDir);
  return (
    owner !== undefined &&
    isProcessAlive(owner.pid) &&
    now - owner.createdAt < startupGraceMs
  );
};

/** True when `lock` is still the daemon lock on disk. */
export const holdsDaemonLock = (lock: DaemonLock) =>
  readLockOwner(lock.path)?.token === lock.token;

/**
 * Acquires the daemon lock, or returns undefined when another daemon owns it.
 * A dead owner is reclaimed. A live owner past the startup grace period is
 * reclaimed only when nothing answers on the socket, because its PID may have
 * been reused or the daemon may be wedged. A wedged daemon notices the
 * takeover through `holdsDaemonLock` and exits.
 */
export const acquireDaemonLock = async ({
  stateDir = PREMIND_STATE_DIR,
  socketPath = PREMIND_SOCKET_PATH,
  startupGraceMs = DAEMON_STARTUP_GRACE_MS,
  isServing = () => isSocketReachable(socketPath, DAEMON_LOCK_SERVING_PROBE_MS),
}: {
  stateDir?: string;
  socketPath?: string;
  startupGraceMs?: number;
  isServing?: () => Promise<boolean>;
} = {}): Promise<DaemonLock | undefined> => {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = daemonLockPath(stateDir);

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
    }

    const owner = readLockOwner(lockPath);
    if (owner === undefined) {
      // Another daemon may be between creating and writing the lock.
      if (!lockIsStale(lockPath, DEFAULT_STALE_LOCK_MS)) return undefined;
    } else if (isProcessAlive(owner.pid)) {
      if (Date.now() - owner.createdAt < startupGraceMs) return undefined;
      if (await isServing()) return undefined;
    }

    // Only remove the lock we judged stale, never one that replaced it since.
    if (readLockOwner(lockPath)?.token !== owner?.token) return undefined;
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
        return undefined;
    }
  }

  return undefined;
};

export const releaseDaemonLock = (lock: DaemonLock) => releaseDaemonStartLock(lock);

export type DaemonLockStatus = {
  pid: number;
  alive: boolean;
  heldSince: string;
} | null;

/** Who holds the daemon lock, for doctor output. */
export const daemonLockStatus = (
  stateDir = PREMIND_STATE_DIR,
): DaemonLockStatus => {
  const owner = readDaemonLockOwner(stateDir);
  if (!owner) return null;
  return {
    pid: owner.pid,
    alive: isProcessAlive(owner.pid),
    heldSince: new Date(owner.createdAt).toISOString(),
  };
};

export const formatDaemonLockStatus = (status: DaemonLockStatus) =>
  status === null
    ? "not held (no daemon running, or one predating the daemon lock)"
    : `held by pid ${status.pid}${status.alive ? "" : " (process gone)"} since ${status.heldSince}`;

// A busy daemon can take well over the default probe to accept a connection.
// Anything that would delete or take over an existing socket must probe for
// this long first, or it can strand a live daemon (see the 2026-10-07 storm).
export const SOCKET_TAKEOVER_PROBE_MS = 2_000;

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

export { readPackagedBuild } from "./build-info.ts";

// ---------------------------------------------------------------------------
// Cooperative handover: one daemon per state directory, replaced only by a
// strictly newer build. Kept dependency-free because Claude's launcher imports
// the generated bundle of this module on every hook.

/** Package version plus the build's commit time in seconds (0 when unknown). */
export type DaemonBuildIdentity = { version: string; buildTime: number };

export type DaemonBuildOrder = "newer" | "older" | "same" | "unordered";

const parseRelease = (version: string): [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || version === "0.0.0") return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Orders `candidate` against `running`. An unknown candidate never orders, so
 * it never takes over. An unknown running build is older than any known
 * candidate, so a daemon of unknown provenance converges to a known build.
 * Equal versions fall back to commit time and are unordered when either is
 * unknown, so the running daemon wins.
 */
export const compareDaemonBuilds = (
  candidate: DaemonBuildIdentity,
  running: DaemonBuildIdentity,
): DaemonBuildOrder => {
  const candidateRelease = parseRelease(candidate.version);
  if (!candidateRelease) return "unordered";
  const runningRelease = parseRelease(running.version);
  if (!runningRelease) return "newer";
  for (let index = 0; index < 3; index += 1) {
    const difference = candidateRelease[index]! - runningRelease[index]!;
    if (difference !== 0) return difference > 0 ? "newer" : "older";
  }
  if (!(candidate.buildTime > 0) || !(running.buildTime > 0)) return "unordered";
  if (candidate.buildTime === running.buildTime) return "same";
  return candidate.buildTime > running.buildTime ? "newer" : "older";
};

export const REQUEST_HANDOVER_OPERATION = "requestHandover";
export const DAEMON_HANDOVER_TIMEOUT_MS = 10_000;
const HANDOVER_REQUEST_TIMEOUT_MS = 2_000;

type RunningDaemon = {
  build: DaemonBuildIdentity;
  commit: string;
  socketPath: string;
  operations: string[];
};

const requestJson = (
  socketPath: string,
  message: unknown,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve) => {
    const connection = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const done = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    connection.setEncoding("utf8");
    connection.once("error", () => done(undefined));
    connection.once("close", () => done(undefined));
    connection.once("connect", () =>
      connection.write(`${JSON.stringify(message)}\n`),
    );
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        done(JSON.parse(buffer.slice(0, newline)));
      } catch {
        done(undefined);
      }
    });
  });

/**
 * Identifies the daemon serving `socketPath` through the permanent bootstrap
 * handshake, or returns undefined for a daemon that predates bootstrap.
 */
export const inspectRunningDaemonBuild = async ({
  socketPath = PREMIND_SOCKET_PATH,
  host,
  build,
  timeoutMs = HANDOVER_REQUEST_TIMEOUT_MS,
}: {
  socketPath?: string;
  host: string;
  build: DaemonBuildIdentity;
  timeoutMs?: number;
}): Promise<RunningDaemon | undefined> => {
  const response = (await requestJson(
    socketPath,
    {
      type: "initialize",
      bootstrapVersion: 1,
      payload: {
        client: {
          host,
          version: build.version,
          commit: "launcher",
          incarnationNonce: randomUUID(),
        },
        protocols: { min: PREMIND_PROTOCOL_VERSION, max: 2 },
      },
    },
    timeoutMs,
  )) as
    | {
        ok?: unknown;
        bootstrapVersion?: unknown;
        result?: {
          daemon?: {
            version?: unknown;
            commit?: unknown;
            buildTime?: unknown;
            socketPath?: unknown;
          };
          capabilities?: { operations?: unknown };
        };
      }
    | undefined;
  const daemon = response?.result?.daemon;
  if (
    response?.ok !== true ||
    response.bootstrapVersion !== 1 ||
    typeof daemon?.version !== "string" ||
    typeof daemon.socketPath !== "string"
  ) {
    return undefined;
  }
  const operations = response.result?.capabilities?.operations;
  return {
    build: {
      version: daemon.version,
      buildTime:
        typeof daemon.buildTime === "number" && Number.isSafeInteger(daemon.buildTime)
          ? daemon.buildTime
          : 0,
    },
    commit: typeof daemon.commit === "string" ? daemon.commit.slice(0, 6) : "------",
    socketPath: daemon.socketPath,
    operations: Array.isArray(operations)
      ? operations.filter((operation): operation is string => typeof operation === "string")
      : [],
  };
};

/** True when a live daemon holds the lifetime daemon lock. */
const daemonLockHeld = (stateDir: string) => {
  const owner = readDaemonLockOwner(stateDir);
  return owner !== undefined && isProcessAlive(owner.pid);
};

export type DaemonHandoverResult =
  | "handed-over"
  | "not-older"
  | "unsupported"
  | "refused"
  | "timeout";

/**
 * Asks the running daemon to hand over when `build` is strictly newer, then
 * waits for it to release the historical socket and the daemon lock. Callers
 * hold the daemon start lock throughout so older launchers wait instead of
 * restarting the old build. A daemon is never killed: on refusal or timeout it
 * keeps serving.
 */
// Daemons that predate `requestHandover` still shut down gracefully on SIGTERM:
// they stop polling, release their leases and the daemon lock, close their
// sockets, and exit. That is their documented cooperative shutdown path.
const DAEMON_ENTRY_PATTERN = /(?:premind-daemon\.mjs|[/\\]daemon[/\\]index\.ts)(?:\s|$)/;

const readProcessCommand = (pid: number): string | undefined => {
  if (process.platform === "win32") return undefined;
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Identifies a running Premind daemon that cannot accept `requestHandover`,
 * so it can be asked to stop with SIGTERM instead. Every check must pass:
 * a live process holds this state directory's daemon lock, its command line
 * is a Premind daemon entry point, and the socket answers a Premind status
 * probe. Anything less is left alone for manual recovery.
 */
export const identifySignalableDaemon = async ({
  socketPath = PREMIND_SOCKET_PATH,
  stateDir = PREMIND_STATE_DIR,
  readCommand = readProcessCommand,
}: {
  socketPath?: string;
  stateDir?: string;
  readCommand?: (pid: number) => string | undefined;
} = {}): Promise<number | undefined> => {
  const owner = readDaemonLockOwner(stateDir);
  if (!owner || owner.pid === process.pid || !isProcessAlive(owner.pid)) {
    return undefined;
  }
  const command = readCommand(owner.pid);
  if (!command || !DAEMON_ENTRY_PATTERN.test(command)) return undefined;
  const probe = await inspectDaemon(socketPath);
  if (probe.status !== "compatible" && probe.status !== "incompatible") {
    return undefined;
  }
  // The lock may have changed hands while probing.
  return readDaemonLockOwner(stateDir)?.token === owner.token ? owner.pid : undefined;
};

/** The build a pre-bootstrap daemon is treated as: older than any known build. */
const UNKNOWN_BUILD: DaemonBuildIdentity = { version: "0.0.0", buildTime: 0 };

type HandoverPlan =
  | { kind: "request"; socketPath: string }
  | { kind: "signal"; pid: number }
  | { kind: "none"; result: Exclude<DaemonHandoverResult, "handed-over" | "timeout" | "refused"> };

const planHandover = async ({
  build,
  host,
  socketPath,
  stateDir,
  readCommand,
}: {
  build: DaemonBuildIdentity;
  host: string;
  socketPath: string;
  stateDir: string;
  readCommand?: (pid: number) => string | undefined;
}): Promise<HandoverPlan> => {
  const running = await inspectRunningDaemonBuild({ socketPath, host, build });
  // A daemon without requestHandover predates #89 and every build that can
  // replace it. Bootstrap-era daemons (#43 to #89) report no build time, so
  // comparing builds would leave them unordered against an equal version.
  const runningBuild =
    running?.operations.includes(REQUEST_HANDOVER_OPERATION) === true
      ? running.build
      : UNKNOWN_BUILD;
  if (compareDaemonBuilds(build, runningBuild) !== "newer") {
    return { kind: "none", result: "not-older" };
  }
  if (running?.operations.includes(REQUEST_HANDOVER_OPERATION)) {
    return { kind: "request", socketPath: running.socketPath };
  }
  const pid = await identifySignalableDaemon({ socketPath, stateDir, readCommand });
  return pid === undefined
    ? { kind: "none", result: "unsupported" }
    : { kind: "signal", pid };
};

/**
 * Replaces the running daemon when `build` is strictly newer, then waits for
 * it to release the historical socket and the daemon lock. A daemon that
 * supports `requestHandover` is asked; an identified older Premind daemon that
 * does not is sent SIGTERM. Callers hold the daemon start lock throughout so
 * older launchers wait instead of restarting the old build. An unidentified
 * process is never signalled, and a daemon that refuses or does not exit in
 * time keeps serving.
 */
export const handOverOlderDaemon = async ({
  build,
  host,
  socketPath = PREMIND_SOCKET_PATH,
  stateDir = PREMIND_STATE_DIR,
  timeoutMs = DAEMON_HANDOVER_TIMEOUT_MS,
  retryMs = 50,
  readCommand,
}: {
  build: DaemonBuildIdentity;
  host: string;
  socketPath?: string;
  stateDir?: string;
  timeoutMs?: number;
  retryMs?: number;
  readCommand?: (pid: number) => string | undefined;
}): Promise<DaemonHandoverResult> => {
  const plan = await planHandover({ build, host, socketPath, stateDir, readCommand });
  if (plan.kind === "none") return plan.result;
  if (plan.kind === "request") {
    const response = (await requestJson(
      plan.socketPath,
      {
        type: REQUEST_HANDOVER_OPERATION,
        protocolVersion: 2,
        payload: { version: build.version, buildTime: build.buildTime },
      },
      HANDOVER_REQUEST_TIMEOUT_MS,
    )) as { ok?: unknown; result?: { accepted?: unknown } } | undefined;
    if (response?.ok !== true || response.result?.accepted !== true) return "refused";
  } else {
    try {
      process.kill(plan.pid, "SIGTERM");
    } catch {
      // It exited on its own; the wait below confirms the socket is free.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!daemonLockHeld(stateDir) && !(await isSocketReachable(socketPath))) {
      return "handed-over";
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return "timeout";
};

/** True when the running daemon is strictly older than `build` and replaceable. */
export const isRunningDaemonOlder = async (options: {
  build: DaemonBuildIdentity;
  host: string;
  socketPath?: string;
  stateDir?: string;
  readCommand?: (pid: number) => string | undefined;
}) =>
  (
    await planHandover({
      ...options,
      socketPath: options.socketPath ?? PREMIND_SOCKET_PATH,
      stateDir: options.stateDir ?? PREMIND_STATE_DIR,
    })
  ).kind !== "none";

const formatBuild = (build: DaemonBuildIdentity, commit?: string) => {
  const parts = [commit, build.buildTime > 0 ? `built ${new Date(build.buildTime * 1000).toISOString().slice(0, 10)}` : undefined]
    .filter((part): part is string => part !== undefined && part !== "------");
  return `v${build.version}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
};

/**
 * One doctor line describing the running daemon's build relative to this
 * host's packaged build, so an update that has not taken effect yet is
 * visible. Never throws; a probe failure is reported in the line.
 */
export const describeDaemonBuild = async ({
  host,
  socketPath = PREMIND_SOCKET_PATH,
  stateDir = PREMIND_STATE_DIR,
  build,
}: {
  host: string;
  socketPath?: string;
  stateDir?: string;
  build: DaemonBuildIdentity;
}): Promise<string> => {
  const plugin = formatBuild(build);
  try {
    const running = await inspectRunningDaemonBuild({ socketPath, host, build });
    if (!running) {
      if (!(await isSocketReachable(socketPath))) return `daemon build: not running; this plugin is ${plugin}`;
      const replaceable = await identifySignalableDaemon({ socketPath, stateDir });
      return replaceable === undefined
        ? `daemon build: unknown (predates build reporting); this plugin is ${plugin}`
        : `daemon build: older than this plugin's ${plugin}; the next Premind launch replaces it`;
    }
    const daemon = formatBuild(running.build, running.commit);
    if (!running.operations.includes(REQUEST_HANDOVER_OPERATION)) {
      const replaceable =
        parseRelease(build.version) !== undefined &&
        (await identifySignalableDaemon({ socketPath, stateDir })) !== undefined;
      return replaceable
        ? `daemon build: ${daemon}, older than this plugin's ${plugin}; the next Premind launch replaces it`
        : `daemon build: ${daemon}, predates handover; it is replaced when it next exits`;
    }
    switch (compareDaemonBuilds(build, running.build)) {
      case "same":
        return `daemon build: ${daemon}, the same as this plugin`;
      case "newer":
        return `daemon build: ${daemon}, older than this plugin's ${plugin}; the next Premind launch replaces it`;
      case "older":
        return `daemon build: ${daemon}, newer than this plugin's ${plugin}; update or reload this host to match`;
      default:
        return `daemon build: ${daemon}; this plugin is ${plugin}`;
    }
  } catch (error) {
    return `daemon build: unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
};
