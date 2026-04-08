import fs from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PREMIND_SOCKET_PATH } from "../shared/constants.js"

const DAEMON_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "daemon",
  "index.ts",
)

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

  // Find tsx or node to run the daemon entry.
  const tsxPath = findExecutable("tsx")
  if (!tsxPath) {
    throw new Error("Cannot start premind daemon: tsx not found in PATH or node_modules/.bin")
  }

  const child = spawn(tsxPath, [DAEMON_ENTRY], {
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

function findExecutable(name: string) {
  // Check node_modules/.bin first (project-local).
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
