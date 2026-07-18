import { tool, type Plugin } from "@opencode-ai/plugin"
import { PREMIND_CLIENT_HEARTBEAT_MS, PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "../shared/constants.ts"
import type { PremindConfig } from "../shared/schema.ts"
import { ensureUserConfigTemplate, getDefaultUserConfigPath, loadPremindConfig } from "../shared/config-loader.ts"
import { PremindDaemonClient } from "./daemon-client.ts"
import { renderPremindStatus } from "./commands.ts"
import { getPluginRuntimeStatePath, readPluginInstances, readPluginRuntimeState, registerPluginInstance, writePluginRuntimeState } from "./debug-state.ts"
import { detectGitContext } from "./git-context.ts"
import { ensureDaemonRunning } from "./daemon-launcher.ts"

const COMMAND_MARKERS = {
  status: "[PREMIND_STATUS]",
  pause: "[PREMIND_PAUSE]",
  resume: "[PREMIND_RESUME]",
  sendNow: "[PREMIND_SEND_NOW]",
  disable: "[PREMIND_DISABLE]",
  enable: "[PREMIND_ENABLE]",
} as const

const ABORT_SENTINEL = "__PREMIND_HANDLED__"

type DaemonClientLike = {
  registerClient: (projectRoot: string, sessionSource?: string) => Promise<any>
  heartbeat: () => Promise<unknown>
  release: () => Promise<unknown>
  registerSession: (payload: Omit<import("../shared/schema.ts").RegisterSessionPayload, "clientId">) => Promise<unknown>
  updateSessionState: (payload: import("../shared/schema.ts").UpdateSessionStatePayload) => Promise<unknown>
  unregisterSession: (sessionId: string) => Promise<unknown>
  pauseSession: (sessionId: string) => Promise<unknown>
  resumeSession: (sessionId: string) => Promise<unknown>
  getPendingReminder: (sessionId: string) => Promise<{ batch: import("../shared/schema.ts").ReminderBatch | null }>
  ackReminder: (payload: import("../shared/schema.ts").AckReminderPayload) => Promise<unknown>
  setGlobalDisabled: (disabled: boolean) => Promise<{ disabled: boolean }>
  getGlobalDisabled: () => Promise<{ disabled: boolean }>
  debugStatus: () => Promise<any>
}

type PromptInput = {
  path: { id: string }
  body: {
    noReply?: boolean
    agent?: string
    model?: { providerID: string; modelID: string }
    parts: Array<{ type: "text"; text: string; ignored?: boolean }>
  }
}

type ToastInput = {
  body: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
  }
}

type PluginContext = {
  directory: string
  worktree?: string
  client: {
    session: {
      get: (input: { path: { id: string } }) => Promise<{ data?: { parentID?: string | null } }>
      prompt: (input: PromptInput) => Promise<unknown>
      promptAsync: (input: PromptInput) => Promise<unknown>
    }
    tui: {
      showToast: (input: ToastInput) => Promise<unknown>
    }
  }
}

export type PremindPluginDependencies = {
  createDaemonClient?: () => DaemonClientLike
  detectGit?: (cwd: string) => Promise<{ repo: string; branch: string }>
  ensureDaemon?: () => Promise<void>
  idleDeliveryThresholdMs?: number
  // Overrides the countdown toast tick interval. Intended for tests.
  toastTickIntervalMs?: number
  // Override the config loader. Intended for tests and embedders that want
  // to supply config from a non-default location.
  loadConfig?: () => PremindConfig
  // Override the template-ensure step. Intended for tests that shouldn't
  // touch the user's real config directory.
  ensureConfigTemplate?: () => void
}

const getEventSessionId = (event: { properties?: unknown }) => {
  const properties = (event.properties ?? {}) as Record<string, unknown>
  const direct = properties.sessionID
  if (typeof direct === "string" && direct.length > 0) return direct
  return undefined
}

const extractText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n")
  }

  const record = value as Record<string, unknown>
  const ownText = typeof record.text === "string" ? record.text : ""
  const partText = extractText(record.parts)
  const messageText = extractText(record.message)
  const outputText = extractText(record.output)
  return [ownText, partText, messageText, outputText].filter(Boolean).join("\n")
}

export const createPremindPlugin = (dependencies: PremindPluginDependencies = {}): Plugin => async (input) => {
  const { directory, worktree, client } = input as unknown as PluginContext
  const root = worktree || directory
  const gitDetector = dependencies.detectGit ?? detectGitContext
  const startDaemon = dependencies.ensureDaemon ?? ensureDaemonRunning
  const toastTickIntervalMs = dependencies.toastTickIntervalMs ?? 1000

  // Load configuration from ~/.config/opencode/premind.jsonc.
  //
  // Two guards protect the user's real config directory from test writes:
  //  1. Injected `loadConfig` → caller owns config placement; we don't touch
  //     the filesystem at all.
  //  2. NODE_TEST_CONTEXT env var (set by `node:test`) → we're inside a test
  //     runner even if this specific test didn't inject loadConfig. Skip
  //     template creation; still load, but from the default path which for
  //     tests will almost always be absent → pure defaults.
  let resolvedConfig
  if (dependencies.loadConfig) {
    resolvedConfig = dependencies.loadConfig()
  } else {
    const underNodeTestRunner = typeof process.env.NODE_TEST_CONTEXT === "string"
    if (!underNodeTestRunner) {
      const ensureTemplate = dependencies.ensureConfigTemplate ?? (() => {
        ensureUserConfigTemplate(getDefaultUserConfigPath())
      })
      ensureTemplate()
    }
    resolvedConfig = loadPremindConfig()
  }

  // dependencies.idleDeliveryThresholdMs (test injection) takes precedence
  // over the loaded config value. Strict undefined check so 0 (used in tests
  // for immediate delivery) is not overridden by the config default.
  let idleDeliveryThreshold =
    dependencies.idleDeliveryThresholdMs ?? resolvedConfig.idleDeliveryThresholdMs ?? PREMIND_IDLE_DELIVERY_THRESHOLD_MS

  writePluginRuntimeState({ phase: "initializing", root })
  registerPluginInstance(root)

  try {
    await startDaemon()
    writePluginRuntimeState({ phase: "daemon-started", root, daemonStarted: true })
  } catch (error) {
    writePluginRuntimeState({
      phase: "daemon-start-failed",
      root,
      daemonStarted: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  const daemon = dependencies.createDaemonClient?.() ?? new PremindDaemonClient()
  const lease = await daemon.registerClient(root, "opencode-plugin")
  writePluginRuntimeState({ phase: "client-registered", root, daemonStarted: true, clientRegistered: true })
  // Tracks reminders currently being handed off via promptAsync. Acts as a
  // delivery-in-progress guard to prevent concurrent delivery for the same
  // session. Entries are set just before promptAsync and cleared immediately
  // after (success or failure) — no waiting for user-message confirmation.
  const inflightReminders = new Set<string>()
  // Sessions this plugin instance has observed through its own lifecycle
  // (opencode event stream, successful attach, or direct interaction). The
  // daemon's debugStatus.sessions returns the global session list across all
  // opencode instances and worktrees — without this gate the plugin would
  // show countdown toasts for sessions it doesn't own. Entries are added by
  // attachSession, chat.message, and tool invocations; removed by
  // session.deleted.
  const ownedSessions = new Set<string>()
  let lastPrimarySessionId: string | undefined

  // Sessions confirmed to have a parentID — i.e. ephemeral child sessions
  // created by other plugins (e.g. delegated-access classifier sessions).
  // Used to skip all processing for known child sessions without needing a
  // round-trip to opencode's session.get on every event.
  const knownChildSessions = new Set<string>()

  // Sessions this plugin has already successfully registered with the daemon.
  // Used to skip the client.session.get call on subsequent reattach attempts
  // for a session we know is real.
  const knownRootSessions = new Set<string>()

  // Soft-cap both caches to avoid unbounded growth in long sessions with many
  // ephemeral child sessions. When the limit is exceeded, prune the oldest half.
  const SESSION_CACHE_LIMIT = 1000
  const pruneSessionCache = (cache: Set<string>) => {
    if (cache.size <= SESSION_CACHE_LIMIT) return
    const toRemove = Math.floor(SESSION_CACHE_LIMIT / 2)
    let i = 0
    for (const id of cache) {
      if (i++ >= toRemove) break
      cache.delete(id)
    }
  }

  // Per-session idle state for threshold-based delivery.
  const idleSince = new Map<string, number>()
  const deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Per-session background poll intervals that check for new batches while idle.
  // This ensures a batch that arrives after the session is already idle still gets delivered.
  const idlePollIntervals = new Map<string, ReturnType<typeof setInterval>>()
  // Sessions currently showing a toast countdown. A single global interval
  // aggregates these into one showToast call per tick so multiple sessions
  // don't interleave their individual toasts and cause visible flicker.
  const toastSessions = new Set<string>()
  // Mutable count refs so the idle poll can update the displayed count without restarting the interval.
  const pendingCountRefs = new Map<string, { value: number }>()
  // Per-session zero-stall counter for the global tick's self-correction logic.
  const zeroTickCounts = new Map<string, number>()

  const heartbeat = setInterval(() => {
    void daemon.heartbeat().catch(() => {})
  }, lease.heartbeatMs ?? PREMIND_CLIENT_HEARTBEAT_MS)
  if (typeof heartbeat.unref === "function") heartbeat.unref()

  const attachSession = async (sessionID: string, trigger: "created" | "reattach" = "created"): Promise<boolean> => {
    // Fast-path: known child — skip immediately, no network call needed.
    if (knownChildSessions.has(sessionID)) {
      writePluginRuntimeState({ phase: "session-skipped-child-cached", lastSessionId: sessionID })
      return false
    }

    // Fast-path: known root — skip session.get, we've already verified this session exists.
    // Go straight to registration/re-registration.
    let sessionData: { parentID?: string | null } | undefined
    if (knownRootSessions.has(sessionID)) {
      writePluginRuntimeState({ phase: "session-attached-from-cache", lastSessionId: sessionID })
      sessionData = {}  // no parentID — we know it's a root
    } else {
      const session = await client.session.get({ path: { id: sessionID } })
      // The opencode SDK returns { error, data: undefined } instead of throwing on 404.
      // If data is absent (session doesn't exist on the server) bail immediately so we
      // never register a zombie session with the daemon or attempt promptAsync against it.
      if (!session?.data) {
        writePluginRuntimeState({
          phase: trigger === "reattach" ? "session-reattach-skipped-nonexistent" : "session-attach-skipped-nonexistent",
          lastSessionId: sessionID,
        })
        return false
      }
      sessionData = session.data
      // If this is a child session, cache it so future events skip the get call.
      if (sessionData?.parentID) {
        knownChildSessions.add(sessionID)
        pruneSessionCache(knownChildSessions)
        return false
      }
    }

    const git = await gitDetector(root)
    // Premind only tracks primary (non-child) sessions. Child sessions (subagent,
    // task, etc.) inherit their parent's reminder stream via the parent session.
    if (sessionData?.parentID) return false

    await daemon.registerSession({
      sessionId: sessionID,
      repo: git.repo,
      branch: git.branch,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    lastPrimarySessionId = sessionID
    ownedSessions.add(sessionID)
    knownRootSessions.add(sessionID)
    pruneSessionCache(knownRootSessions)
    writePluginRuntimeState({
      phase: trigger === "reattach" ? "session-reattached" : "session-attached",
      lastSessionId: sessionID,
    })

    // On reattach, any prior idleSince timestamp in this plugin process is stale
    // (the session was lost and re-registered — its effective idle window resets).
    // Without this, the toast renders "sending in 0s" forever against an ancient
    // timestamp while the already-fired delivery timer never retries.
    //
    // We give the session a fresh idle window and re-arm the delivery + poll.
    // Idle-poll will pick up any queued batch on its next tick, and we also
    // proactively probe for one so the countdown toast starts immediately.
    if (trigger === "reattach") {
      idleSince.set(sessionID, Date.now())
      startIdlePoll(sessionID)
      try {
        const pending = await daemon.getPendingReminder(sessionID)
        if (pending.batch) {
          if (!toastSessions.has(sessionID)) {
            startToastCountdown(sessionID, pending.batch.events.length)
          } else {
            const ref = pendingCountRefs.get(sessionID)
            if (ref) ref.value = pending.batch.events.length
          }
          scheduleDelivery(sessionID)
        }
      } catch {
        // Swallow — the idle poll will retry on its next tick.
      }
    }

    return true
  }

  const isSessionNotFound = (error: unknown) =>
    error instanceof Error && error.message.startsWith("SESSION_NOT_FOUND")

  // The opencode SDK throws a plain object with name: "NotFoundError" when a
  // session no longer exists on the server (HTTP 404). We detect this to cleanly
  // unregister the session from premind instead of retrying forever.
  const isNotFoundError = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as Record<string, unknown>).name === "NotFoundError"

  // The opencode SDK does NOT set throwOnError on prompt/promptAsync, so errors
  // are returned as { error: {...}, response, request } rather than thrown.
  // Extract and throw the error field so our existing catch blocks handle it.
  const throwIfResponseError = (result: unknown): void => {
    if (result && typeof result === "object" && "error" in (result as object)) {
      const err = (result as Record<string, unknown>).error
      if (err) throw err
    }
  }

  // Reactive re-attach: when a daemon call reports SESSION_NOT_FOUND for a session
  // the plugin DID observe an opencode event for, the session almost certainly
  // exists in opencode but not in premind's DB (e.g. opencode resumed a past
  // session, or the daemon's DB was wiped). Re-attach and retry once.
  //
  // Returns true if the initial call or retry succeeded. Returns false if the
  // session is a child session (attachSession deliberately skips parented sessions)
  // or if re-attach itself failed. Callers can use the boolean to decide whether
  // to continue with session-scoped bookkeeping.
  const withReattach = async (sessionID: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return true
    } catch (error) {
      if (!isSessionNotFound(error)) throw error
      let attached: boolean
      try {
        attached = await attachSession(sessionID, "reattach")
      } catch (attachError) {
        writePluginRuntimeState({
          phase: "session-reattach-failed",
          lastSessionId: sessionID,
          error: attachError instanceof Error ? attachError.message : String(attachError),
        })
        return false
      }
      // attachSession returns false when the session is a child (parentID set) —
      // don't retry; premind intentionally ignores child sessions.
      if (!attached) return false
      try {
        await fn()
        return true
      } catch (retryError) {
        // If the retry still hits SESSION_NOT_FOUND, something raced (e.g. the
        // session was unregistered between our registerSession and the retry).
        // Swallow quietly.
        if (isSessionNotFound(retryError)) return false
        throw retryError
      }
    }
  }

  // Attempt immediate delivery of a pending reminder for a session.
  // Does nothing if no batch exists or if a delivery is already in progress.
  const deliverPendingReminder = async (sessionID: string) => {
    // Never deliver to a session this plugin instance doesn't own. The
    // promptAsync call would fail anyway, but we'd have already acked
    // "handed_off" to the daemon, leaving the batch in a wrong state.
    if (!ownedSessions.has(sessionID)) return

    // Prevent concurrent delivery for the same session.
    if (inflightReminders.has(sessionID)) return

    const pending = await daemon.getPendingReminder(sessionID)
    if (!pending.batch) return

    await daemon.ackReminder({
      batchId: pending.batch.batchId,
      sessionId: sessionID,
      state: "handed_off",
    })

    inflightReminders.add(sessionID)
    // Stop countdown toast — delivery is in progress.
    stopToastCountdown(sessionID)
    try {
      const promptResult = await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: pending.batch.reminderText }],
        },
      })
      // The SDK returns error objects instead of throwing on non-2xx responses.
      // Rethrow so our catch block handles NotFoundError and other failures.
      throwIfResponseError(promptResult)
      // Auto-confirm immediately after successful delivery. The reminder has
      // been enqueued in the session; no need to wait for a marker in the
      // user's next message.
      await daemon.ackReminder({
        batchId: pending.batch.batchId,
        sessionId: sessionID,
        state: "confirmed",
      })
    } catch (error) {
      if (isNotFoundError(error)) {
        // The opencode session no longer exists. Unregister it from premind so
        // we stop attempting delivery and clear all associated local state.
        writePluginRuntimeState({ phase: "session-not-found-on-delivery", lastSessionId: sessionID })
        cancelDelivery(sessionID)
        ownedSessions.delete(sessionID)
        void daemon.unregisterSession(sessionID).catch(() => {})
      } else {
        await daemon.ackReminder({
          batchId: pending.batch.batchId,
          sessionId: sessionID,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      inflightReminders.delete(sessionID)
    }
  }

  // Schedule delivery for a session that is idle.
  // If the session has already been idle past the threshold, deliver immediately.
  // Otherwise set a timer to deliver once the threshold elapses.
  const scheduleDelivery = (sessionID: string) => {
    // Cancel any existing delivery timer for this session.
    const existing = deliveryTimers.get(sessionID)
    if (existing !== undefined) {
      clearTimeout(existing)
      deliveryTimers.delete(sessionID)
    }

    const since = idleSince.get(sessionID)
    if (since === undefined) return

    const elapsed = Date.now() - since
    const remaining = idleDeliveryThreshold - elapsed

    if (remaining <= 0) {
      // Already idle long enough — deliver now.
      void deliverPendingReminder(sessionID)
      return
    }

    // Schedule delivery for when the threshold is reached.
    const timer = setTimeout(() => {
      deliveryTimers.delete(sessionID)
      void deliverPendingReminder(sessionID)
    }, remaining)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    deliveryTimers.set(sessionID, timer)
  }

  // Register a session for the global countdown toast.
  const startToastCountdown = (sessionID: string, initialPendingCount: number) => {
    // Never render a toast for a session this plugin instance doesn't own.
    if (!ownedSessions.has(sessionID)) return
    pendingCountRefs.set(sessionID, { value: initialPendingCount })
    zeroTickCounts.set(sessionID, 0)
    toastSessions.add(sessionID)
  }

  const stopToastCountdown = (sessionID: string) => {
    toastSessions.delete(sessionID)
    pendingCountRefs.delete(sessionID)
    zeroTickCounts.delete(sessionID)
  }

  // Global tick: runs once per toastTickIntervalMs regardless of how many sessions
  // are active. Aggregates all pending-countdown sessions into a single showToast
  // call so multiple sessions never interleave their individual toasts.
  let globalToastTickCount = 0
  const globalToastTick = () => {
    globalToastTickCount++

    // Every 10 ticks (10s) verify all countdown sessions are still idle from the
    // daemon's perspective. Handles cross-instance busy transitions.
    if (globalToastTickCount % 10 === 0) {
      void daemon.debugStatus().then((status) => {
        const daemonSessions: Array<{ sessionId: string; busyState?: string }> = status?.sessions ?? []
        for (const sessionID of toastSessions) {
          const ds = daemonSessions.find((s) => s.sessionId === sessionID)
          if (!ds || ds.busyState !== "idle") {
            cancelDelivery(sessionID)
          }
        }
      }).catch(() => {})
    }

    // Collect active sessions: owned, idle locally, not in-flight.
    let totalCount = 0
    let minRemainingSecs = Infinity
    const activeSessions: string[] = []

    for (const sessionID of toastSessions) {
      const since = idleSince.get(sessionID)
      if (since === undefined) {
        // Session is no longer locally idle — remove from set.
        stopToastCountdown(sessionID)
        continue
      }
      if (inflightReminders.has(sessionID)) {
        // Delivery in progress — skip (toast hidden while in-flight).
        continue
      }
      const count = (pendingCountRefs.get(sessionID)?.value ?? 0)
      const elapsed = Date.now() - since
      const remainingSecs = Math.max(0, Math.ceil((idleDeliveryThreshold - elapsed) / 1000))

      totalCount += count
      if (remainingSecs < minRemainingSecs) minRemainingSecs = remainingSecs
      activeSessions.push(sessionID)

      // Per-session zero-stall self-correction.
      const ZERO_STALL_TICKS = 5
      if (remainingSecs === 0) {
        const prev = zeroTickCounts.get(sessionID) ?? 0
        const next = prev + 1
        zeroTickCounts.set(sessionID, next)
        if (next >= ZERO_STALL_TICKS) {
          zeroTickCounts.set(sessionID, 0)
          writePluginRuntimeState({ phase: "toast-countdown-stalled", lastSessionId: sessionID })
          scheduleDelivery(sessionID)
        }
      } else {
        zeroTickCounts.set(sessionID, 0)
      }
    }

    if (activeSessions.length === 0) return

    const label = `${totalCount} PR update${totalCount === 1 ? "" : "s"} queued`
    const message = `${label} — sending in ${minRemainingSecs === Infinity ? 0 : minRemainingSecs}s`
    void client.tui.showToast({ body: { variant: "info", message, duration: 1500 } }).catch(() => {})
  }

  const globalToastInterval = setInterval(globalToastTick, toastTickIntervalMs)
  if (typeof globalToastInterval === "object" && "unref" in globalToastInterval) globalToastInterval.unref()

  // Poll the daemon for new batches while a session is idle.
  // This catches batches that arrive after the session already went idle.
  const startIdlePoll = (sessionID: string) => {
    if (idlePollIntervals.has(sessionID)) return
    // Never poll for sessions this plugin instance doesn't own. Prevents the
    // idle poll from eagerly fetching + toasting another worktree's batch.
    if (!ownedSessions.has(sessionID)) return
    const interval = setInterval(() => {
      // Stop polling if the session is no longer idle OR no longer owned.
      if (!idleSince.has(sessionID) || !ownedSessions.has(sessionID)) {
        clearInterval(interval)
        idlePollIntervals.delete(sessionID)
        return
      }
      // Check for a new batch and start toast countdown + schedule delivery.
      void daemon.getPendingReminder(sessionID).then((pending) => {
        if (!pending.batch) return
        if (!toastSessions.has(sessionID)) {
          // No countdown registered yet — start one.
          startToastCountdown(sessionID, pending.batch.events.length)
        } else {
          // Countdown already registered — update the count ref in place so the
          // next global tick displays the latest count.
          const ref = pendingCountRefs.get(sessionID)
          if (ref) ref.value = pending.batch.events.length
        }
        scheduleDelivery(sessionID)
      }).catch((err) => {
        void writePluginRuntimeState({ phase: "idle-poll-error", error: err instanceof Error ? err.message : String(err) })
      })
    }, PREMIND_CLIENT_HEARTBEAT_MS)
    if (typeof interval === "object" && "unref" in interval) interval.unref()
    idlePollIntervals.set(sessionID, interval)
  }

  const stopIdlePoll = (sessionID: string) => {
    const interval = idlePollIntervals.get(sessionID)
    if (interval !== undefined) {
      clearInterval(interval)
      idlePollIntervals.delete(sessionID)
    }
  }

  // Bootstrap: pick up sessions that were already idle before this plugin instance started.
  // Only act on sessions THIS plugin instance owns (tracked via ownedSessions).
  // The daemon's debugStatus.sessions is the GLOBAL session list across all
  // opencode instances and worktrees; iterating it without a gate caused
  // countdown toasts to appear in TUIs that didn't own the session.
  //
  // On fresh plugin startup, ownedSessions is empty — so no sessions will be
  // bootstrapped. That is correct: sessions this instance owns will arrive
  // via session.created / session.idle events (or via chat.message adoption
  // for resumed sessions), and flow through handleSessionIdle / attachSession
  // which handle the pending-batch probe.
  void daemon.debugStatus().then(async (status) => {
    const sessions: Array<{ sessionId: string; busyState?: string }> = status?.sessions ?? []
    for (const s of sessions) {
      if (!ownedSessions.has(s.sessionId)) continue
      if (s.busyState === "idle" && !idleSince.has(s.sessionId)) {
        // Use now as a conservative idle start — we don't know the real idle time.
        idleSince.set(s.sessionId, Date.now())
        startIdlePoll(s.sessionId)

        // If a batch is already queued for this session, start the countdown toast
        // and arm the delivery timer right away.
        try {
          const pending = await daemon.getPendingReminder(s.sessionId)
          if (pending.batch && !toastSessions.has(s.sessionId)) {
            startToastCountdown(s.sessionId, pending.batch.events.length)
          }
          if (pending.batch) {
            scheduleDelivery(s.sessionId)
          }
        } catch {
          // Swallow — the idle poll will retry on its next tick.
        }
      }
    }
  }).catch(() => {})

  // Cancel a session's idle timer and reset its idle clock (on busy).
  // The pending batch is preserved — delivery will retry on the next idle window.
  const cancelDelivery = (sessionID: string) => {
    const timer = deliveryTimers.get(sessionID)
    if (timer !== undefined) {
      clearTimeout(timer)
      deliveryTimers.delete(sessionID)
    }
    stopIdlePoll(sessionID)
    stopToastCountdown(sessionID)
    idleSince.delete(sessionID)
  }

  const handleSessionIdle = async (sessionID: string) => {
    // Any event we receive scoped to sessionID comes from the opencode client
    // this plugin is attached to — adopt ownership. withReattach's attachSession
    // path already does this in the SESSION_NOT_FOUND branch, but an idle event
    // for an already-registered session would bypass that. Adopting here keeps
    // the ownership set consistent regardless of event arrival order.
    ownedSessions.add(sessionID)

    const git = await gitDetector(root)
    const ok = await withReattach(sessionID, () =>
      daemon.updateSessionState({ sessionId: sessionID, busyState: "idle", repo: git.repo, branch: git.branch }),
    )
    // withReattach returns false if the session is a child (attachSession bailed)
    // or if re-attach itself failed; in either case there is no idle state to manage.
    if (!ok) return

    // Record idle start time if not already set, then schedule threshold-based delivery.
    if (!idleSince.has(sessionID)) {
      idleSince.set(sessionID, Date.now())
    }

    // Start toast countdown if there is already a pending batch.
    const pending = await daemon.getPendingReminder(sessionID).catch(() => ({ batch: null }))
    if (pending.batch && !toastSessions.has(sessionID)) {
      startToastCountdown(sessionID, pending.batch.events.length)
    }

    // Start background polling so batches that arrive while already idle are detected.
    startIdlePoll(sessionID)
    scheduleDelivery(sessionID)
  }

  const injectResponse = async (sessionID: string, text: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    try {
      const promptResult = await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          agent: inputRef?.agent,
          model: inputRef?.model,
          parts: [{ type: "text", text, ignored: true }],
        },
      })
      // The SDK returns error objects instead of throwing on non-2xx responses.
      throwIfResponseError(promptResult)
    } catch (error) {
      if (isNotFoundError(error)) {
        // Session no longer exists in opencode — silently abandon the injection.
        return
      }
      throw error
    }
    throw new Error(ABORT_SENTINEL)
  }

  const handleStatusCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    const status = await daemon.debugStatus()
    await injectResponse(sessionID, renderPremindStatus(status), inputRef)
  }

  const handlePauseCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await withReattach(sessionID, () => daemon.pauseSession(sessionID))
    await injectResponse(sessionID, `premind paused for session ${sessionID}`, inputRef)
  }

  const handleResumeCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await withReattach(sessionID, () => daemon.resumeSession(sessionID))
    await injectResponse(sessionID, `premind resumed for session ${sessionID}`, inputRef)
  }

  const handleSendNowCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    const pending = await daemon.getPendingReminder(sessionID)
    if (!pending.batch) {
      await injectResponse(sessionID, "premind: no pending PR updates to send", inputRef)
      return
    }
    // Cancel the countdown timer and deliver immediately.
    stopToastCountdown(sessionID)
    cancelDelivery(sessionID)
    await deliverPendingReminder(sessionID)
    await injectResponse(sessionID, "premind: sending PR updates now", inputRef)
  }

  const handleDisableCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await daemon.setGlobalDisabled(true)
    await injectResponse(
      sessionID,
      "premind disabled globally. GitHub polling is stopped across all sessions and projects. Use /premind-enable to resume.",
      inputRef,
    )
  }

  const handleEnableCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await daemon.setGlobalDisabled(false)
    await injectResponse(
      sessionID,
      "premind re-enabled globally. GitHub polling will resume on the next scheduler tick.",
      inputRef,
    )
  }

  return {
    // Register slash commands via config mutation.
    config: async (configInput: any) => {
      // Premind config is loaded from ~/.config/opencode/premind.jsonc at
      // plugin-factory time, not from opencode's merged config. opencode's
      // strict schema rejects unknown top-level keys as a hard startup
      // failure, so a top-level `premind` key could never be used. If one
      // is present here, it is ignored.

      configInput.command ??= {}
      configInput.command["premind-status"] = {
        template: COMMAND_MARKERS.status,
        description: "Show premind daemon status, attached sessions, and pending reminders",
      }
      configInput.command["premind-pause"] = {
        template: COMMAND_MARKERS.pause,
        description: "Pause premind reminders for this session (events still accumulate)",
      }
      configInput.command["premind-resume"] = {
        template: COMMAND_MARKERS.resume,
        description: "Resume premind reminders for this session",
      }
      configInput.command["premind-send-now"] = {
        template: COMMAND_MARKERS.sendNow,
        description: "Send pending PR updates to this session immediately without waiting for the idle countdown",
      }
      configInput.command["premind-disable"] = {
        template: COMMAND_MARKERS.disable,
        description: "Disable premind globally (stops GitHub polling across all sessions and projects)",
      }
      configInput.command["premind-enable"] = {
        template: COMMAND_MARKERS.enable,
        description: "Re-enable premind globally (resumes GitHub polling)",
      }

      // Keep the heartbeat alive for the lifetime of the plugin instance.
      process.on("exit", () => {
        clearInterval(heartbeat)
        clearInterval(globalToastInterval)
        void daemon.release().catch(() => {})
      })

      writePluginRuntimeState({ phase: "commands-registered", commandsRegistered: true })
    },

    // Register tools so the model can also call them.
    tool: {
      premind_status: tool({
        description: "Show premind daemon status including active sessions, watchers, and pending reminder counts",
        args: {},
        async execute(_args, ctx) {
          const status = await daemon.debugStatus()
          return renderPremindStatus(status)
        },
      }),
      premind_pause: tool({
        description: "Pause premind PR reminders for the current session. Events still accumulate and will be delivered when resumed.",
        args: {},
        async execute(_args, ctx) {
          const sessionId = ctx.sessionID ?? lastPrimarySessionId
          if (!sessionId) return "premind pause failed: no active session"
          ownedSessions.add(sessionId)
          await withReattach(sessionId, () => daemon.pauseSession(sessionId))
          return `premind paused for session ${sessionId}`
        },
      }),
      premind_resume: tool({
        description: "Resume premind PR reminders for the current session",
        args: {},
        async execute(_args, ctx) {
          const sessionId = ctx.sessionID ?? lastPrimarySessionId
          if (!sessionId) return "premind resume failed: no active session"
          ownedSessions.add(sessionId)
          await withReattach(sessionId, () => daemon.resumeSession(sessionId))
          return `premind resumed for session ${sessionId}`
        },
      }),
      premind_send_now: tool({
        description: "Send pending PR updates to the current session immediately, without waiting for the idle countdown",
        args: {},
        async execute(_args, ctx) {
          const sessionId = ctx.sessionID ?? lastPrimarySessionId
          if (!sessionId) return "premind send-now failed: no active session"
          ownedSessions.add(sessionId)
          const pending = await daemon.getPendingReminder(sessionId)
          if (!pending.batch) return "premind: no pending PR updates to send"
          stopToastCountdown(sessionId)
          cancelDelivery(sessionId)
          await deliverPendingReminder(sessionId)
          return "premind: sending PR updates now"
        },
      }),
      premind_disable: tool({
        description: "Disable premind globally. Stops GitHub polling across all sessions and projects; the daemon stays up so sessions keep registering. Useful for avoiding GitHub API rate limits.",
        args: {},
        async execute() {
          await daemon.setGlobalDisabled(true)
          return "premind disabled globally. GitHub polling is stopped across all sessions and projects."
        },
      }),
      premind_enable: tool({
        description: "Re-enable premind globally after premind_disable. GitHub polling resumes on the next scheduler tick.",
        args: {},
        async execute() {
          await daemon.setGlobalDisabled(false)
          return "premind re-enabled globally. GitHub polling will resume on the next scheduler tick."
        },
      }),
      premind_probe: tool({
        description: "Verify premind plugin initialization and return runtime diagnostics for this instance and all other live instances",
        args: {},
        async execute() {
          const state = readPluginRuntimeState()
          const instances = readPluginInstances()
          const otherInstances = instances.filter((i) => i.pid !== process.pid)
          return [
            "premind probe",
            `- pid: ${process.pid}`,
            `- state file: ${getPluginRuntimeStatePath()}`,
            `- phase: ${state.phase ?? "unknown"}`,
            `- daemon started: ${state.daemonStarted === true ? "yes" : state.daemonStarted === false ? "no" : "unknown"}`,
            `- client registered: ${state.clientRegistered === true ? "yes" : state.clientRegistered === false ? "no" : "unknown"}`,
            `- commands registered: ${state.commandsRegistered === true ? "yes" : state.commandsRegistered === false ? "no" : "unknown"}`,
            `- root: ${state.root ?? "unknown"}`,
            `- last session: ${state.lastSessionId ?? "none"}`,
            `- updated at: ${state.updatedAt ?? "unknown"}`,
            ...(state.error ? [`- error: ${state.error}`] : []),
            ...(otherInstances.length > 0
              ? [`- other live instances (${otherInstances.length}):`, ...otherInstances.map((i) => `  pid=${i.pid} root=${i.root ?? "?"} started=${i.startedAt}`)]
              : ["- other live instances: none"]),
          ].join("\n")
        },
      }),
    },

    event: async ({ event }) => {
      const sessionID = getEventSessionId(event)
      if (!sessionID) return

      // Trace every event arrival so we can see which events reach this plugin
      // instance's handler. The phase is intentionally overwritten on each event
      // so the most recent one is visible in the per-PID state file.
      writePluginRuntimeState({ phase: `event:${event.type}`, lastSessionId: sessionID })

      if (event.type === "session.created") {
        // Extract parentID from the event payload without a network round-trip.
        // EventSessionCreated.properties.info is the full Session object.
        const info = (event.properties as Record<string, any>)?.info
        const parentID = info?.parentID
        if (typeof parentID === "string" && parentID.length > 0) {
          // This is an ephemeral child session (e.g. a delegated-access classifier).
          // Cache it immediately and skip all further processing.
          knownChildSessions.add(sessionID)
          pruneSessionCache(knownChildSessions)
          writePluginRuntimeState({ phase: "session-skipped-child-from-event", lastSessionId: sessionID })
          return
        }
        await attachSession(sessionID)
        return
      }

      // Fast-path: skip all processing for known child sessions.
      // This avoids session.get + daemon IPC calls for every status/idle/deleted
      // event fired during a child session's short lifecycle.
      if (knownChildSessions.has(sessionID)) {
        writePluginRuntimeState({ phase: "session-skipped-child-cached", lastSessionId: sessionID })
        return
      }

      if (event.type === "session.idle") {
        await handleSessionIdle(sessionID)
      }

      if (event.type === "session.status") {
        const statusType = (event.properties as Record<string, any>)?.status?.type
        if (statusType === "busy" || statusType === "retry") {
          // Any event we receive scoped to sessionID comes from the opencode
          // client this plugin is attached to — adopt ownership (after we've
          // confirmed it's not a child session above).
          ownedSessions.add(sessionID)
          await withReattach(sessionID, () =>
            daemon.updateSessionState({ sessionId: sessionID, busyState: "busy" }),
          )
          cancelDelivery(sessionID)
        }
        if (statusType === "idle") {
          await handleSessionIdle(sessionID)
        }
      }

      if (event.type === "session.deleted") {
        // Clean up both caches. If this was a known child session (which would
        // have been caught by the fast-path above), skip the daemon IPC call.
        const wasKnownChild = knownChildSessions.delete(sessionID)
        knownRootSessions.delete(sessionID)
        if (!wasKnownChild) {
          await daemon.unregisterSession(sessionID)
        }
        cancelDelivery(sessionID)
        ownedSessions.delete(sessionID)
      }
    },

    // Handle both slash command markers and reminder confirmation.
    "chat.message": async (input, output) => {
      if (!input.sessionID) return

      // Trace every chat.message arrival so we can confirm the handler fires.
      writePluginRuntimeState({ phase: "chat.message", lastSessionId: input.sessionID })

      // Skip known child sessions — they won't have slash commands or reminders.
      if (knownChildSessions.has(input.sessionID)) return

      // Any chat activity is conclusive proof this plugin instance owns
      // the session (after confirming it's not a child above).
      ownedSessions.add(input.sessionID)

      // Ensure the session is registered and mark it busy FIRST, before
      // handling any slash commands. Slash commands throw ABORT_SENTINEL
      // after responding, which would skip this call if it came after them.
      // This guarantees the session is always registered on first interaction,
      // even if the user's first message is a slash command like /premind-status.
      await withReattach(input.sessionID, () =>
        daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" }),
      )
      cancelDelivery(input.sessionID)

      const outputText = extractText(output)
      const inputRef = { agent: input.agent, model: input.model }

      // Handle slash command markers injected via config.
      if (outputText.includes(COMMAND_MARKERS.status)) {
        await handleStatusCommand(input.sessionID, inputRef)
      }
      if (outputText.includes(COMMAND_MARKERS.pause)) {
        await handlePauseCommand(input.sessionID, inputRef)
      }
      if (outputText.includes(COMMAND_MARKERS.resume)) {
        await handleResumeCommand(input.sessionID, inputRef)
      }
      if (outputText.includes(COMMAND_MARKERS.sendNow)) {
        await handleSendNowCommand(input.sessionID, inputRef)
      }
      if (outputText.includes(COMMAND_MARKERS.disable)) {
        await handleDisableCommand(input.sessionID, inputRef)
      }
      if (outputText.includes(COMMAND_MARKERS.enable)) {
        await handleEnableCommand(input.sessionID, inputRef)
      }
    },
  }
}

export const PremindPlugin = createPremindPlugin()

export default {
  id: "premind",
  server: PremindPlugin,
}
