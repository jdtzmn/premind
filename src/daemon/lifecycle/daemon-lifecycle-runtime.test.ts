import assert from "node:assert/strict"
import { test } from "node:test"
import { DaemonLifecycleRuntime } from "./daemon-lifecycle-runtime.ts"

test("daemon lifecycle runtime cancels and restarts shutdown grace as demand changes", async () => {
  let demand = false
  let nextId = 1
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const clearedTimeouts: number[] = []
  const reasons: string[] = []
  const handle = (id: number) => id as unknown as ReturnType<typeof setTimeout>
  const clock = {
    setTimeout(callback: () => void) {
      const id = nextId++
      timeouts.set(id, callback)
      return handle(id)
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      const id = timer as unknown as number
      clearedTimeouts.push(id)
      timeouts.delete(id)
    },
    setInterval(callback: () => void) {
      const id = nextId++
      intervals.set(id, callback)
      return handle(id)
    },
    clearInterval(timer: ReturnType<typeof setTimeout>) {
      intervals.delete(timer as unknown as number)
    },
  }

  const runtime = new DaemonLifecycleRuntime({
    hasDemand: () => demand,
    graceMs: 100,
    demandPollMs: 1_000,
    clock,
    onStopping: (reason) => { reasons.push(reason) },
  })
  runtime.start()
  assert.equal(runtime.getSnapshot().value, "shutdown_grace")
  assert.equal(timeouts.size, 1)

  demand = true
  runtime.evaluateDemand()
  assert.equal(runtime.getSnapshot().value, "running")
  assert.equal(timeouts.size, 0)
  assert.equal(clearedTimeouts.length, 1)

  demand = false
  runtime.evaluateDemand()
  assert.equal(runtime.getSnapshot().value, "shutdown_grace")
  const expire = [...timeouts.values()][0]
  assert.ok(expire)
  expire()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(reasons, ["idle"])
  assert.equal(runtime.getSnapshot().value, "stopped")
  runtime.close()
})
