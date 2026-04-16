import fs from "node:fs"
import path from "node:path"
import { PREMIND_STATE_DIR } from "../shared/constants.ts"

const PLUGIN_STATE_PATH = path.join(PREMIND_STATE_DIR, "plugin-runtime.json")

export type SessionReminderState = {
  pendingCount: number
  idleSince: number | null  // epoch ms when session became idle, null if busy
  delivering: boolean       // true while reminder is in-flight
}

type PluginRuntimeState = {
  phase: string
  updatedAt: string
  error?: string
  root?: string
  daemonStarted?: boolean
  clientRegistered?: boolean
  commandsRegistered?: boolean
  lastSessionId?: string
  // Per-session reminder state for TUI countdown panel
  sessions?: Record<string, SessionReminderState>
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
  }
}

export function writePluginRuntimeState(partial: Omit<PluginRuntimeState, "updatedAt">) {
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  const previous = readPluginRuntimeState()
  const next: PluginRuntimeState = {
    ...previous,
    ...partial,
    updatedAt: new Date().toISOString(),
  }

  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

export function writeSessionReminderState(sessionId: string, state: SessionReminderState) {
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  const previous = readPluginRuntimeState()
  const sessions = { ...(previous.sessions ?? {}), [sessionId]: state }
  const next: PluginRuntimeState = {
    phase: "running",
    ...previous,
    sessions,
    updatedAt: new Date().toISOString(),
  }

  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

export function clearSessionReminderState(sessionId: string) {
  fs.mkdirSync(PREMIND_STATE_DIR, { recursive: true })

  const previous = readPluginRuntimeState()
  if (!previous.sessions?.[sessionId]) return

  const sessions = { ...previous.sessions }
  delete sessions[sessionId]
  const next: PluginRuntimeState = {
    phase: "running",
    ...previous,
    sessions,
    updatedAt: new Date().toISOString(),
  }

  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
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
