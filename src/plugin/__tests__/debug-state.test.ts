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

  test("writes and reads daemon startup diagnostics", () => {
    const statePath = getPluginRuntimeStatePath()
    fs.rmSync(statePath, { force: true })

    writePluginRuntimeState({
      phase: "daemon-start-failed",
      daemonStarted: false,
      daemonDiagnostics: {
        runner: "/usr/local/bin/tsx",
        daemonEntry: "/some/path/daemon/index.ts",
        spawnPid: 12345,
        exitCode: 1,
        exitSignal: null,
        timedOut: true,
        stderr: "Error: Cannot find module 'some_native.node'",
        stdout: "",
      },
    })

    const read = readPluginRuntimeState()
    assert.equal(read.phase, "daemon-start-failed")
    assert.equal(read.daemonStarted, false)
    assert.ok(read.daemonDiagnostics, "daemonDiagnostics should be present")
    assert.equal(read.daemonDiagnostics?.runner, "/usr/local/bin/tsx")
    assert.equal(read.daemonDiagnostics?.exitCode, 1)
    assert.equal(read.daemonDiagnostics?.timedOut, true)
    assert.match(read.daemonDiagnostics?.stderr ?? "", /some_native/)
  })

  test("daemon diagnostics are merged with previous state fields", () => {
    const statePath = getPluginRuntimeStatePath()
    fs.rmSync(statePath, { force: true })

    writePluginRuntimeState({ phase: "initializing", root: "/tmp/project" })
    writePluginRuntimeState({
      phase: "daemon-start-failed",
      daemonStarted: false,
      daemonDiagnostics: { timedOut: true, spawnError: "ENOENT" },
    })

    const read = readPluginRuntimeState()
    // root from first write should still be present
    assert.equal(read.root, "/tmp/project")
    assert.equal(read.phase, "daemon-start-failed")
    assert.equal(read.daemonDiagnostics?.spawnError, "ENOENT")
  })
})
