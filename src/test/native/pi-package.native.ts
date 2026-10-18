import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { startScriptedGitHub } from "./github.ts"
import { startNativeProcess } from "./process.ts"
import { startNativePi } from "./pi.ts"
import { startScriptedProvider } from "./provider.ts"
import { createNativeSandbox } from "./sandbox.ts"

async function assertConfirmedDelivery(database: DatabaseSync, marker: string) {
	const event = database.prepare("SELECT seq FROM pr_events WHERE repo = 'native/fixture' AND pr_number = 17 AND payload_json LIKE ?").get(`%${marker}%`)
	assert.ok(event && typeof event.seq === "number", "production watcher must persist the external event")
	const deadline = Date.now() + 2000
	let cursor: unknown
	do {
		cursor = database.prepare("SELECT last_delivered_event_seq AS cursor FROM session_subscriptions WHERE repo = 'native/fixture' AND pr_number = 17 AND state = 'active'").get()?.cursor
		if (typeof cursor === "number" && cursor >= event.seq) break
		await delay(25)
	} while (Date.now() < deadline)
	assert.ok(typeof cursor === "number" && cursor >= event.seq, "confirmed subscription cursor must cover the consumed event")
	assert.ok(Number(database.prepare("SELECT COUNT(*) AS n FROM reminder_handoff_settlements WHERE settlement_state = 'confirmed'").get()?.n) >= 1)
}

// Explicit packaged integration and public host operations, never source fallback.
test("packed Premind delivers an external PR comment through Pi's native delivery command", { timeout: 100_000 }, async (t) => {
	const packageRoot = process.env.PREMIND_NATIVE_PACKAGE
	assert.ok(packageRoot && path.isAbsolute(packageRoot), "PREMIND_NATIVE_PACKAGE must name an absolute extracted, dependency-installed npm package")
	const sandbox = createNativeSandbox()
	let daemon: ReturnType<typeof startNativeProcess> | undefined
	let pi: Awaited<ReturnType<typeof startNativePi>> | undefined
	let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined
	let github: Awaited<ReturnType<typeof startScriptedGitHub>> | undefined
	let database: DatabaseSync | undefined
	t.after(async () => {
		try { database?.close(); if (pi) await pi.process.stop() }
		finally { try { if (daemon) await daemon.stop() } finally {
			try { await Promise.all([provider?.stop(), github?.stop()]) } finally { sandbox.dispose() }
		} }
	})
	const marker = `native-reminder-${randomUUID()}`
	provider = await startScriptedProvider(marker)
	github = await startScriptedGitHub(sandbox)
	daemon = startNativeProcess({
		label: "packed production daemon", command: process.execPath,
		args: ["--import", github.preload, path.join(packageRoot, "plugin-claude/generated/premind-daemon.mjs")],
		cwd: sandbox.workspace, env: github.env,
	})
	try {
		await daemon.waitForOutput('"message":"listening"', 10_000)
		pi = await startNativePi({ ...sandbox, env: github.env }, {
			providerUrl: provider.baseUrl, extension: path.join(packageRoot, "extensions/premind.ts"),
		})
		const commands = await pi.rpc.request({ type: "get_commands" }) as { commands: Array<{ name: string }> }
		assert.ok(commands.commands.some((command) => command.name === "premind:subscribe"), "packed Premind must actually load")
		provider.queueToolCall("premind_subscribe", { prNumber: 17, repo: "native/fixture" })
		assert.deepEqual(await pi.promptAndWait("Subscribe to native/fixture pull request 17 using the premind tool."), { text: "No reminder marker observed." })
		await github.waitForSnapshot(1)
		assert.ok(provider.observations.every((row) => !row.markerObserved), "marker must be absent before external update")
		database = new DatabaseSync(path.join(sandbox.state, "epochs", "1", "premind.db"), { readOnly: true })

		// Only the external comment supplies the fresh marker. Autonomous idle
		// delivery is NOT established by this explicit public-command scenario.
		const receiptText = provider.receipt
		const receipt = pi.rpc.waitFor((event) => {
			const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined
			return event.type === "message_end" && message?.role === "assistant" &&
				message.content?.some((part) => part.type === "text" && part.text === receiptText) === true
		}, 70_000)
		github.publishComment(marker)
		await Promise.all([receipt, (async () => {
			await github!.waitForSnapshot(2)
			await pi!.rpc.request({ type: "prompt", message: "/premind:deliver" })
		})()])
		assert.ok(provider.observations.some((row) => row.markerObserved), "the real model request must contain the fresh marker")
		await assertConfirmedDelivery(database, marker)
		assert.equal((await pi.stop()).code, 0)
		pi = undefined
	} catch (error) {
		t.diagnostic(JSON.stringify({ snapshots: github.snapshots, observations: provider.observations,
			events: database?.prepare("SELECT seq, kind, summary FROM pr_events").all(),
			subscriptions: database?.prepare("SELECT repo, pr_number, state, last_delivered_event_seq FROM session_subscriptions").all(),
			batches: database?.prepare("SELECT state, max_event_seq FROM reminder_batches").all(),
			daemon: daemon.output, pi: pi?.process.output.stderr }))
		throw error
	}
})
