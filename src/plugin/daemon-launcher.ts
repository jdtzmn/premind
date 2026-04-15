import fs from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PREMIND_SOCKET_PATH } from "../shared/constants.ts"

// Resolve the daemon entry relative to this file's location.
// This works whether the package is:
// - loaded from a local checkout (src/plugin/daemon-launcher.ts -> src/daemon/index.ts)
// - installed via npm into ~/.cache/opencode/node_modules/premind/
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = path.resolve(THIS_DIR, "..", "daemon", "index.ts")

const CONNECT_RETRY_MS = 300
const CONNECT_MAX_RETRIES = 20

async function isDaemonRunning(socketPath = PREMIND_SOCKET_PATH) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath)
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => {
      resolve(false)
    })
  })
}

async function waitForSocket(socketPath = PREMIND_SOCKET_PATH) {
  for (let attempt = 0; attempt < CONNECT_MAX_RETRIES; attempt++) {
    if (await isDaemonRunning(socketPath)) return true
    await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS))
  }
  return false
}

export async function ensureDaemonRunning(socketPath = PREMIND_SOCKET_PATH) {
  if (await isDaemonRunning(socketPath)) return

  const runner = findRunner()
  if (!runner) {
    throw new Error("Cannot start premind daemon: neither bun nor tsx found")
  }

  const child = spawn(runner.command, [...runner.args, DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  })
  child.unref()

  const connected = await waitForSocket(socketPath)
  if (!connected) {
    throw new Error(`premind daemon failed to start after ${CONNECT_MAX_RETRIES * CONNECT_RETRY_MS}ms`)
  }
}

type Runner = { command: string; args: string[] }

function findRunner(): Runner | undefined {
  // The daemon uses better-sqlite3 which is a native Node addon.
  // Bun does not support better-sqlite3 yet, so we must run the daemon
  // under Node with tsx, not bun.

  // Prefer tsx (Node + TypeScript).
  const tsxPath = findExecutable("tsx")
  if (tsxPath) return { command: tsxPath, args: [] }

  // Fall back to node with tsx loader.
  const nodePath = findExecutable("node")
  if (nodePath && tsxPath) return { command: nodePath, args: ["--import", "tsx"] }

  // Last resort: try bun anyway in case better-sqlite3 support lands.
  const bunPath = findExecutable("bun")
  if (bunPath) return { command: bunPath, args: ["run"] }

  return undefined
}

function findExecutable(name: string) {
  // Walk up from the package directory looking for node_modules/.bin.
  // This handles both direct installs (premind/node_modules/.bin/tsx)
  // and hoisted installs (~/.cache/opencode/node_modules/.bin/tsx).
  let searchDir = path.resolve(THIS_DIR, "..", "..")
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(searchDir, "node_modules", ".bin", name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(searchDir)
    if (parent === searchDir) break
    searchDir = parent
  }

  // Check project-local node_modules.
  const localBin = path.resolve("node_modules", ".bin", name)
  if (fs.existsSync(localBin)) return localBin

  // Fall back to PATH.
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter)
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }

  return undefined
}
