import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderPremindStatus } from "../plugin/commands.ts";
import { PremindDaemonClient } from "../plugin/daemon-client.ts";
import { detectGitContext } from "../plugin/git-context.ts";
import type {
	AckReminderPayload,
	DebugStatusResponse,
	RegisterSessionPayload,
	ReminderBatch,
} from "../shared/schema.ts";

type PruneClosedSessionsResult = {
	sessions: number;
	reminderBatches: number;
};

type RegisterClientResult = {
	heartbeatMs?: number;
};

type DaemonClientLike = {
	registerClient: (
		projectRoot: string,
		sessionSource?: string,
	) => Promise<RegisterClientResult>;
	heartbeat: () => Promise<unknown>;
	release: () => Promise<unknown>;
	registerSession: (
		payload: Omit<RegisterSessionPayload, "clientId">,
	) => Promise<unknown>;
	unregisterSession: (sessionId: string) => Promise<unknown>;
	updateSessionState: (payload: {
		sessionId: string;
		busyState: "busy" | "idle";
	}) => Promise<unknown>;
	getPendingReminder: (
		sessionId: string,
	) => Promise<{ batch: ReminderBatch | null }>;
	ackReminder: (payload: AckReminderPayload) => Promise<unknown>;
	debugStatus: () => Promise<DebugStatusResponse>;
	pruneClosedSessions: () => Promise<unknown>;
};

type GitContext = {
	repo: string;
	branch: string;
};

export type PremindPiExtensionDependencies = {
	createDaemonClient?: () => DaemonClientLike;
	detectGit?: (cwd: string) => Promise<GitContext>;
};

const STATUS_ERROR_PREFIX = "premind status failed";
const PRUNE_ERROR_PREFIX = "premind prune failed";
const FLUSH_ERROR_PREFIX = "premind flush failed";
const SESSION_SOURCE = "pi-extension";
const DEFAULT_HEARTBEAT_MS = 10_000;
const REMINDER_VISIBLE_EVENT_LIMIT = 3;

const priorityRank: Record<
	ReminderBatch["events"][number]["priority"],
	number
> = {
	high: 0,
	medium: 1,
	low: 2,
};

const formatPruneResult = (result: PruneClosedSessionsResult) =>
	`premind pruned ${result.sessions} closed session${result.sessions === 1 ? "" : "s"} and ${result.reminderBatches} reminder batch${result.reminderBatches === 1 ? "" : "es"}.`;

export const renderPremindReminderText = (batch: ReminderBatch | undefined) => {
	const events = batch?.events ?? [];
	const count = events.length;
	const title = `🔔 ${count} new PR change${count === 1 ? "" : "s"}`;
	const visibleEvents = [...events]
		.sort(
			(left, right) =>
				priorityRank[left.priority] - priorityRank[right.priority],
		)
		.slice(0, REMINDER_VISIBLE_EVENT_LIMIT);
	const bullets = visibleEvents.map(
		(event) => `- ${event.summary.replace(/\s+/g, " ").trim()}`,
	);
	const remaining = count - visibleEvents.length;
	if (remaining > 0)
		bullets.push(
			`- ${remaining} more change${remaining === 1 ? "" : "s"} queued`,
		);
	return [title, ...(bullets.length > 0 ? ["", ...bullets] : [])].join("\n");
};

const getPiSessionId = (ctx: {
	cwd: string;
	sessionManager?: { getSessionFile?: () => string | undefined };
}) => ctx.sessionManager?.getSessionFile?.() ?? `pi:${ctx.cwd}`;

export const createPremindPiExtension = (
	dependencies: PremindPiExtensionDependencies = {},
) => {
	return function premindPiExtension(pi: ExtensionAPI): void {
		const createDaemonClient =
			dependencies.createDaemonClient ?? (() => new PremindDaemonClient());
		const detectGit = dependencies.detectGit ?? detectGitContext;

		let sessionClient: DaemonClientLike | undefined;
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let currentSessionId: string | undefined;

		const clearHeartbeat = () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		};

		const getClient = () => sessionClient ?? createDaemonClient();

		const getStatusText = async () => {
			const status = await createDaemonClient().debugStatus();
			return renderPremindStatus(status);
		};

		const pruneClosedSessions = async () => {
			const result = await createDaemonClient().pruneClosedSessions();
			return result as PruneClosedSessionsResult;
		};

		const setStatus = (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			value?: string,
		) => {
			if (!ctx.hasUI) return;
			ctx.ui?.setStatus?.("premind", value);
		};

		const deliverPendingReminder = async (sessionId: string) => {
			const client = getClient();
			const { batch } = await client.getPendingReminder(sessionId);
			if (!batch) return { delivered: false as const };

			await client.ackReminder({
				batchId: batch.batchId,
				sessionId,
				state: "handed_off",
			});

			try {
				pi.sendMessage(
					{
						customType: "premind-reminder",
						content: batch.reminderText,
						display: true,
						details: batch,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				await client.ackReminder({
					batchId: batch.batchId,
					sessionId,
					state: "confirmed",
				});
				return { delivered: true as const, batch };
			} catch (error) {
				await client.ackReminder({
					batchId: batch.batchId,
					sessionId,
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		};

		const markBusyState = async (busyState: "busy" | "idle") => {
			if (!currentSessionId || !sessionClient) return;
			await sessionClient.updateSessionState({
				sessionId: currentSessionId,
				busyState,
			});
		};

		pi.registerMessageRenderer<ReminderBatch>(
			"premind-reminder",
			(message) => new Text(renderPremindReminderText(message.details), 0, 0),
		);

		pi.on("session_start", async (_event, ctx) => {
			clearHeartbeat();
			const client = createDaemonClient();
			sessionClient = client;
			currentSessionId = getPiSessionId(ctx);

			try {
				const lease = await client.registerClient(ctx.cwd, SESSION_SOURCE);
				const heartbeatMs = lease.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
				heartbeatTimer = setInterval(() => {
					void client.heartbeat().catch(() => {});
				}, heartbeatMs);
				heartbeatTimer.unref?.();

				const git = await detectGit(ctx.cwd);
				await client.registerSession({
					sessionId: currentSessionId,
					repo: git.repo,
					branch: git.branch,
					isPrimary: true,
					status: "active",
					busyState: "idle",
				});
				setStatus(ctx, `premind ${git.repo} @ ${git.branch}`);
			} catch (error) {
				setStatus(ctx, "premind error");
				if (ctx.hasUI) {
					ctx.ui.notify(
						`premind session registration failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		});

		pi.on("agent_start", async () => {
			try {
				await markBusyState("busy");
			} catch {
				// Busy-state updates are advisory; status/debug commands can surface daemon health.
			}
		});

		pi.on("agent_end", async (_event, ctx) => {
			try {
				await markBusyState("idle");
				if (currentSessionId) {
					const result = await deliverPendingReminder(currentSessionId);
					if (result.delivered) setStatus(ctx, "premind reminder delivered");
				}
			} catch (error) {
				setStatus(ctx, "premind error");
				if (ctx.hasUI) {
					ctx.ui.notify(
						`premind automatic delivery failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			clearHeartbeat();
			const client = sessionClient;
			const sessionId = currentSessionId;
			sessionClient = undefined;
			currentSessionId = undefined;
			setStatus(ctx, undefined);

			if (!client) return;
			try {
				if (sessionId) await client.unregisterSession(sessionId);
				await client.release();
			} catch {
				// Shutdown must be best-effort; stale sessions can be cleaned by /premind:prune.
			}
		});

		pi.registerCommand("premind:status", {
			description:
				"Show premind daemon status, attached sessions, and pending reminders",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(await getStatusText(), "info");
				} catch (error) {
					ctx.ui.notify(
						`${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("premind:prune", {
			description:
				"Remove closed premind sessions and their pending reminder batches from daemon state",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(formatPruneResult(await pruneClosedSessions()), "info");
				} catch (error) {
					ctx.ui.notify(
						`${PRUNE_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("premind:flush", {
			description:
				"Deliver one pending premind reminder for the current session, if any",
			handler: async (_args, ctx) => {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				try {
					const result = await deliverPendingReminder(sessionId);
					ctx.ui.notify(
						result.delivered
							? `premind delivered reminder batch ${result.batch.batchId}.`
							: "premind has no pending reminders for this session.",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`${FLUSH_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerTool({
			name: "premind_status",
			label: "Premind Status",
			description:
				"Show premind daemon status including active sessions, watchers, and pending reminder counts.",
			promptSnippet: "Inspect premind PR reminder daemon status.",
			promptGuidelines: [
				"Use premind_status when the user asks about premind daemon state, PR reminder attachment, pending reminders, or watcher status.",
			],
			parameters: Type.Object({}),
			async execute() {
				try {
					return {
						content: [{ type: "text" as const, text: await getStatusText() }],
						details: {},
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${STATUS_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: {},
					};
				}
			},
		});
	};
};

export default createPremindPiExtension();
