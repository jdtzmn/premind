import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLAUDE_REQUIRED_DAEMON_OPERATIONS,
  acquireDaemonStartLock,
  probeDaemon,
  releaseDaemonStartLock,
  waitForDaemon,
} from "../runtime/daemon-startup.mjs";

const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../runtime/premind-daemon.mjs",
);
const startupTimeoutMs = 2_000;

export { probeDaemon };

/**
 * Starts the committed Node bundle once per shared state directory. The caller
 * deliberately receives false rather than an error for daemon failures so
 * Claude hooks and the MCP server can fail open.
 */
export const ensureDaemonRunning = async () => {
  if (await probeDaemon(undefined, CLAUDE_REQUIRED_DAEMON_OPERATIONS))
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
    if (await probeDaemon(undefined, CLAUDE_REQUIRED_DAEMON_OPERATIONS))
      return true;
    if (!fs.existsSync(runtimePath)) return false;

    const child = spawn(process.execPath, [runtimePath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
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
