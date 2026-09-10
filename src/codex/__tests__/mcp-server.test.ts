import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PremindDaemonClient } from "../../client/daemon-client.ts";
import { IpcServer } from "../../daemon/ipc/server.ts";
import { StateStore } from "../../daemon/persistence/store.ts";
import {
	type CodexMcpDependencies,
	handleCodexMcpLine,
	handleCodexMcpRequest,
} from "../mcp-server.ts";
import { ensureCodexSessionBinding } from "../session-binding.ts";

const call = (name: string, args: Record<string, unknown>) => ({
	jsonrpc: "2.0" as const,
	id: 1,
	method: "tools/call",
	params: { name, arguments: args },
});

const shortTempRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";

const createTempDir = () =>
	fs.mkdtempSync(path.join(shortTempRoot, "premind-codex-mcp-"));
test("discovers only the four supported Codex controls", async () => {
	const unused = async () => {
		throw new Error("unused MCP dependency");
	};
	const client = {
		activateWorktree: unused,
		debugStatus: unused,
		subscribe: unused,
		unsubscribe: unused,
	} satisfies CodexMcpDependencies["client"];
	const result = await handleCodexMcpRequest(
		{ jsonrpc: "2.0", id: 1, method: "tools/list" },
		{
			client,
			pluginData: "/unused",
			cwd: "/unused",
			ensureDaemon: async () => undefined,
		},
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(result)).tools.map(
			(tool: { name: string }) => tool.name,
		),
		[
			"premind_status",
			"premind_activate_worktree",
			"premind_subscribe",
			"premind_unsubscribe",
		],
	);
});

test("round-trips explicit handles without cross-routing sessions in one cwd", async () => {
	const directory = fs.mkdtempSync(
		path.join(shortTempRoot, "premind-codex-mcp-"),
	);
	const socketPath = path.join(directory, "premind.sock");
	const store = new StateStore(path.join(directory, "premind.db"));
	const server = new IpcServer(store);
	await server.listen(socketPath);
	const client = new PremindDaemonClient({
		socketPath,
		ensureDaemon: async () => undefined,
		maxRetries: 0,
	});
	const firstSession = {
		sessionId: "codex:thread-1",
		hostSessionId: "thread-1",
		repo: "acme/repo",
		branch: "feature/one",
		busyState: "idle" as const,
	};
	const secondSession = {
		...firstSession,
		sessionId: "codex:thread-2",
		hostSessionId: "thread-2",
		branch: "feature/two",
	};
	const firstBinding = ensureCodexSessionBinding(
		directory,
		firstSession.sessionId,
		"/shared/repo",
	);
	ensureCodexSessionBinding(directory, secondSession.sessionId, "/shared/repo");
	const dependencies: CodexMcpDependencies = {
		client,
		pluginData: directory,
		cwd: "/shared/repo",
		ensureDaemon: async () => undefined,
	};

	try {
		await client.registerCodexSession(firstSession);
		await client.registerCodexSession(secondSession);
		const result = await handleCodexMcpRequest(
			call("premind_subscribe", {
				sessionHandle: firstBinding.sessionHandle,
				prNumber: 42,
				repo: "acme/repo",
			}),
			dependencies,
		);
		assert.match(JSON.stringify(result), /acme\/repo#42/);
		assert.ok(store.getSubscription(firstSession.sessionId, "acme/repo", 42));
		assert.equal(
			store.getSubscription(secondSession.sessionId, "acme/repo", 42),
			null,
		);

		const ambiguous = await handleCodexMcpRequest(
			call("premind_status", {}),
			dependencies,
		);
		assert.equal(JSON.parse(JSON.stringify(ambiguous)).isError, true);
		const raceClient = {
			activateWorktree: client.activateWorktree.bind(client),
			async debugStatus() {
				const status = await client.debugStatus();
				await client.updateSessionState({
					sessionId: firstSession.sessionId,
					status: "dormant",
				});
				return status;
			},
			subscribe: client.subscribe.bind(client),
			unsubscribe: client.unsubscribe.bind(client),
		} satisfies CodexMcpDependencies["client"];
		const raced = await handleCodexMcpRequest(
			call("premind_subscribe", {
				sessionHandle: firstBinding.sessionHandle,
				prNumber: 43,
				repo: "acme/repo",
			}),
			{ ...dependencies, client: raceClient },
		);
		assert.equal(JSON.parse(JSON.stringify(raced)).isError, true);
		assert.equal(
			store.getSubscription(firstSession.sessionId, "acme/repo", 43),
			null,
		);
		await assert.rejects(
			client.subscribe({
				sessionId: firstSession.sessionId,
				prNumber: 44,
				repo: "acme/repo",
			}),
			/SESSION_INACTIVE/,
		);
		assert.equal(
			store.getSubscription(firstSession.sessionId, "acme/repo", 44),
			null,
		);
		await assert.rejects(
			client.activateWorktree({
				sessionId: firstSession.sessionId,
				path: "/not-a-worktree",
			}),
			/SESSION_INACTIVE/,
		);
		assert.equal(store.getWorktreeBinding(firstSession.sessionId), null);
		assert.equal(
			store.getSubscription(secondSession.sessionId, "acme/repo", 42),
			null,
		);
	} finally {
		await server.close(socketPath);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects unknown session handles before mutation IPC", async () => {
	let mutationCalled = false;
	const pluginData = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-mcp-empty-"),
	);
	const client = {
		async debugStatus() {
			return {
				daemon: {
					protocolVersion: 1,
					heartbeatMs: 10_000,
					leaseTtlMs: 30_000,
					idleShutdownGraceMs: 15_000,
					operations: [],
				},
				globallyDisabled: false,
				activeClients: 0,
				activeSessions: 0,
				closedSessions: 0,
				activeWatchers: 0,
				lastReapAt: null,
				lastReapCount: 0,
				sessions: [],
			};
		},
		async activateWorktree() {
			mutationCalled = true;
			throw new Error("unexpected mutation");
		},
		async subscribe() {
			mutationCalled = true;
			throw new Error("unexpected mutation");
		},
		async unsubscribe() {
			mutationCalled = true;
			throw new Error("unexpected mutation");
		},
	} satisfies CodexMcpDependencies["client"];
	const result = await handleCodexMcpRequest(
		call("premind_subscribe", {
			sessionHandle: "00000000-0000-4000-8000-000000000099",
			prNumber: 42,
		}),
		{
			client,
			pluginData,
			cwd: "/repo",
			ensureDaemon: async () => undefined,
		},
	);
	assert.equal(JSON.parse(JSON.stringify(result)).isError, true);
	assert.equal(mutationCalled, false);
	fs.rmSync(pluginData, { recursive: true, force: true });
});

test("returns standard JSON-RPC errors without starting the daemon", async () => {
	let starts = 0;
	const dependencies: CodexMcpDependencies = {
		client: {
			async activateWorktree() {
				throw new Error("unused");
			},
			async debugStatus() {
				throw new Error("unused");
			},
			async subscribe() {
				throw new Error("unused");
			},
			async unsubscribe() {
				throw new Error("unused");
			},
		},
		pluginData: "/unused",
		cwd: "/unused",
		async ensureDaemon() {
			starts += 1;
		},
	};
	assert.deepEqual(await handleCodexMcpLine("not json", dependencies), {
		jsonrpc: "2.0",
		id: null,
		error: { code: -32700, message: "Parse error" },
	});
	assert.deepEqual(
		await handleCodexMcpLine(
			JSON.stringify({ id: 1, method: "tools/list" }),
			dependencies,
		),
		{
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Invalid Request" },
		},
	);
	assert.deepEqual(
		await handleCodexMcpLine(
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown" }),
			dependencies,
		),
		{
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32601, message: "Method not found" },
		},
	);
	assert.deepEqual(
		await handleCodexMcpLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "premind_subscribe", arguments: {} },
			}),
			dependencies,
		),
		{
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32602, message: "Invalid tool arguments" },
		},
	);
	assert.equal(starts, 0);
});

test("redacts daemon internals and returns execution failures as tool results", async () => {
	const pluginData = createTempDir();
	try {
		const binding = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			pluginData,
		);
		const dependencies: CodexMcpDependencies = {
			client: {
				async activateWorktree() {
					throw new Error("unused");
				},
				async debugStatus() {
					return {
						daemon: {
							protocolVersion: 1,
							heartbeatMs: 10_000,
							leaseTtlMs: 30_000,
							idleShutdownGraceMs: 15_000,
							operations: [],
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
								sessionId: binding.sessionId,
								host: "codex",
								repo: "acme/repo",
								branch: "feature/test",
								prNumber: null,
								status: "active",
								busyState: "idle",
								pendingReminderCount: 0,
								worktreeBinding: {
									root: "/private/worktree",
									gitDir: "/private/git",
									repo: "acme/repo",
									branch: "feature/test",
									headSha: "abc",
									state: "active",
									updatedAt: 1,
								},
								subscriptions: [],
							},
						],
					};
				},
				async subscribe() {
					throw new Error("unused");
				},
				async unsubscribe() {
					throw new Error("unused");
				},
			},
			pluginData,
			cwd: pluginData,
			ensureDaemon: async () => undefined,
		};
		const result = await handleCodexMcpRequest(
			call("premind_status", { sessionHandle: binding.sessionHandle }),
			dependencies,
		);
		const output = JSON.stringify(result);
		assert.equal(output.includes("acme/repo"), true);
		assert.equal(output.includes(binding.sessionId), false);
		assert.equal(output.includes("/private/worktree"), false);
		assert.equal(output.includes("/private/git"), false);

		const failed = await handleCodexMcpRequest(
			call("premind_status", { sessionHandle: binding.sessionHandle }),
			{
				...dependencies,
				client: {
					...dependencies.client,
					async debugStatus() {
						throw new Error("sensitive daemon detail");
					},
				},
			},
		);
		assert.equal(JSON.parse(JSON.stringify(failed)).isError, true);
		assert.equal(
			JSON.stringify(failed).includes("sensitive daemon detail"),
			false,
		);
	} finally {
		fs.rmSync(pluginData, { recursive: true, force: true });
	}
});
