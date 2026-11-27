import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createNativeSandbox } from "./sandbox.ts"
import { startNativeProcess } from "./process.ts"

function fixture(t: TestContext, source: string, outputLimit?: number) {
	const sandbox = createNativeSandbox()
	const process = startNativeProcess({
		label: "fixture", command: globalThis.process.execPath, args: ["-e", source],
		cwd: sandbox.workspace, env: sandbox.env, outputLimit,
	})
	t.after(async () => { try { await process.stop() } finally { sandbox.dispose() } })
	return process
}

test("native process readiness observes real stdout and uses the isolated environment", async (t) => {
	const process = fixture(t, 'console.log(process.env.HOME); console.error("stderr-ready"); setInterval(() => {}, 1000)')
	await process.waitForOutput("/home", 2_000)
	await process.waitForOutput("stderr-ready", 2_000, "stderr")
	assert.ok(process.child.pid)
	assert.equal(process.output.stdout.includes(globalThis.process.env.HOME!), false)
	await process.stop()
	await process.stop()
	assert.ok((await process.exited).signal)
})

test("readiness fails when the process exits before its marker", async (t) => {
	const process = fixture(t, "process.exit(7)")
	await assert.rejects(process.waitForOutput("never", 2_000), /exited before readiness.*7/)
	assert.equal((await process.exited).code, 7)
})

test("readiness deadline cannot turn an idle process into success", async (t) => {
	const process = fixture(t, 'console.log("ready"); setInterval(() => {}, 1000)')
	await process.waitForOutput("ready", 2_000)
	await assert.rejects(process.waitForOutput("missing", 20), /readiness timed out/)
	assert.throws(() => process.waitForOutput("ready", 0), /Invalid deadline/)
})

test("stdout and stderr diagnostic tails are bounded", async (t) => {
	const process = fixture(t, 'console.log("x".repeat(100000) + "tail"); console.error("y".repeat(100000) + "end"); setInterval(() => {}, 1000)', 128)
	await process.waitForOutput("tail", 2_000)
	await process.waitForOutput("end", 2_000, "stderr")
	assert.ok(process.output.stdout.length <= 128)
	assert.ok(process.output.stderr.length <= 128)
})

test("a missing executable fails readiness rather than hanging", async (t) => {
	const sandbox = createNativeSandbox()
	const process = startNativeProcess({ label: "absent", command: "/nonexistent/native-agent", cwd: sandbox.workspace, env: sandbox.env })
	t.after(async () => { try { await process.stop() } finally { sandbox.dispose() } })
	await assert.rejects(process.waitForOutput("ready", 2_000), /exited before readiness.*ENOENT/)
})

test("shutdown forcibly reaps a process that ignores SIGTERM", async (t) => {
	const process = fixture(t, 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)')
	await process.waitForOutput("ready", 2_000)
	await process.stop(20)
	assert.equal((await process.exited).signal, "SIGKILL")
})
