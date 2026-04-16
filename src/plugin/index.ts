import { tool, type Plugin } from "@opencode-ai/plugin"
import { PREMIND_CLIENT_HEARTBEAT_MS, PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "../shared/constants.ts"
import { PremindDaemonClient } from "./daemon-client.ts"
import { renderPremindStatus } from "./commands.ts"
import { getPluginRuntimeStatePath, readPluginRuntimeState, writePluginRuntimeState, writeSessionReminderState, clearSessionReminderState } from "./debug-state.ts"
import { detectGitContext } from "./git-context.ts"
import { ensureDaemonRunning } from "./daemon-launcher.ts"

const REMINDER_MARKER_PREFIX = "premind://reminder/"

const COMMAND_MARKERS = {
  status: "[PREMIND_STATUS]",
  pause: "[PREMIND_PAUSE]",
  resume: "[PREMIND_RESUME]",
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

type PluginContext = {
  directory: string
  worktree?: string
  client: {
    session: {
      get: (input: { path: { id: string } }) => Promise<{ data?: { parentID?: string | null } }>
      prompt: (input: PromptInput) => Promise<unknown>
      promptAsync: (input: PromptInput) => Promise<unknown>
    }
  }
}

export type PremindPluginDependencies = {
  createDaemonClient?: () => DaemonClientLike
  detectGit?: (cwd: string) => Promise<{ repo: string; branch: string }>
  ensureDaemon?: () => Promise<void>
  idleDeliveryThresholdMs?: number
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
  const idleDeliveryThreshold = dependencies.idleDeliveryThresholdMs ?? PREMIND_IDLE_DELIVERY_THRESHOLD_MS

  writePluginRuntimeState({ phase: "initializing", root })

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
  const inflightReminders = new Map<string, string>()
  let lastPrimarySessionId: string | undefined

  // Per-session idle state for threshold-based delivery.
  const idleSince = new Map<string, number>()
  const deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Per-session background poll intervals that check for new batches while idle.
  // This ensures a batch that arrives after the session is already idle still gets delivered.
  const idlePollIntervals = new Map<string, ReturnType<typeof setInterval>>()

  const heartbeat = setInterval(() => {
    void daemon.heartbeat().catch(() => {})
  }, lease.heartbeatMs ?? PREMIND_CLIENT_HEARTBEAT_MS)
  if (typeof heartbeat.unref === "function") heartbeat.unref()

  const attachSession = async (sessionID: string) => {
    const session = await client.session.get({ path: { id: sessionID } })
    const sessionData = session.data
    const git = await gitDetector(root)
    if (sessionData?.parentID) return

    await daemon.registerSession({
      sessionId: sessionID,
      repo: git.repo,
      branch: git.branch,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    lastPrimarySessionId = sessionID
    writePluginRuntimeState({ phase: "session-attached", lastSessionId: sessionID })
  }

  const isSessionNotFound = (error: unknown) =>
    error instanceof Error && error.message.startsWith("SESSION_NOT_FOUND")

  // Attempt immediate delivery of a pending reminder for a session.
  // Does nothing if no batch exists or if one is already in-flight.
  const deliverPendingReminder = async (sessionID: string) => {
    if (inflightReminders.has(sessionID)) return
    const pending = await daemon.getPendingReminder(sessionID)
    if (!pending.batch) return

    await daemon.ackReminder({
      batchId: pending.batch.batchId,
      sessionId: sessionID,
      state: "handed_off",
    })

    inflightReminders.set(sessionID, pending.batch.batchId)
    // Mark delivering so TUI can show "sending..." state.
    writeSessionReminderState(sessionID, {
      pendingCount: pending.batch.events.length,
      idleSince: idleSince.get(sessionID) ?? null,
      delivering: true,
    })
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: `${pending.batch.reminderText}\n\n${REMINDER_MARKER_PREFIX}${pending.batch.batchId}` }],
        },
      })
    } catch (error) {
      inflightReminders.delete(sessionID)
      writeSessionReminderState(sessionID, {
        pendingCount: pending.batch.events.length,
        idleSince: idleSince.get(sessionID) ?? null,
        delivering: false,
      })
      await daemon.ackReminder({
        batchId: pending.batch.batchId,
        sessionId: sessionID,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
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

  // Poll the daemon for new batches while a session is idle.
  // This catches batches that arrive after the session already went idle.
  const startIdlePoll = (sessionID: string) => {
    if (idlePollIntervals.has(sessionID)) return
    const interval = setInterval(() => {
      // Only keep polling while the session is still idle.
      if (!idleSince.has(sessionID)) {
        clearInterval(interval)
        idlePollIntervals.delete(sessionID)
        return
      }
      // Check for a new batch and update TUI state + schedule delivery.
      void daemon.getPendingReminder(sessionID).then((pending) => {
        if (!pending.batch) return
        const existing = readPluginRuntimeState().sessions?.[sessionID]
        // Only write if count changed or not yet written, to avoid redundant writes.
        if (!existing || existing.pendingCount !== pending.batch.events.length) {
          writeSessionReminderState(sessionID, {
            pendingCount: pending.batch.events.length,
            idleSince: idleSince.get(sessionID) ?? null,
            delivering: false,
          })
        }
        scheduleDelivery(sessionID)
      }).catch(() => {})
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

  // Cancel a session's idle timer and reset its idle clock (on busy).
  // The pending batch is preserved — delivery will retry on the next idle window.
  const cancelDelivery = (sessionID: string) => {
    const timer = deliveryTimers.get(sessionID)
    if (timer !== undefined) {
      clearTimeout(timer)
      deliveryTimers.delete(sessionID)
    }
    stopIdlePoll(sessionID)
    idleSince.delete(sessionID)
    // Update TUI state: session is no longer idle.
    // Only write if there is already an entry (avoids creating noise for sessions with no pending batch).
    const existing = readPluginRuntimeState().sessions?.[sessionID]
    if (existing) {
      writeSessionReminderState(sessionID, { ...existing, idleSince: null, delivering: false })
    }
  }

  const handleSessionIdle = async (sessionID: string) => {
    const git = await gitDetector(root)
    try {
      await daemon.updateSessionState({ sessionId: sessionID, busyState: "idle", repo: git.repo, branch: git.branch })
    } catch (error) {
      // Session may not be registered (e.g. child session, or created event missed). Skip silently.
      if (isSessionNotFound(error)) return
      throw error
    }

    // Record idle start time if not already set, then schedule threshold-based delivery.
    if (!idleSince.has(sessionID)) {
      idleSince.set(sessionID, Date.now())
    }

    // Write TUI-visible state: pending count + idle start time.
    const pending = await daemon.getPendingReminder(sessionID).catch(() => ({ batch: null }))
    if (pending.batch) {
      writeSessionReminderState(sessionID, {
        pendingCount: pending.batch.events.length,
        idleSince: idleSince.get(sessionID) ?? null,
        delivering: false,
      })
    }

    // Start background polling so batches that arrive while already idle are detected.
    startIdlePoll(sessionID)
    scheduleDelivery(sessionID)
  }

  const injectResponse = async (sessionID: string, text: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        agent: inputRef?.agent,
        model: inputRef?.model,
        parts: [{ type: "text", text, ignored: true }],
      },
    })
    throw new Error(ABORT_SENTINEL)
  }

  const handleStatusCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    const status = await daemon.debugStatus()
    await injectResponse(sessionID, renderPremindStatus(status), inputRef)
  }

  const handlePauseCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await daemon.pauseSession(sessionID)
    await injectResponse(sessionID, `premind paused for session ${sessionID}`, inputRef)
  }

  const handleResumeCommand = async (sessionID: string, inputRef?: { agent?: string; model?: { providerID: string; modelID: string } }) => {
    await daemon.resumeSession(sessionID)
    await injectResponse(sessionID, `premind resumed for session ${sessionID}`, inputRef)
  }

  return {
    // Register slash commands via config mutation.
    config: async (configInput: any) => {
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

      // Keep the heartbeat alive for the lifetime of the plugin instance.
      process.on("exit", () => {
        clearInterval(heartbeat)
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
          await daemon.pauseSession(sessionId)
          return `premind paused for session ${sessionId}`
        },
      }),
      premind_resume: tool({
        description: "Resume premind PR reminders for the current session",
        args: {},
        async execute(_args, ctx) {
          const sessionId = ctx.sessionID ?? lastPrimarySessionId
          if (!sessionId) return "premind resume failed: no active session"
          await daemon.resumeSession(sessionId)
          return `premind resumed for session ${sessionId}`
        },
      }),
      premind_probe: tool({
        description: "Verify premind plugin initialization and return runtime diagnostics",
        args: {},
        async execute() {
          const state = readPluginRuntimeState()
          return [
            "premind probe",
            `- state file: ${getPluginRuntimeStatePath()}`,
            `- phase: ${state.phase ?? "unknown"}`,
            `- daemon started: ${state.daemonStarted === true ? "yes" : state.daemonStarted === false ? "no" : "unknown"}`,
            `- client registered: ${state.clientRegistered === true ? "yes" : state.clientRegistered === false ? "no" : "unknown"}`,
            `- commands registered: ${state.commandsRegistered === true ? "yes" : state.commandsRegistered === false ? "no" : "unknown"}`,
            `- root: ${state.root ?? "unknown"}`,
            `- last session: ${state.lastSessionId ?? "none"}`,
            `- updated at: ${state.updatedAt ?? "unknown"}`,
            ...(state.error ? [`- error: ${state.error}`] : []),
          ].join("\n")
        },
      }),
    },

    event: async ({ event }) => {
      const sessionID = getEventSessionId(event)
      if (!sessionID) return

      if (event.type === "session.created") {
        await attachSession(sessionID)
      }

      if (event.type === "session.idle") {
        await handleSessionIdle(sessionID)
      }

      if (event.type === "session.status") {
        const statusType = (event.properties as Record<string, any>)?.status?.type
        if (statusType === "busy" || statusType === "retry") {
          await daemon.updateSessionState({ sessionId: sessionID, busyState: "busy" }).catch((error) => {
            if (!isSessionNotFound(error)) throw error
          })
          cancelDelivery(sessionID)
        }
        if (statusType === "idle") {
          await handleSessionIdle(sessionID)
        }
      }

      if (event.type === "session.deleted") {
        await daemon.unregisterSession(sessionID)
        cancelDelivery(sessionID)
        clearSessionReminderState(sessionID)
      }
    },

    // Handle both slash command markers and reminder confirmation.
    "chat.message": async (input, output) => {
      if (!input.sessionID) return

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

      // Check for reminder confirmation marker.
      const fullText = `${extractText(input)}\n${outputText}`
      const expectedBatchId = inflightReminders.get(input.sessionID)
      if (expectedBatchId && fullText.includes(`${REMINDER_MARKER_PREFIX}${expectedBatchId}`)) {
        await daemon.ackReminder({
          batchId: expectedBatchId,
          sessionId: input.sessionID,
          state: "confirmed",
        })
        inflightReminders.delete(input.sessionID)
        // Reminder confirmed — clear TUI panel state.
        clearSessionReminderState(input.sessionID)
        return
      }

      await daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" }).catch((error) => {
        if (!isSessionNotFound(error)) throw error
      })
      cancelDelivery(input.sessionID)
    },
  }
}

export const PremindPlugin = createPremindPlugin()

export default {
  id: "premind",
  server: PremindPlugin,
}
