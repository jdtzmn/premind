import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { startNativePi } from "./pi.ts"
import { startScriptedProvider } from "./provider.ts"
import { createNativeSandbox } from "./sandbox.ts"

test("native Pi handled commands fail the model-only helper promptly without poisoning later turns", { timeout: 15_000 }, async (t) => {
	const sandbox = createNativeSandbox()
	let pi: Awaited<ReturnType<typeof startNativePi>> | undefined
	let provider: Awaited<ReturnType<typeof startScriptedProvider>> | undefined
	t.after(async () => {
		try { if (pi) await pi.process.stop() }
		finally { try { await provider?.stop() } finally { sandbox.dispose() } }
	})
	provider = await startScriptedProvider(`handled-${randomUUID()}`)
	const extension = path.join(sandbox.root, "handled.mjs")
	writeFileSync(extension, 'export default api => api.registerCommand("native-handled", {description:"Handled without model", handler:async () => {}})\n')
	pi = await startNativePi(sandbox, { providerUrl: provider.baseUrl, extension })
	await assert.rejects(pi.promptAndWait("/native-handled"), /handled without starting a model run/)
	assert.equal(provider.observations.length, 0)
	assert.deepEqual(await pi.promptAndWait("Nothing to consume."), { text: "No reminder marker observed." })
	assert.equal((await pi.stop()).code, 0)
	pi = undefined
})
