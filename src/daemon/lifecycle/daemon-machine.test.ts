import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createDaemonLifecycleActor } from "./daemon-machine.ts"

describe("daemon lifecycle machine", () => {
  test("cancels shutdown grace when demand returns", () => {
    const actor = createDaemonLifecycleActor()
    actor.start()
    actor.send({ type: "STARTUP_COMPLETE", hasDemand: false })
    assert.equal(actor.getSnapshot().value, "shutdown_grace")
    assert.equal(actor.getSnapshot().context.stopReason, "idle")

    actor.send({ type: "DEMAND_CHANGED", hasDemand: true })
    assert.equal(actor.getSnapshot().value, "running")
    assert.equal(actor.getSnapshot().context.stopReason, null)
    actor.stop()
  })

  test("owns the grace-expiry and stopping lifecycle", () => {
    const actor = createDaemonLifecycleActor()
    actor.start()
    actor.send({ type: "STARTUP_COMPLETE", hasDemand: true })
    assert.equal(actor.getSnapshot().value, "running")
    actor.send({ type: "DEMAND_CHANGED", hasDemand: false })
    actor.send({ type: "GRACE_EXPIRED" })
    assert.equal(actor.getSnapshot().value, "stopping")
    actor.send({ type: "STOPPED" })
    assert.equal(actor.getSnapshot().value, "stopped")
  })
})
