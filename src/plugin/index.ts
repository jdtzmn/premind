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

export const PremindPlugin: Plugin = async ({ directory, worktree, client }) => {
  const daemon = new PremindDaemonClient()
  const root = worktree || directory
  const lease = await daemon.registerClient(root, "opencode-plugin")
  const inflightReminders = new Map<string, string>()
  let lastPrimarySessionId: string | undefined

  const heartbeat = setInterval(() => {
    void daemon.heartbeat().catch(() => {
      // Keep the first scaffold quiet; reconnect logic comes later.
    })
  }, lease.heartbeatMs ?? PREMIND_CLIENT_HEARTBEAT_MS)

  const attachSession = async (sessionID: string) => {
    const session = await client.session.get({ path: { id: sessionID } })
    const sessionData = session.data
    const git = await detectGitContext(root)
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
          const git = await detectGitContext(root)
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
        process.stdout.write(`${renderPremindStatus(status)}\n`)
        return
      }

      if (isPremindPauseCommand(input)) {
        if (!targetSessionId) {
          process.stdout.write("premind pause failed: no active session\n")
          return
        }
        await daemon.pauseSession(targetSessionId)
        process.stdout.write(`premind paused for session ${targetSessionId}\n`)
        return
      }

      if (isPremindResumeCommand(input)) {
        if (!targetSessionId) {
          process.stdout.write("premind resume failed: no active session\n")
          return
        }
        await daemon.resumeSession(targetSessionId)
        process.stdout.write(`premind resumed for session ${targetSessionId}\n`)
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
