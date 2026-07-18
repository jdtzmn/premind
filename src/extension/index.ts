import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { renderPremindStatus } from "../plugin/commands.ts"
import { PremindDaemonClient } from "../plugin/daemon-client.ts"
import type { DebugStatusResponse } from "../shared/schema.ts"

type PruneClosedSessionsResult = {
  sessions: number
  reminderBatches: number
}

type DaemonClientLike = {
  debugStatus: () => Promise<DebugStatusResponse>
  pruneClosedSessions: () => Promise<unknown>
}

export type PremindPiExtensionDependencies = {
  createDaemonClient?: () => DaemonClientLike
}

const STATUS_ERROR_PREFIX = "premind status failed"
const PRUNE_ERROR_PREFIX = "premind prune failed"

const formatPruneResult = (result: PruneClosedSessionsResult) =>
  `premind pruned ${result.sessions} closed session${result.sessions === 1 ? "" : "s"} and ${result.reminderBatches} reminder batch${result.reminderBatches === 1 ? "" : "es"}.`

export const createPremindPiExtension = (dependencies: PremindPiExtensionDependencies = {}) => {
  return function premindPiExtension(pi: ExtensionAPI): void {
    const createDaemonClient = dependencies.createDaemonClient ?? (() => new PremindDaemonClient())

    const getStatusText = async () => {
      const status = await createDaemonClient().debugStatus()
      return renderPremindStatus(status)
    }

    const pruneClosedSessions = async () => {
      const result = await createDaemonClient().pruneClosedSessions()
      return result as PruneClosedSessionsResult
    }

    pi.registerCommand("premind:status", {
      description: "Show premind daemon status, attached sessions, and pending reminders",
      handler: async (_args, ctx) => {
        try {
          ctx.ui.notify(await getStatusText(), "info")
        } catch (error) {
          ctx.ui.notify(`${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    })

    pi.registerCommand("premind:prune", {
      description: "Remove closed premind sessions and their pending reminder batches from daemon state",
      handler: async (_args, ctx) => {
        try {
          ctx.ui.notify(formatPruneResult(await pruneClosedSessions()), "info")
        } catch (error) {
          ctx.ui.notify(`${PRUNE_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    })

    pi.registerTool({
      name: "premind_status",
      label: "Premind Status",
      description: "Show premind daemon status including active sessions, watchers, and pending reminder counts.",
      promptSnippet: "Inspect premind PR reminder daemon status.",
      promptGuidelines: [
        "Use premind_status when the user asks about premind daemon state, PR reminder attachment, pending reminders, or watcher status.",
      ],
      parameters: Type.Object({}),
      async execute() {
        try {
          return {
            content: [{ type: "text" as const, text: await getStatusText() }],
            details: {},
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: {},
          }
        }
      },
    })
  }
}

export default createPremindPiExtension()
