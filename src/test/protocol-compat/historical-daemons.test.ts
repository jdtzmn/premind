/**
 * Cross-version compatibility against real released daemon builds.
 *
 * Each pinned build is checked out from git history and run from source with
 * an isolated state directory. An old-protocol client registers a session and
 * a subscription on it, then the current launcher must replace it, keep that
 * state, serve the old client through the protocol-v1 proxy, and give a
 * current client protocol v2. Needs full git history (CI checks out with
 * fetch-depth 0).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";
import { PremindDaemonClient } from "../../client/daemon-client.ts";
import { createDaemonLauncher } from "../../client/daemon-launcher.ts";
import { isSocketReachable, readDaemonLockOwner } from "../../shared/daemon-startup.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CURRENT_DAEMON = path.join(ROOT, "plugins/premind/generated/premind-daemon.mjs");

const HISTORICAL_BUILDS = [
	{ commit: "af15de7", label: "#82, before bootstrap and the storage bridge", bridges: true },
	{ commit: "5728c25", label: "#43, bootstrap without requestHandover", bridges: false },
	{ commit: "8b65be4", label: "#89, requestHandover without stamped builds", bridges: false },
] as const;

const scratch = fs.mkdtempSync(path.join("/tmp", "premind-compat-"));
const worktrees: string[] = [];
const processes: ChildProcess[] = [];
const daemonPids: number[] = [];
after(() => {
	for (const child of processes) if (child.exitCode === null) child.kill("SIGKILL");
	for (const pid of daemonPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already exited.
		}
	}
	for (const worktree of worktrees) {
		spawnSync("git", ["-C", ROOT, "worktree", "remove", "--force", worktree]);
	}
	fs.rmSync(scratch, { recursive: true, force: true });
});

const checkOut = (commit: string) => {
	const worktree = path.join(scratch, `build-${commit}`);
	const added = spawnSync("git", ["-C", ROOT, "worktree", "add", "--detach", worktree, commit], {
		encoding: "utf8",
	});
	assert.equal(added.status, 0, `cannot check out ${commit} (needs full history): ${added.stderr}`);
	worktrees.push(worktree);
	// Historical builds use a subset of today's runtime dependencies.
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(worktree, "node_modules"));
	return worktree;
};

const rpc = (socketPath: string, message: unknown) =>
	new Promise<{ ok: boolean; result?: unknown; error?: { code: string } }>((resolve, reject) => {
		const connection = net.createConnection(socketPath);
		let buffer = "";
		connection.setEncoding("utf8");
		connection.once("error", reject);
		connection.once("connect", () => connection.write(`${JSON.stringify(message)}\n`));
		connection.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			connection.end();
			resolve(JSON.parse(buffer.slice(0, newline)));
		});
	});

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("current launcher against released daemon builds", () => {
	for (const build of HISTORICAL_BUILDS) {
		test(`replaces ${build.commit} (${build.label}) and keeps its sessions`, async () => {
			const worktree = checkOut(build.commit);
			const home = fs.mkdtempSync(path.join(scratch, "home-"));
			const stateDir = path.join(home, "state");
			const socketPath = path.join(home, "premind.sock");
			const env = { ...process.env, PREMIND_STATE_DIR: stateDir, PREMIND_SOCKET_PATH: socketPath };

			const old = spawn(process.execPath, ["--import", "tsx", path.join(worktree, "src/daemon/index.ts")], {
				cwd: worktree,
				env,
				stdio: "ignore",
			});
			processes.push(old);
			for (let attempt = 0; attempt < 150 && !(await isSocketReachable(socketPath)); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const oldPid = readDaemonLockOwner(stateDir)?.pid;
			assert.ok(oldPid, `${build.commit} started and holds the daemon lock`);

			const v1 = (type: string, payload: unknown) =>
				rpc(socketPath, { type, protocolVersion: 1, payload });
			const legacySession = {
				clientId: "legacy-client",
				sessionId: "legacy-session",
				host: "pi",
				repo: "acme/repo",
				branch: "main",
				isPrimary: true,
				status: "active",
				busyState: "idle",
			};
			assert.equal((await v1("registerClient", { clientId: "legacy-client", metadata: { pid: process.pid, projectRoot: home } })).ok, true);
			assert.equal((await v1("registerSession", legacySession)).ok, true);
			assert.equal((await v1("subscribe", { sessionId: "legacy-session", repo: "acme/repo", prNumber: 7 })).ok, true);

			await createDaemonLauncher({
				daemonEntry: CURRENT_DAEMON,
				socketPath,
				stateDir,
				nodeExecutable: process.execPath,
				env: { NODE_PATH: "" },
				startupTimeoutMs: 15_000,
				retryMs: 50,
			})();
			const newPid = readDaemonLockOwner(stateDir)?.pid;
			assert.ok(newPid);
			assert.notEqual(newPid, oldPid, "the current daemon replaced the old one");
			assert.equal(isAlive(oldPid!), false, "the old daemon exited");
			daemonPids.push(newPid);

			if (build.bridges) {
				assert.match(
					fs.readFileSync(path.join(stateDir, "premind.db"), "utf8"),
					/^PREMIND_STORAGE_QUARANTINED_V1/,
					"the legacy database path is quarantined",
				);
			}
			const database = new DatabaseSync(path.join(stateDir, "epochs", "1", "premind.db"), { readOnly: true });
			try {
				assert.deepEqual(
					database.prepare("SELECT session_id FROM sessions").all().map((row) => row.session_id),
					["legacy-session"],
				);
				assert.deepEqual(
					database
						.prepare("SELECT pr_number, state FROM session_subscriptions WHERE session_id = 'legacy-session'")
						.all()
						.map((row) => ({ ...row })),
					[{ pr_number: 7, state: "active" }],
				);
			} finally {
				database.close();
			}

			// The old client keeps working through the frozen protocol-v1 proxy.
			const reregistered = await v1("registerSession", legacySession);
			assert.equal(reregistered.ok, true, JSON.stringify(reregistered));
			const status = (await v1("debugStatus", {})) as { ok: boolean; result?: { sessions?: Array<{ sessionId: string; status: string }> } };
			assert.equal(status.ok, true);
			assert.equal(
				status.result?.sessions?.find((session) => session.sessionId === "legacy-session")?.status,
				"active",
			);

			// A current client negotiates protocol v2 on the new daemon.
			const client = new PremindDaemonClient({ host: "pi", socketPath, ensureDaemon: async () => {} });
			await client.registerClient(home, "compat");
			assert.equal(client.selectedProtocolVersion, 2);
			await client.release();
			process.kill(newPid!, "SIGTERM");
		});
	}
});
