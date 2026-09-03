import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	createPremindPiExtension,
	renderPremindPiStatus,
	renderPremindReminderText,
} from "../index.ts";
import type {
	DebugStatusResponse,
	RegisterSessionPayload,
	ReminderBatch,
} from "../../shared/schema.ts";

const status: DebugStatusResponse = {
	daemon: {
		protocolVersion: 1,
		heartbeatMs: 10_000,
		leaseTtlMs: 30_000,
		idleShutdownGraceMs: 15_000,
	},
	globallyDisabled: false,
	activeClients: 1,
	activeSessions: 1,
	closedSessions: 0,
	activeWatchers: 1,
	lastReapAt: null,
	lastReapCount: 0,
	sessions: [
		{
			sessionId: "session-1",
			repo: "owner/repo",
			branch: "feature/pi",
			prNumber: 123,
			status: "active",
			busyState: "idle",
			pendingReminderCount: 2,
		},
	],
};

const reminderBatch: ReminderBatch = {
	batchId: "batch-1",
	sessionId: "/tmp/session.jsonl",
	reminderText: "<premind-reminder>new PR context</premind-reminder>",
	events: [
		{
			eventId: "event-1",
			kind: "issue_comment.created",
			priority: "high",
			summary: "New PR comment",
		},
	],
};

type CommandContext = {
	cwd?: string;
	sessionManager?: { getSessionFile: () => string | undefined };
	ui: { notify: (message: string, level: string) => void };
};

type CommandDefinition = {
	handler: (args: string, ctx: CommandContext) => Promise<void>;
};

type ToolResult = { content: Array<{ type: "text"; text: string }> };

type ToolDefinition = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
};

type EventContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: { getSessionFile: () => string | undefined };
	ui: {
		notify: (message: string, level: string) => void;
		setStatus: (key: string, value?: string) => void;
	};
};

type EventHandler = (event: unknown, ctx: EventContext) => Promise<void>;

type SentMessage = {
	message: unknown;
	options: unknown;
};

const createMockPi = () => {
	const renderers = new Map<
		string,
		(message: { details?: ReminderBatch }) => unknown
	>();
	const commands = new Map<string, CommandDefinition>();
	const tools = new Map<string, ToolDefinition>();
	const events = new Map<string, EventHandler>();
	const sentMessages: SentMessage[] = [];
	return {
		renderers,
		commands,
		tools,
		events,
		sentMessages,
		pi: {
			on(name: string, handler: EventHandler) {
				events.set(name, handler);
			},
			registerMessageRenderer(
				name: string,
				renderer: (message: { details?: ReminderBatch }) => unknown,
			) {
				renderers.set(name, renderer);
			},
			registerCommand(name: string, definition: CommandDefinition) {
				commands.set(name, definition);
			},
			registerTool(definition: ToolDefinition) {
				tools.set(definition.name, definition);
			},
			sendMessage(message: unknown, options: unknown) {
				sentMessages.push({ message, options });
			},
		},
	};
};

const createEventContext = () => {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value?: string }> = [];
	const ctx: EventContext = {
		cwd: "/tmp/project",
		hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value?: string) {
				statuses.push({ key, value });
			},
		},
	};
	return { ctx, notifications, statuses };
};

const createCommandContext = (
	notifications: Array<{ message: string; level: string }> = [],
): CommandContext => ({
	cwd: "/tmp/project",
	sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
	ui: {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
	},
});

const createClient = (
	options: {
		pruneResult?: { sessions: number; reminderBatches: number };
		pendingBatch?: ReminderBatch | null;
		statusResult?: DebugStatusResponse;
	} = {},
) => {
	const operations: string[] = [];
	const registeredSessions: Array<Omit<RegisterSessionPayload, "clientId">> =
		[];
	return {
		operations,
		registeredSessions,
		client: {
			registerClient: async (projectRoot: string, sessionSource?: string) => {
				operations.push(
					`registerClient:${projectRoot}:${sessionSource ?? "none"}`,
				);
				return { heartbeatMs: 1_000 };
			},
			heartbeat: async () => {
				operations.push("heartbeat");
			},
			release: async () => {
				operations.push("release");
			},
			registerSession: async (
				payload: Omit<RegisterSessionPayload, "clientId">,
			) => {
				registeredSessions.push(payload);
				operations.push(
					`registerSession:${payload.sessionId}:${payload.repo}:${payload.branch}`,
				);
			},
			ensureSessionControl: async ({
				sessionId,
				paused,
			}: {
				sessionId: string;
				paused: boolean;
			}) => {
				operations.push(`ensureSessionControl:${sessionId}:${paused}`);
			},
			unregisterSession: async (sessionId: string) => {
				operations.push(`unregisterSession:${sessionId}`);
			},
			pauseSession: async (sessionId: string) => {
				operations.push(`pauseSession:${sessionId}`);
			},
			resumeSession: async (sessionId: string) => {
				operations.push(`resumeSession:${sessionId}`);
			},
			activateWorktree: async (payload: { sessionId: string; path: string }) => {
				operations.push(`activateWorktree:${payload.sessionId}:${payload.path}`);
			},
			subscribe: async (payload: {
				sessionId: string;
				prNumber: number;
				repo?: string;
			}) => {
				operations.push(`subscribe:${payload.sessionId}:${payload.repo ?? "default"}:${payload.prNumber}`);
			},
			unsubscribe: async (payload: {
				sessionId: string;
				prNumber: number;
				repo?: string;
			}) => {
				operations.push(`unsubscribe:${payload.sessionId}:${payload.repo ?? "default"}:${payload.prNumber}`);
			},
			updateSessionState: async (payload: {
				sessionId: string;
				busyState: string;
			}) => {
				operations.push(
					`updateSessionState:${payload.sessionId}:${payload.busyState}`,
				);
			},
			getPendingReminder: async (sessionId: string) => {
				operations.push(`getPendingReminder:${sessionId}`);
				return { batch: options.pendingBatch ?? null };
			},
			ackReminder: async (payload: {
				batchId: string;
				sessionId: string;
				state: string;
			}) => {
				operations.push(
					`ackReminder:${payload.batchId}:${payload.sessionId}:${payload.state}`,
				);
			},
			debugStatus: async () => options.statusResult ?? status,
			pruneClosedSessions: async () =>
				options.pruneResult ?? { sessions: 0, reminderBatches: 0 },
		},
	};
};

describe("premind Pi extension", () => {
	test("registers namespaced commands, lifecycle handlers, and status tool", () => {
		const mock = createMockPi();
		const client = createClient();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		assert.ok(mock.events.has("session_start"));
		assert.ok(mock.events.has("session_shutdown"));
		assert.ok(mock.events.has("agent_start"));
		assert.ok(mock.events.has("agent_end"));
		assert.ok(mock.renderers.has("premind-reminder"));
		assert.ok(mock.commands.has("premind:status"));
		assert.ok(mock.commands.has("premind:prune"));
		assert.ok(mock.commands.has("premind:activate-worktree"));
		assert.ok(mock.commands.has("premind:subscribe"));
		assert.ok(mock.commands.has("premind:unsubscribe"));
		assert.ok(mock.commands.has("premind:pause"));
		assert.ok(mock.commands.has("premind:resume"));
		assert.ok(mock.commands.has("premind:flush"));
		assert.ok(mock.tools.has("premind_pause"));
		assert.ok(mock.tools.has("premind_resume"));
		assert.ok(mock.tools.has("premind_activate_worktree"));
		assert.ok(mock.tools.has("premind_subscribe"));
		assert.ok(mock.tools.has("premind_unsubscribe"));
		assert.ok(mock.tools.has("premind_status"));
	});

	test("renders reminder messages as concise PR change bullets", () => {
		assert.equal(
			renderPremindReminderText({
				...reminderBatch,
				events: [
					{
						eventId: "low",
						kind: "label.added",
						priority: "low",
						summary: "labels changed",
					},
					{
						eventId: "high",
						kind: "check.failed",
						priority: "high",
						summary: "CI failed: npm run check",
					},
					{
						eventId: "medium",
						kind: "pr.synchronized",
						priority: "medium",
						summary: "branch synchronized",
					},
					{
						eventId: "high-2",
						kind: "review_comment.created",
						priority: "high",
						summary: "alice commented on src/extension/index.ts",
					},
				],
			}),
			[
				"[premind] 4 PR updates",
				"- CI failed: npm run check",
				"- alice commented on src/extension/index.ts",
				"- branch synchronized",
				"- 1 more update queued",
			].join("\n"),
		);
	});

	test("renders reminder messages with themed notification colors", () => {
		const theme = {
			fg(color: string, text: string) {
				return `<${color}>${text}</${color}>`;
			},
		};

		assert.equal(
			renderPremindReminderText(reminderBatch, theme as never),
			[
				"<warning>[premind]</warning> <accent>1 PR update</accent>",
				"<dim>- New PR comment</dim>",
			].join("\n"),
		);
	});

	test("renders Pi status with a shortened session id", () => {
		assert.equal(
			renderPremindPiStatus({
				...status,
				sessions: [
					{
						...status.sessions[0],
						sessionId:
							"/Users/jacob/.pi/agent/sessions/project/2026-07-18T05-45-33-751Z_019f73c2-2f37-7098-88f3-a096cda8ea14.jsonl",
					},
				],
			}),
			[
				"premind: 1 active session",
				"clients 1 · watchers 1",
				"- owner/repo @ feature/pi (PR #123) | active/idle | pending 2 | session …a096cda8ea14",
			].join("\n"),
		);
	});

	test("renders Pi status worktree and qualified subscriptions", () => {
		assert.match(

			renderPremindPiStatus({
				...status,
				sessions: [{
					...status.sessions[0],
					worktreeBinding: {
						root: "/repo/.trees/pi",
						gitDir: "/repo/.git/worktrees/pi",
						repo: "owner/repo",
						branch: "feature/pi",
						headSha: "abc123",
						state: "watching",
						updatedAt: 1,
					},
					subscriptions: [{
						repo: "other/repo",
						prNumber: 456,
						source: "manual",
						state: "active",
						pendingEventCount: 4,
					}],
				}],
			}),
			/worktree owner\/repo @ feature\/pi \(watching\) \| subscriptions other\/repo#456 \(manual\/active, pending 4\)/,
		);
	});

	test("session_start registers the Pi session with repo and branch", async () => {
		const mock = createMockPi();
		const client = createClient();
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
			detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
		})(mock.pi as never);

		const handler = mock.events.get("session_start");
		assert.ok(handler);
		await handler({}, ctx);

		assert.deepEqual(client.registeredSessions, [
			{
				sessionId: "/tmp/session.jsonl",
				repo: "owner/repo",
				branch: "feature/pi",
				isPrimary: true,
				status: "active",
				busyState: "idle",
			},
		]);
		assert.deepEqual(client.operations, [
			"registerClient:/tmp/project:pi-extension",
			"registerSession:/tmp/session.jsonl:owner/repo:feature/pi",
			"activateWorktree:/tmp/session.jsonl:/tmp/project",
		]);
		assert.deepEqual(statuses, [{ key: "premind", value: undefined }]);
	});

	test("session_start shows pending count in the statusbar", async () => {
		const mock = createMockPi();
		const client = createClient({
			statusResult: {
				...status,
				sessions: [
					{
						sessionId: "/tmp/session.jsonl",
						repo: "owner/repo",
						branch: "feature/pi",
						prNumber: 123,
						status: "active",
						busyState: "idle",
						pendingReminderCount: 4,
					},
				],
			},
		});
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
			detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
		})(mock.pi as never);

		const handler = mock.events.get("session_start");
		assert.ok(handler);
		await handler({}, ctx);

		assert.deepEqual(statuses.at(-1), { key: "premind", value: " 4 pending" });
	});

	test("session_shutdown unregisters the Pi session and releases the client", async () => {
		const mock = createMockPi();
		const client = createClient();
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
			detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
		})(mock.pi as never);

		const start = mock.events.get("session_start");
		const shutdown = mock.events.get("session_shutdown");
		assert.ok(start);
		assert.ok(shutdown);
		await start({}, ctx);
		await shutdown({}, ctx);

		assert.deepEqual(client.operations, [
			"registerClient:/tmp/project:pi-extension",
			"registerSession:/tmp/session.jsonl:owner/repo:feature/pi",
			"activateWorktree:/tmp/session.jsonl:/tmp/project",
			"unregisterSession:/tmp/session.jsonl",
			"release",
		]);
		assert.deepEqual(statuses.at(-1), { key: "premind", value: undefined });
	});

	test(
		"in-flight status polling tolerates a context invalidated before shutdown",
		async (t) => {
			t.mock.timers.enable({ apis: ["setInterval"] });
			const mock = createMockPi();
			const client = createClient();
			const { ctx, statuses } = createEventContext();
			let statusCalls = 0;
			let markPollStarted!: () => void;
			let resolvePoll!: (value: DebugStatusResponse) => void;
			const pollStarted = new Promise<void>((resolve) => {
				markPollStarted = resolve;
			});
			const pollResult = new Promise<DebugStatusResponse>((resolve) => {
				resolvePoll = resolve;
			});
			client.client.debugStatus = async () => {
				statusCalls++;
				if (statusCalls === 1) return status;
				markPollStarted();
				return pollResult;
			};

			let contextIsStale = false;
			Object.defineProperty(ctx, "hasUI", {
				get() {
					if (contextIsStale) {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					}
					return true;
				},
			});
			createPremindPiExtension({
				createDaemonClient: () => client.client,
				config: { statusPollIntervalMs: 5_000 },
				detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
			})(mock.pi as never);

			const start = mock.events.get("session_start");
			const shutdown = mock.events.get("session_shutdown");
			assert.ok(start);
			assert.ok(shutdown);
			await start({}, ctx);
			t.mock.timers.tick(5_000);
			await pollStarted;
			const statusCountBeforeInvalidation = statuses.length;
			contextIsStale = true;
			resolvePoll(status);
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(statuses.length, statusCountBeforeInvalidation);
			await shutdown({}, ctx);
		},
	);

	test("status polling treats a stale extension API as cancellation", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const mock = createMockPi();
		const client = createClient({ pendingBatch: reminderBatch });
		const { ctx, statuses } = createEventContext();
		mock.pi.sendMessage = () => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		};
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 5_000 },
			detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
		})(mock.pi as never);

		const start = mock.events.get("session_start");
		const shutdown = mock.events.get("session_shutdown");
		assert.ok(start);
		assert.ok(shutdown);
		await start({}, ctx);
		statuses.length = 0;
		t.mock.timers.tick(5_000);
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(statuses, [{ key: "premind", value: undefined }]);
		assert.ok(
			client.operations.includes(
				"ackReminder:batch-1:/tmp/session.jsonl:failed",
			),
		);
		await shutdown({}, ctx);
	});

	test("agent lifecycle updates busy state and auto-delivers pending reminders on idle", async () => {
		const mock = createMockPi();
		const client = createClient({ pendingBatch: reminderBatch });
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
			detectGit: async () => ({ repo: "owner/repo", branch: "feature/pi" }),
		})(mock.pi as never);

		const startSession = mock.events.get("session_start");
		const agentStart = mock.events.get("agent_start");
		const agentEnd = mock.events.get("agent_end");
		assert.ok(startSession);
		assert.ok(agentStart);
		assert.ok(agentEnd);

		await startSession({}, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx);

		assert.deepEqual(client.operations, [
			"registerClient:/tmp/project:pi-extension",
			"registerSession:/tmp/session.jsonl:owner/repo:feature/pi",
			"activateWorktree:/tmp/session.jsonl:/tmp/project",
			"updateSessionState:/tmp/session.jsonl:busy",
			"updateSessionState:/tmp/session.jsonl:idle",
			"getPendingReminder:/tmp/session.jsonl",
			"ackReminder:batch-1:/tmp/session.jsonl:handed_off",
			"ackReminder:batch-1:/tmp/session.jsonl:confirmed",
		]);
		assert.deepEqual(mock.sentMessages, [
			{
				message: {
					customType: "premind-reminder",
					content: reminderBatch.reminderText,
					display: true,
					details: reminderBatch,
				},
				options: { deliverAs: "followUp", triggerTurn: true },
			},
		]);
		assert.deepEqual(statuses.at(-1), { key: "premind", value: undefined });
	});

	test("/premind:status renders daemon status", async () => {
		const mock = createMockPi();
		const client = createClient();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const command = mock.commands.get("premind:status");
		assert.ok(command);
		await command.handler("", createCommandContext(notifications));

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "info");
		assert.match(notifications[0]?.message ?? "", /premind: 1 active session/);
		assert.match(
			notifications[0]?.message ?? "",
			/owner\/repo @ feature\/pi \(PR #123\)/,
		);
	});

	test("/premind:prune prunes closed sessions", async () => {
		const mock = createMockPi();
		const client = createClient({
			pruneResult: { sessions: 401, reminderBatches: 17 },
		});
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const command = mock.commands.get("premind:prune");
		assert.ok(command);
		await command.handler("", createCommandContext(notifications));

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "info");
		assert.match(
			notifications[0]?.message ?? "",
			/premind pruned 401 closed sessions and 17 reminder batches\./,
		);
	});

	test("/premind:pause and /premind:resume control the current session", async () => {
		const mock = createMockPi();
		const client = createClient();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const pause = mock.commands.get("premind:pause");
		const resume = mock.commands.get("premind:resume");
		assert.ok(pause);
		assert.ok(resume);
		await pause.handler("", createCommandContext(notifications));
		await resume.handler("", createCommandContext(notifications));

		assert.deepEqual(client.operations, [
			"registerClient:/tmp/project:pi-extension",
			"ensureSessionControl:/tmp/session.jsonl:true",
			"registerClient:/tmp/project:pi-extension",
			"ensureSessionControl:/tmp/session.jsonl:false",
		]);
		assert.deepEqual(
			notifications.map((notification) => notification.message),
			["premind paused for this session.", "premind resumed for this session."],
		);
	});

	test("premind_pause and premind_resume tools control the current session", async () => {
		const mock = createMockPi();
		const client = createClient();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const pause = mock.tools.get("premind_pause");
		const resume = mock.tools.get("premind_resume");
		assert.ok(pause);
		assert.ok(resume);
		await pause.execute(
			"tool-call-1",
			{},
			undefined,
			undefined,
			createCommandContext(),
		);
		await resume.execute(
			"tool-call-2",
			{},
			undefined,
			undefined,
			createCommandContext(),
		);

		assert.deepEqual(client.operations, [
			"registerClient:/tmp/project:pi-extension",
			"ensureSessionControl:/tmp/session.jsonl:true",
			"registerClient:/tmp/project:pi-extension",
			"ensureSessionControl:/tmp/session.jsonl:false",
		]);
	});

	test("worktree and subscription commands and tools target the current session", async () => {
		const mock = createMockPi();
		const client = createClient();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const activate = mock.commands.get("premind:activate-worktree");
		const subscribe = mock.commands.get("premind:subscribe");
		const unsubscribe = mock.commands.get("premind:unsubscribe");
		const activateTool = mock.tools.get("premind_activate_worktree");
		const subscribeTool = mock.tools.get("premind_subscribe");
		const unsubscribeTool = mock.tools.get("premind_unsubscribe");
		assert.ok(activate);
		assert.ok(subscribe);
		assert.ok(unsubscribe);
		assert.ok(activateTool);
		assert.ok(subscribeTool);
		assert.ok(unsubscribeTool);

		const ctx = createCommandContext(notifications);
		await activate.handler("/tmp/other-worktree", ctx);
		await subscribe.handler("42 owner/repo", ctx);
		await unsubscribe.handler("42 owner/repo", ctx);
		await activateTool.execute("tool-call-1", { path: "/tmp/tool-worktree" }, undefined, undefined, ctx);
		await subscribeTool.execute("tool-call-2", { prNumber: 13 }, undefined, undefined, ctx);
		await unsubscribeTool.execute("tool-call-3", { prNumber: 13 }, undefined, undefined, ctx);

		assert.deepEqual(client.operations, [
			"activateWorktree:/tmp/session.jsonl:/tmp/other-worktree",
			"subscribe:/tmp/session.jsonl:owner/repo:42",
			"unsubscribe:/tmp/session.jsonl:owner/repo:42",
			"activateWorktree:/tmp/session.jsonl:/tmp/tool-worktree",
			"subscribe:/tmp/session.jsonl:default:13",
			"unsubscribe:/tmp/session.jsonl:default:13",
		]);
		assert.deepEqual(
			notifications.map((notification) => notification.message),
			[
				"premind activated worktree /tmp/other-worktree.",
				"premind subscribed to owner/repo#42.",
				"premind unsubscribed from owner/repo#42.",
			],
		);
	});

	test("/premind:flush reports when there is no pending reminder", async () => {
		const mock = createMockPi();
		const client = createClient();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const command = mock.commands.get("premind:flush");
		assert.ok(command);
		await command.handler("", createCommandContext(notifications));

		assert.deepEqual(client.operations, [
			"getPendingReminder:/tmp/session.jsonl",
		]);
		assert.deepEqual(mock.sentMessages, []);
		assert.equal(
			notifications[0]?.message,
			"premind has no pending reminders for this session.",
		);
	});

	test("/premind:flush sends a follow-up message and confirms the batch", async () => {
		const mock = createMockPi();
		const client = createClient({ pendingBatch: reminderBatch });
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const command = mock.commands.get("premind:flush");
		assert.ok(command);
		await command.handler("", createCommandContext(notifications));

		assert.deepEqual(client.operations, [
			"getPendingReminder:/tmp/session.jsonl",
			"ackReminder:batch-1:/tmp/session.jsonl:handed_off",
			"ackReminder:batch-1:/tmp/session.jsonl:confirmed",
		]);
		assert.deepEqual(mock.sentMessages, [
			{
				message: {
					customType: "premind-reminder",
					content: reminderBatch.reminderText,
					display: true,
					details: reminderBatch,
				},
				options: { deliverAs: "followUp", triggerTurn: true },
			},
		]);
		assert.equal(
			notifications[0]?.message,
			"premind delivered reminder batch batch-1.",
		);
	});

	test("premind_status tool returns daemon status", async () => {
		const mock = createMockPi();
		const client = createClient();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
			config: { statusPollIntervalMs: 0 },
		})(mock.pi as never);

		const tool = mock.tools.get("premind_status");
		assert.ok(tool);
		const result = await tool.execute(
			"tool-call-1",
			{},
			undefined,
			undefined,
			{},
		);
		assert.match(result.content[0].text, /premind: 1 active session/);
		assert.match(result.content[0].text, /pending 2/);
	});
});
