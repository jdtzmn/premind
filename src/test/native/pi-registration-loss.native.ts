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
	// Production write-fencing triggers require this connection-local function,
	// including when SQLite prepares statements against an epoch-one database.
	database.function("premind_expected_storage_epoch", () => epoch as number)
	assert.equal(database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId).changes, 1)
	assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId)?.n, 0)
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
	database = new DatabaseSync(path.join(sandbox.state, "epochs", "1", "premind.db"))
	const session = database.prepare("SELECT session_id FROM sessions WHERE host = 'pi' AND status = 'active'").get()
	assert.ok(session && typeof session.session_id === "string", "initial native registration must succeed")
	assert.equal(database.prepare("SELECT COUNT(*) AS n FROM session_subscriptions WHERE session_id = ? AND pr_number = 17").get(session.session_id)?.n, 1)
	const pid = pi.process.child.pid
	// Missing registration, not a user deletion or full database replacement.
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
})
