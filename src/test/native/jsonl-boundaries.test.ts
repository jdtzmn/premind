import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { nativeJsonl } from "./jsonl.ts"
import { startNativeProcess } from "./process.ts"
import { createNativeSandbox } from "./sandbox.ts"

function fixture(t: TestContext, source: string) {
	const sandbox = createNativeSandbox()
	const process = startNativeProcess({ label: "JSONL boundary", command: globalThis.process.execPath,
		args: ["-e", source], cwd: sandbox.workspace, env: sandbox.env })
	t.after(async () => { try { await process.stop() } finally { sandbox.dispose() } })
	return nativeJsonl(process)
}

test("JSONL drains final responses before treating host exit as EOF", async (t) => {
	const rpc = fixture(t, 'process.stdin.once("data", data => { const {id}=JSON.parse(data); process.stdout.end(JSON.stringify({type:"response", id, success:true, data:"x".repeat(200000)}) + "\\n"); process.stdin.destroy() })')
	assert.equal(await rpc.request({ type: "get_messages" }), "x".repeat(200000))
})

test("truncated EOF and invalid local requests cannot become valid records", async (t) => {
	const rpc = fixture(t, 'process.stdout.end(JSON.stringify({type:"agent_settled"}))')
	await assert.rejects(rpc.request({ type: "prompt", value: "x".repeat(262145) }), /command exceeds limit/)
	await assert.rejects(rpc.waitFor(() => true, 2_000), /Truncated native JSONL record/)
	await assert.rejects(rpc.request({ type: "prompt" }), /Truncated native JSONL record/)
})
