import { resolve } from "node:path"
import { renderPremindStatus } from "../plugin-opencode/commands.ts"
import { daemonLockStatus, describeDaemonBuild, formatDaemonLockStatus, readPackagedBuild } from "../shared/daemon-startup.ts"
import type { SubscribePayload, UnsubscribePayload } from "../shared/schema.ts"
import { SESSION_PAUSED_DELIVERY_MESSAGE, SESSION_PAUSED_MESSAGE, SESSION_RESUMED_MESSAGE } from "../shared/session-pause.ts"
import { getCurrentStatusLines, renderCurrentStatus } from "../shared/status-view.ts"
import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import type { trackSessions } from "./sessions.ts"

export function premindActions(sessions: ReturnType<typeof trackSessions>, directory: string) {
	const { daemon, connect, withSession, deliverNow } = sessions
	return {
		status: (sessionID: string) => withSession(sessionID, async () =>
			renderCurrentStatus(await daemon.debugStatus({ includeSnapshots: true }), sessionID)),
		async debugStatus(sessionID: string) {
			await connect()
			return renderPremindStatus(await daemon.debugStatus(), Date.now(), PREMIND_VERSION_LABEL, sessionID)
		},
		async doctor() {
			return [
				`premind doctor ${PREMIND_VERSION_LABEL}`,
				"- host: opencode v2",
				`- pid: ${process.pid}`,
				`- location: ${directory}`,
				`- daemon lock: ${formatDaemonLockStatus(daemonLockStatus())}`,
				`- ${await describeDaemonBuild({ host: "opencode", build: readPackagedBuild() })}`,
			].join("\n")
		},
		setActiveCheckout: (sessionID: string, path: string) => withSession(sessionID, async () => {
			await daemon.activateWorktree({ sessionId: sessionID, path: resolve(directory, path) })
			return `premind set active checkout ${path}.`
		}),
		subscribe: (sessionID: string, input: Omit<SubscribePayload, "sessionId">) => withSession(sessionID, async () => {
			const { subscription } = await daemon.subscribe({ ...input, sessionId: sessionID })
			return `premind subscribed to ${subscription.repo}#${subscription.prNumber} with write policy ${subscription.writePolicy ?? "observe-only"}.`
		}),
		unsubscribe: (sessionID: string, input: Omit<UnsubscribePayload, "sessionId">) => withSession(sessionID, async () => {
			await daemon.unsubscribe({ ...input, sessionId: sessionID })
			return `premind unsubscribed from ${input.repo ?? "active worktree"}#${input.prNumber}.`
		}),
		setPaused: (sessionID: string, paused: boolean) => withSession(sessionID, async () => {
			if (paused) {
				await daemon.pauseSession(sessionID)
				return SESSION_PAUSED_MESSAGE
			}
			await daemon.resumeSession(sessionID)
			return SESSION_RESUMED_MESSAGE
		}),
		deliver: (sessionID: string) => withSession(sessionID, async () => {
			if ((await deliverNow(sessionID)).delivered) return "premind: queued PR updates for delivery"
			const status = await daemon.debugStatus()
			return status.sessions.some((session) => session.sessionId === sessionID && session.status === "paused")
				? SESSION_PAUSED_DELIVERY_MESSAGE
				: "premind: no pending PR updates to deliver"
		}),
		async prune() {
			await connect()
			const result = await daemon.pruneClosedSessions() as { sessions: number; reminderBatches: number }
			return `premind pruned ${result.sessions} closed session${result.sessions === 1 ? "" : "s"} and ${result.reminderBatches} reminder batch${result.reminderBatches === 1 ? "" : "es"}.`
		},
		statusLines: (sessionID: string) => withSession(sessionID, async () =>
			getCurrentStatusLines(await daemon.debugStatus({ includeSnapshots: true }), sessionID)),
		async setDisabled(disabled: boolean) {
			await connect()
			await daemon.setGlobalDisabled(disabled)
			return disabled
				? "premind disabled globally. GitHub polling is stopped across all sessions and projects."
				: "premind re-enabled globally. GitHub polling will resume on the next scheduler tick across all sessions and projects."
		},
	}
}
