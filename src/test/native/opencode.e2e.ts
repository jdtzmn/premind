import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { PremindRpc } from "../../plugin-opencode-v2/rpc.ts"
import { startE2EEnvironment, type E2EEnvironment } from "./environment.ts"
import { locateHost } from "./host.ts"
import { openCodeDriver, pluginDirectory, startOpenCode, type OpenCodeInstance } from "./opencode.ts"
import { packedPremind } from "./package.ts"

/**
 * OpenCode-only checks. Shared delivery behavior belongs in `scenarios.ts`;
 * this suite covers what only OpenCode has: the plugin list, RPC, and
 * `location.reload()`.
 */
const located = locateHost(openCodeDriver)

describe("opencode: V2 plugin", { skip: "missing" in located ? located.missing : false, timeout: 300_000 }, () => {
	let e2e: E2EEnvironment
	let opencode: OpenCodeInstance
	let packageRoot: string

	/** The plugin loads on a location's first request, so the first RPC can race it. */
	const ping = () => e2e.waitFor("the plugin to answer RPC", () =>
		opencode.client().rpc(PremindRpc).ping({}).then((result) => result as { version?: unknown }, () => undefined), 10_000)

	before(async () => {
		if ("missing" in located) return
		packageRoot = packedPremind()
		e2e = await startE2EEnvironment({ model: openCodeDriver.model, diagnostics: () => opencode?.output() ?? "" })
		opencode = await startOpenCode(e2e, { binary: located.binary, packageRoot })
	})

	after(async () => {
		try {
			await opencode?.stop()
		} finally {
			await e2e?.close()
		}
	})

	test("loads from the packed package and answers RPC", async () => {
		assert.equal(typeof (await ping()).version, "string")
		const plugins = JSON.stringify(await opencode.client().plugin.list())
		assert.ok(plugins.includes(pluginDirectory(packageRoot)), `plugin list includes the packed plugin: ${plugins.slice(0, 2000)}`)
	})

	test("runs agent turns against the fake model", async () => {
		e2e.model.reply({ text: "hello from the fake model" })
		const session = await opencode.openSession()
		await session.prompt("hello")
		assert.deepEqual(e2e.model.userMessages(), ["hello"])
	})

	test("survives a location reload and a server restart", async () => {
		await opencode.client().location.reload()
		assert.equal(typeof (await ping()).version, "string")
		await opencode.restart()
		assert.equal(typeof (await ping()).version, "string")
	})
})
