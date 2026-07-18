import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPremindPiExtension } from "../index.ts";
import type { DebugStatusResponse } from "../../shared/schema.ts";

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

type CommandDefinition = {
	handler: (
		args: string,
		ctx: { ui: { notify: (message: string, level: string) => void } },
	) => Promise<void>;
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

const createMockPi = () => {
	const commands = new Map<string, CommandDefinition>();
	const tools = new Map<string, ToolDefinition>();
	return {
		commands,
		tools,
		pi: {
			registerCommand(name: string, definition: CommandDefinition) {
				commands.set(name, definition);
			},
			registerTool(definition: ToolDefinition) {
				tools.set(definition.name, definition);
			},
		},
	};
};

describe("premind Pi extension", () => {
	test("registers namespaced status command and status tool", () => {
		const mock = createMockPi();
		createPremindPiExtension({
			createDaemonClient: () => ({ debugStatus: async () => status }),
		})(mock.pi as never);

		assert.ok(mock.commands.has("premind:status"));
		assert.ok(mock.tools.has("premind_status"));
	});

	test("/premind:status renders daemon status", async () => {
		const mock = createMockPi();
		const notifications: Array<{ message: string; level: string }> = [];
		createPremindPiExtension({
			createDaemonClient: () => ({ debugStatus: async () => status }),
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

	test("premind_status tool returns daemon status", async () => {
		const mock = createMockPi();
		createPremindPiExtension({
			createDaemonClient: () => ({ debugStatus: async () => status }),
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
