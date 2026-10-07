/** Claude Code hook contract driver. */

// @ts-expect-error The shipped Claude hook runtime is plain JavaScript.
import { handleHook } from "../../../../plugin-claude/bin/lib.mjs"
// @ts-expect-error The shipped Claude MCP runtime is plain JavaScript.
import { handleMcpRequest } from "../../../../plugin-claude/bin/mcp-server.mjs"
import { harnessToolName } from "./tool-names.ts"
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
	let handoffEntry: {
		handoffId: string
		mode: "bundle" | "legacy" | "legacy-bundle"
	} | undefined
	const handoffs = {
		async replace(
			_sessionId: string,
			entry: {
				handoffId: string
				mode: "bundle" | "legacy" | "legacy-bundle"
			},
		) {
			handoffEntry = entry
		},
		async peek(_sessionId: string) {
			return handoffEntry
		},
		async remove(_sessionId: string, handoffId: string) {
			if (handoffEntry?.handoffId === handoffId) handoffEntry = undefined
		},
		async clear(_sessionId: string) {
			handoffEntry = undefined
		},
	}
	const ipc = async (
		type: string,
		payload: {
			sessionId: string
			busyState?: "busy" | "idle"
			state?: "confirmed" | "failed"
			handoffId?: string
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
					handoffId: payload.handoffId ?? "missing-handoff-id",
					state: payload.state ?? "confirmed",
					...(payload.error ? { error: payload.error } : {}),
				})
			default:
				return daemonClient.call(type, payload)
		}
	}
	const stop = async (stopHookActive = false) => {
		const output = (await handleHook(
			"Stop",
			{ session_id: sessionId, ...(stopHookActive ? { stop_hook_active: true } : {}) },
			ipc,
			{ CLAUDE_CODE_SESSION_ID: sessionId },
			handoffs,
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

	async createControls(args) {
		const harness = createClaudeHarness(args)
		const environment = { CLAUDE_CODE_SESSION_ID: args.sessionId }
		// The SessionStart hook registers through real git detection, which the
		// harness cannot stub, so send the registration it would have sent.
		await args.daemonClient.call("registerClaudeSession", {
			sessionId: args.sessionId,
			hostSessionId: args.sessionId,
			repo: "acme/repo",
			branch: args.branch,
			busyState: "idle",
		})
		return {
			captured: harness.captured,
			async invoke(capabilityId, params = {}) {
				const result = (await handleMcpRequest(
					{
						method: "tools/call",
						params: { name: harnessToolName("claude", capabilityId), arguments: params },
					},
					(type: string, payload: unknown) => args.daemonClient.call(type, payload),
					environment,
				)) as { content: Array<{ text: string }>; isError?: boolean }
				return {
					text: result.content.map((part) => part.text).join("\n"),
					isError: result.isError === true,
				}
			},
			shutdown: async () => {},
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
