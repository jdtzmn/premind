import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PREMIND_SOCKET_PATH, PREMIND_STATE_DIR } from "../shared/constants.ts";
import {
  acquireDaemonStartLock,
  inspectDaemon,
  releaseDaemonStartLock,
  type DaemonProbeResult,
} from "../shared/daemon-startup.ts";
import { resolveNodeRuntime } from "./node-runtime.ts";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DAEMON_ENTRY = path.resolve(
  THIS_DIR,
  "..",
  "..",
  "runtime",
  "premind-daemon.mjs",
);
const CONNECT_RETRY_MS = 300;
const CONNECT_MAX_RETRIES = 20;

export type DaemonLaunchDiagnostic = {
  phase: "daemon-spawning" | "daemon-started" | "daemon-start-failed";
  daemonStarted: boolean;
  runner?: string;
  daemonEntry?: string;
  spawnCwd?: string;
  spawnCommand?: string;
  logPath?: string;
  spawnPid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  spawnError?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

export type DaemonLauncherOptions = {
  daemonEntry?: string;
  socketPath?: string;
  stateDir?: string;
  requiredOperations?: readonly string[];
  nodeExecutable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  retryMs?: number;
  onDiagnostic?: (diagnostic: DaemonLaunchDiagnostic) => void;
};

const waitForProbe = async (
  socketPath: string,
  requiredOperations: readonly string[],
  timeoutMs: number,
  retryMs: number,
): Promise<DaemonProbeResult> => {
  const deadline = Date.now() + timeoutMs;
  let lastTransient: Extract<
    DaemonProbeResult,
    { status: "unreachable" | "unresponsive" }
  > = { status: "unreachable" };
  while (Date.now() < deadline) {
    const result = await inspectDaemon(socketPath, requiredOperations);
    if (result.status === "compatible" || result.status === "incompatible") {
      return result;
    }
    lastTransient = result;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return lastTransient;
};

const incompatibleDaemonError = (
  result: Extract<DaemonProbeResult, { status: "incompatible" }>,
) =>
  new Error(
    `An incompatible Premind daemon already owns the global socket: ${result.reason}. ` +
      "Close other Premind hosts and retry; the socket will not be replaced automatically.",
  );
const unresponsiveDaemonError = (reason: string) =>
  new Error(
    `A Premind daemon owns the global socket but did not answer the capability probe: ${reason}. ` +
      "The socket was left untouched; retry after the existing daemon exits.",
  );


export const createDaemonLauncher = (options: DaemonLauncherOptions = {}) => {
  const socketPath = options.socketPath ?? PREMIND_SOCKET_PATH;
  const stateDir = options.stateDir ?? PREMIND_STATE_DIR;
  const requiredOperations = options.requiredOperations ?? [];
  const daemonEntry = options.daemonEntry ?? DEFAULT_DAEMON_ENTRY;
  const startupTimeoutMs =
    options.startupTimeoutMs ?? CONNECT_MAX_RETRIES * CONNECT_RETRY_MS;
  const retryMs = options.retryMs ?? CONNECT_RETRY_MS;

  return async () => {
    const initialProbe = await inspectDaemon(socketPath, requiredOperations);
    if (initialProbe.status === "compatible") return;
    if (initialProbe.status === "incompatible") {
      throw incompatibleDaemonError(initialProbe);
    }
    if (initialProbe.status === "unresponsive") {
      const waited = await waitForProbe(
        socketPath,
        requiredOperations,
        startupTimeoutMs,
        retryMs,
      );
      if (waited.status === "compatible") return;
      if (waited.status === "incompatible") {
        throw incompatibleDaemonError(waited);
      }
      if (waited.status === "unresponsive") {
        throw unresponsiveDaemonError(waited.reason);
      }
    }

    let lock = acquireDaemonStartLock({ stateDir });
    if (!lock) {
      const waited = await waitForProbe(
        socketPath,
        requiredOperations,
        startupTimeoutMs,
        retryMs,
      );
      if (waited.status === "compatible") return;
      if (waited.status === "incompatible")
        throw incompatibleDaemonError(waited);
      if (waited.status === "unresponsive") {
        throw unresponsiveDaemonError(waited.reason);
      }
      lock = acquireDaemonStartLock({ stateDir });
      if (!lock) throw new Error("Premind daemon startup remains locked");
    }

    let failureReported = false;
    try {
      const lockedProbe = await inspectDaemon(socketPath, requiredOperations);
      if (lockedProbe.status === "compatible") return;
      if (lockedProbe.status === "incompatible") {
        throw incompatibleDaemonError(lockedProbe);
      }
      if (lockedProbe.status === "unresponsive") {
        throw unresponsiveDaemonError(lockedProbe.reason);
      }

      const runtime = resolveNodeRuntime({
        executable: options.nodeExecutable,
      });
      const spawnCwd = options.cwd ?? path.dirname(daemonEntry);
      const spawnCommand = `${runtime.executable} ${daemonEntry}`;
      const logPath = path.join(stateDir, "daemon.log");
      const baseDiagnostic = {
        runner: runtime.executable,
        daemonEntry,
        spawnCwd,
        spawnCommand,
        logPath,
      };
      options.onDiagnostic?.({
        phase: "daemon-spawning",
        daemonStarted: false,
        ...baseDiagnostic,
      });

      let spawnError: string | undefined;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      const stderrFd = fs.openSync(logPath, "a");
      const child = (() => {
        try {
          return spawn(runtime.executable, [daemonEntry], {
            detached: true,
            stdio: ["ignore", "ignore", stderrFd],
            cwd: spawnCwd,
            env: {
              ...process.env,
              ...options.env,
              PREMIND_SOCKET_PATH: socketPath,
              PREMIND_STATE_DIR: stateDir,
            },
          });
        } finally {
          fs.closeSync(stderrFd);
        }
      })();
      child.once("error", (error) => {
        spawnError = error.message;
      });
      child.once("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });

      const probe = await waitForProbe(
        socketPath,
        requiredOperations,
        startupTimeoutMs,
        retryMs,
      );
      child.unref();
      const diagnostic = {
        ...baseDiagnostic,
        spawnPid: child.pid,
        exitCode,
        exitSignal,
        ...(spawnError ? { spawnError } : {}),
      };
      if (probe.status === "incompatible") {
        child.kill("SIGTERM");
        const failure = {
          phase: "daemon-start-failed" as const,
          daemonStarted: false,
          ...diagnostic,
        };
        failureReported = true;
        options.onDiagnostic?.(failure);
        throw incompatibleDaemonError(probe);
      }
      if (probe.status !== "compatible") {
        child.kill("SIGTERM");
        failureReported = true;
        options.onDiagnostic?.({
          phase: "daemon-start-failed",
          daemonStarted: false,
          timedOut: true,
          ...diagnostic,
        });
        throw new Error(
          `Premind daemon failed to start after ${startupTimeoutMs}ms. ` +
            `See ${logPath} for daemon diagnostics` +
            (spawnError ? `; spawn error: ${spawnError}` : ""),
        );
      }
      options.onDiagnostic?.({
        phase: "daemon-started",
        daemonStarted: true,
        ...diagnostic,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!failureReported) {
        options.onDiagnostic?.({
          phase: "daemon-start-failed",
          daemonStarted: false,
          spawnError: error.message,
        });
      }
      throw error;
    } finally {
      releaseDaemonStartLock(lock);
    }
  };
};

export const ensureDaemonRunning = createDaemonLauncher();
