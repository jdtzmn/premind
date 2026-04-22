import fs from "node:fs"
import path from "node:path"
import { PREMIND_STATE_DIR } from "../shared/constants.ts"

// Each plugin instance (one per opencode process) writes to its own state file
// keyed by PID. This prevents multiple instances from clobbering each other's
// diagnostics in the shared state directory, making multi-instance debugging
// tractable.
const PLUGIN_STATE_PATH = path.join(PREMIND_STATE_DIR, `plugin-runtime-${process.pid}.json`)

// Index of all live plugin instances. Written on init; cleaned up on read.
const PLUGIN_INSTANCES_PATH = path.join(PREMIND_STATE_DIR, "plugin-instances.json")

type PluginRuntimeState = {
  phase: string
  updatedAt: string
  pid: number
  error?: string
  root?: string
  daemonStarted?: boolean
  clientRegistered?: boolean
  commandsRegistered?: boolean
  lastSessionId?: string
  // Daemon startup diagnostics — populated by daemon-launcher on failure
  daemonDiagnostics?: {
    runner?: string
    daemonEntry?: string
    spawnPid?: number
    exitCode?: number | null
    exitSignal?: string | null
    spawnError?: string
    timedOut?: boolean
    stderr?: string
    stdout?: string
    spawnCwd?: string
    spawnCommand?: string
  }
}

type InstanceEntry = { pid: number; root?: string; startedAt: string }

export function writePluginRuntimeState(partial: Omit<PluginRuntimeState, "updatedAt" | "pid">) {
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  const previous = readPluginRuntimeState()
  const next: PluginRuntimeState = {
    ...previous,
    ...partial,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }

  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

export function readPluginRuntimeState(): Partial<PluginRuntimeState> {
  try {
    if (!fs.existsSync(PLUGIN_STATE_PATH)) return {}
    return JSON.parse(fs.readFileSync(PLUGIN_STATE_PATH, "utf8")) as Partial<PluginRuntimeState>
  } catch {
    return {}
  }
}

export function getPluginRuntimeStatePath() {
  return PLUGIN_STATE_PATH
}

/** Register this plugin instance in the shared index. Prunes stale entries. */
export function registerPluginInstance(root: string) {
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  let entries: InstanceEntry[] = []
  try {
    if (fs.existsSync(PLUGIN_INSTANCES_PATH)) {
      entries = JSON.parse(fs.readFileSync(PLUGIN_INSTANCES_PATH, "utf8")) as InstanceEntry[]
    }
  } catch {
    entries = []
  }

  // Prune entries whose process is no longer alive.
  entries = entries.filter((e) => {
    if (e.pid === process.pid) return false // will re-add below
    try {
      process.kill(e.pid, 0)
      return true  // still alive
    } catch {
      // Attempt to clean up the stale state file.
      try { fs.rmSync(path.join(PREMIND_STATE_DIR, `plugin-runtime-${e.pid}.json`)) } catch {}
      return false
    }
  })

  entries.push({ pid: process.pid, root, startedAt: new Date().toISOString() })
  fs.writeFileSync(PLUGIN_INSTANCES_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8")
}

/** Read all live plugin instance entries. */
export function readPluginInstances(): InstanceEntry[] {
  try {
    if (!fs.existsSync(PLUGIN_INSTANCES_PATH)) return []
    return JSON.parse(fs.readFileSync(PLUGIN_INSTANCES_PATH, "utf8")) as InstanceEntry[]
  } catch {
    return []
  }
}
