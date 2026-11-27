import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import { PremindRpc } from "../../plugin-opencode-v2/rpc.ts"
import { BRANCH, REPO, startE2EEnvironment, type E2EEnvironment } from "./environment.ts"
import { textOf } from "./fake-model.ts"
import { locateHost } from "./host.ts"
import { openCodeDriver, pluginDirectory, startOpenCode, type OpenCodeInstance, type OpenCodeSession } from "./opencode.ts"
import { packedPremind } from "./package.ts"

/**
 * OpenCode-only checks. Shared delivery behavior belongs in `scenarios.ts`;
 * this suite covers what only OpenCode has: the plugin list, RPC, synthetic
 * messages in the transcript, delivery at the end of a running execution,
 * `location.reload()`, child sessions, and archiving.
 */
const located = locateHost(openCodeDriver)

describe("opencode: V2 plugin", { skip: "missing" in located ? located.missing : false, timeout: 300_000 }, () => {
	let e2e: E2EEnvironment
	let opencode: OpenCodeInstance
	let packageRoot: string
	let session: OpenCodeSession

	/** The plugin loads on a location's first request, so the first RPC can race it. */
	const ping = () => e2e.waitFor("the plugin to answer RPC", () =>
		opencode.client().rpc(PremindRpc).ping({}).then((result) => result as { version?: unknown }, () => undefined), 10_000)

	const daemonSession = (id = session.id) => e2e.daemon.session(id)
	/** Premind's synthetic messages in the session transcript. */
	const reminders = async () => (await opencode.client().session.context({ sessionID: session.id }))
		.flatMap((message) => message.type === "synthetic" && message.id.startsWith("msg_premind_") && !message.id.startsWith("msg_premind_command_") ? [message] : [])
	/** Command results Premind queued into the transcript. */
	const commandResults = async () => (await opencode.client().session.context({ sessionID: session.id }))
		.flatMap((message) => message.type === "synthetic" && message.id.startsWith("msg_premind_command_") ? [message] : [])
	const expectReminder = async (...updates: string[]) => {
		const includesUpdates = (text: string) => updates.every((update) => text.includes(update))
		await e2e.waitFor(`${updates.join(" and ")} in the model input`, () => e2e.model.userMessages().some(includesUpdates), 60_000)
		const matches = (await reminders()).filter((message) => includesUpdates(message.text))
		assert.equal(matches.length, 1, "the updates appear in one synthetic message")
		const message = matches[0]!
		const handoffId = message.id.replace(/^msg_premind_/, "")
		await e2e.waitFor(`daemon confirmation of ${message.id}`, () => e2e.daemon.confirmedHandoffs(session.id).includes(handoffId))
		await e2e.waitFor("the session to settle after delivery", () => daemonSession()?.busy_state === "idle")
		return message
	}

	before(async () => {
		if ("missing" in located) return
		packageRoot = packedPremind()
		e2e = await startE2EEnvironment({ model: openCodeDriver.model, diagnostics: () => opencode?.output() ?? "" })
		e2e.github.addPullRequest({ repo: REPO, number: 42, headRefName: BRANCH, title: "Add widgets" })
		opencode = await startOpenCode(e2e, { binary: located.binary, packageRoot })
	})

	after(async () => {
		try {
			await opencode?.stop()
		} finally {
			await e2e?.close()
		}
	})

	test("loads from the packed package and answers RPC without starting the daemon", async () => {
		assert.equal(typeof (await ping()).version, "string")
		// The list can lag the plugin answering RPC, so wait for it.
		await e2e.waitFor("the plugin list to include the packed plugin", async () =>
			JSON.stringify(await opencode.client().plugin.list()).includes(pluginDirectory(packageRoot)), 10_000)
		assert.equal(existsSync(e2e.sandbox.socket), false, "loading an unused plugin leaves the daemon stopped")
	})

	test("labels the reminder in the transcript", async () => {
		e2e.model.reply({ text: "hello from the fake model" })
		session = (await opencode.openSession()) as OpenCodeSession
		await session.prompt("hello")
		const reminder = await expectReminder(`Discovered open PR ${REPO}#42`)
		assert.equal(reminder.description, "Premind: pull request updates")
	})

	test("offers the Premind tools to the model and lists the skill", async () => {
		const tools = new Set(e2e.model.requests.at(-1)?.tools?.map((tool) => tool.function.name))
		for (const name of ["status", "debug_status", "set_active_checkout", "subscribe", "unsubscribe", "deliver", "pause", "resume", "enable", "disable", "doctor"]) {
			assert.ok(tools.has(`premind_${name}`), `premind_${name} is a direct tool`)
		}
		const skills = await opencode.client().skill.list()
		const skill = JSON.stringify(skills)
		assert.match(skill, /"name":"premind"/)
		assert.match(skill, /Premind pull-request tracking and reminder instructions for OpenCode/)
	})

	test("runs premind_subscribe when the model calls it", async () => {
		e2e.github.addPullRequest({ repo: REPO, number: 43, headRefName: "feature/other", title: "Other widgets" })
		e2e.model.reply({ toolCalls: [{ name: "premind_subscribe", arguments: { prNumber: 43, repo: REPO, writePolicy: "observe-only" } }] })
		e2e.model.reply({ text: "subscribed" })
		await session.prompt("follow PR 43")
		const result = e2e.model.requests.at(-1)?.messages.find((message) => message.role === "tool")
		assert.match(textOf(result?.content), new RegExp(`premind subscribed to ${REPO}#43 with write policy observe-only`))
		const row = e2e.daemon.get<{ write_policy: string }>(
			"SELECT write_policy FROM session_subscriptions WHERE session_id = ? AND repo = ? AND pr_number = 43", session.id, REPO)
		assert.equal(row?.write_policy, "observe-only")
	})

	test("lists the Premind commands and runs them without a model turn", async () => {
		const commands = new Set((await opencode.client().command.list()).data.map((command) => command.name))
		for (const name of ["status", "debug-status", "doctor", "subscribe", "unsubscribe", "set-active-checkout", "pause", "resume", "deliver", "enable", "disable", "prune"]) {
			assert.ok(commands.has(`premind:${name}`), `premind:${name} is a command`)
		}
		for (const alias of ["premind-status", "premind-send-now", "premind-enable", "premind-disable"]) {
			assert.ok(commands.has(alias), `${alias} stays as an alias`)
		}
		const requests = e2e.model.requests.length
		await opencode.client().session.command({ sessionID: session.id, name: "premind:pause", text: "" })
		const paused = () => e2e.daemon.get("SELECT session_id FROM session_pauses WHERE session_id = ?", session.id) !== undefined
		await e2e.waitFor("the session to pause", paused)
		await opencode.client().session.command({ sessionID: session.id, name: "premind:resume", text: "" })
		await e2e.waitFor("the session to resume", () => !paused())
		assert.equal(e2e.model.requests.length, requests, "commands do not start a model turn")
		// Results wait in the inbox and join the transcript with the next turn.
		e2e.model.reply({ text: "noted" })
		await session.prompt("continue")
		await e2e.waitFor("the command results in the transcript", async () => {
			const descriptions = (await commandResults()).map((message) => message.description)
			return descriptions.includes("/premind:pause") && descriptions.includes("/premind:resume")
		})
	})

	test("runs commands over RPC for the TUI", async () => {
		const rpc = opencode.client().rpc(PremindRpc)
		const status = await rpc.command({ name: "premind:status", sessionID: session.id }) as { ok: boolean; text: string }
		assert.equal(status.ok, true)
		assert.match(status.text, /#42 Add widgets/)
		const usage = await rpc.command({ name: "premind:subscribe", sessionID: session.id, args: "not-a-number" }) as { ok: boolean; text: string }
		assert.deepEqual(usage, { ok: false, text: "premind:subscribe failed: usage: /premind:subscribe <pr> [owner/repo]" })
		const lines = await rpc.statusLines({ sessionID: session.id }) as { lines: unknown[] }
		assert.ok(lines.lines.some((line) => typeof line === "object"), "PR lines carry a signal for coloring")
	})

	test("delivers one merged reminder at the end of the running execution", async () => {
		let release!: () => void
		const waitFor = new Promise<void>((resolve) => { release = resolve })
		const first = "First comment during the running turn"
		const second = "Second comment during the running turn"
		e2e.model.reply({ text: "finished the running turn", waitFor })
		try {
			await opencode.client().session.prompt({ sessionID: session.id, text: "take your time" })
			await e2e.waitFor("the session to be busy", () => daemonSession()?.busy_state === "busy")
			e2e.github.addComment(REPO, 42, { author: "reviewer", body: first })
			e2e.github.addComment(REPO, 42, { author: "reviewer", body: second })
			await e2e.waitFor("both PR changes in a pending reminder", () => {
				// Each subscription builds its own batch, so look across all of them.
				const batches = e2e.daemon.all<{ reminder_text: string }>(
					"SELECT reminder_text FROM reminder_batches WHERE session_id = ? AND state = 'built'", session.id) ?? []
				return batches.some((batch) => batch.reminder_text.includes(first) && batch.reminder_text.includes(second))
			})
			assert.ok(!(await reminders()).some((message) => message.text.includes(first)), "nothing is injected mid-execution")
		} finally {
			release()
		}
		await expectReminder(first, second)
	})

	test("reattaches after a location reload and a server restart without repeating reminders", async () => {
		const delivered = (await reminders()).map(({ id }) => id)
		const initialClient = daemonSession()?.client_id
		await opencode.client().location.reload()
		assert.equal(typeof (await ping()).version, "string")
		await e2e.waitFor("a new active client after reload", () =>
			daemonSession()?.status === "active" && daemonSession()?.client_id !== initialClient)
		const reloadedClient = daemonSession()?.client_id
		await opencode.restart()
		assert.equal(typeof (await ping()).version, "string")
		await e2e.waitFor("a new active client after restart", () =>
			daemonSession()?.status === "active" && daemonSession()?.client_id !== reloadedClient)
		assert.deepEqual((await reminders()).map(({ id }) => id), delivered)
	})

	test("ignores child sessions, detaches an archived session and closes a deleted one", async () => {
		const client = opencode.client()
		const child = await client.session.create({ parentID: session.id, location: { directory: e2e.sandbox.workspace } })
		await client.session.prompt({ sessionID: child.id, text: "child-only prompt" })
		await e2e.waitFor("the child to finish its turn", () => e2e.model.userMessages().includes("child-only prompt"))
		await client.session.update({ sessionID: session.id, archived: true })
		await e2e.waitFor("the archived session to detach", () => daemonSession()?.status === "detached")
		assert.equal(daemonSession(child.id), undefined, "child sessions are not registered")
		await client.session.remove({ sessionID: session.id })
		await e2e.waitFor("the deleted session to close", () => daemonSession()?.status === "closed")
	})
})
