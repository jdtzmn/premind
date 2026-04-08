import fs from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PREMIND_SOCKET_PATH } from "../shared/constants.js"

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
  // Prefer bun since OpenCode runs under bun and it handles .ts natively.
  const bunPath = findExecutable("bun")
  if (bunPath) return { command: bunPath, args: ["run"] }

  // Fall back to tsx for Node-based environments.
  const tsxPath = findExecutable("tsx")
  if (tsxPath) return { command: tsxPath, args: [] }

  // Last resort: node with tsx loader if tsx is available as a package.
  const nodePath = findExecutable("node")
  const tsxPkg = findExecutable("tsx")
  if (nodePath && tsxPkg) return { command: nodePath, args: ["--import", "tsx"] }

  return undefined
}

function findExecutable(name: string) {
  // Check relative to the package first (handles npm install paths).
  const pkgBin = path.resolve(THIS_DIR, "..", "..", "node_modules", ".bin", name)
  if (fs.existsSync(pkgBin)) return pkgBin

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
