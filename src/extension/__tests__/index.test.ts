import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPremindPiExtension } from "../index.ts";
import type {
	DebugStatusResponse,
	RegisterSessionPayload,
} from "../../shared/schema.ts";

const status: DebugStatusResponse = {
	daemon: {
		protocolVersion: 1,
		heartbeatMs: 10_000,
		leaseTtlMs: 30_000,
		idleShutdownGraceMs: 15_000,
	},
	activeClients: 1,
	activeSessions: 1,
	activeWatchers: 1,
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

type CommandContext = {
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
		params: Record<string, never>,
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

const createMockPi = () => {
	const commands = new Map<string, CommandDefinition>();
	const tools = new Map<string, ToolDefinition>();
	const events = new Map<string, EventHandler>();
	return {
		commands,
		tools,
		events,
		pi: {
			on(name: string, handler: EventHandler) {
				events.set(name, handler);
			},
			registerCommand(name: string, definition: CommandDefinition) {
				commands.set(name, definition);
			},
			registerTool(definition: ToolDefinition) {
				tools.set(definition.name, definition);
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

const createClient = (
	options: { pruneResult?: { sessions: number; reminderBatches: number } } = {},
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
			unregisterSession: async (sessionId: string) => {
				operations.push(`unregisterSession:${sessionId}`);
			},
			debugStatus: async () => status,
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
		})(mock.pi as never);

		assert.ok(mock.events.has("session_start"));
		assert.ok(mock.events.has("session_shutdown"));
		assert.ok(mock.commands.has("premind:status"));
		assert.ok(mock.commands.has("premind:prune"));
		assert.ok(mock.tools.has("premind_status"));
	});

	test("session_start registers the Pi session with repo and branch", async () => {
		const mock = createMockPi();
		const client = createClient();
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
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
		]);
		assert.deepEqual(statuses, [
			{ key: "premind", value: "premind owner/repo @ feature/pi" },
		]);
	});

	test("session_shutdown unregisters the Pi session and releases the client", async () => {
		const mock = createMockPi();
		const client = createClient();
		const { ctx, statuses } = createEventContext();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
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
			"unregisterSession:/tmp/session.jsonl",
			"release",
		]);
		assert.deepEqual(statuses.at(-1), { key: "premind", value: undefined });
	});

	test("/premind:status renders daemon status", async () => {
		const mock = createMockPi();
		const client = createClient();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => client.client,
		})(mock.pi as never);

		const command = mock.commands.get("premind:status");
		assert.ok(command);
		await command.handler("", {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		});

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "info");
		assert.match(notifications[0]?.message ?? "", /premind status/);
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
		})(mock.pi as never);

		const command = mock.commands.get("premind:prune");
		assert.ok(command);
		await command.handler("", {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		});

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "info");
		assert.match(
			notifications[0]?.message ?? "",
			/premind pruned 401 closed sessions and 17 reminder batches\./,
		);
	});

	test("premind_status tool returns daemon status", async () => {
		const mock = createMockPi();
		const client = createClient();
		createPremindPiExtension({
			createDaemonClient: () => client.client,
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
		assert.match(result.content[0].text, /premind status/);
		assert.match(result.content[0].text, /pending 2/);
	});
});
