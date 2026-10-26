import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { startScriptedGitHub } from "./github.ts"
import { startNativeProcess } from "./process.ts"
import { startNativePi } from "./pi.ts"
import { startScriptedProvider } from "./provider.ts"
import { createNativeSandbox } from "./sandbox.ts"

/** Deliberate storage fault only: never used to implement registration/recovery. */
function loseRegistration(database: DatabaseSync, sessionId: string) {
	const epoch = database.prepare("SELECT storage_epoch FROM storage_metadata WHERE singleton = 1").get()?.storage_epoch
	assert.equal(epoch, 1, "this scenario must not cross a storage authority epoch")
	database.function("premind_expected_storage_epoch", () => epoch as number)
	// Lose only registration, not a normal cascading deletion. Durable adjunct
	// state and the existing lease intentionally survive this injected fault.
	database.exec("PRAGMA foreign_keys = OFF")
	try {
		assert.equal(database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId).changes, 1)
	} finally { database.exec("PRAGMA foreign_keys = ON") }
	assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId)?.n, 0)
}

function retainedState(database: DatabaseSync, sessionId: string) {
	return {
		lease: database.prepare("SELECT owner_instance_id, generation, client_incarnation_nonce FROM session_daemon_leases WHERE session_id = ?").get(sessionId),
		pause: database.prepare("SELECT * FROM session_pauses WHERE session_id = ?").get(sessionId),
		binding: database.prepare("SELECT * FROM worktree_bindings WHERE session_id = ?").get(sessionId),
		subscription: database.prepare("SELECT subscription_id, state, last_delivered_event_seq FROM session_subscriptions WHERE session_id = ? AND pr_number = 17").get(sessionId),
	}
}

test("live native Pi repairs missing registration before retrying subscribe", { timeout: 40_000 }, async (t) => {
	const packageRoot = process.env.PREMIND_NATIVE_PACKAGE
	assert.ok(packageRoot && path.isAbsolute(packageRoot), "PREMIND_NATIVE_PACKAGE must name an extracted dependency-installed npm artifact")
	const sandbox = createNativeSandbox()
	let github: Awaited<ReturnType<typeof startScriptedGitHub>> | undefined
	let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined
	let daemon: ReturnType<typeof startNativeProcess> | undefined
	let pi: Awaited<ReturnType<typeof startNativePi>> | undefined
	let database: DatabaseSync | undefined
	t.after(async () => {
		try { database?.close(); if (pi) await pi.process.stop() }
		finally { try { if (daemon) await daemon.stop() } finally {
			try { await Promise.all([provider?.stop(), github?.stop()]) } finally { sandbox.dispose() }
		} }
	})
	github = await startScriptedGitHub(sandbox)
	provider = await startScriptedProvider(`registration-loss-${randomUUID()}`)
	daemon = startNativeProcess({
		label: "packed registration-loss daemon", command: process.execPath,
		args: ["--import", github.preload, path.join(packageRoot, "plugin-claude/generated/premind-daemon.mjs")],
		cwd: sandbox.workspace, env: github.env,
	})
	await daemon.waitForOutput('"message":"listening"', 10_000)
	pi = await startNativePi({ ...sandbox, env: github.env }, {
		providerUrl: provider.baseUrl, extension: path.join(packageRoot, "extensions/premind.ts"),
	})
	provider.queueToolCall("premind_subscribe", { prNumber: 17, repo: "native/fixture" })
	await pi.promptAndWait("Subscribe to native/fixture pull request 17 using the premind tool.")
	provider.queueToolCall("premind_pause", {})
	await pi.promptAndWait("Pause reminders for this session using the premind tool.")
	database = new DatabaseSync(path.join(sandbox.state, "epochs", "1", "premind.db"))
	const session = database.prepare("SELECT session_id FROM sessions WHERE host = 'pi' AND status = 'active'").get()
	assert.ok(session && typeof session.session_id === "string", "initial native registration must succeed")
	const retained = retainedState(database, session.session_id)
	assert.ok(retained.lease && retained.pause && retained.subscription, "native controls must establish retained state before the fault")
	// No Git binding in this isolated workspace; recovery must not invent one.
	const pid = pi.process.child.pid
	loseRegistration(database, session.session_id)
	assert.equal(pi.process.child.exitCode, null)

	provider.queueToolCall("premind_subscribe", { prNumber: 18, repo: "native/fixture" })
	await pi.promptAndWait("Subscribe to native/fixture pull request 18 using the premind tool.")
	const response = await pi.rpc.request({ type: "get_messages" }) as { messages: Array<{ role?: string; toolName?: string; isError?: boolean; content?: unknown }> }
	const results = response.messages.filter((message) => message.role === "toolResult" && message.toolName === "premind_subscribe")
	assert.equal(results.length, 2, "both real model tool calls must execute")
	assert.equal(results[1].isError, false, `subscribe must recover instead of failing: ${JSON.stringify(results[1].content)}`)
	assert.equal(pi.process.child.pid, pid, "recovery must not restart the host")
	assert.equal(database.prepare("SELECT COUNT(*) AS n FROM session_subscriptions WHERE session_id = ? AND pr_number = 18 AND state = 'active'").get(session.session_id)?.n, 1)
	assert.deepEqual(retainedState(database, session.session_id), retained, "repair must retain lease authority, pause, worktree binding, and the prior subscription cursor")
})
