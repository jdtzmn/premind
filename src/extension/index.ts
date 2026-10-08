import { PREMIND_VERSION_LABEL } from "../shared/version.ts";
import { commandCapabilities } from "../shared/command-capabilities.ts";
import {
	GLOBAL_CONFIRMATION_DESCRIPTION,
	globalControlRefusal,
	globalControlResult,
} from "../shared/global-control.ts";
import {
	SESSION_PAUSED_DELIVERY_MESSAGE,
	SESSION_PAUSED_MESSAGE,
	SESSION_RESUMED_MESSAGE,
} from "../shared/session-pause.ts";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PremindDaemonClient } from "../client/daemon-client.ts";
import { detectGitContext } from "../client/git-context.ts";
import { ensureDaemonRunning } from "../plugin-opencode/daemon-launcher.ts";
import {
	daemonLockStatus,
	formatDaemonLockStatus,
} from "../shared/daemon-startup.ts";
import type {
	AckReminderPayload,
	AckReminderBundlePayload,
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
	releaseSessionOwner: (sessionId: string) => Promise<unknown>;
	ensureSessionControl: (
		payload: Omit<EnsureSessionControlPayload, "clientId">,
	) => Promise<unknown>;
	pauseSession: (sessionId: string) => Promise<unknown>;
	resumeSession: (sessionId: string) => Promise<unknown>;
	activateWorktree: (payload: ActivateWorktreePayload) => Promise<unknown>;
	subscribe: (payload: SubscribePayload) => Promise<{
        subscription: { writePolicy?: "owned-active" | "user-authorized" | "observe-only" };
    }>;
	unsubscribe: (payload: UnsubscribePayload) => Promise<unknown>;
	setGlobalDisabled: (disabled: boolean) => Promise<{ disabled: boolean }>;
	updateSessionState: (payload: {
		sessionId: string;
		busyState: "busy" | "idle";
	}) => Promise<unknown>;
	claimReminderBundle: (
		sessionId: string,
	) => Promise<{
		bundle: { handoffId: string; batches: ReminderBatch[] } | null;
	}>;
	ackReminderBundle: (
		payload: AckReminderBundlePayload,
	) => Promise<{ acknowledged: number }>;
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
const DELIVER_ERROR_PREFIX = "premind deliver failed";
const CHECKOUT_ERROR_PREFIX = "premind active checkout update failed";
const SUBSCRIPTION_ERROR_PREFIX = "premind subscription update failed";
const SESSION_CONTROL_ERROR_PREFIX = "premind session control failed";
const SESSION_SOURCE = "pi-extension";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 15_000;
const MIN_STATUS_POLL_INTERVAL_MS = 5_000;
// A status poll still running after this long is treated as abandoned so one
// stuck daemon request cannot end idle delivery for the rest of the session.
// Daemon requests time out well before this, so it only trips on a true hang.
export const STATUS_POLL_STALE_MS = 2 * 60_000;
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
					`${subscription.repo}#${subscription.prNumber} (${subscription.source}/${subscription.writePolicy}/${subscription.state}, pending ${subscription.pendingEventCount})`,
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
			(left, right) => priorityRank[left.priority] - priorityRank[right.priority],
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
			dependencies.createDaemonClient ??
			(() => new PremindDaemonClient({ ensureDaemon: ensureDaemonRunning }));
		const detectGit = dependencies.detectGit ?? detectGitContext;

		let sessionClient: DaemonClientLike | undefined;
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let statusPollTimer: NodeJS.Timeout | undefined;
		// Start time of the running status poll, or undefined when none is running.
		let statusPollStartedAt: number | undefined;
		let statusPollToken = 0;
		let lastStatusPollCompletedAt: number | undefined;
		let lastStatusPollError: string | undefined;

		const describeStatusPoll = (now: number) => {
			if (
				statusPollStartedAt !== undefined &&
				now - statusPollStartedAt >= STATUS_POLL_STALE_MS
			)
				return `stuck for ${Math.round((now - statusPollStartedAt) / 1000)}s; the next poll replaces it`;
			if (lastStatusPollCompletedAt === undefined) return "no poll has completed yet";
			const age = `last completed ${Math.round((now - lastStatusPollCompletedAt) / 1000)}s ago`;
			return lastStatusPollError ? `${age} with an error: ${lastStatusPollError}` : age;
		};
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

		const attachPiSession = async (ctx: {
			cwd: string;
			sessionManager?: { getSessionFile?: () => string | undefined };
		}) => {
			const client = sessionClient ?? createDaemonClient();
			const sessionId = currentSessionId ?? getPiSessionId(ctx);
			const lease = await client.registerClient(ctx.cwd, SESSION_SOURCE);
			const git = await detectGit(ctx.cwd);
			await client.registerSession({
				sessionId,
				host: "pi",
				repo: git.repo,
				branch: git.branch,
				isPrimary: true,
				status: "active",
				busyState: "idle",
			});
			sessionClient = client;
			currentSessionId = sessionId;
			clearHeartbeat();
			const heartbeatMs = lease.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
			heartbeatTimer = setInterval(() => {
				void client.heartbeat().catch(() => {});
			}, heartbeatMs);
			heartbeatTimer.unref?.();
			return { client, sessionId };
		};
		const ensurePiSessionAttached = async (ctx: {
			cwd: string;
			sessionManager?: { getSessionFile?: () => string | undefined };
		}) => {
			if (sessionClient && currentSessionId) {
				return { client: sessionClient, sessionId: currentSessionId };
			}
			return attachPiSession(ctx);
		};

		const getStatusText = async () => {
			const status = await createDaemonClient().debugStatus();
			return renderPremindPiStatus(status);
		};

		const getDoctorText = async () => {
			const lines = [
				`premind doctor ${PREMIND_VERSION_LABEL}`,
				"- host: pi",
				`- extension: ${config.enabled ? "enabled" : "disabled"}`,
				`- automatic delivery: ${config.autoDeliver ? "enabled" : "disabled"}`,
				`- status polling: ${config.statusPollIntervalMs === 0 ? "disabled" : `${config.statusPollIntervalMs}ms`}`,
				`- session: ${currentSessionId ? `attached (${formatSessionId(currentSessionId)})` : "not attached"}`,
				"- delivery: follow-up messages can wake an idle Pi session",
				...(config.statusPollIntervalMs > 0
					? [`- idle delivery poll: ${describeStatusPoll(Date.now())}`]
					: []),
				`- daemon lock: ${formatDaemonLockStatus(daemonLockStatus())}`,
			];
			try {
				const status = await createDaemonClient().debugStatus();
				lines.splice(2, 0, `- daemon: reachable (protocol ${status.daemon.protocolVersion})`);
				// Idle sessions that still have reminders usually mean that session's
				// idle delivery stopped; a message there delivers the backlog.
				const stalled = status.sessions.filter(
					(session) =>
						session.busyState === "idle" && session.pendingReminderCount > 0,
				);
				lines.push(
					stalled.length === 0
						? "- idle sessions with pending reminders: none"
						: `- idle sessions with pending reminders: ${stalled
								.map((session) => `${formatSessionId(session.sessionId)} (${session.pendingReminderCount})`)
								.join(", ")}`,
				);
			} catch (error) {
				lines.splice(
					2,
					0,
					`- daemon: unreachable (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			return lines.join("\n");
		};

		const pruneClosedSessions = async () => {
			const result = await createDaemonClient().pruneClosedSessions();
			return result as PruneClosedSessionsResult;
		};

		const setCurrentSessionPaused = async (
			ctx: {
				cwd: string;
				sessionManager?: { getSessionFile?: () => string | undefined };
			},
			paused: boolean,
		) => {
			const { client, sessionId } = await ensurePiSessionAttached(ctx);
			if (paused) await client.pauseSession(sessionId);
			else await client.resumeSession(sessionId);
			return paused ? SESSION_PAUSED_MESSAGE : SESSION_RESUMED_MESSAGE;
		};

		const isCurrentSessionPaused = async () => {
			if (!currentSessionId) return false;
			const status = await getClient().debugStatus();
			return status.sessions.some(
				(session) =>
					session.sessionId === currentSessionId && session.status === "paused",
			);
		};

		const describeUndelivered = async () =>
			(await isCurrentSessionPaused().catch(() => false))
				? SESSION_PAUSED_DELIVERY_MESSAGE
				: "premind has no pending reminders for this session.";

		const setGlobalPolling = async (disabled: boolean) => {
			const result = await createDaemonClient().setGlobalDisabled(disabled);
			return globalControlResult(result.disabled);
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
				ctx.ui?.setStatus?.("premind", config.showStatusbar ? value : undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
			}
		};

		const notify = (
			ctx: {
				hasUI?: boolean;
				ui?: {
					notify?: (message: string, level: "info" | "warning" | "error") => void;
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
					status.sessions.find((session) => session.sessionId === currentSessionId),
				),
			);
		};

		const deliverPendingReminders = async (
			sessionId: string,
			generation: number,
			options: { force?: boolean } = {},
		) => {
			if (
				!config.enabled ||
				(!options.force && !config.autoDeliver) ||
				deliveryInFlight ||
				generation !== sessionGeneration
			)
				return { delivered: false as const };
			deliveryInFlight = true;
			const client = getClient();
			let batches: ReminderBatch[] = [];
			let handoffId: string | null = null;
			let handedOff = false;
			try {
				const bundle = (await client.claimReminderBundle(sessionId)).bundle;
				if (!bundle) return { delivered: false as const };
				batches = bundle.batches;
				handoffId = bundle.handoffId;
				handedOff = true;

				if (generation !== sessionGeneration) {
					await client.ackReminderBundle({
						sessionId,
						handoffId,
						state: "failed",
						error: "Pi session ended before reminder delivery",
					});
					handedOff = false;
					return { delivered: false as const };
				}

				const reminderText = batches
					.map((batch) => batch.reminderText)
					.join("\n\n");
				const details: ReminderBatch = {
					...batches[0],
					reminderText,
					events: batches.flatMap((batch) => batch.events),
				};
				pi.sendMessage(
					{
						customType: "premind-reminder",
						content: reminderText,
						display: true,
						details,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				const result = await client.ackReminderBundle({
					sessionId,
					handoffId,
					state: "confirmed",
				});
				if (result.acknowledged !== batches.length)
					throw new Error(
						`Confirmed ${result.acknowledged} of ${batches.length} reminder batches`,
					);
				handedOff = false;
				return { delivered: true as const, batches };
			} catch (error) {
				if (handedOff) {
					try {
						await client.ackReminderBundle({
							sessionId,
							handoffId: handoffId!,
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
				isIdle?: () => boolean;
				ui?: { setStatus?: (key: string, value?: string) => void };
			},
			generation: number,
		) => {
			if (generation !== sessionGeneration) return;
			const startedAt = Date.now();
			if (
				statusPollStartedAt !== undefined &&
				startedAt - statusPollStartedAt < STATUS_POLL_STALE_MS
			)
				return;
			// Owning the poll by token lets an abandoned poll finish late without
			// clearing the marker of the poll that replaced it.
			const token = ++statusPollToken;
			statusPollStartedAt = startedAt;
			let pollError: string | undefined;
			try {
				await refreshStatusbar(ctx, generation);
				if (
					generation !== sessionGeneration ||
					ctx.isIdle?.() !== true ||
					!currentSessionId
				)
					return;
				const result = await deliverPendingReminders(
					currentSessionId,
					generation,
				);
				if (generation === sessionGeneration && result.delivered)
					setStatus(ctx, undefined);
			} catch (error) {
				pollError = error instanceof Error ? error.message : String(error);
				if (
					generation === sessionGeneration &&
					!isStaleExtensionContextError(error)
				)
					setStatus(ctx, `${PR_ICON} error`);
			} finally {
				if (token === statusPollToken) {
					statusPollStartedAt = undefined;
					lastStatusPollCompletedAt = Date.now();
					lastStatusPollError = pollError;
				}
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
			try {
				const { client, sessionId } = await attachPiSession(ctx);
				await client.activateWorktree({
					sessionId,
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

		pi.on("agent_end", async () => {
			try {
				await markBusyState("idle");
			} catch {
				// Busy-state updates are advisory; status/debug commands can surface daemon health.
			}
		});

		pi.on("turn_end", async (_event, ctx) => {
			const generation = sessionGeneration;
			const sessionId = currentSessionId;
			if (!sessionId) return;

			try {
				const result = await deliverPendingReminders(sessionId, generation);
				if (generation !== sessionGeneration) return;
				if (result.delivered) setStatus(ctx, undefined);
				else await refreshStatusbar(ctx, generation);
			} catch (error) {
				if (generation !== sessionGeneration || isStaleExtensionContextError(error))
					return;
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
				// Pi fires session_shutdown for reload, quit, new, resume, and fork.
				// Release ownership instead of deleting the session: a dormant
				// session keeps its subscriptions, cursors, worktree binding, and
				// opt-outs, and the next session_start for the same session file
				// reactivates it. Deleting it cascaded all of that away (#86).
				if (sessionId) await client.releaseSessionOwner(sessionId);
			} catch {
				// Best-effort: the session may already be closed by stale-session reaping.
			}
			try {
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

		pi.registerCommand("premind:doctor", {
			description: "Diagnose premind extension, configuration, and daemon health",
			handler: async (_args, ctx) => {
				ctx.ui.notify(await getDoctorText(), "info");
			},
		});

		pi.registerCommand("premind:enable", {
			description:
				"Enable premind GitHub polling globally, across all sessions and projects",
			handler: async (_args, ctx) => {
				ctx.ui.notify(await setGlobalPolling(false), "info");
			},
		});

		pi.registerCommand("premind:disable", {
			description:
				"Disable premind GitHub polling globally, across all sessions and projects (use /premind:pause for this session only)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(await setGlobalPolling(true), "info");
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

		pi.registerCommand("premind:set-active-checkout", {
			description: "Set the active Git checkout for the current premind session",
			handler: async (args, ctx) => {
				const path = args.trim();
				if (!path) {
					ctx.ui.notify(`${CHECKOUT_ERROR_PREFIX}: expected: <path>`, "error");
					return;
				}
				try {
					const { client, sessionId } = await ensurePiSessionAttached(ctx);
					await client.activateWorktree({ sessionId, path });
					ctx.ui.notify(`premind set active checkout ${path}.`, "info");
				} catch (error) {
					ctx.ui.notify(
						`${CHECKOUT_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
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
					const { client, sessionId } = await ensurePiSessionAttached(ctx);
					await client.subscribe({ sessionId, ...subscription });
					ctx.ui.notify(
						`premind subscribed to ${subscription.repo ?? "active worktree"}#${subscription.prNumber}.`,
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
					const { client, sessionId } = await ensurePiSessionAttached(ctx);
					await client.unsubscribe({ sessionId, ...subscription });
					ctx.ui.notify(
						`premind unsubscribed from ${subscription.repo ?? "active worktree"}#${subscription.prNumber}.`,
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

		for (const [name, paused] of [
			["premind:pause", true],
			["premind:resume", false],
		] as const) {
			pi.registerCommand(name, {
				description: paused
					? "Pause premind reminders for this session only; subscriptions keep being watched"
					: "Resume premind reminders for this session without changing subscriptions",
				handler: async (_args, ctx) => {
					try {
						const message = await setCurrentSessionPaused(ctx, paused);
						if (paused) setStatus(ctx, `${PR_ICON} paused`);
						else await refreshStatusbar(ctx);
						ctx.ui.notify(message, "info");
					} catch (error) {
						ctx.ui.notify(
							`${SESSION_CONTROL_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				},
			});
		}

		const deliverCommand = {
			description:
				"Deliver all pending premind reminders for the current session, if any",
			handler: async (_args, ctx) => {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				try {
					const result = await deliverPendingReminders(
						sessionId,
						sessionGeneration,
						{ force: true },
					);
					if (result.delivered) setStatus(ctx, undefined);
					else await refreshStatusbar(ctx);
					ctx.ui.notify(
						result.delivered
							? `premind delivered ${result.batches.length} reminder batch${result.batches.length === 1 ? "" : "es"}.`
							: await describeUndelivered(),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`${DELIVER_ERROR_PREFIX}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		} satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
		pi.registerCommand("premind:deliver", deliverCommand);
		pi.registerCommand("premind:flush", {
			...deliverCommand,
			description: "Deprecated alias for /premind:deliver",
		});

		pi.registerTool({
			name: "premind_set_active_checkout",
			label: "Premind Set Active Checkout",
			description: `Set the active Git checkout for the current premind session. ${commandCapabilities["set-active-checkout"].toolGuidance}`,
			promptSnippet: "Tell premind which Git checkout this session is actively using.",
			promptGuidelines: [
				"Call premind_set_active_checkout at the start of any PR work, including when already in the startup checkout, and again after switching branches before creating or following a PR.",
			],
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { client, sessionId } = await ensurePiSessionAttached(ctx);
				await client.activateWorktree({ sessionId, path: params.path });
				return {
					content: [
						{
							type: "text" as const,
							text: `premind set active checkout ${params.path}.`,
						},
					],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_subscribe",
			label: "Premind Subscribe",
			description: commandCapabilities.subscribe.toolGuidance,
			promptGuidelines: [
				"Omit writePolicy to let Premind verify whether the authenticated GitHub user authored the PR on this session's active checkout. It remains observation-only until verified.",
				"Use user-authorized only when the user explicitly authorizes work on this PR. Use observe-only to prevent automatic authority escalation.",
			],
			parameters: Type.Object({
				prNumber: Type.Integer({ minimum: 1 }),
				repo: Type.Optional(Type.String({ minLength: 1 })),
				writePolicy: Type.Optional(
					Type.Union([Type.Literal("user-authorized"), Type.Literal("observe-only")]),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { client, sessionId } = await ensurePiSessionAttached(ctx);
				const result = await client.subscribe({ sessionId, ...params });
				const target = `${params.repo ?? "active worktree"}#${params.prNumber}`;
				return {
					content: [
						{
							type: "text" as const,
							text: `premind subscribed to ${target} with write policy ${result.subscription.writePolicy ?? "observe-only"}.`,
						},
					],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_unsubscribe",
			label: "Premind Unsubscribe",
			description: `Unsubscribe the current session from a pull request. ${commandCapabilities.unsubscribe.toolGuidance}`,
			parameters: Type.Object({
				prNumber: Type.Integer({ minimum: 1 }),
				repo: Type.Optional(Type.String({ minLength: 1 })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { client, sessionId } = await ensurePiSessionAttached(ctx);
				await client.unsubscribe({ sessionId, ...params });
				const target = `${params.repo ?? "active worktree"}#${params.prNumber}`;
				return {
					content: [
						{ type: "text" as const, text: `premind unsubscribed from ${target}.` },
					],
					details: {},
				};
			},
		});

		for (const [name, label, paused, description] of [
			["premind_pause", "Premind Pause", true, commandCapabilities.pause.toolGuidance],
			["premind_resume", "Premind Resume", false, commandCapabilities.resume.toolGuidance],
		] as const) {
			pi.registerTool({
				name,
				label,
				description,
				parameters: Type.Object({}),
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					const text = await setCurrentSessionPaused(ctx, paused);
					if (paused) setStatus(ctx, `${PR_ICON} paused`);
					else await refreshStatusbar(ctx);
					return {
						content: [{ type: "text" as const, text }],
						details: {},
					};
				},
			});
		}

		pi.registerTool({
			name: "premind_deliver",
			label: "Premind Deliver",
			description: commandCapabilities.deliver.toolGuidance,
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId ?? getPiSessionId(ctx);
				const result = await deliverPendingReminders(
					sessionId,
					sessionGeneration,
					{ force: true },
				);
				if (result.delivered) setStatus(ctx, undefined);
				else await refreshStatusbar(ctx);
				const text = result.delivered
					? `premind delivered ${result.batches.length} reminder batch${result.batches.length === 1 ? "" : "es"}.`
					: await describeUndelivered();
				return {
					content: [{ type: "text" as const, text }],
					details: {},
				};
			},
		});

		for (const [name, label, action] of [
			["premind_enable", "Premind Enable", "enable"],
			["premind_disable", "Premind Disable", "disable"],
		] as const) {
			pi.registerTool({
				name,
				label,
				description: `${action === "enable" ? "Enable" : "Disable"} premind polling. ${commandCapabilities[action].toolGuidance}`,
				parameters: Type.Object({
					confirmGlobal: Type.Boolean({ description: GLOBAL_CONFIRMATION_DESCRIPTION }),
				}),
				async execute(_toolCallId, params) {
					if (params.confirmGlobal !== true) {
						throw new Error(globalControlRefusal(action));
					}
					return {
						content: [
							{
								type: "text" as const,
								text: await setGlobalPolling(action === "disable"),
							},
						],
						details: {},
					};
				},
			});
		}

		pi.registerTool({
			name: "premind_doctor",
			label: "Premind Doctor",
			description: commandCapabilities.doctor.toolGuidance,
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: await getDoctorText() }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "premind_status",
			label: "Premind Status",
			description: `Show premind daemon status, active sessions, and watchers. ${commandCapabilities.status.toolGuidance}`,
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
