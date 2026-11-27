/**
 * OpenCode lifecycle contract driver.
 *
 * Runs the production OpenCode V2 server part (`createPremindServer`) against
 * a fake `Plugin.Context`: an in-memory storage that survives restarts like
 * OpenCode's, the session event stream, the `experimental.idle` hook, and a
 * synthetic-message sink that admits each id once, as OpenCode does. The real
 * host is covered by `src/test/native/opencode.e2e.ts`.
 */

import { PREMIND_CLIENT_HEARTBEAT_MS } from "../../../shared/constants.ts"
import { createPremindServer } from "../../../plugin-opencode-v2/server.ts"
import type { SessionDaemon } from "../../../plugin-opencode-v2/sessions.ts"
import { harnessToolName } from "./tool-names.ts"
import type { AdapterDriver, DeliverArgs, DeliveryCapture, HarnessControls, StartIdleArgs } from "./types.ts"

const DIRECTORY = "/tmp/project"

type Tool = { execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> }
type IdleHook = (input: { sessionID: string; background: [] }) => Promise<void>
type SessionEvent = { type: string; data: Record<string, unknown>; location?: { directory: string } }

/** What OpenCode keeps across a reload or restart of the plugin. */
type Host = { storage: Map<string, unknown>; synthetic: Set<string>; captured: DeliveryCapture[]; busy: boolean; deleted: boolean }

const createHost = (): Host => ({ storage: new Map(), synthetic: new Set(), captured: [], busy: false, deleted: false })

const createOpenCodeHarness = async (
	{ daemonClient, sessionId, branch }: Pick<StartIdleArgs, "daemonClient" | "sessionId" | "branch">,
	host = createHost(),
) => {
	const tools = new Map<string, Tool>()
	const events: SessionEvent[] = []
	let wake: (() => void) | undefined
	let idleHook: IdleHook | undefined
	let clock = 1

	const ctx = {
		options: {},
		location: { directory: DIRECTORY },
		storage: {
			get: async (key: string) => host.storage.get(key),
			set: async (key: string, value: unknown) => void host.storage.set(key, value),
			remove: async (key: string) => void host.storage.delete(key),
			scan: async ({ prefix }: { prefix: string }) => ({
				entries: [...host.storage.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, value: host.storage.get(key) })),
			}),
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => {
				if (sessionID !== sessionId || host.deleted) throw Object.assign(new Error("not found"), { _tag: "SessionNotFoundError" })
				const now = clock++
				return { id: sessionID, location: { directory: DIRECTORY }, time: { created: 0, ...(host.busy ? { busy: now } : { idle: now }) } }
			},
			synthetic: async (input: { sessionID: string; id: string; text: string; description?: string }) => {
				if (input.id.startsWith("msg_premind_command_") || host.synthetic.has(input.id)) return
				host.synthetic.add(input.id)
				host.captured.push({ sessionId: input.sessionID, text: input.text, meta: { id: input.id, description: input.description } })
			},
			hook: async (_name: string, hook: IdleHook) => {
				idleHook = hook
				return { dispose: () => { idleHook = undefined } }
			},
		},
		event: {
			async *subscribe({ signal }: { signal: AbortSignal }) {
				signal.addEventListener("abort", () => wake?.())
				while (!signal.aborted) {
					const event = events.shift()
					if (event) yield event
					else await new Promise<void>((resolve) => { wake = resolve })
				}
			},
		},
		tool: {
			transform: async (edit: (editor: { add(tool: Tool & { name: string }): void }) => void) =>
				edit({ add: (tool) => void tools.set(`premind_${tool.name}`, tool) }),
		},
		command: { transform: async (edit: (editor: { add(): void }) => void) => edit({ add() {} }) },
		skill: { transform: async (edit: (editor: { add(): void }) => void) => edit({ add() {} }) },
		rpc: { register: async () => ({ dispose() {} }) },
	}

	const server = await createPremindServer(ctx as never, {
		daemon: daemonClient as unknown as SessionDaemon,
		detectGit: async () => ({ repo: "acme/repo", branch }),
	})
	const fire = async (type: string) => {
		events.push({ type, data: { sessionID: sessionId }, location: { directory: DIRECTORY } })
		wake?.()
		await server.sessions.settled()
	}
	/** OpenCode runs the idle hook when model work ends, before the session goes idle. */
	const finishExecution = async () => {
		host.busy = false
		await idleHook?.({ sessionID: sessionId, background: [] })
		await fire("session.execution.succeeded")
	}
	await fire("session.created")

	return { host, tools, fire, finishExecution, server }
}

const createOpenCodeControls = async (args: DeliverArgs, host?: Host): Promise<HarnessControls> => {
	const harness = await createOpenCodeHarness(args, host)
	return {
		captured: harness.host.captured,
		async invoke(capabilityId, params = {}) {
			const name = harnessToolName("opencode", capabilityId)
			const tool = harness.tools.get(name)
			if (!tool) throw new Error(`opencode did not register ${name}`)
			try {
				const { content } = await tool.execute(params, { sessionID: args.sessionId })
				return { text: content, isError: /\b(failed|refused)\b/i.test(content) }
			} catch (error) {
				return { text: error instanceof Error ? error.message : String(error), isError: true }
			}
		},
		crossDeliveryBoundary: () => harness.finishExecution(),
		// A reload or restart runs the plugin's cleanup, then setup again with the same storage.
		async restart() {
			await harness.server.dispose()
			return createOpenCodeControls(args, harness.host)
		},
		async shutdown() {
			harness.host.deleted = true
			await harness.fire("session.deleted")
			await harness.server.dispose()
		},
	}
}

export const opencodeDriver: AdapterDriver = {
	key: "opencode",
	sessionId: "opencode-session",
	branch: "feature/opencode",

	async deliver(args) {
		const harness = await createOpenCodeHarness(args)
		// Busy while the update is already queued, so delivery waits for the end of the execution.
		harness.host.busy = true
		await harness.fire("session.execution.started")
		await harness.finishExecution()
		return {
			captured: harness.host.captured,
			idleAgain: () => harness.finishExecution(),
		}
	},

	createControls: (args) => createOpenCodeControls(args),

	async startIdle({ advanceTime, ...args }) {
		const harness = await createOpenCodeHarness(args)
		await harness.finishExecution()
		// OpenCode's status poll delivers batches that arrive after the session went idle.
		const poll = async () => {
			await advanceTime(PREMIND_CLIENT_HEARTBEAT_MS)
			await harness.server.sessions.settled()
		}
		return {
			captured: harness.host.captured,
			afterUpdate: poll,
			idleAgain: poll,
			async shutdown() {
				harness.host.deleted = true
				await harness.fire("session.deleted")
				await harness.server.dispose()
			},
		}
	},
}
