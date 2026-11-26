import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { PremindRpc } from "../../plugin-opencode-v2/rpc.ts"
import { findOpenCodeV2, PLUGIN_SOURCE_DIR, startOpenCodeV2Environment, type OpenCodeV2Environment } from "./environment.ts"

const binary = findOpenCodeV2()
const skip = "missing" in binary ? binary.missing : false

/** The plugin loads on a location's first request, so the first RPC can race it. */
const ping = async (env: OpenCodeV2Environment) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await env.client.rpc(PremindRpc).ping({})
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

describe("OpenCode V2 plugin", { skip }, () => {
  let env: OpenCodeV2Environment

  before(async () => {
    if ("missing" in binary) return
    env = await startOpenCodeV2Environment({ binary })
  })

  after(async () => {
    await env?.close()
  })

  test("loads in a real server and answers RPC", async () => {
    const result = (await ping(env)) as { version?: unknown }
    assert.equal(typeof result.version, "string", env.logs().slice(-4000))
    const plugins = await env.client.plugin.list()
    assert.ok(
      JSON.stringify(plugins).includes(PLUGIN_SOURCE_DIR),
      `plugin list includes ${PLUGIN_SOURCE_DIR}: ${JSON.stringify(plugins).slice(0, 2000)}`,
    )
  })

  test("runs agent turns against the fake model", async () => {
    env.model.reply({ text: "hello from the fake model" })
    const session = await env.client.session.create({ location: { directory: env.projectDir } })
    await env.client.session.prompt({ sessionID: session.id, text: "hello" })
    for (let attempt = 0; attempt < 100 && env.model.requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.deepEqual(env.model.userMessages(), ["hello"], env.logs().slice(-4000))
  })

  test("survives a reload and a restart", async () => {
    await env.client.location.reload()
    assert.equal(typeof ((await ping(env)) as { version?: unknown }).version, "string")
    await env.restart()
    assert.equal(typeof ((await ping(env)) as { version?: unknown }).version, "string")
  })
})
