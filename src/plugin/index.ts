import type { Plugin } from "@opencode-ai/plugin"
import { PREMIND_CLIENT_HEARTBEAT_MS } from "../shared/constants.js"
import { PremindDaemonClient } from "./daemon-client.js"
import {
  getCommandSessionId,
  isPremindPauseCommand,
  isPremindResumeCommand,
  isPremindStatusCommand,
  renderPremindStatus,
} from "./commands.js"
import { detectGitContext } from "./git-context.js"

const REMINDER_MARKER_PREFIX = "premind://reminder/"

type DaemonClientLike = {
  registerClient: (projectRoot: string, sessionSource?: string) => Promise<any>
  heartbeat: () => Promise<unknown>
  release: () => Promise<unknown>
  registerSession: (payload: Omit<import("../shared/schema.js").RegisterSessionPayload, "clientId">) => Promise<unknown>
  updateSessionState: (payload: import("../shared/schema.js").UpdateSessionStatePayload) => Promise<unknown>
  unregisterSession: (sessionId: string) => Promise<unknown>
  pauseSession: (sessionId: string) => Promise<unknown>
  resumeSession: (sessionId: string) => Promise<unknown>
  getPendingReminder: (sessionId: string) => Promise<{ batch: import("../shared/schema.js").ReminderBatch | null }>
  ackReminder: (payload: import("../shared/schema.js").AckReminderPayload) => Promise<unknown>
  debugStatus: () => Promise<any>
}

type PluginContext = {
  directory: string
  worktree?: string
  client: {
    session: {
      get: (input: { path: { id: string } }) => Promise<{ data?: { parentID?: string | null } }>
      promptAsync: (input: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }) => Promise<unknown>
    }
  }
}

type PremindPluginDependencies = {
  createDaemonClient?: () => DaemonClientLike
  detectGit?: (cwd: string) => Promise<{ repo: string; branch: string }>
  writeOutput?: (text: string) => void
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
  const daemon = dependencies.createDaemonClient?.() ?? new PremindDaemonClient()
  const root = worktree || directory
  const gitDetector = dependencies.detectGit ?? detectGitContext
  const writeOutput = dependencies.writeOutput ?? ((text: string) => process.stdout.write(text))
  const lease = await daemon.registerClient(root, "opencode-plugin")
  const inflightReminders = new Map<string, string>()
  let lastPrimarySessionId: string | undefined

  const heartbeat = setInterval(() => {
    void daemon.heartbeat().catch(() => {
      // Keep the first scaffold quiet; reconnect logic comes later.
    })
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
  }

  return {
    event: async ({ event }) => {
      const sessionID = getEventSessionId(event)
      if (!sessionID) return

      if (event.type === "session.created") {
        await attachSession(sessionID)
      }

      if (event.type === "session.status") {
        const statusType = event.properties?.status?.type
        if (statusType === "busy" || statusType === "retry") {
          await daemon.updateSessionState({ sessionId: sessionID, busyState: "busy" })
        }
        if (statusType === "idle") {
          const git = await gitDetector(root)
          await daemon.updateSessionState({ sessionId: sessionID, busyState: "idle", repo: git.repo, branch: git.branch })
          const pending = await daemon.getPendingReminder(sessionID)
          if (!pending.batch) return

          await daemon.ackReminder({
            batchId: pending.batch.batchId,
            sessionId: sessionID,
            state: "handed_off",
          })

          inflightReminders.set(sessionID, pending.batch.batchId)
          try {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                parts: [{ type: "text", text: `${pending.batch.reminderText}\n\n${REMINDER_MARKER_PREFIX}${pending.batch.batchId}` }],
              },
            })
          } catch (error) {
            inflightReminders.delete(sessionID)
            await daemon.ackReminder({
              batchId: pending.batch.batchId,
              sessionId: sessionID,
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      if (event.type === "session.deleted") {
        await daemon.unregisterSession(sessionID)
      }
    },
    "chat.message": async (input) => {
      if (!input.sessionID) return

      const text = extractText(input)
      const expectedBatchId = inflightReminders.get(input.sessionID)
      if (expectedBatchId && text.includes(`${REMINDER_MARKER_PREFIX}${expectedBatchId}`)) {
        await daemon.ackReminder({
          batchId: expectedBatchId,
          sessionId: input.sessionID,
          state: "confirmed",
        })
        inflightReminders.delete(input.sessionID)
        return
      }

      await daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" })
    },
    "command.execute.before": async (input) => {
      const targetSessionId = getCommandSessionId(input) ?? lastPrimarySessionId

      if (isPremindStatusCommand(input)) {
        const status = await daemon.debugStatus()
        writeOutput(`${renderPremindStatus(status)}\n`)
        return
      }

      if (isPremindPauseCommand(input)) {
        if (!targetSessionId) {
          writeOutput("premind pause failed: no active session\n")
          return
        }
        await daemon.pauseSession(targetSessionId)
        writeOutput(`premind paused for session ${targetSessionId}\n`)
        return
      }

      if (isPremindResumeCommand(input)) {
        if (!targetSessionId) {
          writeOutput("premind resume failed: no active session\n")
          return
        }
        await daemon.resumeSession(targetSessionId)
        writeOutput(`premind resumed for session ${targetSessionId}\n`)
      }
    },
    config: async () => {
      // Keep the heartbeat alive for the lifetime of the plugin instance.
      process.on("exit", () => {
        clearInterval(heartbeat)
        void daemon.release().catch(() => {
          // Ignore shutdown cleanup failures.
        })
      })
    },
  }
}

export const PremindPlugin = createPremindPlugin()
