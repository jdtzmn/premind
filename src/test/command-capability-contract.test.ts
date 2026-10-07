import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { createPremindPiExtension } from "../extension/index.ts";
import { createPremindPlugin } from "../plugin-opencode/index.ts";
import { codexMcpTools } from "../codex/mcp-server.ts";
import { tool } from "@opencode-ai/plugin";
import {
	type CommandCapability,
	commandCapabilities,
	expectedCapabilitySurface,
	expectedToolParameters,
	harnessSurface,
	type PremindHarness,
	premindHarnesses,
	type ToolParameter,
} from "../shared/command-capabilities.ts";
// @ts-expect-error The shipped Claude MCP runtime is plain JavaScript.
import { handleMcpRequest } from "../../plugin-claude/bin/mcp-server.mjs";

const sorted = (values: Iterable<string>) => [...values].sort();

type ToolSchemas = Record<string, Record<string, ToolParameter>>;
type JsonSchemaNode = {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	anyOf?: JsonSchemaNode[];
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
};

const parameterType = (node: JsonSchemaNode): string => {
	if (node.type) return node.type;
	if (node.const !== undefined) return typeof node.const;
	if (node.enum?.length) return typeof node.enum[0];
	const branchTypes = new Set((node.anyOf ?? []).map(parameterType));
	return branchTypes.size === 1 ? [...branchTypes][0] : "unknown";
};

/** Reduces TypeBox, zod-generated, and hand-written JSON schemas to name/type/required. */
const normalizeJsonSchema = (schema: unknown): Record<string, ToolParameter> => {
	const node = (schema ?? {}) as JsonSchemaNode;
	const required = new Set(node.required ?? []);
	return Object.fromEntries(
		Object.entries(node.properties ?? {}).map(([name, property]) => [
			name,
			{ type: parameterType(property) as ToolParameter["type"], required: required.has(name) },
		]),
	);
};

const harnessCollectors = {
	pi: async () => collectPiSurface(),
	claude: () => collectClaudeSurface(),
	opencode: () => collectOpenCodeSurface(),
	codex: async () => collectCodexSurface(),
} satisfies Record<PremindHarness, () => Promise<{ schemas: ToolSchemas }>>;

const collectPiSurface = () => {
	const commands = new Set<string>();
	const tools = new Set<string>();
	const schemas: ToolSchemas = {};
	const pi = {
		on() {},
		registerMessageRenderer() {},
		registerCommand(name: string) {
			commands.add(name);
		},
		registerTool(definition: { name: string; parameters?: unknown }) {
			tools.add(definition.name);
			schemas[definition.name] = normalizeJsonSchema(definition.parameters);
		},
		sendMessage() {},
	};
	createPremindPiExtension()(pi as never);
	return { commands: sorted(commands), tools: sorted(tools), schemas };
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
		tool: Record<string, { args: Record<string, unknown> }>;
	};
	const config: Record<string, unknown> = {};
	await runtime.config(config);
	const schemas: ToolSchemas = {};
	for (const [name, definition] of Object.entries(runtime.tool)) {
		schemas[name] = normalizeJsonSchema(
			tool.schema.toJSONSchema(tool.schema.object(definition.args as never)),
		);
	}
	return {
		commands: sorted(Object.keys(config.command as Record<string, unknown>)),
		tools: sorted(Object.keys(runtime.tool)),
		schemas,
	};
};

const collectClaudeSurface = async () => {
	const commandDirectory = new URL("../../plugin-claude/commands/", import.meta.url);
	const commands = readdirSync(commandDirectory)
		.filter((name) => name.endsWith(".md"))
		.map((name) => `premind:${name.slice(0, -3)}`);
	const result = await handleMcpRequest({ method: "tools/list" });
	const listed = result.tools as Array<{ name: string; inputSchema: unknown }>;
	return {
		commands: sorted(commands),
		tools: sorted(listed.map((definition) => definition.name)),
		schemas: Object.fromEntries(
			listed.map((definition) => [definition.name, normalizeJsonSchema(definition.inputSchema)]),
		) as ToolSchemas,
	};
};

/**
 * Codex plugins expose MCP tools and skills but cannot register slash commands,
 * so the command surface is the absence of any command manifest.
 */
const collectCodexSurface = () => {
	for (const pluginRoot of ["../../plugins/premind/", "../../plugins/codex/premind/"]) {
		assert.equal(
			existsSync(new URL(`${pluginRoot}commands`, import.meta.url)),
			false,
			`${pluginRoot} unexpectedly ships slash commands; declare them in command-capabilities.ts`,
		)
	}
	return {
		commands: [],
		tools: sorted(codexMcpTools.map((definition) => definition.name)),
		schemas: Object.fromEntries(
			codexMcpTools.map((definition) => [
				definition.name,
				normalizeJsonSchema(definition.inputSchema),
			]),
		) as ToolSchemas,
	}
}

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

	test("Codex MCP tools match the declared surface", () => {
		const actual = collectCodexSurface();
		assert.deepEqual(actual.commands, expectedCapabilitySurface("codex", "commands"));
		assert.deepEqual(actual.tools, expectedCapabilitySurface("codex", "tools"));
	});

	test("OpenCode registrations match the declared surface", async () => {
		const actual = await collectOpenCodeSurface();
		assert.deepEqual(
			actual.commands,
			expectedCapabilitySurface("opencode", "commands"),
		);
		assert.deepEqual(actual.tools, expectedCapabilitySurface("opencode", "tools"));
	});

	test("every harness tool accepts exactly the declared parameters", async () => {
		for (const harness of premindHarnesses) {
			const { schemas } = await harnessCollectors[harness]();
			for (const [capabilityId, capability] of Object.entries(
				commandCapabilities as Record<string, CommandCapability>,
			)) {
				const surface = harnessSurface(capability, harness);
				const expected = expectedToolParameters(capability, harness);
				for (const name of [...surface.tools, ...(surface.aliases?.tools ?? [])]) {
					assert.deepEqual(
						schemas[name],
						expected,
						`${harness} tool ${name} (${capabilityId}) parameters drifted from command-capabilities.ts`,
					);
				}
				for (const parameter of Object.keys(surface.parameterExceptions ?? {})) {
					for (const name of surface.tools) {
						assert.equal(
							parameter in (schemas[name] ?? {}),
							false,
							`${harness} tool ${name} now accepts ${parameter}; remove its stale parameter exception`,
						);
					}
				}
			}
		}
	});
});
