import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { CommandInput, CommandOutput } from "./rpc.ts"
import tui from "./tui.ts"

type Command = { slash?: { name: string; aliases?: string[]; arguments?: true }; palette?: true; run(input?: string): unknown }

const fakeTui = (reply: (input: CommandInput) => CommandOutput, answers: { prompt?: string; confirm?: boolean } = {}) => {
	const calls: CommandInput[] = []
	const shown: Array<{ kind: string; value: unknown }> = []
	let commands: Command[] = []
	const ctx = {
		client: { rpc: () => ({ command: async (input: CommandInput) => (calls.push(input), reply(input)) }) },
		keymap: { layer: (factory: () => { commands: Command[] }) => { commands = factory().commands } },
		ui: {
			router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
			dialog: {
				alert: async (value: unknown) => void shown.push({ kind: "alert", value }),
				prompt: async (value: unknown) => (shown.push({ kind: "prompt", value }), answers.prompt),
				confirm: async (value: unknown) => (shown.push({ kind: "confirm", value }), answers.confirm),
			},
			toast: { show: (value: unknown) => void shown.push({ kind: "toast", value }) },
		},
	} as unknown as Plugin.Context
	tui.setup(ctx)
	const command = (name: string) => {
		const found = commands.find((item) => item.slash?.name === name)
		assert.ok(found, `${name} is registered`)
		return found
	}
	return { calls, shown, commands, command }
}

test("registers every command as a slash and palette command with its aliases", () => {
	const { commands, command } = fakeTui(() => ({ ok: true, text: "" }))
	assert.ok(commands.length >= 12)
	assert.ok(commands.every((item) => item.palette))
	assert.deepEqual(command("premind:deliver").slash?.aliases, ["premind-send-now"])
	assert.equal(command("premind:subscribe").slash?.arguments, true)
})

test("shows reports in a dialog and actions in a toast, for the current session", async () => {
	const { calls, shown, command } = fakeTui((input) => ({ ok: true, text: `${input.name} done` }))
	await command("premind:status").run()
	await command("premind:pause").run()
	assert.deepEqual(calls, [
		{ name: "premind:status", sessionID: "ses_1", args: "" },
		{ name: "premind:pause", sessionID: "ses_1", args: "" },
	])
	assert.deepEqual(shown.map((item) => item.kind), ["alert", "toast"])
})

test("prompts for missing arguments and shows failures as error toasts", async () => {
	const { calls, shown, command } = fakeTui(() => ({ ok: false, text: "premind:subscribe failed: nope" }), { prompt: "42" })
	await command("premind:subscribe").run()
	assert.equal(calls[0]?.args, "42")
	assert.deepEqual(shown.at(-1), { kind: "toast", value: { title: "premind", message: "premind:subscribe failed: nope", variant: "error", sessionID: "ses_1" } })
})

test("asks before changing polling globally", async () => {
	const { calls, command } = fakeTui(() => ({ ok: true, text: "" }), { confirm: false })
	await command("premind:disable").run()
	assert.deepEqual(calls, [], "declining runs nothing")
})
