import assert from "node:assert/strict"
import { test } from "node:test"
import type { premindActions } from "./actions.ts"
import { premindCommands, runPremindCommand } from "./commands.ts"

type Actions = ReturnType<typeof premindActions>

const recording = () => {
	const calls: unknown[][] = []
	const record = (name: string) => async (...args: unknown[]) => {
		calls.push([name, ...args])
		return `${name} ok`
	}
	const actions = new Proxy({}, { get: (_target, name) => record(String(name)) }) as unknown as Actions
	return { actions, calls }
}

test("parses pull request arguments for subscribe", async () => {
	const { actions, calls } = recording()
	assert.deepEqual(await runPremindCommand(actions, "premind:subscribe", "s1", " #42  acme/widgets "), { ok: true, text: "subscribe ok" })
	assert.deepEqual(calls, [["subscribe", "s1", { prNumber: 42, repo: "acme/widgets" }]])
})

test("reports usage, missing sessions and unknown commands as text", async () => {
	const { actions, calls } = recording()
	assert.deepEqual(await runPremindCommand(actions, "premind:unsubscribe", "s1", "abc"),
		{ ok: false, text: "premind:unsubscribe failed: usage: /premind:unsubscribe <pr> [owner/repo]" })
	assert.deepEqual(await runPremindCommand(actions, "premind:pause", undefined),
		{ ok: false, text: "premind:pause failed: open a session first" })
	assert.deepEqual(await runPremindCommand(actions, "premind:nope", "s1"), { ok: false, text: "premind: unknown command premind:nope" })
	assert.deepEqual(calls, [])
})

test("keeps the V1 aliases pointing at their commands", async () => {
	const { actions, calls } = recording()
	await runPremindCommand(actions, "premind-send-now", "s1")
	await runPremindCommand(actions, "premind-disable", undefined)
	assert.deepEqual(calls, [["deliver", "s1"], ["setDisabled", true]])
	const names = premindCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])])
	assert.equal(new Set(names).size, names.length, "names are unique")
})
