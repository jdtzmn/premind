/** Claude Code hook contract driver. */

// @ts-expect-error The shipped Claude hook runtime is plain JavaScript.
import { handleHook } from "../../../../plugin-claude/bin/lib.mjs"
import type { AdapterDriver, DeliveryCapture, StartIdleArgs } from "./types.ts"

type HookOutput = {
	hookSpecificOutput: {
		hookEventName: string
		additionalContext: string
	}
}

type ClaudeHarnessArgs = Pick<StartIdleArgs, "daemonClient" | "sessionId">

const createClaudeHarness = ({ daemonClient, sessionId }: ClaudeHarnessArgs) => {
	const captured: DeliveryCapture[] = []
	const ipc = async (
		type: string,
		payload: {
			sessionId: string
			busyState?: "busy" | "idle"
			state?: "confirmed" | "failed"
			error?: string
		},
	) => {
		switch (type) {
			case "touchClaudeSession":
				return daemonClient.touchClaudeSession({
					sessionId: payload.sessionId,
					busyState: payload.busyState ?? "idle",
				})
			case "claimReminderBundle":
				return daemonClient.claimReminderBundle(payload.sessionId)
			case "ackReminderBundle":
				return daemonClient.ackReminderBundle({
					sessionId: payload.sessionId,
					state: payload.state ?? "confirmed",
					...(payload.error ? { error: payload.error } : {}),
				})
			default:
				throw new Error(`unexpected Claude hook request: ${type}`)
		}
	}
	const stop = async (stopHookActive = false) => {
		const output = (await handleHook(
			"Stop",
			{ session_id: sessionId, ...(stopHookActive ? { stop_hook_active: true } : {}) },
			ipc,
			{ CLAUDE_CODE_SESSION_ID: sessionId },
		)) as HookOutput | undefined
		if (output) {
			captured.push({
				sessionId,
				text: output.hookSpecificOutput.additionalContext,
				meta: { hookEventName: output.hookSpecificOutput.hookEventName },
			})
		}
	}
	const deliverAtStop = async () => {
		await stop()
		// Claude confirms the handoff when the injected continuation reaches its
		// next Stop hook.
		await stop(true)
	}

	return { captured, deliverAtStop, stop }
}

export const claudeDriver: AdapterDriver = {
	key: "claude",
	sessionId: "claude-session",
	branch: "feature/claude",

	async deliver(args) {
		const harness = createClaudeHarness(args)
		await harness.deliverAtStop()
		return {
			captured: harness.captured,
			idleAgain: () => harness.stop(),
		}
	},

	async startIdle(args) {
		const harness = createClaudeHarness(args)
		// A no-op Stop establishes that Claude is already idle before persistence.
		await harness.stop()
		return {
			captured: harness.captured,
			// Claude cannot wake an inactive process; Stop is its earliest supported boundary.
			afterUpdate: harness.deliverAtStop,
			idleAgain: () => harness.stop(),
			shutdown: async () => {},
		}
	},
}
