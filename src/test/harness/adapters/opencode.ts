/** OpenCode lifecycle contract driver. */

import { PREMIND_CLIENT_HEARTBEAT_MS } from "../../../shared/constants.ts"
import { createPremindPlugin } from "../../../plugin-opencode/index.ts"
import type {
	AdapterDriver,
	DeliveryCapture,
	StartIdleArgs,
} from "./types.ts"

type PluginRuntime = {
	config: (input: Record<string, unknown>) => Promise<void>
	event: (input: { event: unknown }) => Promise<void>
}

type OpenCodeHarnessArgs = Pick<StartIdleArgs, "daemonClient" | "sessionId" | "branch">

const createOpenCodeHarness = async ({
	daemonClient,
	sessionId,
	branch,
}: OpenCodeHarnessArgs) => {
	const captured: DeliveryCapture[] = []
	let resolveDelivery: (() => void) | undefined
	const delivered = new Promise<void>((resolve) => {
		resolveDelivery = resolve
	})

	const plugin = await createPremindPlugin({
		createDaemonClient: () => daemonClient as never,
		detectGit: async () => ({ repo: "acme/repo", branch }),
		ensureDaemon: async () => {},
		// Countdown timing is covered by idle-delivery.test.ts. This driver only
		// proves which lifecycle or polling boundary makes the handoff.
		idleDeliveryThresholdMs: 0,
	})({
		directory: "/tmp/project",
		worktree: "/tmp/project",
		client: {
			session: {
				get: async () => ({ data: {} }),
				prompt: async () => {},
				promptAsync: async ({ path, body }: never) => {
					const input = { path, body } as unknown as {
						path: { id: string }
						body: { parts: Array<{ text: string }> }
					}
					captured.push({ sessionId: input.path.id, text: input.body.parts[0].text })
					resolveDelivery?.()
				},
			},
			tui: { showToast: async () => undefined },
		},
	} as never)

	const runtime = plugin as unknown as PluginRuntime
	await runtime.config({})
	const fire = (event: unknown) => runtime.event({ event })
	await fire({ type: "session.created", properties: { sessionID: sessionId } })

	return { captured, delivered, fire }
}

export const opencodeDriver: AdapterDriver = {
	key: "opencode",
	sessionId: "opencode-session",
	branch: "feature/opencode",

	async deliver(args) {
		const harness = await createOpenCodeHarness(args)
		// Busy while the update is already queued, so delivery has to wait for idle.
		await harness.fire({
			type: "session.status",
			properties: { sessionID: args.sessionId, status: { type: "busy" } },
		})
		await harness.fire({ type: "session.idle", properties: { sessionID: args.sessionId } })
		await Promise.race([
			harness.delivered,
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		])

		return {
			captured: harness.captured,
			idleAgain: async () => {
				await harness.fire({ type: "session.idle", properties: { sessionID: args.sessionId } })
				await new Promise((resolve) => setTimeout(resolve, 50))
			},
		}
	},

	async startIdle({ advanceTime, ...args }) {
		const harness = await createOpenCodeHarness(args)
		await harness.fire({ type: "session.idle", properties: { sessionID: args.sessionId } })

		return {
			captured: harness.captured,
			// OpenCode polls for batches that arrive after the idle event.
			afterUpdate: () => advanceTime(PREMIND_CLIENT_HEARTBEAT_MS),
			idleAgain: () => advanceTime(PREMIND_CLIENT_HEARTBEAT_MS),
			shutdown: () =>
				harness.fire({ type: "session.deleted", properties: { sessionID: args.sessionId } }),
		}
	},
}
