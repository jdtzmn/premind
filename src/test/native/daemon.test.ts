import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { premindHarnesses } from "../../shared/command-capabilities.ts"
import { protocolV2ResponseSchema } from "../../shared/protocol/v2.ts"
import { startNativeDaemon } from "./daemon.ts"
import { nativeIpcRequest } from "./ipc.ts"
import { createNativeSandbox } from "./sandbox.ts"

test("production daemon bootstraps all four host identities over actual sockets", { timeout: 20_000 }, async (t) => {
	const sandbox = createNativeSandbox()
	let daemon: Awaited<ReturnType<typeof startNativeDaemon>> | undefined
	t.after(async () => { try { await daemon?.stop() } finally { sandbox.dispose() } })
	daemon = await startNativeDaemon(sandbox)
	for (const host of premindHarnesses) {
		const bootstrap = await daemon.bootstrap(host)
		assert.equal(bootstrap.daemon.pid, daemon.process.child.pid)
		assert.equal(bootstrap.protocols.selected, 2)
		assert.equal(bootstrap.daemon.lifecycleState, "ready")
		assert.ok(bootstrap.daemon.socketPath.startsWith(sandbox.root))
		const status = protocolV2ResponseSchema.parse(await nativeIpcRequest(bootstrap.daemon.socketPath, {
			type: "debugStatus", protocolVersion: 2, payload: {},
		}))
		assert.equal(status.ok, true)
		assert.equal(status.protocolVersion, 2)
	}
	assert.ok(existsSync(path.join(sandbox.state, "epochs", "1", "premind.db")))
})

test("real daemon restart preserves registered sessions and subscriptions in SQLite", { timeout: 30_000 }, async (t) => {
	const sandbox = createNativeSandbox()
	let daemon: Awaited<ReturnType<typeof startNativeDaemon>> | undefined
	t.after(async () => { try { await daemon?.stop() } finally { sandbox.dispose() } })
	daemon = await startNativeDaemon(sandbox)
	const client = await daemon.legacyRequest("registerClient", {
		clientId: "native-fixture", metadata: { pid: process.pid, projectRoot: sandbox.workspace },
	}) as { ok: boolean }
	assert.equal(client.ok, true, JSON.stringify(client))
	for (const host of premindHarnesses) {
		const registration = await daemon.legacyRequest("registerSession", {
			clientId: "native-fixture", sessionId: `native-${host}`, host,
			repo: "fixture/repo", branch: "main", isPrimary: true, status: "active", busyState: "idle",
		}) as { ok: boolean }
		assert.equal(registration.ok, true, JSON.stringify(registration))
		const subscription = await daemon.legacyRequest("subscribe", {
			sessionId: `native-${host}`, repo: "fixture/repo", prNumber: 123,
		}) as { ok: boolean }
		assert.equal(subscription.ok, true, JSON.stringify(subscription))
	}
	const before = (await daemon.bootstrap("pi")).daemon.instanceId
	await daemon.stop()
	daemon = await startNativeDaemon(sandbox)
	assert.notEqual((await daemon.bootstrap("pi")).daemon.instanceId, before)
	const database = new DatabaseSync(path.join(sandbox.state, "epochs", "1", "premind.db"), { readOnly: true })
	try {
		assert.deepEqual(database.prepare("SELECT session_id FROM sessions ORDER BY session_id").all().map((row) => row.session_id),
			premindHarnesses.map((host) => `native-${host}`).sort())
		assert.equal(database.prepare("SELECT COUNT(*) AS n FROM session_subscriptions WHERE pr_number = 123").get()?.n, 4)
	} finally { database.close() }
})
