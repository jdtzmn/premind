import type { Plugin } from "@opencode-ai/plugin"
import { PREMIND_CLIENT_HEARTBEAT_MS } from "../shared/constants.js"
import { PremindDaemonClient } from "./daemon-client.js"
import { detectGitContext } from "./git-context.js"

const getEventSessionId = (event: { properties?: unknown }) => {
  const properties = (event.properties ?? {}) as Record<string, unknown>
  const direct = properties.sessionID
  if (typeof direct === "string" && direct.length > 0) return direct
  return undefined
}

export const PremindPlugin: Plugin = async ({ directory, worktree, client }) => {
  const daemon = new PremindDaemonClient()
  const root = worktree || directory
  const lease = await daemon.registerClient(root, "opencode-plugin")

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

          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: `${pending.batch.reminderText}\n\npremind://reminder/${pending.batch.batchId}` }],
            },
          })

          await daemon.ackReminder({
            batchId: pending.batch.batchId,
            sessionId: sessionID,
            state: "confirmed",
          })
        }
      }

      if (event.type === "session.deleted") {
        await daemon.unregisterSession(sessionID)
      }
    },
    "chat.message": async (input) => {
      if (!input.sessionID) return
      await daemon.updateSessionState({ sessionId: input.sessionID, busyState: "busy" })
    },
    "command.execute.before": async () => {
      // Reserved for future plugin commands.
    },
    config: async () => {
      // Keep the heartbeat alive for the lifetime of the plugin instance.
      process.on("exit", () => {
        clearInterval(heartbeat)
      })
    },
  }
}
