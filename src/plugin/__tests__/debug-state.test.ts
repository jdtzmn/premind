import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, test } from "node:test"
import { getPluginRuntimeStatePath, readPluginRuntimeState, writePluginRuntimeState } from "../debug-state.ts"

describe("plugin debug state", () => {
  test("writes and reads plugin runtime state", () => {
    const statePath = getPluginRuntimeStatePath()
    fs.rmSync(statePath, { force: true })

    const written = writePluginRuntimeState({
      phase: "testing",
      daemonStarted: true,
      clientRegistered: true,
      commandsRegistered: false,
      root: "/tmp/project",
    })

    assert.equal(written.phase, "testing")
    assert.ok(fs.existsSync(statePath))

    const read = readPluginRuntimeState()
    assert.equal(read.phase, "testing")
    assert.equal(read.daemonStarted, true)
    assert.equal(read.clientRegistered, true)
    assert.equal(read.commandsRegistered, false)
    assert.equal(read.root, "/tmp/project")
  })
})
