import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { nativeJsonl } from "./jsonl.ts"
import { startNativeProcess } from "./process.ts"
import { createNativeSandbox } from "./sandbox.ts"

function fixture(t: TestContext, source: string) {
	const sandbox = createNativeSandbox()
	const process = startNativeProcess({ label: "JSONL fixture", command: globalThis.process.execPath,
		args: ["-e", source], cwd: sandbox.workspace, env: sandbox.env })
	t.after(async () => { try { await process.stop() } finally { sandbox.dispose() } })
	return { process, rpc: nativeJsonl(process) }
}

test("JSONL commands correlate responses and preserve Unicode separators", async (t) => {
	const { rpc } = fixture(t, `process.stdin.on("data", data => {
		for (const line of data.toString().trim().split("\\n")) {
			const command = JSON.parse(line);
			process.stdout.write(JSON.stringify({type:"response", id:command.id, success:true, data:command.value}) + "\\r\\n");
		}
	})`)
	assert.deepEqual(await Promise.all([
		rpc.request({ type: "get_state", value: "first\u2028second\u2029third" }),
		rpc.request({ type: "get_state", value: "independent" }),
	]), ["first\u2028second\u2029third", "independent"])
})

test("JSONL waits reject on exit, malformed data, oversize records, and deadlines", async (t) => {
	for (const [source, expected] of [
		["process.exit(1)", /Native host exited/],
		['console.log("not-json")', /Invalid native JSONL/],
		['process.stdout.write("x".repeat(262145))', /exceeds limit/],
	] as const) {
		const { rpc } = fixture(t, source)
		await assert.rejects(rpc.waitFor(() => true, 2_000), expected)
	}
	const { rpc } = fixture(t, "setInterval(() => {}, 1000)")
	await assert.rejects(rpc.waitFor(() => true, 20), /timed out/)
})

test("JSONL listener installed before command cannot miss immediate host events", { timeout: 2_000 }, async (t) => {
	const { rpc, process } = fixture(t, 'process.stdin.once("data", () => { console.log(JSON.stringify({type:"agent_settled"})); process.stdin.destroy() })')
	const settled = rpc.waitFor((event) => event.type === "agent_settled")
	// EOF is not leader exit. Observe both before the process-group cleanup.
	await assert.rejects(rpc.request({ type: "prompt" }), /exited/)
	assert.equal((await settled).type, "agent_settled")
	await assert.rejects(rpc.waitFor((event) => event.type === "agent_settled"), /exited/)
	assert.equal((await process.exited).code, 0)
})

test("JSONL response failure does not become command success", async (t) => {
	const { rpc } = fixture(t, 'process.stdin.once("data", data => { const command=JSON.parse(data); console.log(JSON.stringify({type:"response", id:command.id, success:false})); process.stdin.destroy() })')
	await assert.rejects(rpc.request({ type: "prompt" }), /Native RPC command failed: prompt/)
})
