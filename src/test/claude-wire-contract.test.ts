import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	createClaudeHandoffStore,
	handleHook,
	request,
	// @ts-expect-error The shipped Claude hook runtime is plain JavaScript.
} from "../../plugin-claude/bin/lib.mjs";
import { IpcServer } from "../daemon/ipc/server.ts";
import { StateStore } from "../daemon/persistence/store.ts";
import { LegacyV1GuardServer } from "../shared/protocol/legacy-v1-guard-server.ts";
import { LegacyV1ProxyRouter } from "../shared/protocol/legacy-v1-proxy.ts";

type HookOutput = { hookSpecificOutput: { additionalContext: string } } | undefined;

// Claude's hooks are hand-written JavaScript that speak protocol v1 to the
// historical socket. Drive them over a real socket through the production
// guard and frozen v1 proxy, so any drift between their wire messages and the
// shared contract fails here rather than in a user's Claude session.
test("Claude hooks complete a delivery over the real historical socket", async () => {
	const dir = fs.mkdtempSync(path.join("/tmp", "premind-claude-wire-"));
	const historicalSocketPath = path.join(dir, "premind.sock");
	const instanceSocketPath = path.join(dir, "instance.sock");
	const server = new IpcServer(new StateStore(path.join(dir, "premind.db")));
	server.advertiseSocketPath(instanceSocketPath);
	const guard = new LegacyV1GuardServer(
		new LegacyV1ProxyRouter(server.store, server.daemonInstanceId, (routed) =>
			server.handleRequest(routed),
		),
		(value) => server.bootstrap(value),
	);
	await guard.listen(historicalSocketPath);
	await server.listen(instanceSocketPath);

	const repository = path.join(dir, "repo");
	fs.mkdirSync(repository);
	for (const args of [
		["init", "--quiet"],
		["remote", "add", "origin", "https://github.com/acme/repo.git"],
		["checkout", "--quiet", "-b", "feature/claude-wire"],
	]) {
		assert.equal(spawnSync("git", ["-C", repository, ...args]).status, 0);
	}

	const sessionId = "claude-wire-session";
	const environment = { PREMIND_CLAUDE_HANDOFF_DIR: path.join(dir, "handoffs") };
	const ipc = (type: string, payload: unknown) =>
		request(type, payload, historicalSocketPath);
	// Each hook is a separate Claude process, so each gets a fresh handoff store
	// that shares only the on-disk directory.
	const hook = async (eventName: string, event: Record<string, unknown>) =>
		(await handleHook(
			eventName,
			{ session_id: sessionId, ...event },
			ipc,
			environment,
			createClaudeHandoffStore(environment),
		)) as HookOutput;

	try {
		await hook("SessionStart", { cwd: repository });
		const session = server.store.getSession(sessionId);
		assert.equal(session?.host, "claude");
		assert.equal(session?.repo, "acme/repo");
		assert.equal(session?.branch, "feature/claude-wire");

		await hook("UserPromptSubmit", {});
		assert.equal(server.store.getSession(sessionId)?.busy_state, "busy");

		const batchId = server.store.createOrReplaceReminder(
			sessionId,
			null,
			"acme/repo#7: review changed",
			[],
			0,
		);
		const delivered = await hook("Stop", {});
		assert.match(delivered?.hookSpecificOutput.additionalContext ?? "", /PR update for acme\/repo/);
		assert.equal(server.store.getReminderBatchRecord(batchId, sessionId)?.state, "handed_off");

		// The continuation turn's Stop hook confirms the handoff by its token.
		assert.equal(await hook("Stop", { stop_hook_active: true }), undefined);
		assert.equal(server.store.getReminderBatchRecord(batchId, sessionId), null);
		assert.equal(await hook("Stop", {}), undefined, "nothing left to deliver");

		await hook("SessionEnd", {});
		assert.notEqual(server.store.getSession(sessionId)?.status, "active");
	} finally {
		await guard.close();
		await server.close(instanceSocketPath);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
