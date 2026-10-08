/** Pi lifecycle contract driver. */

import { createPremindPiExtension } from "../../../extension/index.ts"
import { harnessToolName } from "./tool-names.ts"
import type {
	AdapterDriver,
	DeliverArgs,
	DeliveryCapture,
	HarnessControls,
	StartIdleArgs,
} from "./types.ts"

type EventHandler = (event: unknown, ctx: unknown) => Promise<void>
type PiTool = {
	name: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }> }>
}

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
	const tools = new Map<string, PiTool>()
	const captured: DeliveryCapture[] = []
	let idle = true

	const pi = {
		on(name: string, handler: EventHandler) {
			events.set(name, handler)
		},
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(definition: PiTool) {
			tools.set(definition.name, definition)
		},
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

	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		const handler = events.get(name)
		if (!handler) {
			throw new Error(
				`pi extension did not register ${name}; registered: ${[...events.keys()].join(", ")}`,
			)
		}
		await handler(event, ctx)
	}

	return {
		captured,
		fire,
		ctx,
		tools,
		setIdle(value: boolean) {
			idle = value
		},
	}
}

const createPiControls = async (args: DeliverArgs): Promise<HarnessControls> => {
	const harness = createPiHarness({ ...args, statusPollIntervalMs: 0 })
	await harness.fire("session_start")
	return {
		captured: harness.captured,
		async invoke(capabilityId, params = {}) {
			const name = harnessToolName("pi", capabilityId)
			const tool = harness.tools.get(name)
			if (!tool) throw new Error(`pi did not register ${name}`)
			try {
				const result = await tool.execute("scenario", params, undefined, undefined, harness.ctx)
				return { text: result.content.map((part) => part.text).join("\n"), isError: false }
			} catch (error) {
				return { text: error instanceof Error ? error.message : String(error), isError: true }
			}
		},
		// Pi hands off queued reminders as a follow-up at the end of a turn.
		crossDeliveryBoundary: () => harness.fire("turn_end"),
		// `/reload` fires session_shutdown on the old extension instance, then
		// session_start on a fresh one for the same session file (Pi extension docs).
		async restart() {
			await harness.fire("session_shutdown", { reason: "reload" })
			return createPiControls(args)
		},
		shutdown: () => harness.fire("session_shutdown"),
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

	createControls: (args) => createPiControls(args),

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
