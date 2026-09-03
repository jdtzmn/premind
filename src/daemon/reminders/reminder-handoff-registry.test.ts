import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../persistence/store.ts"
import { ReminderHandoffRegistry } from "./reminder-handoff-registry.ts"

const dirs: string[] = []
const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-handoff-"))
  dirs.push(dir)
  return new StateStore(path.join(dir, "state.db"))
}

const seed = (store: StateStore) => {
  store.registerClient("client", { pid: 1, projectRoot: "/repo" })
  store.registerSession({
    clientId: "client",
    sessionId: "session",
    repo: "acme/repo",
    branch: "feature/x",
    isPrimary: true,
    status: "active",
    busyState: "idle",
  })
  const subscription = store.upsertSubscription({
    sessionId: "session",
    repo: "acme/repo",
    prNumber: 13,
    source: "manual",
  })
  store.insertEvents("acme/repo", 13, [{
    dedupeKey: "comment:1",
    kind: "issue_comment.created",
    priority: "high",
    summary: "New review comment",
    payload: {},
  }])
  return subscription
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("ReminderHandoffRegistry", () => {
  test("rejects illegal transitions and advances only after confirmation", () => {
    const store = createStore()
    const subscription = seed(store)
    const registry = new ReminderHandoffRegistry(store)
    const batch = registry.getPendingReminder("session")
    assert.ok(batch)

    const illegal = registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "confirmed" })
    assert.equal(illegal.acknowledged, false)
    assert.equal(store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq, 0)

    assert.equal(registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "handed_off" }).acknowledged, true)
    assert.equal(registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "confirmed" }).acknowledged, true)
    assert.equal(store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq, 1)
    assert.equal(store.getReminderBatchRecord(batch.batchId), null)
    registry.close()
    store.close()
  })

  test("reconstructs a crash-interrupted handoff and retries the durable batch", () => {
    const store = createStore()
    seed(store)
    let registry = new ReminderHandoffRegistry(store)
    const batch = registry.getPendingReminder("session")
    assert.ok(batch)
    assert.equal(registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "handed_off" }).acknowledged, true)
    registry.close()

    store.recoverFromRestart(1_000)
    assert.equal(store.getReminderBatchRecord(batch.batchId)?.state, "failed")
    registry = new ReminderHandoffRegistry(store)
    assert.equal(registry.getPendingReminder("session")?.batchId, batch.batchId)
    assert.equal(store.getReminderBatchRecord(batch.batchId)?.state, "built")

    assert.equal(registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "handed_off" }).acknowledged, true)
    assert.equal(registry.acknowledge({ batchId: batch.batchId, sessionId: "session", state: "failed" }).acknowledged, true)
    assert.equal(store.getReminderBatchRecord(batch.batchId)?.state, "failed")
    registry.close()
    store.close()
  })
})
