/**
 * Codex lifecycle-hook contract driver.
 *
 * Drives the production `runCodexLifecycle` hook runner with the hook payloads
 * Codex sends (see `src/codex/schemas.ts`). Codex cannot wake an idle thread:
 * reminders arrive at the next SessionStart, UserPromptSubmit, or Stop
 * boundary, and a Stop-boundary reminder is confirmed when the continuation it
 * requested reaches its own Stop with `stop_hook_active: true`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { acquireSessionLifecycleLock } from "../../../codex/delivery-receipts.ts"
import { runCodexLifecycle } from "../../../codex/lifecycle.ts"
import { handleCodexMcpRequest } from "../../../codex/mcp-server.ts"
import { ensureCodexSessionBinding } from "../../../codex/session-binding.ts"
import { harnessToolName } from "./tool-names.ts"
import type {
	AdapterDriver,
	DeliverArgs,
	DeliveryCapture,
	HarnessControls,
	StartIdleArgs,
} from "./types.ts"

const HOST_SESSION_ID = "harness-thread"

type CodexHarnessArgs = Pick<StartIdleArgs, "daemonClient" | "sessionId" | "branch">

const createCodexHarness = ({ daemonClient, sessionId, branch }: CodexHarnessArgs) => {
	if (sessionId !== `codex:${HOST_SESSION_ID}`) {
		throw new Error(`codex driver sessions must be namespaced: ${sessionId}`)
	}
	const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "premind-codex-driver-"))
	const captured: DeliveryCapture[] = []
	let turn = 0
	let sessionHandle: string | undefined

	const dependencies = {
		client: daemonClient,
		ensureDaemon: async () => undefined,
		detectGitContext: async () => ({ repo: "acme/repo", branch }),
		ensureSessionBinding: async (targetSessionId: string, cwd: string) => {
			const binding = ensureCodexSessionBinding(pluginData, targetSessionId, cwd)
			sessionHandle = binding.sessionHandle
			return binding
		},
		acquireLock: async (targetSessionId: string, cleanupBoundary: boolean) =>
			await acquireSessionLifecycleLock(pluginData, targetSessionId, {
				...(cleanupBoundary ? { timeoutMs: 100 } : {}),
			}),
		writeOutput: async (serialized: string) => {
			const output = JSON.parse(serialized) as {
				hookSpecificOutput?: { hookEventName: string; additionalContext: string }
				decision?: string
				reason?: string
			}
			const context = output.hookSpecificOutput?.additionalContext
			// SessionStart always announces the session handle; that is not a reminder.
			const isHandleNoticeOnly =
				context !== undefined &&
				/^Premind session handle: \S+\n[^\n]*$/.test(context.trim())
			if (context && !isHandleNoticeOnly) {
				captured.push({
					sessionId,
					text: context,
					meta: { hookEventName: output.hookSpecificOutput?.hookEventName },
				})
			} else if (output.decision === "block" && output.reason) {
				captured.push({
					sessionId,
					text: output.reason,
					meta: { hookEventName: "Stop", decision: output.decision },
				})
			}
		},
	}

	const base = {
		session_id: HOST_SESSION_ID,
		transcript_path: null,
		cwd: "/tmp/project",
		model: "gpt-harness",
	}

	const sessionStart = (source: "startup" | "resume" = "startup") =>
		runCodexLifecycle(
			"SessionStart",
			{ ...base, hook_event_name: "SessionStart", permission_mode: "default", source },
			dependencies,
		)

	const stop = (stopHookActive = false) =>
		runCodexLifecycle(
			"Stop",
			{
				...base,
				hook_event_name: "Stop",
				permission_mode: "default",
				turn_id: `turn-${++turn}`,
				stop_hook_active: stopHookActive,
				last_assistant_message: null,
			},
			dependencies,
		)

	const sessionEnd = () =>
		runCodexLifecycle(
			"SessionEnd",
			{ ...base, hook_event_name: "SessionEnd", reason: "other" },
			dependencies,
		)

	return {
		captured,
		pluginData,
		get sessionHandle() {
			return sessionHandle
		},
		sessionStart,
		stop,
		/** Deliver at Stop, then confirm when the requested continuation stops. */
		deliverAtStop: async () => {
			await stop()
			await stop(true)
		},
		/** Codex's SessionEnd hook leaves the session dormant in the daemon. */
		end: async () => {
			await sessionEnd()
			fs.rmSync(pluginData, { recursive: true, force: true })
		},
		shutdown: async () => {
			await sessionEnd()
			fs.rmSync(pluginData, { recursive: true, force: true })
		},
	}
}

const createCodexControls = async (
	args: DeliverArgs,
	source: "startup" | "resume" = "startup",
): Promise<HarnessControls> => {
	const harness = createCodexHarness(args)
	await harness.sessionStart(source)
	let requestId = 0
	return {
		captured: harness.captured,
		async invoke(capabilityId, params = {}) {
			const name = harnessToolName("codex", capabilityId)
			const definition = (await handleCodexMcpRequest(
				{ jsonrpc: "2.0", id: ++requestId, method: "tools/list" },
				{
					client: args.daemonClient as never,
					pluginData: harness.pluginData,
					cwd: "/tmp/project",
					ensureDaemon: async () => {},
				},
			)) as { tools: Array<{ name: string; inputSchema: { properties: object } }> }
			const takesHandle = definition.tools.some(
				(tool) => tool.name === name && "sessionHandle" in tool.inputSchema.properties,
			)
			const result = (await handleCodexMcpRequest(
				{
					jsonrpc: "2.0",
					id: ++requestId,
					method: "tools/call",
					params: {
						name,
						arguments: {
							...params,
							...(takesHandle && harness.sessionHandle
								? { sessionHandle: harness.sessionHandle }
								: {}),
						},
					},
				},
				{
					client: args.daemonClient as never,
					pluginData: harness.pluginData,
					cwd: "/tmp/project",
					ensureDaemon: async () => {},
				},
			)) as { content: Array<{ text: string }>; isError?: boolean }
			return {
				text: result.content.map((part) => part.text).join("\n"),
				isError: result.isError === true,
			}
		},
		// Codex delivers at Stop and confirms when the continuation stops again.
		crossDeliveryBoundary: harness.deliverAtStop,
		// Ending a Codex thread runs SessionEnd (session goes dormant); resuming it
		// runs SessionStart with source "resume" for the same thread.
		async restart() {
			await harness.end()
			return createCodexControls(args, "resume")
		},
		shutdown: harness.shutdown,
	}
}

export const codexDriver: AdapterDriver = {
	key: "codex",
	sessionId: `codex:${HOST_SESSION_ID}`,
	branch: "feature/codex",
	scenarioExceptions: {
		bundlesPendingBatches: {
			kind: "deferred",
			reason:
				"Codex hooks claim and receipt one reminder batch per boundary, so pending batches arrive at successive boundaries instead of one bundled message.",
			tracking: "#77",
		},
	},

	async deliver(args) {
		const harness = createCodexHarness(args)
		// SessionStart injects the pending reminder; the turn's first Stop proves it.
		await harness.sessionStart()
		await harness.stop()
		return {
			captured: harness.captured,
			idleAgain: () => harness.stop(),
		}
	},

	createControls: (args) => createCodexControls(args),

	async startIdle(args) {
		const harness = createCodexHarness(args)
		await harness.sessionStart()
		return {
			captured: harness.captured,
			// Codex cannot wake an idle thread; Stop is its earliest supported boundary.
			afterUpdate: harness.deliverAtStop,
			idleAgain: () => harness.stop(),
			shutdown: harness.shutdown,
		}
	},
}
