/**
 * OpenCode contract driver.
 *
 * Drives the plugin through its real lifecycle events rather than calling an
 * extracted delivery helper, because the interesting logic is the gating:
 * `ownedSessions`, idle timers, and the in-flight guard.
 */

import { createPremindPlugin } from "../../../plugin/index.ts"
import type { AdapterDriver, DeliveryCapture } from "./types.ts"

type PluginRuntime = {
	config: (input: Record<string, unknown>) => Promise<void>
	event: (input: { event: unknown }) => Promise<void>
}

export const opencodeDriver: AdapterDriver = {
	key: "opencode",
	sessionId: "opencode-session",
	branch: "feature/opencode",

	async deliver({ daemonClient, sessionId, branch }) {
		const captured: DeliveryCapture[] = []
		let resolveDelivery: (() => void) | undefined
		const delivered = new Promise<void>((resolve) => {
			resolveDelivery = resolve
		})

		const plugin = await createPremindPlugin({
			createDaemonClient: () => daemonClient as never,
			detectGit: async () => ({ repo: "acme/repo", branch }),
			ensureDaemon: async () => {},
			// Deliver on the first idle event instead of waiting out a countdown;
			// countdown timing is covered by idle-delivery.test.ts.
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

		await runtime.event({ event: { type: "session.created", properties: { sessionID: sessionId } } })
		// Busy while the update is already queued, so delivery has to wait for idle.
		await runtime.event({
			event: { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
		})
		await runtime.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })

		await Promise.race([
			delivered,
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		])

		return {
			captured,
			// A second idle boundary must not re-deliver a confirmed batch.
			idleAgain: async () => {
				await runtime.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
				await new Promise((resolve) => setTimeout(resolve, 50))
			},
		}
	},
}
