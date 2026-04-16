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
  let pollTimer: ReturnType<typeof setInterval> | undefined
  // Track which sessions we have already shown a toast for, so we only show
  // the first-arrival toast once (not on every poll tick before idle threshold).
  const knownSessions = new Set<string>()

  const tick = () => {
    const sessions = readSessions()
    const activeEntries = Object.entries(sessions).filter(
      ([, s]) => s.pendingCount > 0 && !s.delivering,
    )

    if (activeEntries.length === 0) {
      // Nothing pending — stop polling and show a brief delivered toast if we
      // were previously showing a countdown.
      if (knownSessions.size > 0) {
        api.ui.toast({ variant: "success", message: "PR updates delivered to session", duration: 3_000 })
        knownSessions.clear()
      }
      if (pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
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

  // Start polling when a new event arrives via the event bus, or on a timer.
  // The event bus gives us a near-instant trigger when new PR events come in.
  const startPolling = () => {
    if (pollTimer !== undefined) return
    pollTimer = setInterval(tick, POLL_INTERVAL_MS)
    // Unref so this timer doesn't keep the process alive artificially.
    if (typeof pollTimer === "object" && "unref" in pollTimer) pollTimer.unref()
    // Run immediately.
    tick()
  }

  // Watch for any session event that might indicate new PR activity.
  // We start polling optimistically whenever any session event fires.
  const unsubscribe = api.event.on("session.idle" as never, () => {
    startPolling()
  })

  // Also poll on initial load in case there is already pending state.
  const initialSessions = readSessions()
  if (Object.values(initialSessions).some((s) => s.pendingCount > 0)) {
    startPolling()
  }

  // Also watch for session status events (busy/idle transitions).
  const unsubscribeBusy = api.event.on("session.status" as never, () => {
    if (pollTimer !== undefined) tick()
    else startPolling()
  })

  api.lifecycle.onDispose(() => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    unsubscribe()
    unsubscribeBusy()
  })
}

export default {
  id: "premind",
  tui: PremindTuiPlugin,
}
