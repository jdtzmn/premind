import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "./store.ts"
import type { PullRequestSnapshot } from "../github/types.ts"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-store-test-"))
  const dbPath = path.join(dir, "premind.db")
  tempPaths.push(dir)
  return new StateStore(dbPath)
}

const snapshot = (): PullRequestSnapshot => ({
  core: {
    number: 7,
    title: "Track PR",
    url: "https://github.com/acme/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature/x",
    baseRefName: "main",
    headRefOid: "sha-7",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    updatedAt: "2026-04-08T00:00:00Z",
  },
  reviews: [],
  issueComments: [],
  reviewComments: [],
  checks: [],
  fetchedAt: Date.now(),
})

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("StateStore", () => {
  test("advances delivery cursor after confirmed ack", () => {
    const store = createStore()

    store.registerClient("client-1", { pid: 123, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-1",
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/x",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/x", 7)
    store.saveSnapshot("acme/repo", 7, snapshot())
    store.insertEvents("acme/repo", 7, [
      {
        dedupeKey: "issue_comment.created:11",
        kind: "issue_comment.created",
        priority: "high",
        summary: "New issue comment from bob",
        payload: { commentId: 11 },
      },
      {
        dedupeKey: "check.failed:lint:sha-7",
        kind: "check.failed",
        priority: "high",
        summary: "Check failed: lint",
        payload: { name: "lint" },
      },
    ])

    const batch = store.buildReminderBatch("session-1")
    assert.ok(batch)
    assert.equal(batch.events.length, 2)

    const pending = store.getPendingReminder("session-1")
    assert.equal(pending?.batchId, batch.batchId)

    store.ackReminder({
      batchId: batch!.batchId,
      sessionId: "session-1",
      state: "confirmed",
    })

    assert.equal(store.getPendingReminder("session-1"), null)
    assert.equal(store.buildReminderBatch("session-1"), null)

    store.close()
  })

  test("keeps failed reminder batches retryable", () => {
    const store = createStore()

    store.registerClient("client-2", { pid: 456, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-2",
      sessionId: "session-2",
      repo: "acme/repo",
      branch: "feature/y",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/y", 8)
    store.insertEvents("acme/repo", 8, [
      {
        dedupeKey: "review.approved:9",
        kind: "review.approved",
        priority: "high",
        summary: "alice approved",
        payload: { reviewId: 9 },
      },
    ])

    const batch = store.buildReminderBatch("session-2")
    assert.ok(batch)

    store.ackReminder({
      batchId: batch!.batchId,
      sessionId: "session-2",
      state: "failed",
      error: "network",
    })

    const retryBatch = store.getPendingReminder("session-2")
    assert.equal(retryBatch?.batchId, batch.batchId)

    store.close()
  })

  test("paused sessions block delivery and resumed sessions recover", () => {
    const store = createStore()

    store.registerClient("client-3", { pid: 789, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-3",
      sessionId: "session-3",
      repo: "acme/repo",
      branch: "feature/z",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/z", 10)
    store.insertEvents("acme/repo", 10, [
      {
        dedupeKey: "check.failed:build:sha-10",
        kind: "check.failed",
        priority: "high",
        summary: "Check failed: build",
        payload: { name: "build" },
      },
    ])

    // Pause the session — should block delivery.
    store.setSessionPaused("session-3", true)
    assert.equal(store.buildReminderBatch("session-3"), null)

    // Events should still accumulate while paused.
    store.insertEvents("acme/repo", 10, [
      {
        dedupeKey: "issue_comment.created:99",
        kind: "issue_comment.created",
        priority: "high",
        summary: "New comment while paused",
        payload: { commentId: 99 },
      },
    ])
    assert.equal(store.buildReminderBatch("session-3"), null)

    // Resume — should now deliver both events.
    store.setSessionPaused("session-3", false)
    const batch = store.buildReminderBatch("session-3")
    assert.ok(batch)
    assert.equal(batch.events.length, 2)

    store.close()
  })

  test("restart recovery prunes stale leases and resets handed-off batches", () => {
    const store = createStore()

    // Simulate a previous daemon session: register client, session, PR, events, and a batch.
    store.registerClient("client-old", { pid: 111, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-old",
      sessionId: "session-restart",
      repo: "acme/repo",
      branch: "feature/restart",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/restart", 20)
    store.insertEvents("acme/repo", 20, [
      {
        dedupeKey: "check.failed:ci:sha-20",
        kind: "check.failed",
        priority: "high",
        summary: "Check failed: ci",
        payload: { name: "ci" },
      },
    ])

    // Build a batch and mark it handed_off (simulating crash mid-delivery).
    const batch = store.buildReminderBatch("session-restart")
    assert.ok(batch)
    store.ackReminder({
      batchId: batch.batchId,
      sessionId: "session-restart",
      state: "handed_off",
    })

    // Verify pre-recovery state.
    assert.equal(store.countActiveClients(), 1)
    assert.ok(store.getPendingReminder("session-restart"))

    // Simulate daemon restart.
    const recovery = store.recoverFromRestart()

    // Stale client leases should be pruned.
    assert.equal(recovery.prunedClients, 1)
    assert.equal(store.countActiveClients(), 0)

    // Handed-off batch should be reset (deleted).
    assert.equal(recovery.resetBatches, 1)
    assert.equal(store.getPendingReminder("session-restart"), null)

    // Session and watcher state should survive.
    assert.equal(recovery.recoveredSessions, 1)
    assert.ok(store.getSession("session-restart"))

    // Events survive, so rebuilding should work after a new client registers.
    const rebuilt = store.buildReminderBatch("session-restart")
    assert.ok(rebuilt)
    assert.equal(rebuilt.events.length, 1)

    store.close()
  })
})
