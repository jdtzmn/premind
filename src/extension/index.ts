import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
	pauseSession: (sessionId: string) => Promise<unknown>;
	resumeSession: (sessionId: string) => Promise<unknown>;
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

export type PremindPiConfig = {
	enabled: boolean;
	autoDeliver: boolean;
	statusPollIntervalMs: number;
	showStatusbar: boolean;
};

export type PremindPiExtensionDependencies = {
	createDaemonClient?: () => DaemonClientLike;
	detectGit?: (cwd: string) => Promise<GitContext>;
	config?: Partial<PremindPiConfig>;
};

const STATUS_ERROR_PREFIX = "premind status failed";
const PRUNE_ERROR_PREFIX = "premind prune failed";
const FLUSH_ERROR_PREFIX = "premind flush failed";
const PAUSE_ERROR_PREFIX = "premind pause failed";
const RESUME_ERROR_PREFIX = "premind resume failed";
const SESSION_SOURCE = "pi-extension";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 15_000;
const MIN_STATUS_POLL_INTERVAL_MS = 5_000;
const REMINDER_VISIBLE_EVENT_LIMIT = 3;
const PR_ICON = ""; // nf-oct-git_pull_request

const priorityRank: Record<
	ReminderBatch["events"][number]["priority"],
	number
> = {
	high: 0,
	medium: 1,
	low: 2,
};

const DEFAULT_CONFIG: PremindPiConfig = {
	enabled: true,
	autoDeliver: true,
	statusPollIntervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
	showStatusbar: true,
};

export const normalizePremindPiConfig = (
	config: Partial<PremindPiConfig> = {},
): PremindPiConfig => ({
	enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
	autoDeliver: config.autoDeliver ?? DEFAULT_CONFIG.autoDeliver,
	statusPollIntervalMs:
		config.statusPollIntervalMs === 0
			? 0
			: Math.max(
					MIN_STATUS_POLL_INTERVAL_MS,
					config.statusPollIntervalMs ?? DEFAULT_CONFIG.statusPollIntervalMs,
				),
	showStatusbar: config.showStatusbar ?? DEFAULT_CONFIG.showStatusbar,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const parseConfigFile = (value: unknown): Partial<PremindPiConfig> => {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
		...(typeof value.autoDeliver === "boolean"
			? { autoDeliver: value.autoDeliver }
			: {}),
		...(typeof value.statusPollIntervalMs === "number" &&
		Number.isFinite(value.statusPollIntervalMs)
			? { statusPollIntervalMs: value.statusPollIntervalMs }
			: {}),
		...(typeof value.showStatusbar === "boolean"
			? { showStatusbar: value.showStatusbar }
			: {}),
	};
};

const loadProjectConfig = async (ctx: {
	cwd: string;
	isProjectTrusted?: () => boolean | Promise<boolean>;
}) => {
	if (!(await Promise.resolve(ctx.isProjectTrusted?.() ?? false))) return {};
	try {
		return parseConfigFile(
			JSON.parse(
				await readFile(join(ctx.cwd, CONFIG_DIR_NAME, "premind.json"), "utf8"),
			),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return {};
		throw error;
	}
};

const formatPruneResult = (result: PruneClosedSessionsResult) =>
	`premind pruned ${result.sessions} closed session${result.sessions === 1 ? "" : "s"} and ${result.reminderBatches} reminder batch${result.reminderBatches === 1 ? "" : "es"}.`;

const formatSessionId = (sessionId: string) => {
	const normalized = sessionId.replace(/\.jsonl$/, "");
	const leaf = normalized.split(/[\\/]/).pop() ?? normalized;
	if (leaf.length <= 18) return leaf;
	return `…${leaf.slice(-12)}`;
};

export const renderPremindPiStatus = (status: DebugStatusResponse) => {
	const activeLabel = `${status.activeSessions} active session${status.activeSessions === 1 ? "" : "s"}`;
	const header = `premind: ${activeLabel}`;
	const sessions = status.sessions.map((session) => {
		const pr = session.prNumber ? ` (PR #${session.prNumber})` : "";
		return `- ${session.repo} @ ${session.branch}${pr} | ${session.status}/${session.busyState} | pending ${session.pendingReminderCount} | session ${formatSessionId(session.sessionId)}`;
	});
	return [
		header,
		`clients ${status.activeClients} · watchers ${status.activeWatchers}`,
		...sessions,
	].join("\n");
};

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

const formatStatusbar = (
	session: DebugStatusResponse["sessions"][number] | undefined,
) => {
	if (!session) return undefined;
	if (session.status === "paused") return `${PR_ICON} paused`;
	if (session.pendingReminderCount > 0)
		return `${PR_ICON} ${session.pendingReminderCount} pending`;
	return undefined;
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
		let statusPollTimer: NodeJS.Timeout | undefined;
		let statusPollInFlight = false;
		let deliveryInFlight = false;
		let config = normalizePremindPiConfig(dependencies.config);
		let currentSessionId: string | undefined;

		const clearHeartbeat = () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		};

		const clearStatusPoll = () => {
			if (statusPollTimer) clearInterval(statusPollTimer);
			statusPollTimer = undefined;
		};

		const getClient = () => sessionClient ?? createDaemonClient();

		const getStatusText = async () => {
			const status = await createDaemonClient().debugStatus();
			return renderPremindPiStatus(status);
		};

		const pruneClosedSessions = async () => {
			const result = await createDaemonClient().pruneClosedSessions();
			return result as PruneClosedSessionsResult;
		};

		const pauseCurrentSession = async (sessionId: string) => {
			await getClient().pauseSession(sessionId);
		};

		const resumeCurrentSession = async (sessionId: string) => {
			await getClient().resumeSession(sessionId);
		};

		const setStatus = (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			value?: string,
		) => {
			if (!ctx.hasUI) return;
			ctx.ui?.setStatus?.("premind", config.showStatusbar ? value : undefined);
		};

		const refreshStatusbar = async (ctx: {
			hasUI?: boolean;
			ui?: { setStatus?: (key: string, value?: string) => void };
		}) => {
			if (!config.enabled) {
				setStatus(ctx, `${PR_ICON} disabled`);
				return;
			}
			if (!currentSessionId) return;
			const status = await getClient().debugStatus();
			setStatus(
				ctx,
				formatStatusbar(
					status.sessions.find(
						(session) => session.sessionId === currentSessionId,
					),
				),
			);
		};

		const deliverPendingReminder = async (
			sessionId: string,
			options: { force?: boolean } = {},
		) => {
			if (
				!config.enabled ||
				(!options.force && !config.autoDeliver) ||
				deliveryInFlight
			)
				return { delivered: false as const };
			deliveryInFlight = true;
			const client = getClient();
			const { batch } = await client.getPendingReminder(sessionId);
			if (!batch) {
				deliveryInFlight = false;
				return { delivered: false as const };
			}

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
				deliveryInFlight = false;
				return { delivered: true as const, batch };
			} catch (error) {
				await client.ackReminder({
					batchId: batch.batchId,
					sessionId,
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
				deliveryInFlight = false;
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

		const pollStatus = async (ctx: {
			hasUI?: boolean;
			ui?: { setStatus?: (key: string, value?: string) => void };
		}) => {
			if (statusPollInFlight) return;
			statusPollInFlight = true;
			try {
				await refreshStatusbar(ctx);
				if (currentSessionId) {
					const result = await deliverPendingReminder(currentSessionId);
					if (result.delivered) setStatus(ctx, undefined);
				}
			} catch {
				setStatus(ctx, `${PR_ICON} error`);
			} finally {
				statusPollInFlight = false;
			}
		};

		const startStatusPoll = (ctx: {
			hasUI?: boolean;
			ui?: { setStatus?: (key: string, value?: string) => void };
		}) => {
			clearStatusPoll();
			if (!config.enabled || config.statusPollIntervalMs <= 0) return;
			statusPollTimer = setInterval(() => {
				void pollStatus(ctx);
			}, config.statusPollIntervalMs);
			statusPollTimer.unref?.();
		};

		pi.registerMessageRenderer<ReminderBatch>(
			"premind-reminder",
			(message) => new Text(renderPremindReminderText(message.details), 0, 0),
		);

		pi.on("session_start", async (_event, ctx) => {
			clearHeartbeat();
			clearStatusPoll();
			config = normalizePremindPiConfig({
				...dependencies.config,
				...(await loadProjectConfig(ctx)),
			});
			if (!config.enabled) {
				setStatus(ctx, `${PR_ICON} disabled`);
				return;
			}
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
				await refreshStatusbar(ctx);
				startStatusPoll(ctx);
			} catch (error) {
				setStatus(ctx, `${PR_ICON} error`);
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
					if (result.delivered) setStatus(ctx, undefined);
					else await refreshStatusbar(ctx);
				}
			} catch (error) {
				setStatus(ctx, `${PR_ICON} error`);
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
			clearStatusPoll();
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

		pi.registerCommand("premind:pause", {
			description: "Pause premind reminders for the current session",
			handler: async (_args, ctx) => {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				try {
					await pauseCurrentSession(sessionId);
					setStatus(ctx, `${PR_ICON} paused`);
					ctx.ui.notify("premind paused for this session.", "info");
				} catch (error) {
					ctx.ui.notify(
						`${PAUSE_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("premind:resume", {
			description: "Resume premind reminders for the current session",
			handler: async (_args, ctx) => {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				try {
					await resumeCurrentSession(sessionId);
					await refreshStatusbar(ctx);
					ctx.ui.notify("premind resumed for this session.", "info");
				} catch (error) {
					ctx.ui.notify(
						`${RESUME_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
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
					const result = await deliverPendingReminder(sessionId, {
						force: true,
					});
					if (result.delivered) setStatus(ctx, undefined);
					else await refreshStatusbar(ctx);
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
			name: "premind_pause",
			label: "Premind Pause",
			description:
				"Pause premind PR reminders for the current session. Events still accumulate while paused.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				await pauseCurrentSession(sessionId);
				return {
					content: [
						{ type: "text" as const, text: "premind paused for this session." },
					],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_resume",
			label: "Premind Resume",
			description: "Resume premind PR reminders for the current session.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				await resumeCurrentSession(sessionId);
				return {
					content: [
						{
							type: "text" as const,
							text: "premind resumed for this session.",
						},
					],
					details: {},
				};
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
