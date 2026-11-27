import assert from "node:assert/strict"
import { test } from "node:test"
import { startFakeModel } from "./fake-model.ts"

const complete = async (url: string, body: unknown) => {
	const response = await fetch(`${url}/chat/completions`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	})
	return response.text()
}

test("fake model answers from its script and records agent turns", async (t) => {
	const model = await startFakeModel()
	t.after(() => model.close())
	model.reply({ toolCalls: [{ name: "premind_status", arguments: {} }] })
	const first = await complete(model.url, { messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "premind_status" } }] })
	assert.match(first, /"name":"premind_status"/)
	assert.match(first, /"finish_reason":"tool_calls"/)
	const second = await complete(model.url, { messages: [{ role: "user", content: [{ type: "text", text: "again" }] }] })
	assert.match(second, /"content":"ok"/)
	assert.deepEqual(model.userMessages(), ["hello", "again"])
})

test("fake model answers a host's auxiliary requests without using the script", async (t) => {
	const model = await startFakeModel({ isAuxiliary: (request) => (request.tools?.length ? undefined : "A title") })
	t.after(() => model.close())
	model.reply({ text: "scripted" })
	assert.match(await complete(model.url, { messages: [{ role: "user", content: "name this" }] }), /"content":"A title"/)
	assert.match(await complete(model.url, { messages: [{ role: "user", content: "turn" }], tools: [{ type: "function", function: { name: "x" } }] }), /"content":"scripted"/)
	assert.deepEqual(model.userMessages(), ["turn"])
})

test("fake model holds a reply until its gate opens", async (t) => {
	const model = await startFakeModel()
	t.after(() => model.close())
	let open!: () => void
	model.reply({ text: "late", waitFor: new Promise<void>((resolve) => { open = resolve }) })
	let settled = false
	const pending = complete(model.url, { messages: [] }).then((body) => { settled = true; return body })
	await new Promise((resolve) => setTimeout(resolve, 100))
	assert.equal(settled, false)
	open()
	assert.match(await pending, /"content":"late"/)
})
