import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { createPremindPiExtension } from "../extension/index.ts";
import { createPremindPlugin } from "../plugin-opencode/index.ts";
import { expectedCapabilitySurface } from "../shared/command-capabilities.ts";
// @ts-expect-error The shipped Claude MCP runtime is plain JavaScript.
import { handleMcpRequest } from "../../plugin-claude/bin/mcp-server.mjs";

const sorted = (values: Iterable<string>) => [...values].sort();

const collectPiSurface = () => {
	const commands = new Set<string>();
	const tools = new Set<string>();
	const pi = {
		on() {},
		registerMessageRenderer() {},
		registerCommand(name: string) {
			commands.add(name);
		},
		registerTool(definition: { name: string }) {
			tools.add(definition.name);
		},
		sendMessage() {},
	};
	createPremindPiExtension()(pi as never);
	return { commands: sorted(commands), tools: sorted(tools) };
};

const collectOpenCodeSurface = async () => {
	const daemon = {
		registerClient: async () => ({ heartbeatMs: 10_000 }),
		heartbeat: async () => undefined,
		release: async () => undefined,
		debugStatus: async () => ({ sessions: [] }),
	};
	const plugin = await createPremindPlugin({
		createDaemonClient: () => daemon as never,
		ensureDaemon: async () => {},
		loadConfig: () => ({ idleDeliveryThresholdMs: 60_000 }),
	})({
		directory: "/tmp/premind-contract",
		client: {
			session: {
				get: async () => ({ data: {} }),
				prompt: async () => undefined,
				promptAsync: async () => undefined,
			},
			tui: { showToast: async () => undefined },
		},
	} as never);
	const runtime = plugin as unknown as {
		config: (input: Record<string, unknown>) => Promise<void>;
		tool: Record<string, unknown>;
	};
	const config: Record<string, unknown> = {};
	await runtime.config(config);
	return {
		commands: sorted(Object.keys(config.command as Record<string, unknown>)),
		tools: sorted(Object.keys(runtime.tool)),
	};
};

const collectClaudeSurface = async () => {
	const commandDirectory = new URL("../../plugin-claude/commands/", import.meta.url);
	const commands = readdirSync(commandDirectory)
		.filter((name) => name.endsWith(".md"))
		.map((name) => `premind:${name.slice(0, -3)}`);
	const result = await handleMcpRequest({ method: "tools/list" });
	return {
		commands: sorted(commands),
		tools: sorted(result.tools.map((tool: { name: string }) => tool.name)),
	};
};

describe("adapter command capability contract", () => {
	test("Pi registrations match the declared surface", () => {
		const actual = collectPiSurface();
		assert.deepEqual(actual.commands, expectedCapabilitySurface("pi", "commands"));
		assert.deepEqual(actual.tools, expectedCapabilitySurface("pi", "tools"));
	});

	test("Claude command files and MCP tools match the declared surface", async () => {
		const actual = await collectClaudeSurface();
		assert.deepEqual(
			actual.commands,
			expectedCapabilitySurface("claude", "commands"),
		);
		assert.deepEqual(actual.tools, expectedCapabilitySurface("claude", "tools"));
	});

	test("OpenCode registrations match the declared surface", async () => {
		const actual = await collectOpenCodeSurface();
		assert.deepEqual(
			actual.commands,
			expectedCapabilitySurface("opencode", "commands"),
		);
		assert.deepEqual(actual.tools, expectedCapabilitySurface("opencode", "tools"));
	});
});
