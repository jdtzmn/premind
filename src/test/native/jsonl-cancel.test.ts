import assert from "node:assert/strict"
import { test } from "node:test"
import { nativeJsonl } from "./jsonl.ts"
import { startNativeProcess } from "./process.ts"
import { createNativeSandbox } from "./sandbox.ts"

test("unused JSONL event waits can be cancelled without poisoning later responses", { timeout: 2000 }, async (t) => {
	const sandbox = createNativeSandbox()
	const process = startNativeProcess({ label: "cancellable RPC fixture", command: globalThis.process.execPath,
		args: ["-e", 'process.stdin.on("data", data => { for(const line of data.toString().trim().split("\\n")) { const c = JSON.parse(line); console.log(JSON.stringify({type:"response",id:c.id,success:true,data:{ok:true}})) } })'],
		cwd: sandbox.workspace, env: sandbox.env })
	t.after(async () => { try { await process.stop() } finally { sandbox.dispose() } })
	const rpc = nativeJsonl(process)
	const controller = new AbortController()
	const pending = rpc.waitFor(() => false, 10_000, controller.signal)
	const rejected = assert.rejects(pending, /Native JSONL wait aborted/)
	controller.abort()
	await rejected
	await assert.rejects(rpc.waitFor(() => false, 10_000, controller.signal), /Native JSONL wait aborted/)
	assert.deepEqual(await rpc.request({ type: "get_state" }), { ok: true })
})
