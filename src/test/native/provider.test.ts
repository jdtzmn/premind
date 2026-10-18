import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { startScriptedProvider } from "./provider.ts"

async function complete(baseUrl: string, payload: Record<string, unknown>) {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ stream: true, messages: [], ...payload }), signal: AbortSignal.timeout(2_000),
	})
	assert.equal(response.status, 200)
	return response.text()
}

test("scripted receipt requires the exact marker in model-visible content", async (t) => {
	const marker = `native-${randomUUID()}`
	const provider = await startScriptedProvider(marker)
	t.after(() => provider.stop())
	for (const messages of [[], [{ role: "user", content: "wrong marker" }]]) {
		assert.ok(!(await complete(provider.baseUrl, { messages })).includes(provider.receipt))
	}
	const response = await complete(provider.baseUrl, { messages: [{ role: "user", content: `Reminder: ${marker}` }] })
	assert.ok(response.includes(provider.receipt))
	assert.ok(response.endsWith("data: [DONE]\n\n"))
	assert.deepEqual(provider.observations.map((row) => row.markerObserved), [false, false, true])
})

test("metadata and tool schemas cannot counterfeit reminder consumption", async (t) => {
	const marker = `native-${randomUUID()}`
	const provider = await startScriptedProvider(marker)
	t.after(() => provider.stop())
	const response = await complete(provider.baseUrl, { model: marker, tools: [{ description: marker }], messages: [{ role: "user", content: [{ type: "image_url", text: marker }] }] })
	assert.ok(!response.includes(provider.receipt))
	assert.ok((await complete(provider.baseUrl, { messages: [{ role: "user", content: [{ type: "text", text: marker }] }] })).includes(provider.receipt))
})

test("scripted tools use real streamed OpenAI-compatible tool call frames", async (t) => {
	const provider = await startScriptedProvider(`native-${randomUUID()}`)
	t.after(() => provider.stop())
	provider.queueToolCall("premind_subscribe", { repo: "fixture/repo", prNumber: 123 })
	const frames = (await complete(provider.baseUrl, {})).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)))
	const tool = frames[0].choices[0].delta.tool_calls[0]
	assert.equal(tool.function.name, "premind_subscribe")
	assert.deepEqual(JSON.parse(tool.function.arguments), { repo: "fixture/repo", prNumber: 123 })
	assert.equal(frames[1].choices[0].finish_reason, "tool_calls")
})
