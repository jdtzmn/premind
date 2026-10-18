import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { startScriptedProvider } from "./provider.ts"

test("a historical assistant receipt cannot counterfeit a new reminder observation", async (t) => {
	const marker = `fresh-${randomUUID()}`
	const provider = await startScriptedProvider(marker)
	t.after(() => provider.stop())
	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2000),
		body: JSON.stringify({ stream: true, messages: [
			{ role: "assistant", content: provider.receipt },
			{ role: "user", content: "An unrelated next turn" },
		] }),
	})
	assert.equal(response.status, 200)
	assert.ok(!(await response.text()).includes(provider.receipt))
	assert.deepEqual(provider.observations, [{ markerObserved: false }])
})
