import { PREMIND_VERSION_LABEL } from "../shared/version.ts"
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PremindDaemonClient } from "../plugin/daemon-client.ts";
import { detectGitContext } from "../plugin/git-context.ts";
import type {
	AckReminderPayload,
	ActivateWorktreePayload,
	DebugStatusResponse,
	EnsureSessionControlPayload,
	RegisterSessionPayload,
	ReminderBatch,
	SubscribePayload,
	UnsubscribePayload,
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
	ensureSessionControl: (
		payload: Omit<EnsureSessionControlPayload, "clientId">,
	) => Promise<unknown>;
	pauseSession: (sessionId: string) => Promise<unknown>;
	resumeSession: (sessionId: string) => Promise<unknown>;
	activateWorktree: (payload: ActivateWorktreePayload) => Promise<unknown>;
	subscribe: (payload: SubscribePayload) => Promise<unknown>;
	unsubscribe: (payload: UnsubscribePayload) => Promise<unknown>;
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
const WORKTREE_ERROR_PREFIX = "premind worktree activation failed";
const SUBSCRIPTION_ERROR_PREFIX = "premind subscription update failed";
const SESSION_SOURCE = "pi-extension";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 15_000;
const MIN_STATUS_POLL_INTERVAL_MS = 5_000;
const REMINDER_VISIBLE_EVENT_LIMIT = 3;
const PR_ICON = ""; // nf-oct-git_pull_request
const STALE_EXTENSION_CONTEXT_PREFIX = "This extension ctx is stale";

const isStaleExtensionContextError = (error: unknown): boolean =>
	error instanceof Error &&
	error.message.startsWith(STALE_EXTENSION_CONTEXT_PREFIX);

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

export const renderPremindPiStatus = (
	status: DebugStatusResponse,
	versionLabel = PREMIND_VERSION_LABEL,
) => {
	const activeLabel = `${status.activeSessions} active session${status.activeSessions === 1 ? "" : "s"}`;
	const header = `premind: ${versionLabel} · ${activeLabel}`;
	const sessions = status.sessions.map((session) => {
		const pr = session.prNumber ? ` (PR #${session.prNumber})` : "";
		const worktree = session.worktreeBinding
			? ` | worktree ${session.worktreeBinding.repo} @ ${session.worktreeBinding.branch ?? "detached"} (${session.worktreeBinding.state})`
			: "";
		const subscriptions = (session.subscriptions ?? [])
			.map(
				(subscription) =>
					`${subscription.repo}#${subscription.prNumber} (${subscription.source}/${subscription.state}, pending ${subscription.pendingEventCount})`,
			)
			.join(", ");
		const subscriptionSummary = subscriptions
			? ` | subscriptions ${subscriptions}`
			: "";
		return `- ${session.repo} @ ${session.branch}${pr} | ${session.status}/${session.busyState} | pending ${session.pendingReminderCount}${worktree}${subscriptionSummary} | session ${formatSessionId(session.sessionId)}`;
	});
	return [
		header,
		`clients ${status.activeClients} · watchers ${status.activeWatchers}`,
		...sessions,
	].join("\n");
};

type ReminderTheme = Pick<Theme, "fg">;
type ThemeColor = Parameters<Theme["fg"]>[0];

const themed = (
	theme: ReminderTheme | undefined,
	color: ThemeColor,
	text: string,
) => (theme ? theme.fg(color, text) : text);

export const renderPremindReminderText = (
	batch: ReminderBatch | undefined,
	theme?: ReminderTheme,
) => {
	const events = batch?.events ?? [];
	const count = events.length;
	const title = `${themed(theme, "warning", "[premind]")} ${themed(
		theme,
		"accent",
		`${count} PR update${count === 1 ? "" : "s"}`,
	)}`;
	const visibleEvents = [...events]
		.sort(
			(left, right) =>
				priorityRank[left.priority] - priorityRank[right.priority],
		)
		.slice(0, REMINDER_VISIBLE_EVENT_LIMIT);
	const bullets = visibleEvents.map((event) =>
		themed(theme, "dim", `- ${event.summary.replace(/\s+/g, " ").trim()}`),
	);
	const remaining = count - visibleEvents.length;
	if (remaining > 0)
		bullets.push(
			themed(
				theme,
				"dim",
				`- ${remaining} more update${remaining === 1 ? "" : "s"} queued`,
			),
		);
	return [title, ...bullets].join("\n");
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

const parseSubscriptionArguments = (args: string) => {
	const [prNumberArg, repo, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	const prNumber = Number(prNumberArg);
	if (
		!prNumberArg ||
		extra.length > 0 ||
		!Number.isSafeInteger(prNumber) ||
		prNumber < 1
	) {
		throw new Error("expected: <pr-number> [owner/repo]");
	}
	return { prNumber, ...(repo ? { repo } : {}) };
};

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
		let sessionGeneration = 0;
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


		const setStatus = (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			value?: string,
		) => {
			try {
				if (!ctx.hasUI) return;
				ctx.ui?.setStatus?.(
					"premind",
					config.showStatusbar ? value : undefined,
				);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
			}
		};

		const notify = (
			ctx: {
				hasUI?: boolean;
				ui?: {
					notify?: (
						message: string,
						level: "info" | "warning" | "error",
					) => void;
				};
			},
			message: string,
			level: "info" | "warning" | "error",
		) => {
			try {
				if (ctx.hasUI === false) return;
				ctx.ui?.notify?.(message, level);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
			}
		};

		const refreshStatusbar = async (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			generation?: number,
		) => {
			if (generation !== undefined && generation !== sessionGeneration) return;
			if (!config.enabled) {
				setStatus(ctx, `${PR_ICON} disabled`);
				return;
			}
			if (!currentSessionId) return;
			const status = await getClient().debugStatus();
			if (generation !== undefined && generation !== sessionGeneration) return;
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
			generation?: number,
		) => {
			if (
				!config.enabled ||
				(!options.force && !config.autoDeliver) ||
				deliveryInFlight ||
				(generation !== undefined && generation !== sessionGeneration)
			)
				return { delivered: false as const };
			deliveryInFlight = true;
			const client = getClient();
			let batch: ReminderBatch | null = null;
			let handedOff = false;
			try {
				const pending = await client.getPendingReminder(sessionId);
				if (generation !== undefined && generation !== sessionGeneration)
					return { delivered: false as const };
				batch = pending.batch;
				if (!batch) return { delivered: false as const };

				await client.ackReminder({
					batchId: batch.batchId,
					sessionId,
					state: "handed_off",
				});
				handedOff = true;

				if (generation !== undefined && generation !== sessionGeneration) {
					await client.ackReminder({
						batchId: batch.batchId,
						sessionId,
						state: "failed",
						error: "Pi session ended before reminder delivery",
					});
					handedOff = false;
					return { delivered: false as const };
				}

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
				handedOff = false;
				return { delivered: true as const, batch };
			} catch (error) {
				if (batch && handedOff) {
					try {
						await client.ackReminder({
							batchId: batch.batchId,
							sessionId,
							state: "failed",
							error: error instanceof Error ? error.message : String(error),
						});
					} catch {
						// Preserve the original delivery failure.
					}
				}
				throw error;
			} finally {
				deliveryInFlight = false;
			}
		};

		const markBusyState = async (busyState: "busy" | "idle") => {
			if (!currentSessionId || !sessionClient) return;
			await sessionClient.updateSessionState({
				sessionId: currentSessionId,
				busyState,
			});
		};

		const pollStatus = async (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			generation: number,
		) => {
			if (generation !== sessionGeneration || statusPollInFlight) return;
			statusPollInFlight = true;
			try {
				await refreshStatusbar(ctx, generation);
				if (generation !== sessionGeneration) return;
				if (currentSessionId) {
					const result = await deliverPendingReminder(
						currentSessionId,
						{},
						generation,
					);
					if (generation !== sessionGeneration) return;
					if (result.delivered) setStatus(ctx, undefined);
				}
			} catch (error) {
				if (
					generation === sessionGeneration &&
					!isStaleExtensionContextError(error)
				)
					setStatus(ctx, `${PR_ICON} error`);
			} finally {
				statusPollInFlight = false;
			}
		};

		const startStatusPoll = (
			ctx: {
				hasUI?: boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			generation: number,
		) => {
			clearStatusPoll();
			if (!config.enabled || config.statusPollIntervalMs <= 0) return;
			statusPollTimer = setInterval(() => {
				void pollStatus(ctx, generation);
			}, config.statusPollIntervalMs);
			statusPollTimer.unref?.();
		};

		pi.registerMessageRenderer<ReminderBatch>(
			"premind-reminder",
			(message, _options, theme) =>
				new Text(renderPremindReminderText(message.details, theme), 0, 0),
		);

		pi.on("session_start", async (_event, ctx) => {
			const generation = ++sessionGeneration;
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
				await client.activateWorktree({
					sessionId: currentSessionId,
					path: ctx.cwd,
				});
				await refreshStatusbar(ctx, generation);
				if (generation !== sessionGeneration) return;
				startStatusPoll(ctx, generation);
			} catch (error) {
				if (generation !== sessionGeneration) return;
				setStatus(ctx, `${PR_ICON} error`);
				notify(
					ctx,
					`premind session registration failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
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
				notify(
					ctx,
					`premind automatic delivery failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			sessionGeneration++;
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

		pi.registerCommand("premind:activate-worktree", {
			description: "Activate a Git worktree for the current premind session",
			handler: async (args, ctx) => {
				const path = args.trim();
				if (!path) {
					ctx.ui.notify(`${WORKTREE_ERROR_PREFIX}: expected: <path>`, "error");
					return;
				}
				try {
					await getClient().activateWorktree({
						sessionId: currentSessionId ?? getPiSessionId(ctx),
						path,
					});
					ctx.ui.notify(`premind activated worktree ${path}.`, "info");
				} catch (error) {
					ctx.ui.notify(
						`${WORKTREE_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("premind:subscribe", {
			description: "Subscribe to a pull request: <pr-number> [owner/repo]",
			handler: async (args, ctx) => {
				try {
					const subscription = parseSubscriptionArguments(args);
					await getClient().subscribe({
						sessionId: currentSessionId ?? getPiSessionId(ctx),
						...subscription,
					});
					ctx.ui.notify(
						`premind subscribed to ${(subscription.repo ?? "active worktree")}#${subscription.prNumber}.`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`${SUBSCRIPTION_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("premind:unsubscribe", {
			description: "Unsubscribe from a pull request: <pr-number> [owner/repo]",
			handler: async (args, ctx) => {
				try {
					const subscription = parseSubscriptionArguments(args);
					await getClient().unsubscribe({
						sessionId: currentSessionId ?? getPiSessionId(ctx),
						...subscription,
					});
					ctx.ui.notify(
						`premind unsubscribed from ${(subscription.repo ?? "active worktree")}#${subscription.prNumber}.`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`${SUBSCRIPTION_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
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
			name: "premind_activate_worktree",
			label: "Premind Activate Worktree",
			description: "Activate a Git worktree for the current premind session.",
			promptSnippet: "Tell premind which Git worktree this session is actively using.",
			promptGuidelines: [
				"Call premind_activate_worktree whenever you begin working in a different linked or nested Git worktree than the session's startup directory, including before that branch has a pull request.",
			],
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				await getClient().activateWorktree({ sessionId, path: params.path });
				return {
					content: [{ type: "text" as const, text: `premind activated worktree ${params.path}.` }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_subscribe",
			label: "Premind Subscribe",
			description: "Subscribe the current session to a pull request.",
			parameters: Type.Object({
				prNumber: Type.Integer({ minimum: 1 }),
				repo: Type.Optional(Type.String({ minLength: 1 })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				await getClient().subscribe({ sessionId, ...params });
				const target = `${params.repo ?? "active worktree"}#${params.prNumber}`;
				return {
					content: [{ type: "text" as const, text: `premind subscribed to ${target}.` }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_unsubscribe",
			label: "Premind Unsubscribe",
			description: "Unsubscribe the current session from a pull request.",
			parameters: Type.Object({
				prNumber: Type.Integer({ minimum: 1 }),
				repo: Type.Optional(Type.String({ minLength: 1 })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				await getClient().unsubscribe({ sessionId, ...params });
				const target = `${params.repo ?? "active worktree"}#${params.prNumber}`;
				return {
					content: [{ type: "text" as const, text: `premind unsubscribed from ${target}.` }],
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
