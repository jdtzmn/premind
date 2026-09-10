/**
 * An adapter-facing daemon client backed by a real `Router` over a real
 * `StateStore`.
 *
 * Adapter suites elsewhere hand their plugin a hand-written fake that returns
 * fabricated reminder batches. That proves the adapter calls the right methods,
 * but it cannot prove an adapter delivers what the database actually holds.
 * This client closes that gap: every call is a validated IPC request handled by
 * production router code, so `getPendingReminder` goes through
 * `ReminderHandoffRegistry` and `ackReminder` moves real rows.
 *
 * The Unix socket is deliberately not involved — framing, reconnect, and
 * daemon-spawn races stay covered by `src/plugin/daemon-client.test.ts`.
 */

import { PREMIND_PROTOCOL_VERSION } from "../../shared/constants.ts"
import { Router } from "../../daemon/ipc/router.ts"
import type { StateStore } from "../../daemon/persistence/store.ts"
import type { PremindRequest } from "../../shared/ipc.ts"
import type {
	AckReminderPayload,
	RegisterSessionPayload,
	ReminderBatch,
} from "../../shared/schema.ts"

export type RouterDaemonClient = ReturnType<typeof createRouterDaemonClient>

/**
 * `Router` resolves worktrees with real git by default. Tests run against
 * temporary directories that are not repositories, so callers supply the
 * binding the daemon would have resolved.
 */
export type WorktreeStub = {
	root: string
	gitDir: string
	repo: string
	branch: string | null
	headSha: string
}

export const createRouterDaemonClient = (
	store: StateStore,
	options: { clientId?: string; worktree?: WorktreeStub } = {},
) => {
	const clientId = options.clientId ?? "harness-client"
	/** Ordered transcript of adapter -> daemon traffic, for failure diagnostics. */
	const operations: string[] = []

	const router = new Router(
		store,
		async () =>
			options.worktree ?? {
				root: "/tmp/harness",
				gitDir: "/tmp/harness/.git",
				repo: "acme/repo",
				branch: "feature/test",
				headSha: "harness-sha",
			},
	)

	const send = async (request: PremindRequest) => {
		operations.push(request.type)
		const response = await router.handle(request)
		if (!response.ok) {
			throw new Error(`${request.type} failed: ${response.error.code} ${response.error.message}`)
		}
		return response.result
	}

	const request = <T extends PremindRequest["type"]>(
		type: T,
		payload: Extract<PremindRequest, { type: T }>["payload"],
	) =>
		send({
			type,
			protocolVersion: PREMIND_PROTOCOL_VERSION,
			payload,
		} as PremindRequest)

	return {
		operations,
		clientId,

		registerClient: async (projectRoot: string, sessionSource?: string) => {
			await request("registerClient", {
				clientId,
				metadata: { pid: process.pid, projectRoot, ...(sessionSource ? { sessionSource } : {}) },
			})
			return { heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 }
		},
		heartbeat: async () => {
			await request("heartbeatClient", { clientId })
		},
		release: async () => {
			await request("releaseClient", { clientId })
		},
		registerSession: async (payload: Omit<RegisterSessionPayload, "clientId">) => {
			await request("registerSession", { ...payload, clientId })
		},
		ensureSessionControl: async (payload: {
			sessionId: string
			repo: string
			branch: string
			isPrimary?: boolean
			busyState?: "busy" | "idle"
			paused: boolean
		}) => {
			await request("ensureSessionControl", {
				clientId,
				sessionId: payload.sessionId,
				repo: payload.repo,
				branch: payload.branch,
				isPrimary: payload.isPrimary ?? true,
				busyState: payload.busyState ?? "idle",
				paused: payload.paused,
			})
		},
		updateSessionState: async (payload: {
			sessionId: string
			status?: "active" | "paused" | "closed"
			busyState?: "busy" | "idle"
			repo?: string
			branch?: string
		}) => {
			await request("updateSessionState", payload)
		},
		unregisterSession: async (sessionId: string) => {
			await request("unregisterSession", { sessionId })
		},
		pauseSession: async (sessionId: string) => {
			await request("updateSessionState", { sessionId, status: "paused" })
		},
		resumeSession: async (sessionId: string) => {
			await request("updateSessionState", { sessionId, status: "active" })
		},
		activateWorktree: async (payload: { sessionId: string; path: string }) => {
			await request("activateWorktree", payload)
		},
		subscribe: async (payload: { sessionId: string; prNumber: number; repo?: string }) => {
			await request("subscribe", payload)
		},
		unsubscribe: async (payload: { sessionId: string; prNumber: number; repo?: string }) => {
			await request("unsubscribe", payload)
		},
		getPendingReminder: async (sessionId: string) => {
			const result = (await request("getPendingReminder", { sessionId })) as {
				batch: ReminderBatch | null
			}
			return result
		},
		ackReminder: async (payload: AckReminderPayload) => {
			operations.push(`ack:${payload.state}`)
			await request("ackReminder", payload)
		},
		debugStatus: async () => (await request("debugStatus", {})) as Record<string, unknown>,
		pruneClosedSessions: async () =>
			(await request("pruneClosedSessions", {})) as {
				sessions: number
				reminderBatches: number
			},
		setGlobalDisabled: async (disabled: boolean) => {
			await request("setGlobalDisabled", { disabled })
		},
		getGlobalDisabled: async () =>
			(await request("getGlobalDisabled", {})) as { disabled: boolean },
	}
}
