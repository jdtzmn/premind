import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const stateDir =
  process.env.PREMIND_STATE_DIR ??
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "premind")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "premind"));
const socketPath = process.env.PREMIND_SOCKET_PATH ?? path.join(os.tmpdir(), "premind.sock");
const lockPath = path.join(stateDir, "daemon-start.lock");
const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../runtime/premind-daemon.mjs",
);
const startupTimeoutMs = 2_000;
const staleLockMs = 10_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const probeDaemon = (socket = socketPath) =>
  new Promise((resolve) => {
    const connection = net.createConnection(socket);
    let buffer = "";
    const done = (reachable) => {
      connection.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => done(false), 250);
    connection.setEncoding("utf8");
    connection.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
    connection.once("connect", () =>
      connection.write(`${JSON.stringify({ type: "debugStatus", protocolVersion: 1, payload: {} })}\n`),
    );
    connection.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        done(response?.ok === true && response?.protocolVersion === 1);
      } catch {
        done(false);
      }
    });
  });

const acquireLock = () => {
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    return fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleLockMs) {
        fs.unlinkSync(lockPath);
        return fs.openSync(lockPath, "wx");
      }
    } catch (retryError) {
      if (retryError?.code !== "EEXIST") throw retryError;
    }
    return undefined;
  }
};

const waitForDaemon = async () => {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeDaemon()) return true;
    await delay(50);
  }
  return false;
};

/**
 * Starts the committed Node bundle once per shared state directory. The caller
 * deliberately receives false rather than an error for daemon failures so
 * Claude hooks and the MCP server can fail open.
 */
export const ensureDaemonRunning = async () => {
  if (await probeDaemon()) return true;
  let lock;
  try {
    lock = acquireLock();
    if (lock === undefined) return await waitForDaemon();
    if (await probeDaemon()) return true;
    if (!fs.existsSync(runtimePath)) return false;
    const child = spawn(process.execPath, [runtimePath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return await waitForDaemon();
  } catch {
    return false;
  } finally {
    if (lock !== undefined) {
      try {
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
      } catch {
        // A concurrent launcher or cleanup may have removed the lock.
      }
    }
  }
};
