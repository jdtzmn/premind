import fs from "node:fs"
import path from "node:path"
import { PREMIND_STATE_DIR } from "../shared/constants.js"

const PLUGIN_STATE_PATH = path.join(PREMIND_STATE_DIR, "plugin-runtime.json")

type PluginRuntimeState = {
  phase: string
  updatedAt: string
  error?: string
  root?: string
  daemonStarted?: boolean
  clientRegistered?: boolean
  commandsRegistered?: boolean
  lastSessionId?: string
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
