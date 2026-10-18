import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { startNativePi } from "./pi.ts"
import { startScriptedProvider } from "./provider.ts"
import { createNativeSandbox } from "./sandbox.ts"

// Requires actual installed Pi. No skip/fallback and no Premind-delivery claim:
// this proves only native RPC, model transport, persistence and process resume.
test("real Pi consumes streamed model responses and resumes its native session", { timeout: 30_000 }, async (t) => {
	const sandbox = createNativeSandbox()
	let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined
	let pi: Awaited<ReturnType<typeof startNativePi>> | undefined
	// Own cleanup before the first fallible asynchronous fixture startup.
	t.after(async () => {
		try { if (pi) await pi.process.stop() }
		finally { try { if (provider) await provider.stop() } finally { sandbox.dispose() } }
	})
	const marker = `native-${randomUUID()}`
	provider = await startScriptedProvider(marker)
	pi = await startNativePi(sandbox, { providerUrl: provider.baseUrl })
	assert.deepEqual(await pi.rpc.request({ type: "get_commands" }), { commands: [] })
	assert.deepEqual(await pi.promptAndWait("Return the fixture response."), { text: "No reminder marker observed." })
	assert.deepEqual(await pi.promptAndWait(`Transport control: ${marker}`), { text: provider.receipt })
	const state = await pi.rpc.request({ type: "get_state" }) as { sessionFile: string; isStreaming: boolean }
	assert.equal(state.isStreaming, false)
	assert.ok(state.sessionFile.startsWith(sandbox.root))
	assert.equal((await pi.stop()).code, 0)
	pi = undefined
	pi = await startNativePi(sandbox, { providerUrl: provider.baseUrl, sessionFile: state.sessionFile })
	assert.deepEqual(await pi.promptAndWait("Confirm the restored context."), { text: provider.receipt })
	assert.equal((await pi.stop()).code, 0)
	pi = undefined
	assert.deepEqual(provider.observations.map((row) => row.markerObserved), [false, true, true])
})
