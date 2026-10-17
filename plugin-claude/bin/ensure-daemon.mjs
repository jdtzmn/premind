import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  DAEMON_START_LOCK_TOKEN_ENV,
  acquireDaemonStartLock,
  handOverOlderDaemon,
  isDaemonStarting,
  isRunningDaemonOlder,
  probeDaemon,
  readPackagedBuild,
  releaseDaemonStartLock,
  waitForDaemon,
} from "../generated/daemon-startup.mjs";

const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../generated/premind-daemon.mjs",
);
const startupTimeoutMs = 2_000;

export { probeDaemon };

/**
 * Starts the committed Node bundle once per shared state directory. The caller
 * deliberately receives false rather than an error for daemon failures so
 * Claude hooks and the MCP server can fail open.
 */
export const ensureDaemonRunning = async () => {
  // A running daemon serves this hook unless the bundled build is strictly
  // newer, in which case it hands over below.
  const build = readPackagedBuild();
  if (
    (await probeDaemon()) &&
    !(await isRunningDaemonOlder({ build, host: "claude" }))
  )
    return true;

  let lock;
  try {
    lock = acquireDaemonStartLock();
    if (lock === undefined)
      return await waitForDaemon(
        undefined,
        CLAUDE_REQUIRED_DAEMON_OPERATIONS,
        startupTimeoutMs,
      );
    if (await probeDaemon()) {
      // Holding the start lock keeps older launchers from restarting the old
      // build between its exit and our daemon's startup.
      const handover = await handOverOlderDaemon({ build, host: "claude" });
      if (handover !== "handed-over") return true;
    }
    // A daemon that holds the daemon lock is starting up; never spawn another.
    if (isDaemonStarting())
      return await waitForDaemon(
        undefined,
        CLAUDE_REQUIRED_DAEMON_OPERATIONS,
        startupTimeoutMs,
      );
    if (!fs.existsSync(runtimePath)) return false;

    const child = spawn(process.execPath, [runtimePath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [DAEMON_START_LOCK_TOKEN_ENV]: lock.token },
    });
    child.unref();
    return await waitForDaemon(
      undefined,
      CLAUDE_REQUIRED_DAEMON_OPERATIONS,
      startupTimeoutMs,
    );
  } catch {
    return false;
  } finally {
    if (lock !== undefined) releaseDaemonStartLock(lock);
  }
};
