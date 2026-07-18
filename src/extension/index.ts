import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderPremindStatus } from "../plugin/commands.ts";
import { PremindDaemonClient } from "../plugin/daemon-client.ts";
import { detectGitContext } from "../plugin/git-context.ts";
import type {
	DebugStatusResponse,
	RegisterSessionPayload,
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
const SESSION_SOURCE = "pi-extension";
const DEFAULT_HEARTBEAT_MS = 10_000;

const formatPruneResult = (result: PruneClosedSessionsResult) =>
	`premind pruned ${result.sessions} closed session${result.sessions === 1 ? "" : "s"} and ${result.reminderBatches} reminder batch${result.reminderBatches === 1 ? "" : "es"}.`;

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
