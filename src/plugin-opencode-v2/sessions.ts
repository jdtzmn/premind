import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { PremindDaemonClient } from "../client/daemon-client.ts"
import { createDaemonLauncher } from "../client/daemon-launcher.ts"
import { detectGitContext } from "../client/git-context.ts"
import { createLogger } from "../daemon/logging/logger.ts"
import { PREMIND_CLIENT_HEARTBEAT_MS } from "../shared/constants.ts"
import { isDaemonError } from "../shared/daemon-error.ts"
import { createReminderDeliveryController } from "../shared/reminder-delivery.ts"

const daemonEntry = fileURLToPath(new URL("../../plugins/premind/generated/premind-daemon.mjs", import.meta.url))
const IDLE_POLL_MS = 2_000
const sessionEvents = [
	"session.created",
	"session.viewed",
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.archived",
	"session.unarchived",
	"session.moved",
	"session.deleted",
] as const

export function trackSessions(ctx: Plugin.Context) {
	const directory = ctx.location.directory
	const prefix = `sessions/${encodeURIComponent(directory)}/`
	const logger = createLogger("opencode-v2")
	const warn = (error: unknown) => logger.warn("session tracking failed", { error: String(error) })
	const daemon = new PremindDaemonClient({
		host: "opencode",
		ensureDaemon: createDaemonLauncher({ daemonEntry, host: "opencode" }),
	})
	const abort = new AbortController()
	const attached = new Map<string, { busy: boolean; bound: boolean }>()
	const tasks = new Map<string, Promise<unknown>>()
	let registration: Promise<unknown> | undefined
	let heartbeat: Promise<void> | undefined

	const connect = () => registration ??= daemon.registerClient(directory, "opencode-v2").catch((error) => {
		registration = undefined
		throw error
	})

	// Events, explicit tool/command attachment, polling and the idle hook all
	// serialize against archive, move and deletion for the same session.
	const run = <T>(sessionID: string, action: () => Promise<T>) => {
		const task = (tasks.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(() => {
			if (!abort.signal.aborted) return action()
		})
		tasks.set(sessionID, task)
		return task.finally(() => {
			if (tasks.get(sessionID) === task) tasks.delete(sessionID)
		})
	}

	const getSession = async (sessionID: string) => {
		try {
			return await ctx.session.get({ sessionID })
		} catch (error) {
			if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") return
			throw error
		}
	}

	const detach = async (sessionID: string) => {
		if (!attached.has(sessionID)) return
		await daemon.unregisterSession(sessionID)
		attached.delete(sessionID)
	}

	const remove = async (sessionID: string) => {
		if (!attached.has(sessionID) && !await ctx.storage.get(prefix + sessionID)) return
		await connect()
		try {
			await daemon.deleteSession(sessionID)
		} catch (error) {
			if (!isDaemonError(error, "SESSION_NOT_FOUND")) throw error
		}
		attached.delete(sessionID)
		await ctx.storage.remove(prefix + sessionID)
	}

	const refresh = async (sessionID: string, enroll: boolean) => {
		const session = await getSession(sessionID)
		if (!session) return
		if (session.location.directory !== directory) {
			if (attached.has(sessionID) || await ctx.storage.get(prefix + sessionID)) {
				await detach(sessionID)
				await ctx.storage.remove(prefix + sessionID)
			}
			return
		}
		if (session.parentID || session.time.archived !== undefined) {
			await detach(sessionID)
			return
		}
		const busy = session.time.busy !== undefined && session.time.busy > (session.time.idle ?? 0)
		let state = attached.get(sessionID)
		if (!state) {
			if (!enroll) return
			const git = await detectGitContext(directory)
			await connect()
			await ctx.storage.set(prefix + sessionID, true)
			await daemon.registerSession({
				sessionId: sessionID,
				host: "opencode",
				hostSessionId: sessionID,
				...git,
				isPrimary: true,
				status: "active",
				busyState: busy ? "busy" : "idle",
			})
			state = { busy, bound: false }
			attached.set(sessionID, state)
		}
		if (!state.bound) {
			try {
				await daemon.activateWorktree({ sessionId: sessionID, path: directory })
			} catch (error) {
				if (!isDaemonError(error, "WORKTREE_RESOLUTION_FAILED")) throw error
			}
			state.bound = true
		}
		if (state.busy !== busy) {
			await daemon.updateSessionState({ sessionId: sessionID, busyState: busy ? "busy" : "idle" })
			state.busy = busy
		}
		return state
	}

	const delivery = createReminderDeliveryController({
		getClient: () => daemon,
		sessionEndedError: "OpenCode session stopped before reminder delivery",
		retainHandoffOnConfirmationFailure: true,
		send: async ({ sessionId, handoffId, reminderText }) => {
			await ctx.session.synthetic({
				sessionID: sessionId,
				id: `msg_premind_${handoffId}`,
				text: reminderText,
				description: "Premind: pull request updates",
				delivery: "queue",
				resume: true,
			})
		},
	})
	const deliver = async (sessionID: string, atIdleHook: boolean) => {
		if (ctx.options.autoDeliver === false) return
		const state = await refresh(sessionID, atIdleHook)
		if (state && (atIdleHook || !state.busy)) {
			await delivery.deliver(sessionID, () => !abort.signal.aborted)
		}
	}
	const idleHook = ctx.session.hook("experimental.idle", async ({ sessionID }) => {
		await run(sessionID, () => deliver(sessionID, true)).catch(warn)
	})

	const listen = async () => {
		for await (const event of ctx.event.subscribe({ types: [...sessionEvents], signal: abort.signal })) {
			const { sessionID } = event.data
			if (event.type === "session.created" && event.data.parentID) continue
			if (event.location && event.location.directory !== directory && !attached.has(sessionID)) continue
			void run(sessionID, async () => {
				if (event.type === "session.deleted") await remove(sessionID)
				else await refresh(sessionID, true)
			}).catch(warn)
		}
	}

	const restore = async () => {
		let after: string | undefined
		do {
			const page = await ctx.storage.scan({ prefix, after })
			for (const { key } of page.entries) {
				const sessionID = key.slice(prefix.length)
				await run(sessionID, async () => {
					const session = await getSession(sessionID)
					if (!session) await remove(sessionID)
					else await refresh(sessionID, true)
				}).catch(warn)
			}
			after = page.next
		} while (after && !abort.signal.aborted)
	}

	void listen().catch(warn)
	void restore().catch(warn)
	const pollTimer = setInterval(() => {
		for (const [sessionID, state] of attached) {
			if (!state.busy && !tasks.has(sessionID)) void run(sessionID, () => deliver(sessionID, false)).catch(warn)
		}
	}, IDLE_POLL_MS)
	const heartbeatTimer = setInterval(() => {
		if (!registration || heartbeat) return
		heartbeat = registration.then(() => daemon.heartbeat()).catch(warn).finally(() => {
			heartbeat = undefined
		})
	}, PREMIND_CLIENT_HEARTBEAT_MS)

	return {
		daemon,
		connect,
		async withSession<T>(sessionID: string, action: () => Promise<T>) {
			const result = await run(sessionID, async () => {
				if (!await refresh(sessionID, true)) throw new Error("Premind requires an active primary session at this location")
				return { value: await action() }
			})
			if (!result) throw new Error("Premind is shutting down")
			return result.value
		},
		deliverNow: (sessionID: string) => delivery.deliver(sessionID, () => !abort.signal.aborted),
		async dispose() {
			abort.abort()
			clearInterval(pollTimer)
			clearInterval(heartbeatTimer)
			await Promise.allSettled(tasks.values())
			await heartbeat
			for (const sessionID of attached.keys()) {
				await daemon.updateSessionState({ sessionId: sessionID, status: "dormant", busyState: "idle" }).catch(warn)
			}
			if (registration) await daemon.release().catch(warn)
			await (await idleHook).dispose()
		},
	}
}
