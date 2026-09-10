import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const HOOK_BUNDLE = path.join(ROOT, "runtime", "premind-hook.mjs");
const DAEMON_BUNDLE = path.join(ROOT, "runtime", "premind-daemon.mjs");
const MCP_BUNDLE = path.join(ROOT, "runtime", "premind-mcp.mjs");

test("Codex hook bundle runs outside repository node_modules", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-bundle-"),
	);
	try {
		const hookPath = path.join(directory, "premind-hook.mjs");
		fs.copyFileSync(HOOK_BUNDLE, hookPath);
		fs.copyFileSync(DAEMON_BUNDLE, path.join(directory, "premind-daemon.mjs"));
		const input = {
			session_id: "thread-1",
			transcript_path: null,
			cwd: directory,
			hook_event_name: "Interrupt",
			model: "gpt-test",
			permission_mode: "default",
			turn_id: "turn-1",
		};
		const result = spawnSync(process.execPath, [hookPath, "Interrupt"], {
			cwd: directory,
			env: { ...process.env, NODE_PATH: "", PLUGIN_DATA: "" },
			input: `${JSON.stringify(input)}\n`,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {});
		const bundle = fs.readFileSync(hookPath, "utf8");
		assert.equal(/from\s+["'](?:zod|xstate|tsx)["']/.test(bundle), false);
		assert.equal(bundle.includes(ROOT), false);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("Codex MCP bundle initializes outside repository node_modules", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-mcp-bundle-"),
	);
	try {
		const mcpPath = path.join(directory, "premind-mcp.mjs");
		fs.copyFileSync(MCP_BUNDLE, mcpPath);
		fs.copyFileSync(DAEMON_BUNDLE, path.join(directory, "premind-daemon.mjs"));
		const result = spawnSync(process.execPath, [mcpPath], {
			cwd: directory,
			env: {
				...process.env,
				NODE_PATH: "",
				PLUGIN_DATA: path.join(directory, "plugin-data"),
			},
			input:
				'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n',
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		const response = JSON.parse(result.stdout);
		assert.equal(response.id, 1);
		assert.equal(response.result.serverInfo.name, "premind");
		assert.equal(response.result.capabilities.tools instanceof Object, true);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("relocated hook starts its adjacent daemon and registers a session", async () => {
	const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
	const directory = fs.mkdtempSync(
		path.join(temporaryRoot, "premind-codex-relocated-"),
	);
	const hookPath = path.join(directory, "premind-hook.mjs");
	const actualDaemonPath = path.join(directory, "actual-daemon.mjs");
	const daemonPath = path.join(directory, "premind-daemon.mjs");
	const stateDirectory = path.join(directory, "state");
	const pluginData = path.join(directory, "plugin-data");
	const pidPath = path.join(directory, "daemon.pid");
	const socketPath = path.join(directory, "premind.sock");
	try {
		fs.copyFileSync(HOOK_BUNDLE, hookPath);
		fs.copyFileSync(DAEMON_BUNDLE, actualDaemonPath);
		fs.writeFileSync(
			daemonPath,
			[
				'import fs from "node:fs";',
				`fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
				'await import("./actual-daemon.mjs");',
				"",
			].join("\n"),
		);
		const input = {
			session_id: "thread-relocated",
			transcript_path: null,
			cwd: directory,
			hook_event_name: "SessionStart",
			model: "gpt-test",
			permission_mode: "default",
			source: "resume",
		};
		const result = spawnSync(process.execPath, [hookPath, "SessionStart"], {
			cwd: directory,
			env: {
				...process.env,
				NODE_PATH: "",
				PLUGIN_DATA: pluginData,
				PREMIND_SOCKET_PATH: socketPath,
				PREMIND_STATE_DIR: stateDirectory,
			},
			input: `${JSON.stringify(input)}\n`,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {});
		assert.ok(fs.existsSync(pidPath), "adjacent daemon did not start");
		const database = new DatabaseSync(path.join(stateDirectory, "premind.db"));
		const session = database
			.prepare("SELECT host, host_session_id FROM sessions WHERE session_id = ?")
			.get("codex:thread-relocated") as
			| { host: string; host_session_id: string }
			| undefined;
		database.close();
		assert.deepEqual(
			{ ...session },
			{
				host: "codex",
				host_session_id: "thread-relocated",
			},
		);
	} finally {
		if (fs.existsSync(pidPath)) {
			try {
				process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGTERM");
			} catch {
				// The isolated daemon may already have exited.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
