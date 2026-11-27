import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import { PremindRpc } from "../../plugin-opencode-v2/rpc.ts"
import { BRANCH, REPO, startE2EEnvironment, type E2EEnvironment } from "./environment.ts"
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
		.flatMap((message) => message.type === "synthetic" && message.id.startsWith("msg_premind_") ? [message] : [])
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
		const plugins = JSON.stringify(await opencode.client().plugin.list())
		assert.ok(plugins.includes(pluginDirectory(packageRoot)), `plugin list includes the packed plugin: ${plugins.slice(0, 2000)}`)
		assert.equal(existsSync(e2e.sandbox.socket), false, "loading an unused plugin leaves the daemon stopped")
	})

	test("labels the reminder in the transcript", async () => {
		e2e.model.reply({ text: "hello from the fake model" })
		session = (await opencode.openSession()) as OpenCodeSession
		await session.prompt("hello")
		const reminder = await expectReminder(`Discovered open PR ${REPO}#42`)
		assert.equal(reminder.description, "Premind: pull request updates")
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
				const batch = e2e.daemon.get<{ reminder_text: string }>(
					"SELECT reminder_text FROM reminder_batches WHERE session_id = ? AND state = 'built'", session.id)
				return batch?.reminder_text.includes(first) && batch.reminder_text.includes(second)
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
