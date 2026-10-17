import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyInstallArtifact } from "./verify-install-artifact.mjs";

const directory = process.argv[2] && path.resolve(process.argv[2]);
if (!directory) throw new Error("Usage: node scripts/test-dist.mjs <dist-directory>");
const metadata = verifyInstallArtifact(directory);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "premind-dist-test-"));
try {
	const codex = path.join(temporary, "codex");
	const claude = path.join(temporary, "claude");
	fs.mkdirSync(codex);
	fs.mkdirSync(claude);
	for (const [host, target] of [["codex", codex], ["claude", claude]]) {
		const result = spawnSync("tar", ["-xzf", path.join(directory, metadata.archives[host].file), "-C", target], { encoding: "utf8" });
		if (result.error) throw result.error;
		assert.equal(result.status, 0, result.stderr);
	}

	const isolatedEnvironment = {
		...process.env,
		PLUGIN_DATA: path.join(temporary, "plugin-data"),
		PREMIND_SOCKET_PATH: path.join(temporary, "premind.sock"),
		PREMIND_STATE_DIR: path.join(temporary, "state"),
	};
	const mcp = spawnSync(process.execPath, [path.join(codex, "plugins/codex/premind/generated/premind-mcp.mjs")], {
		cwd: temporary,
		encoding: "utf8",
		env: isolatedEnvironment,
		input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
		timeout: 10_000,
	});
	if (mcp.error) throw mcp.error;
	assert.equal(mcp.status, 0, mcp.stderr);
	const replies = mcp.stdout.trim().split("\n").map(JSON.parse);
	assert.equal(replies.find((reply) => reply.id === 1)?.result?.protocolVersion, "2025-06-18");
	assert.ok(replies.find((reply) => reply.id === 2)?.result?.tools?.some((tool) => tool.name === "premind_status"));

	const hook = spawnSync(process.execPath, [path.join(codex, "plugins/codex/premind/generated/premind-hook.mjs"), "SessionEnd"], {
		cwd: temporary,
		encoding: "utf8",
		env: isolatedEnvironment,
		input: `${JSON.stringify({ session_id: "dist-validation", transcript_path: null, cwd: temporary, model: "test", hook_event_name: "SessionEnd", reason: "other" })}\n`,
		timeout: 10_000,
	});
	if (hook.error) throw hook.error;
	assert.equal(hook.status, 0, hook.stderr);
	assert.equal(hook.stdout.trim(), "");
	for (const file of ["generated/premind-daemon.mjs", "generated/daemon-startup.mjs", "bin/mcp-server.mjs"]) {
		const checked = spawnSync(process.execPath, ["--check", path.join(claude, file)], { encoding: "utf8", timeout: 10_000 });
		if (checked.error) throw checked.error;
		assert.equal(checked.status, 0, checked.stderr);
	}
	process.stdout.write(`PASS: tested released dist archives from ${metadata.sourceCommit}\n`);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}
