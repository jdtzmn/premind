import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "./store.js"
import type { PullRequestSnapshot } from "../github/types.js"

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
})
