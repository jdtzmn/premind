import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PremindDaemonClient } from "../client/daemon-client.ts";
import { createDaemonLauncher } from "../client/daemon-launcher.ts";
import { CODEX_REQUIRED_DAEMON_OPERATIONS } from "../shared/daemon-startup.ts";
import {
	type CodexSessionBinding,
	resolveCodexSessionBinding,
} from "./session-binding.ts";

const RUNTIME_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.join(RUNTIME_DIRECTORY, "premind-daemon.mjs");
const MCP_PROTOCOL_VERSION = "2024-11-05";

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const requestSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: jsonRpcIdSchema.optional(),
		method: z.string().min(1),
		params: z.unknown().optional(),
	})
	.strict();
const initializeArgumentsSchema = z
	.object({ protocolVersion: z.string().min(1) })
	.passthrough();
const statusArgumentsSchema = z
	.object({ sessionHandle: z.string().uuid().optional() })
	.strict();
const activateArgumentsSchema = z
	.object({
		sessionHandle: z.string().uuid(),
		path: z.string().min(1),
	})
	.strict();
const subscriptionArgumentsSchema = z
	.object({
		sessionHandle: z.string().uuid(),
		prNumber: z.number().int().positive(),
		repo: z.string().min(1).optional(),
	})
	.strict();
const toolCallSchema = z
	.object({
		name: z.string().min(1),
		arguments: z.unknown().optional(),
	})
	.strict();

const tools = [
	{
		name: "premind_status",
		description:
			"Return redacted Premind status and, when resolvable, status for the current Codex session.",
		inputSchema: {
			type: "object",
			properties: { sessionHandle: { type: "string", format: "uuid" } },
			additionalProperties: false,
		},
	},
	{
		name: "premind_activate_worktree",
		description: "Bind this Codex session to a linked or nested worktree path.",
		inputSchema: {
			type: "object",
			properties: {
				sessionHandle: { type: "string", format: "uuid" },
				path: { type: "string", minLength: 1 },
			},
			required: ["sessionHandle", "path"],
			additionalProperties: false,
		},
	},
	{
		name: "premind_subscribe",
		description: "Subscribe this Codex session to a pull request.",
		inputSchema: {
			type: "object",
			properties: {
				sessionHandle: { type: "string", format: "uuid" },
				prNumber: { type: "integer", minimum: 1 },
				repo: { type: "string", minLength: 1 },
			},
			required: ["sessionHandle", "prNumber"],
			additionalProperties: false,
		},
	},
	{
		name: "premind_unsubscribe",
		description: "Unsubscribe this Codex session from a pull request.",
		inputSchema: {
			type: "object",
			properties: {
				sessionHandle: { type: "string", format: "uuid" },
				prNumber: { type: "integer", minimum: 1 },
				repo: { type: "string", minLength: 1 },
			},
			required: ["sessionHandle", "prNumber"],
			additionalProperties: false,
		},
	},
] as const;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

const text = (value: string): ToolResult => ({
	content: [{ type: "text", text: value }],
});
const toolError = (): ToolResult => ({
	content: [
		{
			type: "text",
			text: "Premind could not complete this request. Check premind_status and retry.",
		},
	],
	isError: true,
});

class JsonRpcError extends Error {
	constructor(
		readonly code: -32600 | -32601 | -32602,
		message: string,
	) {
		super(message);
	}
}

type McpDaemonClient = Pick<
	PremindDaemonClient,
	"activateWorktree" | "debugStatus" | "subscribe" | "unsubscribe"
>;

export type CodexMcpDependencies = {
	client: McpDaemonClient;
	pluginData: string;
	cwd: string;
	ensureDaemon(): Promise<void>;
};

const resolveBinding = async (
	dependencies: CodexMcpDependencies,
	sessionHandle?: string,
): Promise<{
	binding: CodexSessionBinding | undefined;
	status: Awaited<ReturnType<McpDaemonClient["debugStatus"]>>;
}> => {
	const status = await dependencies.client.debugStatus();
	const binding = resolveCodexSessionBinding({
		pluginData: dependencies.pluginData,
		sessions: status.sessions,
		...(sessionHandle ? { sessionHandle } : { cwd: dependencies.cwd }),
	});
	return { binding, status };
};

const requireBinding = async (
	dependencies: CodexMcpDependencies,
	sessionHandle: string,
) => {
	const { binding } = await resolveBinding(dependencies, sessionHandle);
	if (!binding) throw new Error("Premind could not resolve this Codex session");
	return binding;
};

type ParsedToolCall =
	| { name: "premind_status"; args: z.infer<typeof statusArgumentsSchema> }
	| {
			name: "premind_activate_worktree";
			args: z.infer<typeof activateArgumentsSchema>;
	  }
	| {
			name: "premind_subscribe" | "premind_unsubscribe";
			args: z.infer<typeof subscriptionArgumentsSchema>;
	  };

const parseToolCall = (params: unknown): ParsedToolCall => {
	const call = toolCallSchema.safeParse(params);
	if (!call.success) {
		throw new JsonRpcError(-32602, "Invalid tools/call parameters");
	}
	const rawArguments = call.data.arguments ?? {};
	switch (call.data.name) {
		case "premind_status": {
			const args = statusArgumentsSchema.safeParse(rawArguments);
			if (!args.success)
				throw new JsonRpcError(-32602, "Invalid tool arguments");
			return { name: call.data.name, args: args.data };
		}
		case "premind_activate_worktree": {
			const args = activateArgumentsSchema.safeParse(rawArguments);
			if (!args.success)
				throw new JsonRpcError(-32602, "Invalid tool arguments");
			return { name: call.data.name, args: args.data };
		}
		case "premind_subscribe":
		case "premind_unsubscribe": {
			const args = subscriptionArgumentsSchema.safeParse(rawArguments);
			if (!args.success)
				throw new JsonRpcError(-32602, "Invalid tool arguments");
			return { name: call.data.name, args: args.data };
		}
		default:
			throw new JsonRpcError(-32602, "Unknown Premind tool");
	}
};

const callTool = async (
	tool: ParsedToolCall,
	dependencies: CodexMcpDependencies,
): Promise<ToolResult> => {
	try {
		await dependencies.ensureDaemon();
		if (tool.name === "premind_status") {
			const { binding, status } = await resolveBinding(
				dependencies,
				tool.args.sessionHandle,
			);
			const current = binding
				? status.sessions.find(
						(session) => session.sessionId === binding.sessionId,
					)
				: undefined;
			return text(
				JSON.stringify({
					globallyDisabled: status.globallyDisabled,
					activeSessions: status.activeSessions,
					activeWatchers: status.activeWatchers,
					...(current
						? {
								currentSession: {
									repo: current.repo,
									branch: current.branch,
									status: current.status,
									pendingReminderCount: current.pendingReminderCount,
									subscriptions: current.subscriptions ?? [],
								},
							}
						: {}),
				}),
			);
		}

		const binding = await requireBinding(dependencies, tool.args.sessionHandle);
		if (tool.name === "premind_activate_worktree") {
			const result = await dependencies.client.activateWorktree({
				sessionId: binding.sessionId,
				path: tool.args.path,
			});
			return text(
				`Premind activated ${result.binding.repo} from this Codex session.`,
			);
		}

		if (tool.name === "premind_subscribe") {
			const result = await dependencies.client.subscribe({
				sessionId: binding.sessionId,
				prNumber: tool.args.prNumber,
				...(tool.args.repo ? { repo: tool.args.repo } : {}),
			});
			return text(
				`Premind subscribed this Codex session to ${result.subscription.repo}#${result.subscription.prNumber}.`,
			);
		}

		const result = await dependencies.client.unsubscribe({
			sessionId: binding.sessionId,
			prNumber: tool.args.prNumber,
			...(tool.args.repo ? { repo: tool.args.repo } : {}),
		});
		return text(
			`Premind unsubscribe result: ${result.unsubscribed ? "removed" : "no active subscription"}.`,
		);
	} catch {
		return toolError();
	}
};

export const handleCodexMcpRequest = async (
	message: unknown,
	dependencies: CodexMcpDependencies,
): Promise<unknown> => {
	const request = requestSchema.safeParse(message);
	if (!request.success) throw new JsonRpcError(-32600, "Invalid Request");
	if (request.data.method === "initialize") {
		const params = initializeArgumentsSchema.safeParse(request.data.params);
		if (!params.success) {
			throw new JsonRpcError(-32602, "Invalid initialize parameters");
		}
		return {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "premind", version: "0.1.0" },
		};
	}
	if (request.data.method === "notifications/initialized") return undefined;
	if (request.data.method === "tools/list") return { tools };
	if (request.data.method !== "tools/call") {
		throw new JsonRpcError(-32601, "Method not found");
	}
	const tool = parseToolCall(request.data.params);
	return await callTool(tool, dependencies);
};

type JsonRpcReply = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
};

export const handleCodexMcpLine = async (
	line: string,
	dependencies: CodexMcpDependencies,
): Promise<JsonRpcReply | undefined> => {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		};
	}
	const request = requestSchema.safeParse(message);
	if (!request.success) {
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Invalid Request" },
		};
	}
	const isNotification = !("id" in request.data);
	try {
		const result = await handleCodexMcpRequest(request.data, dependencies);
		if (isNotification) return undefined;
		return { jsonrpc: "2.0", id: request.data.id ?? null, result };
	} catch (error) {
		if (isNotification) return undefined;
		const protocolError =
			error instanceof JsonRpcError
				? error
				: new JsonRpcError(-32600, "Invalid Request");
		return {
			jsonrpc: "2.0",
			id: request.data.id ?? null,
			error: { code: protocolError.code, message: protocolError.message },
		};
	}
};

const isMainModule = () => {
	if (!process.argv[1]) return false;
	try {
		return (
			fs.realpathSync(process.argv[1]) ===
			fs.realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
};

if (isMainModule()) {
	const pluginData = process.env.PLUGIN_DATA;
	if (!pluginData) throw new Error("PLUGIN_DATA is required for Premind MCP");
	const ensureDaemon = createDaemonLauncher({
		daemonEntry: DAEMON_ENTRY,
		requiredOperations: CODEX_REQUIRED_DAEMON_OPERATIONS,
	});
	const dependencies: CodexMcpDependencies = {
		client: new PremindDaemonClient({ ensureDaemon }),
		pluginData,
		cwd: process.env.PWD ?? process.cwd(),
		ensureDaemon,
	};
	const input = readline.createInterface({
		input: process.stdin,
		crlfDelay: Infinity,
	});
	input.on("line", async (line) => {
		const reply = await handleCodexMcpLine(line, dependencies);
		if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
	});
}
