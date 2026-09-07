import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../persistence/store.ts"
import { ReminderHandoffRegistry } from "./reminder-handoff-registry.ts"
import { DatabaseSync } from "node:sqlite"
import { diffSnapshot } from "../github/diff.ts"
import type { NormalizedPrEvent, PullRequestCheck, PullRequestSnapshot } from "../github/types.ts"

const dirs: string[] = []
const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-handoff-"))
  dirs.push(dir)
  return new StateStore(path.join(dir, "state.db"))
}

const seed = (store: StateStore, source: "automatic" | "manual" = "manual") => {
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
    source,
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
    assert.equal(batch.repo, "acme/repo")
    assert.equal(batch.prNumber, 13)
    assert.equal(batch.subscriptionId, subscription.subscriptionId)
    assert.equal(batch.source, "manual")
    assert.match(batch.reminderText, /acme\/repo#13/)

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

  test("drains cross-repository subscriptions sequentially with qualified identity", () => {
    const store = createStore()
    seed(store)
    store.upsertSubscription({
      sessionId: "session", repo: "other/repo", prNumber: 42, source: "manual",
    }, 200)
    store.insertEvents("other/repo", 42, [{
      dedupeKey: "review:1", kind: "review.approved", priority: "high",
      summary: "Approved", payload: {},
    }], 200)
    const registry = new ReminderHandoffRegistry(store)
    const first = registry.getPendingReminder("session")
    assert.ok(first?.repo && first.prNumber)
    assert.match(first.reminderText, new RegExp(`${first.repo}#${first.prNumber}`))
    assert.equal(registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "handed_off" }).acknowledged, true)
    assert.equal(registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "confirmed" }).acknowledged, true)

    const second = registry.getPendingReminder("session")
    assert.ok(second?.repo && second.prNumber)
    assert.notEqual(`${second.repo}#${second.prNumber}`, `${first.repo}#${first.prNumber}`)
    assert.match(second.reminderText, new RegExp(`${second.repo}#${second.prNumber}`))
    registry.close()
    store.close()
  })
})

const liveSnapshot = (checks: PullRequestCheck[] = [{ name: "lint", state: "FAILURE", workflow: "CI", event: "push" }]): PullRequestSnapshot => ({
  core: { number: 13, title: "Live blockers", url: "https://github.com/acme/repo/pull/13", state: "OPEN",
    isDraft: false, headRefName: "feature/x", baseRefName: "main", headRefOid: "head-old", mergeStateStatus: "CLEAN" },
  checks, reviews: [], issueComments: [], reviewComments: [], fetchedAt: 100,
})
const failureEvent = (name = "lint"): NormalizedPrEvent => ({
  dedupeKey: `failure:${name}`, kind: "check.failed", priority: "high", summary: `Check failed: ${name}`,
  payload: { name, headSha: "head-old", workflow: "CI", event: "push" },
})
const setupLive = (source: "automatic" | "manual" = "automatic") => {
  const store = createStore()
  seed(store, source) // Also includes an unrelated comment which must survive reconciliation.
  const subscription = store.upsertSubscription({ sessionId: "session", repo: "acme/repo", prNumber: 13, source })
  const registry = new ReminderHandoffRegistry(store)
  const save = (snapshot: PullRequestSnapshot) => store.saveSnapshot("acme/repo", 13, snapshot)
  return { store, registry, subscription, save }
}
const assertAction = (text: string, actionable: boolean) => {
  if (actionable) assert.match(text, /Action required: resolve .*on HEAD/)
  else assert.doesNotMatch(text, /Action required:/)
}

describe("pending reminder live reconciliation", () => {
  const check = (state: string, workflow = "CI", event = "push"): PullRequestCheck => ({ name: "lint", state, workflow, event })
  for (const scenario of [
    { name: "explicit live failure", checks: [check("FAILURE")], kind: "check.failed", summary: /Check failed: lint/, action: true },
    { name: "same-SHA pass", checks: [check("SUCCESS")], kind: "check.resolved", summary: /now passed/, action: false },
    { name: "same-SHA cancellation", checks: [check("CANCELLED")], kind: "check.resolved", summary: /now cancelled/, action: false },
    { name: "same-SHA active rerun", checks: [check("FAILURE"), check("IN_PROGRESS")], kind: "check.rerunning", summary: /active rerun/, action: false },
    { name: "queued retry", checks: [check("FAILURE"), check("QUEUED")], kind: "check.rerunning", summary: /active rerun/, action: false },
    { name: "missing check is not resolved", checks: [], kind: "check.unverified", summary: /UNVERIFIED/, action: false },
    { name: "different workflow is not a match", checks: [check("SUCCESS", "other")], kind: "check.unverified", summary: /UNVERIFIED/, action: false },
    { name: "different event is not a match", checks: [check("SUCCESS", "CI", "label")], kind: "check.unverified", summary: /UNVERIFIED/, action: false },
    { name: "terminal duplicates cannot be ordered", checks: [check("SUCCESS"), check("FAILURE")], kind: "check.unverified", summary: /UNVERIFIED/, action: false },
    { name: "unknown state is not an active rerun", checks: [check("MYSTERY")], kind: "check.unverified", summary: /UNVERIFIED/, action: false },
    { name: "workflow isolates a genuine failure", checks: [check("SUCCESS", "other"), check("FAILURE")], kind: "check.failed", summary: /Check failed: lint/, action: true },
  ]) {
    test(`refreshes ${scenario.name} through store and registry`, () => {
      const { store, registry, save } = setupLive()
      try {
        save(liveSnapshot())
        store.insertEvents("acme/repo", 13, [failureEvent()])
        const queued = store.buildReminderBatch("session")!
        assertAction(queued.reminderText, true)
        const rawBefore = store.listUndeliveredEvents("session")
        save(liveSnapshot(scenario.checks))
        const refreshed = registry.getPendingReminder("session")!
        assert.equal(refreshed.batchId, queued.batchId)
        const checkEvent = refreshed.events.find((event) => event.kind.startsWith("check."))!
        assert.equal(checkEvent.kind, scenario.kind)
        assert.match(checkEvent.summary, scenario.summary)
        assertAction(refreshed.reminderText, scenario.action)
        assert.match(refreshed.reminderText, /New review comment/)
        assert.deepEqual(store.listUndeliveredEvents("session"), rawBefore, "original pr_events must not change")
        assert.deepEqual(store.getPendingReminder("session"), refreshed, "refresh is idempotent")
      } finally { registry.close(); store.close() }
    })
  }

  test("refreshes built/failed batches without changing ownership, cursors, or their event window", () => {
    const { store, registry, save, subscription } = setupLive()
    try {
      save(liveSnapshot())
      store.insertEvents("acme/repo", 13, [failureEvent()])
      const first = registry.getPendingReminder("session")!
      const original = store.getReminderBatchRecord(first.batchId)!
      assertAction(first.reminderText, true)
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "handed_off" })
      const current = liveSnapshot([])
      current.core.headRefOid = "head-new"
      save(current)
      store.insertEvents("acme/repo", 13, [{ ...failureEvent("new failure"), payload: { name: "new failure", headSha: "head-new" } }])
      assert.equal(store.getPendingReminder("session"), null)
      assert.equal(store.getReminderBatchRecord(first.batchId)!.reminderText, first.reminderText, "handed_off is immutable")
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "failed" })
      const failed = store.getPendingReminder("session")!
      assert.equal(store.getReminderBatchRecord(first.batchId)!.state, "failed", "refresh must not retry on its own")
      assert.match(failed.reminderText, /superseded by head-ne/)
      assertAction(failed.reminderText, false)
      const retry = registry.getPendingReminder("session")!
      assert.equal(retry.batchId, first.batchId)
      assert.equal(retry.subscriptionId, subscription.subscriptionId)
      assert.doesNotMatch(retry.reminderText, /new failure/)
      assert.equal(store.getReminderBatchRecord(first.batchId)!.maxEventSeq, original.maxEventSeq)
      assert.equal(store.getSubscriptionById(subscription.subscriptionId)!.lastDeliveredEventSeq, 0)
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "handed_off" })
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "confirmed" })
      assert.equal(store.getSubscriptionById(subscription.subscriptionId)!.lastDeliveredEventSeq, original.maxEventSeq)
      assert.deepEqual(store.listUndeliveredEventsForSubscription(subscription.subscriptionId).map((event) => event.summary), ["Check failed: new failure"])
      const next = registry.getPendingReminder("session")!
      assert.notEqual(next.batchId, first.batchId)
      assert.match(next.reminderText, /new failure/)
    } finally { registry.close(); store.close() }
  })

  for (const scenario of [
    { state: "CLEAN", stable: undefined, action: false, summary: /now cleared/ },
    { state: "DIRTY", stable: undefined, action: true, summary: /Merge conflicts detected/ },
    { state: "UNKNOWN", stable: "DIRTY", action: true, summary: /Merge conflicts detected/ },
    { state: "UNKNOWN", stable: "CLEAN", action: false, summary: /now cleared/ },
    { state: "UNKNOWN", stable: undefined, action: false, summary: /UNVERIFIED/ },
    { state: "BLOCKED", stable: "DIRTY", action: false, summary: /UNVERIFIED/ },
    { state: "BEHIND", stable: undefined, action: false, summary: /UNVERIFIED/ },
  ]) {
    test(`reconciles conflict to ${scenario.state}/${scenario.stable ?? "no stable state"}`, () => {
      const { store, registry, save } = setupLive()
      try {
        const current = liveSnapshot([])
        current.core.mergeStateStatus = "DIRTY"
        save(current)
        store.insertEvents("acme/repo", 13, [{ dedupeKey: "conflict", kind: "merge_conflict.detected", priority: "high",
          summary: "Merge conflicts detected", payload: {} }])
        const first = store.buildReminderBatch("session")!
        assertAction(first.reminderText, true)
        current.core.mergeStateStatus = scenario.state
        current.core.lastStableMergeStateStatus = scenario.stable
        save(current)
        const refreshed = registry.getPendingReminder("session")!
        assert.equal(refreshed.batchId, first.batchId)
        assertAction(refreshed.reminderText, scenario.action)
        assert.match(refreshed.events.find((event) => event.kind.startsWith("merge_conflict."))!.summary, scenario.summary)
        if (scenario.summary.source === "UNVERIFIED") assert.doesNotMatch(refreshed.reminderText, /now cleared|now clean/)
      } finally { registry.close(); store.close() }
    })
  }

  for (const state of ["CLEAN", "DIRTY", "UNKNOWN", "BLOCKED", "CLOSED", "MERGED", "NEW_HEAD", "NEW_HEAD_FAILURE"]) {
    test(`recomputes queued initial blockers for ${state}`, () => {
      const { store, registry, save } = setupLive()
      try {
        const initial = liveSnapshot()
        initial.core.mergeStateStatus = "DIRTY"
        store.saveSnapshotAndEvents("acme/repo", 13, initial, diffSnapshot(null, initial))
        const first = store.buildReminderBatch("session")!
        assertAction(first.reminderText, true)
        const next = liveSnapshot([])
        if (["CLOSED", "MERGED"].includes(state)) next.core.state = state
        else if (state.startsWith("NEW_HEAD")) {
          next.core.headRefOid = "head-new"
          if (state === "NEW_HEAD_FAILURE") next.checks = [{ name: "fresh failure", state: "FAILURE" }]
        } else {
          next.core.mergeStateStatus = state
          if (state === "UNKNOWN") next.core.lastStableMergeStateStatus = "DIRTY"
        }
        save(next)
        const refreshed = registry.getPendingReminder("session")!
        assert.equal(refreshed.batchId, first.batchId)
        assertAction(refreshed.reminderText, ["DIRTY", "UNKNOWN", "NEW_HEAD_FAILURE"].includes(state))
        const event = refreshed.events.find((item) => item.kind === "pr.snapshot.initialized")!
        assert.doesNotMatch(event.summary, /lint/)
        if (state === "CLEAN" || state === "NEW_HEAD") {
          assert.equal(event.summary, "Started tracking 13: Live blockers")
          assert.equal(event.priority, "low")
        }
        if (state === "NEW_HEAD_FAILURE") assert.match(event.summary, /fresh failure/)
        if (state === "BLOCKED") assert.match(event.summary, /UNVERIFIED/)
      } finally { registry.close(); store.close() }
    })
  }

  for (const state of ["CLOSED", "MERGED"]) {
    test(`terminal ${state} snapshot retires historical check and conflict instructions`, () => {
      const { store, registry, save } = setupLive()
      try {
        const current = liveSnapshot()
        current.core.mergeStateStatus = "DIRTY"
        save(current)
        store.insertEvents("acme/repo", 13, [failureEvent(), { dedupeKey: "conflict", kind: "merge_conflict.detected", priority: "high", summary: "Merge conflict", payload: {} }])
        const first = store.buildReminderBatch("session")!
        assertAction(first.reminderText, true)
        current.core.state = state
        save(current)
        const refreshed = registry.getPendingReminder("session")!
        assertAction(refreshed.reminderText, false)
        assert.match(refreshed.reminderText, new RegExp(`PR ${state}`))
        assert.match(refreshed.reminderText, /New review comment/)
      } finally { registry.close(); store.close() }
    })
  }

  for (const legacyGroup of [false, true]) {
    test(`partially reconciles ${legacyGroup ? "legacy nested" : "new"} diff groups and preserves all raw IDs`, () => {
      const { store, registry, save } = setupLive()
      try {
        const previous = liveSnapshot([])
        const next = liveSnapshot([check("FAILURE"), { ...check("FAILURE"), name: "build" }, { ...check("FAILURE"), name: "test" }])
        const events = diffSnapshot(previous, next)
        const group = events.find((event) => event.kind === "check.failed")!
        assert.equal(group.payload.headSha, "head-old")
        assert.equal((group.payload.events as unknown[]).length, 3)
        if (legacyGroup) delete group.payload.headSha
        store.saveSnapshotAndEvents("acme/repo", 13, next, events)
        const first = store.buildReminderBatch("session")!
        assert.equal(first.events.filter((event) => event.kind === "check.failed").length, 3)
        next.checks = [check("SUCCESS"), { ...check("FAILURE"), name: "build" }, { ...check("IN_PROGRESS"), name: "test" }]
        save(next)
        const refreshed = registry.getPendingReminder("session")!
        assert.equal(refreshed.batchId, first.batchId)
        assert.deepEqual(refreshed.events.filter((event) => event.kind === "check.failed").map((event) => event.summary), ["Check failed: build"])
        assert.match(refreshed.reminderText, /lint: now passed/)
        assert.match(refreshed.reminderText, /test: active rerun/)
        assertAction(refreshed.reminderText, true)
        assert.doesNotMatch(refreshed.reminderText, /Check failed: lint|Check failed: test/)
        next.core.headRefOid = "head-new"
        save(next)
        const superseded = store.buildReminderBatchForSubscription(refreshed.subscriptionId!)!
        assert.equal(superseded.batchId, first.batchId)
        assert.match(superseded.reminderText, /3 failed on head-ol/)
        assertAction(superseded.reminderText, false)
      } finally { registry.close(); store.close() }
    })
  }

  test("uses manual subscription snapshot rather than session PR and retains authorization limits", () => {
    const { store, registry, save, subscription } = setupLive("manual")
    try {
      save(liveSnapshot())
      store.insertEvents("acme/repo", 13, [failureEvent()])
      const first = store.buildReminderBatchForSubscription(subscription.subscriptionId)!
      assert.match(first.reminderText, /Action required: report .*wait for authorization/)
      const external = store.upsertSubscription({ sessionId: "session", repo: "other/repo", prNumber: 99, source: "manual" })
      store.saveSnapshot("other/repo", 99, liveSnapshot([]))
      store.insertEvents("other/repo", 99, [{ ...failureEvent(), dedupeKey: "external" }])
      const other = store.buildReminderBatchForSubscription(external.subscriptionId)!
      assert.equal(other.repo, "other/repo")
      assert.equal(other.prNumber, 99)
      assert.match(other.reminderText, /UNVERIFIED/)
      assertAction(other.reminderText, false)
      assert.match(store.buildReminderBatchForSubscription(subscription.subscriptionId)!.reminderText, /Action required: report/)
      save(liveSnapshot([check("SUCCESS")]))
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, first.batchId)
      assert.match(refreshed.reminderText, /Do not make changes unless the user explicitly asks/)
      assertAction(refreshed.reminderText, false)
    } finally { registry.close(); store.close() }
  })

  test("legacy condensed batches recover the bounded raw window and upgrade provenance", () => {
    const { store, registry, save, subscription } = setupLive()
    try {
      save(liveSnapshot())
      store.insertEvents("acme/repo", 13, [failureEvent("lint"), failureEvent("build"), failureEvent("test")])
      // Old superseded buckets only retained the last ID, not the other jobs.
      const batchId = store.createOrReplaceReminder("session", subscription.subscriptionId, "old stale text",
        [{ eventId: "1", kind: "issue_comment.created", priority: "high", summary: "New review comment" },
          { eventId: "4", kind: "check.superseded", priority: "low", summary: "3 failed on old" }], 4)
      store.insertEvents("acme/repo", 13, [{ ...failureEvent("later"), dedupeKey: "later" }])
      const next = liveSnapshot([])
      next.core.headRefOid = "head-new"
      save(next)
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, batchId)
      assert.match(refreshed.reminderText, /3 failed on head-ol/)
      assert.doesNotMatch(refreshed.reminderText, /later/)
      assert.deepEqual(store.getPendingReminder("session"), refreshed)
      assert.equal(store.getReminderBatchRecord(batchId)!.maxEventSeq, 4)
      assert.equal(store.getSubscriptionById(subscription.subscriptionId)!.lastDeliveredEventSeq, 0)
    } finally { registry.close(); store.close() }
  })

  for (const missing of ["snapshot", "payload", "head", "malformed", "ambiguous identity", "raw rows"]) {
    test(`requires verification for missing/legacy ${missing}`, () => {
      const { store, registry, save, subscription } = setupLive()
      try {
        if (missing !== "snapshot") save(liveSnapshot([check("SUCCESS"), check("FAILURE", "other")]))
        const event = failureEvent()
        if (missing === "payload") event.payload = {}
        if (missing === "head") delete event.payload.headSha
        if (missing === "ambiguous identity") delete event.payload.workflow
        store.insertEvents("acme/repo", 13, [event])
        if (missing === "malformed") {
          const db = (store as unknown as { db: DatabaseSync }).db
          db.prepare("UPDATE pr_events SET payload_json = '{broken' WHERE kind = 'check.failed'").run()
        }
        if (missing === "raw rows") {
          store.createOrReplaceReminder("session", subscription.subscriptionId, "Action required: resolve old failures on HEAD",
            [{ eventId: "100", kind: "check.failed", priority: "high", summary: "Check failed: lost job" }], 100)
        }
        const batch = registry.getPendingReminder("session")!
        assert.match(batch.reminderText, /UNVERIFIED/)
        assert.match(batch.reminderText, /Verify current status before acting/)
        assertAction(batch.reminderText, false)
        assert.doesNotMatch(batch.reminderText, /now passed|now cleared/)
      } finally { registry.close(); store.close() }
    })
  }

  test("keeps the original 20-row batch limit while newer events remain pending", () => {
    const { store, registry, save, subscription } = setupLive()
    try {
      const events = Array.from({ length: 25 }, (_, index) => failureEvent(`job-${index}`))
      const current = liveSnapshot(events.map((event) => ({ name: String(event.payload.name), state: "FAILURE", workflow: "CI", event: "push" })))
      save(current)
      store.insertEvents("acme/repo", 13, events)
      const first = registry.getPendingReminder("session")!
      assert.equal(first.events.length, 20)
      assert.equal(store.getReminderBatchRecord(first.batchId)!.maxEventSeq, 20)
      current.core.headRefOid = "head-new"
      save(current)
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, first.batchId)
      assert.match(refreshed.reminderText, /19 failed on head-ol/)
      assert.equal(store.getReminderBatchRecord(first.batchId)!.maxEventSeq, 20)
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "handed_off" })
      registry.acknowledge({ batchId: first.batchId, sessionId: "session", state: "confirmed" })
      assert.equal(store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length, 6)
      assert.equal(store.getSubscriptionById(subscription.subscriptionId)!.lastDeliveredEventSeq, 20)
    } finally { registry.close(); store.close() }
  })

  test("legacy session-owned batches refresh without losing their null subscription", () => {
    const { store, registry, save } = setupLive()
    try {
      store.recordBranchAssociation("acme/repo", "feature/x", 13)
      save(liveSnapshot())
      store.insertEvents("acme/repo", 13, [failureEvent()])
      const id = store.createOrReplaceReminder("session", null, "old text",
        [{ eventId: "2", kind: "check.failed", priority: "high", summary: "Check failed: lint" }], 2)
      const first = store.getPendingReminder("session")!
      assert.equal(first.batchId, id)
      assertAction(first.reminderText, true)
      save(liveSnapshot([check("SUCCESS")]))
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, id)
      assert.equal(store.getReminderBatchRecord(id)!.subscriptionId, null)
      assertAction(refreshed.reminderText, false)
      assert.match(refreshed.reminderText, /now passed/)
      assert.doesNotMatch(refreshed.reminderText, /New review comment/)
    } finally { registry.close(); store.close() }
  })

  test("re-expands separate condensed source rows when the stored HEAD returns", () => {
    const { store, registry, save } = setupLive()
    try {
      const next = liveSnapshot([])
      next.core.headRefOid = "head-new"
      save(next)
      store.insertEvents("acme/repo", 13, [failureEvent("lint"), failureEvent("build"), failureEvent("test")])
      const first = registry.getPendingReminder("session")!
      assert.match(first.reminderText, /3 failed on head-ol/)
      save(liveSnapshot([check("FAILURE"), { ...check("SUCCESS"), name: "build" }, { ...check("CANCELLED"), name: "test" }]))
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, first.batchId)
      assertAction(refreshed.reminderText, true)
      assert.deepEqual(refreshed.events.filter((event) => event.kind === "check.failed").map((event) => event.summary), ["Check failed: lint"])
      assert.match(refreshed.reminderText, /build: now passed/)
      assert.match(refreshed.reminderText, /test: now cancelled/)
    } finally { registry.close(); store.close() }
  })

  test("does not hide an explicit gate failure behind sibling cancellations", () => {
    const { store, registry, save } = setupLive()
    try {
      const next = liveSnapshot([{ ...check("FAILURE"), name: "Required gate" }, { ...check("CANCELLED"), name: "shard" }])
      const events = diffSnapshot(liveSnapshot([]), next)
      // Even a historical heuristic-labelled cancellation is checked against the
      // explicit stored FAILURE; it must not suppress genuine failures at delivery.
      store.saveSnapshotAndEvents("acme/repo", 13, next, events)
      const batch = registry.getPendingReminder("session")!
      assertAction(batch.reminderText, true)
      assert.deepEqual(batch.events.filter((event) => event.kind === "check.failed").map((event) => event.summary), ["Check failed: Required gate"])
    } finally { registry.close(); store.close() }
  })
})
