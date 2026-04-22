import fs from "node:fs"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PREMIND_SOCKET_PATH } from "../shared/constants.ts"
import { writePluginRuntimeState } from "./debug-state.ts"

// Resolve the daemon entry relative to this file's location.
// This works whether the package is:
// - loaded from a local checkout (src/plugin/daemon-launcher.ts -> src/daemon/index.ts)
// - installed via npm into ~/.cache/opencode/node_modules/premind/
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = path.resolve(THIS_DIR, "..", "daemon", "index.ts")

const CONNECT_RETRY_MS = 300
const CONNECT_MAX_RETRIES = 20

// Maximum bytes captured from daemon stdio during startup.
const STDIO_BUFFER_LIMIT = 4096

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
    const diag = { timedOut: false, spawnError: "no runner found: tsx and bun are unavailable" }
    writePluginRuntimeState({ phase: "daemon-start-failed", daemonStarted: false, daemonDiagnostics: diag })
    throw new Error("Cannot start premind daemon: tsx and bun are unavailable")
  }

  // Capture stdout/stderr during startup so failures are diagnosable.
  let stdoutBuf = ""
  let stderrBuf = ""
  let spawnError: string | undefined
  let exitCode: number | null = null
  let exitSignal: string | null = null

  // Spawn with an explicit cwd set to the daemon entry's directory.
  // This avoids CWD-relative module resolution quirks when opencode's process
  // is in a project that has tsx (or other loaders) in its local node_modules —
  // those loaders would resolve the daemon entry relative to the wrong base.
  const spawnCwd = path.dirname(DAEMON_ENTRY)
  const spawnCommand = [runner.command, ...runner.args, DAEMON_ENTRY].join(" ")

  // Write pre-spawn diagnostics immediately so they're visible even if the
  // spawn hangs or crashes before we can capture the diagnostics below.
  writePluginRuntimeState({
    phase: "daemon-spawning",
    daemonStarted: false,
    daemonDiagnostics: { runner: runner.command, daemonEntry: DAEMON_ENTRY, spawnCwd, spawnCommand },
  })

  const child = spawn(runner.command, [...runner.args, DAEMON_ENTRY], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    cwd: spawnCwd,
  })

  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf = (stdoutBuf + chunk).slice(-STDIO_BUFFER_LIMIT)
  })
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDIO_BUFFER_LIMIT)
  })
  child.on("error", (err) => {
    spawnError = err.message
  })
  child.on("exit", (code, signal) => {
    exitCode = code
    exitSignal = signal
  })

  const connected = await waitForSocket(socketPath)
  child.unref()

  const diag = {
    runner: runner.command,
    daemonEntry: DAEMON_ENTRY,
    spawnCwd,
    spawnCommand,
    spawnPid: child.pid,
    exitCode,
    exitSignal,
    ...(spawnError !== undefined ? { spawnError } : {}),
    ...(stdoutBuf.length > 0 ? { stdout: stdoutBuf } : {}),
    ...(stderrBuf.length > 0 ? { stderr: stderrBuf } : {}),
  }

  if (!connected) {
    const fullDiag = { ...diag, timedOut: true }
    writePluginRuntimeState({ phase: "daemon-start-failed", daemonStarted: false, daemonDiagnostics: fullDiag })
    throw new Error(
      `premind daemon failed to start after ${CONNECT_MAX_RETRIES * CONNECT_RETRY_MS}ms` +
      (stderrBuf ? `\nstderr: ${stderrBuf.trim()}` : "") +
      (spawnError ? `\nspawn error: ${spawnError}` : ""),
    )
  }
}

type Runner = { command: string; args: string[] }

function findRunner(): Runner | undefined {
  // The daemon uses node:sqlite (built-in, no native addon required).
  // node:sqlite requires Node 22.5+. Bun does not yet implement node:sqlite,
  // so we must run the daemon under Node with tsx, not bun.

  // Prefer tsx (Node + TypeScript).
  const tsxPath = findExecutable("tsx")
  if (tsxPath) return { command: tsxPath, args: [] }

  // Fall back to node with tsx as a loader.
  // tsx may exist as a package without a direct executable in PATH but can
  // still be used as --import tsx when node is available.
  const nodePath = findExecutable("node")
  const tsxModule = resolveTsxModule()
  if (nodePath && tsxModule) return { command: nodePath, args: ["--import", tsxModule] }

  // Last resort: try bun anyway in case node:sqlite support lands in Bun.
  const bunPath = findExecutable("bun")
  if (bunPath) return { command: bunPath, args: ["run"] }

  return undefined
}

function findExecutable(name: string) {
  // Walk up from the package directory all the way to the filesystem root,
  // looking for node_modules/.bin/<name>. Terminates when path.dirname()
  // stops changing (i.e. we've reached "/"). This handles both direct installs
  // and hoisted installs at any ancestor depth — including deeply-encoded
  // git+https: cache paths that exceed a hardcoded depth limit.
  //
  // Deliberately does NOT check process.cwd()/node_modules. That fallback
  // would pick up tsx from whatever project opencode happens to be open in,
  // which may be unable to resolve the daemon entry in the opencode cache.
  let searchDir = path.resolve(THIS_DIR, "..", "..")
  while (true) {
    const candidate = path.join(searchDir, "node_modules", ".bin", name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(searchDir)
    if (parent === searchDir) break  // reached filesystem root
    searchDir = parent
  }

  // Fall back to PATH (global installs via asdf, nvm, homebrew, etc.).
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter)
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }

  return undefined
}

// Resolve tsx as a Node loader module path (for --import).
// This finds tsx's dist/esm/index.cjs which can be used as an import specifier.
function resolveTsxModule(): string | undefined {
  let searchDir = path.resolve(THIS_DIR, "..", "..")
  while (true) {
    const candidate = path.join(searchDir, "node_modules", "tsx", "dist", "esm", "index.cjs")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(searchDir)
    if (parent === searchDir) break
    searchDir = parent
  }
  return undefined
}
