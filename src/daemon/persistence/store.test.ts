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

  test("global disable flag defaults to false and persists when toggled", () => {
    const store = createStore()

    // Default is false.
    assert.equal(store.isGloballyDisabled(), false)

    // Setting to true persists.
    store.setGloballyDisabled(true)
    assert.equal(store.isGloballyDisabled(), true)

    // Setting to false clears.
    store.setGloballyDisabled(false)
    assert.equal(store.isGloballyDisabled(), false)

    // Idempotent: setting the same value twice is fine.
    store.setGloballyDisabled(true)
    store.setGloballyDisabled(true)
    assert.equal(store.isGloballyDisabled(), true)

    store.close()
  })

  test("global disable flag survives across store instances (same db file)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-store-test-"))
    const dbPath = path.join(dir, "premind.db")
    tempPaths.push(dir)

    const first = new StateStore(dbPath)
    first.setGloballyDisabled(true)
    first.close()

    const second = new StateStore(dbPath)
    assert.equal(second.isGloballyDisabled(), true)
    second.close()
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

  test("last_activity_at: registerSession sets it to now", () => {
    const store = createStore()
    const now = 1_000_000
    store.registerClient("client-a", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-a",
        sessionId: "session-a",
        repo: "acme/repo",
        branch: "feature/a",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now,
    )
    const session = store.getSession("session-a")
    assert.ok(session)
    assert.equal(session.last_activity_at, now)
    store.close()
  })

  test("last_activity_at: updateSessionState bumps it", () => {
    const store = createStore()
    const createdAt = 1_000_000
    const updateAt = 2_000_000
    store.registerClient("client-b", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-b",
        sessionId: "session-b",
        repo: "acme/repo",
        branch: "feature/b",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      createdAt,
    )

    store.updateSessionState({ sessionId: "session-b", busyState: "busy" }, updateAt)

    const session = store.getSession("session-b")
    assert.ok(session)
    assert.equal(session.last_activity_at, updateAt)
    store.close()
  })

  test("last_activity_at: recordBranchAssociation does NOT bump it", () => {
    const store = createStore()
    const createdAt = 1_000_000
    const branchAssocAt = 5_000_000
    store.registerClient("client-c", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-c",
        sessionId: "session-c",
        repo: "acme/repo",
        branch: "feature/c",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      createdAt,
    )

    store.recordBranchAssociation("acme/repo", "feature/c", 42, branchAssocAt)

    const session = store.getSession("session-c")
    assert.ok(session)
    // last_activity_at must NOT have been touched by branch discovery.
    assert.equal(session.last_activity_at, createdAt)
    store.close()
  })

  test("last_activity_at: updateDeliveredEventSeq (via ack) does NOT bump it", () => {
    const store = createStore()
    const createdAt = 1_000_000
    store.registerClient("client-d", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-d",
        sessionId: "session-d",
        repo: "acme/repo",
        branch: "feature/d",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      createdAt,
    )
    store.recordBranchAssociation("acme/repo", "feature/d", 55, createdAt)
    store.insertEvents("acme/repo", 55, [
      {
        dedupeKey: "issue_comment.created:1",
        kind: "issue_comment.created",
        priority: "high",
        summary: "hello",
        payload: {},
      },
    ])
    const batch = store.buildReminderBatch("session-d")
    assert.ok(batch)

    // Confirmed ack runs updateDeliveredEventSeq internally.
    store.ackReminder({
      batchId: batch.batchId,
      sessionId: "session-d",
      state: "confirmed",
    })

    const session = store.getSession("session-d")
    assert.ok(session)
    // last_activity_at must NOT have been touched by ack / delivery cursor.
    assert.equal(session.last_activity_at, createdAt)
    store.close()
  })

  test("last_activity_at: setSessionPaused does NOT bump it", () => {
    const store = createStore()
    const createdAt = 1_000_000
    store.registerClient("client-e", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-e",
        sessionId: "session-e",
        repo: "acme/repo",
        branch: "feature/e",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      createdAt,
    )

    store.setSessionPaused("session-e", true)

    const session = store.getSession("session-e")
    assert.ok(session)
    // Pausing is not "user activity" — it must not refresh the staleness clock.
    assert.equal(session.last_activity_at, createdAt)
    store.close()
  })

  test("reapStaleSessions: fresh session not reaped, stale active session reaped", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r1", { pid: 1, projectRoot: "/tmp/p" })

    // Fresh session registered "now".
    store.registerSession(
      {
        clientId: "client-r1",
        sessionId: "session-fresh",
        repo: "acme/repo",
        branch: "feature/fresh",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now,
    )

    // Stale session registered "threshold + 1ms" ago.
    store.registerSession(
      {
        clientId: "client-r1",
        sessionId: "session-stale",
        repo: "acme/repo",
        branch: "feature/stale",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold - 1,
    )

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 1)

    assert.equal(store.getSession("session-fresh")?.status, "active")
    assert.equal(store.getSession("session-stale")?.status, "closed")
    store.close()
  })

  test("reapStaleSessions: stale paused session is also reaped", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r2", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r2",
        sessionId: "session-paused-stale",
        repo: "acme/repo",
        branch: "feature/ps",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold - 10_000,
    )
    store.setSessionPaused("session-paused-stale", true)

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 1)
    assert.equal(store.getSession("session-paused-stale")?.status, "closed")
    store.close()
  })

  test("reapStaleSessions: already-closed session is not re-updated", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r3", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r3",
        sessionId: "session-already-closed",
        repo: "acme/repo",
        branch: "feature/ac",
        isPrimary: true,
        status: "closed",
        busyState: "idle",
      },
      now - threshold - 10_000,
    )

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 0)
    store.close()
  })

  test("reapStaleSessions: boundary (strict <) — session exactly at cutoff is NOT reaped", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r4", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r4",
        sessionId: "session-boundary",
        repo: "acme/repo",
        branch: "feature/b",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold, // last_activity_at === cutoff
    )

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 0)
    assert.equal(store.getSession("session-boundary")?.status, "active")
    store.close()
  })

  test("reapStaleSessions: oldestAgeMs returns null when no non-closed sessions remain", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r5", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r5",
        sessionId: "session-only",
        repo: "acme/repo",
        branch: "feature/only",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold - 1,
    )

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 1)
    assert.equal(result.oldestAgeMs, null)
    store.close()
  })

  test("reapStaleSessions: oldestAgeMs reflects age of oldest surviving session", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r6", { pid: 1, projectRoot: "/tmp/p" })
    // Two fresh sessions, one "older" but still fresh.
    store.registerSession(
      {
        clientId: "client-r6",
        sessionId: "session-youngest",
        repo: "acme/repo",
        branch: "feature/y",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - 1_000,
    )
    store.registerSession(
      {
        clientId: "client-r6",
        sessionId: "session-oldest-fresh",
        repo: "acme/repo",
        branch: "feature/of",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - 60_000,
    )

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 0)
    assert.equal(result.oldestAgeMs, 60_000)
    store.close()
  })

  test("reapStaleSessions: reaping drops watcher active_session_count via refreshWatcherCounts", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000
    store.registerClient("client-r7", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r7",
        sessionId: "session-watched",
        repo: "acme/repo",
        branch: "feature/w",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold - 10_000,
    )
    store.recordBranchAssociation("acme/repo", "feature/w", 42, now - threshold - 10_000)

    // Before reap: the PR watcher should count our one session.
    const beforeTargets = store.listPrWatchTargets(now - threshold - 5_000)
    assert.equal(beforeTargets.length, 1)
    assert.equal(beforeTargets[0]?.active_session_count, 1)

    store.reapStaleSessions(threshold, now)

    // After reap: the session is closed, so the watcher has no active sessions.
    const afterTargets = store.listPrWatchTargets(now)
    assert.equal(afterTargets.length, 0)
    store.close()
  })

  test("reapStaleSessions: lastReapAt/lastReapCount recorded even when nothing reaped", () => {
    const store = createStore()
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000

    assert.equal(store.getLastReapAt(), null)
    assert.equal(store.getLastReapCount(), 0)

    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 0)
    assert.equal(store.getLastReapAt(), now)
    assert.equal(store.getLastReapCount(), 0)

    // Second sweep with a session that needs reaping.
    const later = now + 1_000
    store.registerClient("client-r8", { pid: 1, projectRoot: "/tmp/p" })
    store.registerSession(
      {
        clientId: "client-r8",
        sessionId: "session-gone",
        repo: "acme/repo",
        branch: "feature/g",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      later - threshold - 1,
    )

    const result2 = store.reapStaleSessions(threshold, later)
    assert.equal(result2.reaped, 1)
    assert.equal(store.getLastReapAt(), later)
    assert.equal(store.getLastReapCount(), 1)
    store.close()
  })
})
