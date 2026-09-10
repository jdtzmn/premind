/**
 * Pi contract driver.
 *
 * Pi delivers at `turn_end` (see "Delay Pi reminders until turn end", #26), not
 * at `agent_end`, and it drains in a loop via `deliverPendingReminders`. The
 * driver drives those real handlers so a change to the delivery trigger shows
 * up here rather than silently narrowing coverage.
 */

import { createPremindPiExtension } from "../../../extension/index.ts"
import type { AdapterDriver, DeliveryCapture } from "./types.ts"

type EventHandler = (event: unknown, ctx: unknown) => Promise<void>

type SentMessage = {
	message: { customType?: string; content?: string; details?: unknown }
	options: unknown
}

export const piDriver: AdapterDriver = {
	key: "pi",
	sessionId: "/tmp/pi-session.jsonl",
	branch: "feature/pi",

	async deliver({ daemonClient, sessionId, branch }) {
		const events = new Map<string, EventHandler>()
		const sentMessages: SentMessage[] = []

		const pi = {
			on(name: string, handler: EventHandler) {
				events.set(name, handler)
			},
			registerMessageRenderer() {},
			registerCommand() {},
			registerTool() {},
			sendMessage(message: SentMessage["message"], options: unknown) {
				sentMessages.push({ message, options })
			},
		}

		const ctx = {
			cwd: "/tmp/project",
			hasUI: true,
			sessionManager: { getSessionFile: () => sessionId },
			ui: {
				notify: () => {},
				setStatus: () => {},
			},
		}

		createPremindPiExtension({
			createDaemonClient: () => daemonClient as never,
			config: { statusPollIntervalMs: 0 },
			detectGit: async () => ({ repo: "acme/repo", branch }),
		})(pi as never)

		const sessionStart = events.get("session_start")
		const agentStart = events.get("agent_start")
		const agentEnd = events.get("agent_end")
		const turnEnd = events.get("turn_end")
		if (!sessionStart || !agentStart || !agentEnd || !turnEnd) {
			throw new Error(
				`pi extension did not register the expected lifecycle events: ${[...events.keys()].join(", ")}`,
			)
		}

		await sessionStart({}, ctx)
		// Busy while the update is already queued, so delivery waits for the turn
		// boundary rather than firing mid-turn.
		await agentStart({}, ctx)
		await agentEnd({}, ctx)
		await turnEnd({}, ctx)

		const captured: DeliveryCapture[] = sentMessages.map((sent) => ({
			sessionId,
			text: sent.message.content ?? "",
			meta: { customType: sent.message.customType, options: sent.options, details: sent.message.details },
		}))

		return {
			captured,
			idleAgain: async () => {
				await turnEnd({}, ctx)
			},
		}
	},
}
