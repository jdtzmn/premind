/** Pi lifecycle contract driver. */

import { createPremindPiExtension } from "../../../extension/index.ts"
import type {
	AdapterDriver,
	DeliveryCapture,
	StartIdleArgs,
} from "./types.ts"

type EventHandler = (event: unknown, ctx: unknown) => Promise<void>

type PiHarnessArgs = Pick<StartIdleArgs, "daemonClient" | "sessionId" | "branch"> & {
	statusPollIntervalMs: number
}

const createPiHarness = ({
	daemonClient,
	sessionId,
	branch,
	statusPollIntervalMs,
}: PiHarnessArgs) => {
	const events = new Map<string, EventHandler>()
	const captured: DeliveryCapture[] = []
	let idle = true

	const pi = {
		on(name: string, handler: EventHandler) {
			events.set(name, handler)
		},
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool() {},
		sendMessage(
			message: { customType?: string; content?: string; details?: unknown },
			options: unknown,
		) {
			captured.push({
				sessionId,
				text: message.content ?? "",
				meta: { customType: message.customType, options, details: message.details },
			})
		},
	}

	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionFile: () => sessionId },
		ui: {
			notify: () => {},
			setStatus: () => {},
		},
	}

	createPremindPiExtension({
		createDaemonClient: () => daemonClient as never,
		config: { statusPollIntervalMs },
		detectGit: async () => ({ repo: "acme/repo", branch }),
	})(pi as never)

	const fire = async (name: string) => {
		const handler = events.get(name)
		if (!handler) {
			throw new Error(
				`pi extension did not register ${name}; registered: ${[...events.keys()].join(", ")}`,
			)
		}
		await handler({}, ctx)
	}

	return {
		captured,
		fire,
		setIdle(value: boolean) {
			idle = value
		},
	}
}

export const piDriver: AdapterDriver = {
	key: "pi",
	sessionId: "/tmp/pi-session.jsonl",
	branch: "feature/pi",

	async deliver(args) {
		const harness = createPiHarness({ ...args, statusPollIntervalMs: 0 })
		await harness.fire("session_start")
		// Busy while the update is already queued, so delivery waits for the turn
		// boundary rather than firing mid-turn.
		harness.setIdle(false)
		await harness.fire("agent_start")
		harness.setIdle(true)
		await harness.fire("agent_end")
		await harness.fire("turn_end")

		return {
			captured: harness.captured,
			idleAgain: () => harness.fire("turn_end"),
		}
	},

	async startIdle({ advanceTime, ...args }) {
		const harness = createPiHarness({ ...args, statusPollIntervalMs: 5_000 })
		await harness.fire("session_start")

		return {
			captured: harness.captured,
			// Pi can wake an already-idle session from its autonomous status poll.
			afterUpdate: () => advanceTime(5_000),
			idleAgain: () => advanceTime(5_000),
			shutdown: () => harness.fire("session_shutdown"),
		}
	},
}
