import fs from "node:fs"
import { PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "../shared/constants.ts"
import { getPluginRuntimeStatePath, type SessionReminderState } from "./debug-state.ts"

import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// How often the TUI plugin polls the state file and updates the toast.
const POLL_INTERVAL_MS = 1_000

const formatCountdown = (ms: number): string => {
  const secs = Math.max(0, Math.ceil(ms / 1000))
  return `${secs}s`
}

const pluralUpdates = (n: number) => `${n} PR update${n === 1 ? "" : "s"} queued`

const readSessions = (): Record<string, SessionReminderState> => {
  try {
    const raw = fs.readFileSync(getPluginRuntimeStatePath(), "utf8")
    const state = JSON.parse(raw) as { sessions?: Record<string, SessionReminderState> }
    return state.sessions ?? {}
  } catch {
    return {}
  }
}

export const PremindTuiPlugin: TuiPlugin = async (api) => {
  // Track sessions we have shown a toast for so we can show the "delivered" toast.
  const knownSessions = new Set<string>()

  const tick = () => {
    const sessions = readSessions()
    const activeEntries = Object.entries(sessions).filter(
      ([, s]) => s.pendingCount > 0 && !s.delivering,
    )

    if (activeEntries.length === 0) {
      // Nothing pending — show a brief "delivered" toast if we were counting down.
      if (knownSessions.size > 0) {
        api.ui.toast({ variant: "success", message: "PR updates delivered to session", duration: 3_000 })
        knownSessions.clear()
      }
      return
    }

    // Pick the session with the most imminent delivery (lowest remaining time).
    let bestMessage = ""
    let bestRemaining = Infinity

    for (const [sessionId, s] of activeEntries) {
      knownSessions.add(sessionId)

      if (s.idleSince === null) {
        // Session is busy — countdown paused.
        bestMessage = `${pluralUpdates(s.pendingCount)} — waiting for ${formatCountdown(PREMIND_IDLE_DELIVERY_THRESHOLD_MS)} of inactivity`
        bestRemaining = PREMIND_IDLE_DELIVERY_THRESHOLD_MS
      } else {
        const elapsed = Date.now() - s.idleSince
        const remaining = Math.max(0, PREMIND_IDLE_DELIVERY_THRESHOLD_MS - elapsed)
        if (remaining < bestRemaining) {
          bestRemaining = remaining
          bestMessage = `${pluralUpdates(s.pendingCount)} — sending in ${formatCountdown(remaining)}`
        }
      }
    }

    api.ui.toast({
      variant: "info",
      message: bestMessage,
      duration: POLL_INTERVAL_MS + 200, // slightly longer than tick so it never gaps
    })
  }

  // Persistent background poll — always running so we catch state file updates
  // written by the server plugin's idle background poll, regardless of whether
  // session events fire in the TUI.
  const pollTimer = setInterval(tick, POLL_INTERVAL_MS)
  if (typeof pollTimer === "object" && "unref" in pollTimer) pollTimer.unref()

  // Run once immediately on startup.
  tick()

  api.lifecycle.onDispose(() => {
    clearInterval(pollTimer)
  })
}

export default {
  id: "premind",
  tui: PremindTuiPlugin,
}
