import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createDisableGatedTick, type DisableGateStore } from "./disable-gate.ts"

const makeStore = (initial = false): DisableGateStore & { set(v: boolean): void } => {
  let disabled = initial
  return {
    isGloballyDisabled: () => disabled,
    set: (v: boolean) => {
      disabled = v
    },
  }
}

const makeLogger = () => {
  const messages: string[] = []
  return {
    info: (message: string) => {
      messages.push(message)
    },
    messages,
  }
}

describe("createDisableGatedTick", () => {
  test("invokes the underlying tick when not disabled", async () => {
    const store = makeStore(false)
    const logger = makeLogger()
    let callCount = 0
    const gated = createDisableGatedTick("pr-watcher", store, async () => {
      callCount++
    }, logger)

    await gated()
    await gated()

    assert.equal(callCount, 2)
    // No transitions logged because we started enabled and stayed enabled.
    assert.equal(logger.messages.length, 0)
  })

  test("skips the underlying tick when globally disabled", async () => {
    const store = makeStore(true)
    const logger = makeLogger()
    let callCount = 0
    const gated = createDisableGatedTick("pr-watcher", store, async () => {
      callCount++
    }, logger)

    await gated()
    await gated()
    await gated()

    assert.equal(callCount, 0, "underlying tick must not run while disabled")
    // Only one "skipped" message even across multiple ticks.
    assert.equal(logger.messages.length, 1)
    assert.match(logger.messages[0], /pr-watcher skipped/)
    assert.match(logger.messages[0], /globally disabled/)
  })

  test("logs resume exactly once when re-enabled", async () => {
    const store = makeStore(false)
    const logger = makeLogger()
    let callCount = 0
    const gated = createDisableGatedTick("branch-discovery", store, async () => {
      callCount++
    }, logger)

    // Tick once while enabled — no log.
    await gated()
    assert.equal(callCount, 1)
    assert.equal(logger.messages.length, 0)

    // Disable and tick twice — one "skipped" log.
    store.set(true)
    await gated()
    await gated()
    assert.equal(callCount, 1)
    assert.equal(logger.messages.length, 1)
    assert.match(logger.messages[0], /branch-discovery skipped/)

    // Re-enable and tick twice — one "resumed" log, plus two tick calls.
    store.set(false)
    await gated()
    await gated()
    assert.equal(callCount, 3)
    assert.equal(logger.messages.length, 2)
    assert.match(logger.messages[1], /branch-discovery resumed/)
  })

  test("each gate tracks its own transition state", async () => {
    const store = makeStore(true)
    const logger = makeLogger()
    const prTick = createDisableGatedTick("pr-watcher", store, async () => {}, logger)
    const discoveryTick = createDisableGatedTick("branch-discovery", store, async () => {}, logger)

    await prTick()
    await discoveryTick()

    // Both gates should have logged their own "skipped" message.
    assert.equal(logger.messages.length, 2)
    assert.ok(logger.messages.some((m) => m.includes("pr-watcher skipped")))
    assert.ok(logger.messages.some((m) => m.includes("branch-discovery skipped")))
  })

  test("propagates errors from the underlying tick", async () => {
    const store = makeStore(false)
    const logger = makeLogger()
    const gated = createDisableGatedTick("pr-watcher", store, async () => {
      throw new Error("boom")
    }, logger)

    await assert.rejects(() => gated(), /boom/)
  })
})
