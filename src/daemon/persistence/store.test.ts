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

    // Only one session on its branch — nothing deduplicated.
    assert.equal(recovery.dedupedSessions, 0)

    // Session and watcher state should survive.
    assert.equal(recovery.recoveredSessions, 1)
    assert.ok(store.getSession("session-restart"))

    // Events survive, so rebuilding should work after a new client registers.
    const rebuilt = store.buildReminderBatch("session-restart")
    assert.ok(rebuilt)
    assert.equal(rebuilt.events.length, 1)

    store.close()
  })

  test("updateSessionState revives a closed session when busyState is provided", () => {
    const store = createStore()
    store.registerClient("client-revival", { pid: 1, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-revival", sessionId: "revive-ses", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })

    // Simulate supersession closing the session.
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id = 'revive-ses'`).run()
    assert.equal(store.getSession("revive-ses")?.status, "closed")

    // A busyState update should revive it.
    const result = store.updateSessionState({ sessionId: "revive-ses", busyState: "busy" })
    assert.deepEqual(result, { updated: true, revived: true })
    assert.equal(store.getSession("revive-ses")?.status, "active")
    assert.equal(store.getSession("revive-ses")?.busy_state, "busy")

    store.close()
  })

  test("updateSessionState on active session does not set revived", () => {
    const store = createStore()
    store.registerClient("client-no-revival", { pid: 1, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-no-revival", sessionId: "active-ses", repo: "acme/repo",
      branch: "feature/y", isPrimary: true, status: "active", busyState: "idle",
    })

    const result = store.updateSessionState({ sessionId: "active-ses", busyState: "busy" })
    assert.deepEqual(result, { updated: true, revived: false })
    assert.equal(store.getSession("active-ses")?.status, "active")

    store.close()
  })

  test("updateSessionState on unknown session returns updated:false", () => {
    const store = createStore()
    const result = store.updateSessionState({ sessionId: "does-not-exist", busyState: "busy" })
    assert.deepEqual(result, { updated: false, revived: false })
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

  test("registerSession returns {created: true} for a fresh row", () => {
    const store = createStore()
    store.registerClient("client-re-1", { pid: 1, projectRoot: "/tmp/project" })

    const result = store.registerSession({
      clientId: "client-re-1",
      sessionId: "session-fresh",
      repo: "acme/repo",
      branch: "feature/fresh",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    assert.deepEqual(result, { created: true, superseded: 0 })

    store.close()
  })

  test("registerSession returns {created: false} when re-registering the same session", () => {
    const store = createStore()
    store.registerClient("client-re-2", { pid: 2, projectRoot: "/tmp/project" })

    const first = store.registerSession({
      clientId: "client-re-2",
      sessionId: "session-reattach",
      repo: "acme/repo",
      branch: "feature/reattach",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    assert.deepEqual(first, { created: true, superseded: 0 })

    const second = store.registerSession({
      clientId: "client-re-2",
      sessionId: "session-reattach",
      repo: "acme/repo",
      branch: "feature/reattach",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    assert.deepEqual(second, { created: false, superseded: 0 })

    store.close()
  })

  test("recordBranchAssociation on fresh PR with existing events skips replay by advancing cursor", () => {
    const store = createStore()
    store.registerClient("client-re-3", { pid: 3, projectRoot: "/tmp/project" })

    // Simulate a prior daemon run having recorded events for PR #42. The session does
    // not yet exist — these events are historical from the perspective of the session
    // we're about to attach.
    store.recordBranchAssociation("acme/repo", "feature/skip-replay", 42)
    store.insertEvents("acme/repo", 42, [
      {
        dedupeKey: "event-1",
        kind: "issue_comment.created",
        priority: "high",
        summary: "Historical event 1",
        payload: {},
      },
      {
        dedupeKey: "event-2",
        kind: "issue_comment.created",
        priority: "high",
        summary: "Historical event 2",
        payload: {},
      },
    ])

    // Now attach a fresh session to the same branch; recordBranchAssociation runs again
    // as part of the discovery path.
    store.registerSession({
      clientId: "client-re-3",
      sessionId: "session-skip-replay",
      repo: "acme/repo",
      branch: "feature/skip-replay",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/skip-replay", 42)

    // Build a reminder batch — historical events should have been skipped.
    assert.equal(store.buildReminderBatch("session-skip-replay"), null)

    // New events after association should deliver normally.
    store.insertEvents("acme/repo", 42, [
      {
        dedupeKey: "event-3",
        kind: "issue_comment.created",
        priority: "high",
        summary: "Fresh event after attach",
        payload: {},
      },
    ])
    const batch = store.buildReminderBatch("session-skip-replay")
    assert.ok(batch)
    assert.equal(batch.events.length, 1)
    assert.equal(batch.events[0].summary, "Fresh event after attach")

    store.close()
  })

  test("recordBranchAssociation does NOT reset cursor on idempotent re-association", () => {
    const store = createStore()
    store.registerClient("client-re-4", { pid: 4, projectRoot: "/tmp/project" })

    store.registerSession({
      clientId: "client-re-4",
      sessionId: "session-idempotent",
      repo: "acme/repo",
      branch: "feature/idempotent",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/idempotent", 7)

    // Deliver and confirm an event; cursor should advance via ack.
    store.insertEvents("acme/repo", 7, [
      {
        dedupeKey: "evt-a",
        kind: "issue_comment.created",
        priority: "high",
        summary: "Real delivered event",
        payload: {},
      },
    ])
    const batch = store.buildReminderBatch("session-idempotent")
    assert.ok(batch)
    store.ackReminder({
      batchId: batch!.batchId,
      sessionId: "session-idempotent",
      state: "confirmed",
    })

    // Re-running association with the same PR must NOT roll the cursor backwards or
    // forwards; subsequent new events must still be delivered.
    store.recordBranchAssociation("acme/repo", "feature/idempotent", 7)
    store.insertEvents("acme/repo", 7, [
      {
        dedupeKey: "evt-b",
        kind: "issue_comment.created",
        priority: "high",
        summary: "Next event after re-association",
        payload: {},
      },
    ])
    const nextBatch = store.buildReminderBatch("session-idempotent")
    assert.ok(nextBatch)
    assert.equal(nextBatch.events.length, 1)
    assert.equal(nextBatch.events[0].summary, "Next event after re-association")

    store.close()
  })

  test("pruneClosedSessions: deletes closed rows older than retention, preserves recent and active", () => {
    const store = createStore()
    const now = Date.now()
    const retentionMs = 24 * 60 * 60 * 1000 // 24 h

    store.registerClient("client-prune", { pid: 1, projectRoot: "/tmp/project" })

    // Session closed a long time ago (beyond retention).
    store.registerSession({
      clientId: "client-prune", sessionId: "old-closed", repo: "acme/repo",
      branch: "old", isPrimary: true, status: "active", busyState: "idle",
    }, now - retentionMs - 1000)
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed', updated_at = :t WHERE session_id = 'old-closed'`)
      .run({ t: now - retentionMs - 1000 })

    // Session closed recently (within retention window).
    store.registerSession({
      clientId: "client-prune", sessionId: "recent-closed", repo: "acme/repo",
      branch: "recent", isPrimary: true, status: "active", busyState: "idle",
    }, now - 1000)
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed', updated_at = :t WHERE session_id = 'recent-closed'`)
      .run({ t: now - 1000 })

    // Active session — must never be touched.
    store.registerSession({
      clientId: "client-prune", sessionId: "still-active", repo: "acme/repo",
      branch: "active", isPrimary: true, status: "active", busyState: "idle",
    }, now)

    const pruned = store.pruneClosedSessions(retentionMs, now)
    assert.equal(pruned, 1, "only the old closed session should be pruned")
    assert.ok(!store.getSession("old-closed"), "old closed session should be gone")
    assert.ok(store.getSession("recent-closed"), "recently closed session should survive")
    assert.ok(store.getSession("still-active"), "active session must not be pruned")

    store.close()
  })

  test("pruneClosedSessions: reminder_batches cascade-deleted with session", () => {
    const store = createStore()
    const now = Date.now()
    const retentionMs = 1000 // very short for test

    store.registerClient("client-cascade", { pid: 1, projectRoot: "/tmp/project" })
    store.registerSession({
      clientId: "client-cascade", sessionId: "cascade-session", repo: "acme/repo",
      branch: "cascade", isPrimary: true, status: "active", busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "cascade", 99)
    store.insertEvents("acme/repo", 99, [{
      dedupeKey: "ev-cascade", kind: "issue_comment.created", priority: "high",
      summary: "cascade test", payload: {},
    }])
    // Build a reminder batch so there's a reminder_batches row.
    store.buildReminderBatch("cascade-session", now - 2000)

    // Close and age the session beyond retention.
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed', updated_at = :t WHERE session_id = 'cascade-session'`)
      .run({ t: now - 2000 })

    const pruned = store.pruneClosedSessions(retentionMs, now)
    assert.equal(pruned, 1)
    // The reminder batch should be gone via CASCADE.
    assert.equal(store.getPendingReminder("cascade-session"), null)

    store.close()
  })

  test("pruneOrphanedPrEvents: removes events and snapshots for PRs with no active sessions", () => {
    const store = createStore()

    store.registerClient("client-orphan", { pid: 1, projectRoot: "/tmp/project" })

    // PR 1: closed session — events should be pruned.
    store.registerSession({
      clientId: "client-orphan", sessionId: "closed-ses", repo: "acme/repo",
      branch: "branch-a", isPrimary: true, status: "active", busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "branch-a", 1)
    store.saveSnapshot("acme/repo", 1, snapshot())
    store.insertEvents("acme/repo", 1, [{
      dedupeKey: "orphan-ev-1", kind: "issue_comment.created", priority: "high",
      summary: "orphaned event", payload: {},
    }])
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id = 'closed-ses'`).run()

    // PR 2: active session — events must survive.
    store.registerSession({
      clientId: "client-orphan", sessionId: "active-ses", repo: "acme/repo",
      branch: "branch-b", isPrimary: true, status: "active", busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "branch-b", 2)
    store.insertEvents("acme/repo", 2, [{
      dedupeKey: "active-ev-1", kind: "issue_comment.created", priority: "high",
      summary: "active event", payload: {},
    }])

    const prunedEvents = store.pruneOrphanedPrEvents()
    assert.equal(prunedEvents, 1, "should prune 1 event for the orphaned PR")

    // PR 1 events gone, snapshot gone.
    const eventsForPr1 = (store as any).db.prepare(`SELECT COUNT(*) AS c FROM pr_events WHERE repo = 'acme/repo' AND pr_number = 1`).get() as { c: number }
    assert.equal(eventsForPr1.c, 0)
    assert.equal(store.getSnapshot("acme/repo", 1), null, "snapshot for orphaned PR should be pruned")

    // PR 2 events survive.
    const eventsForPr2 = (store as any).db.prepare(`SELECT COUNT(*) AS c FROM pr_events WHERE repo = 'acme/repo' AND pr_number = 2`).get() as { c: number }
    assert.equal(eventsForPr2.c, 1)

    store.close()
  })

  test("pruneOrphanedPrEvents: PR with mixed active+closed sessions is NOT pruned", () => {
    const store = createStore()

    store.registerClient("client-mixed", { pid: 1, projectRoot: "/tmp/project" })

    // Two sessions on the same PR: one closed, one still active.
    store.registerSession({
      clientId: "client-mixed", sessionId: "mixed-closed", repo: "acme/repo",
      branch: "mixed", isPrimary: true, status: "active", busyState: "idle",
    })
    store.registerSession({
      clientId: "client-mixed", sessionId: "mixed-active", repo: "acme/repo",
      branch: "mixed", isPrimary: false, status: "active", busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "mixed", 3)
    store.insertEvents("acme/repo", 3, [{
      dedupeKey: "mixed-ev", kind: "review.approved", priority: "high",
      summary: "mixed event", payload: {},
    }])
    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id = 'mixed-closed'`).run()

    const prunedEvents = store.pruneOrphanedPrEvents()
    assert.equal(prunedEvents, 0, "should not prune events when at least one active session exists")

    const eventsForPr3 = (store as any).db.prepare(`SELECT COUNT(*) AS c FROM pr_events WHERE repo = 'acme/repo' AND pr_number = 3`).get() as { c: number }
    assert.equal(eventsForPr3.c, 1)

    store.close()
  })

  test("countClosedSessions: counts only closed rows", () => {
    const store = createStore()
    store.registerClient("client-count", { pid: 1, projectRoot: "/tmp/project" })

    assert.equal(store.countClosedSessions(), 0)

    store.registerSession({ clientId: "client-count", sessionId: "s-active", repo: "r", branch: "b", isPrimary: true, status: "active", busyState: "idle" })
    store.registerSession({ clientId: "client-count", sessionId: "s-closed-1", repo: "r", branch: "b2", isPrimary: true, status: "active", busyState: "idle" })
    store.registerSession({ clientId: "client-count", sessionId: "s-closed-2", repo: "r", branch: "b3", isPrimary: true, status: "active", busyState: "idle" })

    ;(store as any).db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id IN ('s-closed-1', 's-closed-2')`).run()

    assert.equal(store.countClosedSessions(), 2)
    store.close()
  })

  test("recoverFromRestart deduplicates: keeps most-recent session per branch, closes the rest", () => {
    const store = createStore()
    const now = Date.now()

    store.registerClient("client-dedup", { pid: 1, projectRoot: "/tmp/project" }, now - 10_000)

    // Insert three sessions on the same branch directly (bypassing registerSession's
    // own supersession so we can simulate the pre-fix state where duplicates existed).
    const insertSession = (store as any).db.prepare(`
      INSERT INTO sessions (session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
      VALUES (:id, 'client-dedup', 'acme/repo', 'feature/x', NULL, 1, 'active', 'idle', 0, :t, :t, :t)
    `)
    insertSession.run({ id: "oldest", t: now - 3000 })
    insertSession.run({ id: "middle", t: now - 2000 })
    insertSession.run({ id: "newest", t: now - 1000 })

    // A session on a different branch — must not be affected.
    ;(store as any).db.prepare(`
      INSERT INTO sessions (session_id, client_id, repo, branch, pr_number, is_primary, status, busy_state, last_delivered_event_seq, last_activity_at, created_at, updated_at)
      VALUES ('other-branch', 'client-dedup', 'acme/repo', 'feature/y', NULL, 1, 'active', 'idle', 0, :t, :t, :t)
    `).run({ t: now - 500 })

    const recovery = store.recoverFromRestart(now)

    assert.equal(recovery.dedupedSessions, 2, "oldest and middle should be closed")
    assert.equal(store.getSession("oldest")?.status, "closed")
    assert.equal(store.getSession("middle")?.status, "closed")
    assert.equal(store.getSession("newest")?.status, "active", "most-recent session survives")
    assert.equal(store.getSession("other-branch")?.status, "active", "different branch unaffected")
    assert.equal(recovery.recoveredSessions, 2, "two active sessions remain after dedup")

    store.close()
  })

  test("registerSession closes superseded sessions on the same (repo, branch)", () => {
    const store = createStore()
    store.registerClient("client-sup", { pid: 1, projectRoot: "/tmp/project" })

    // Register session A on acme/repo @ feature/x.
    const r1 = store.registerSession({
      clientId: "client-sup", sessionId: "session-A", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })
    assert.deepEqual(r1, { created: true, superseded: 0 })
    assert.equal(store.getSession("session-A")?.status, "active")

    // Register session B on the same branch — A should be superseded.
    const r2 = store.registerSession({
      clientId: "client-sup", sessionId: "session-B", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })
    assert.deepEqual(r2, { created: true, superseded: 1 })
    assert.equal(store.getSession("session-A")?.status, "closed", "A should be closed")
    assert.equal(store.getSession("session-B")?.status, "active", "B should be active")

    store.close()
  })

  test("registerSession does NOT close sessions on different branches", () => {
    const store = createStore()
    store.registerClient("client-diff", { pid: 1, projectRoot: "/tmp/project" })

    store.registerSession({
      clientId: "client-diff", sessionId: "branch-a-ses", repo: "acme/repo",
      branch: "feature/a", isPrimary: true, status: "active", busyState: "idle",
    })
    const r = store.registerSession({
      clientId: "client-diff", sessionId: "branch-b-ses", repo: "acme/repo",
      branch: "feature/b", isPrimary: true, status: "active", busyState: "idle",
    })

    assert.equal(r.superseded, 0, "different branch must not be superseded")
    assert.equal(store.getSession("branch-a-ses")?.status, "active")
    assert.equal(store.getSession("branch-b-ses")?.status, "active")

    store.close()
  })

  test("registerSession re-registering the same session does not close itself", () => {
    const store = createStore()
    store.registerClient("client-idem", { pid: 1, projectRoot: "/tmp/project" })

    store.registerSession({
      clientId: "client-idem", sessionId: "session-X", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })
    const r = store.registerSession({
      clientId: "client-idem", sessionId: "session-X", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })

    assert.deepEqual(r, { created: false, superseded: 0 }, "idempotent re-register must not supersede itself")
    assert.equal(store.getSession("session-X")?.status, "active")

    store.close()
  })

  test("superseded sessions become orphan-pruneable once they lose the only active reference", () => {
    const store = createStore()
    store.registerClient("client-orphan2", { pid: 1, projectRoot: "/tmp/project" })

    // Register A, associate with PR 7.
    store.registerSession({
      clientId: "client-orphan2", sessionId: "sup-A", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/x", 7)
    store.insertEvents("acme/repo", 7, [{
      dedupeKey: "sup-ev-1", kind: "review.approved", priority: "high",
      summary: "approved", payload: {},
    }])

    // Before supersession: events must NOT be prunable (A is active).
    assert.equal(store.pruneOrphanedPrEvents(), 0, "events must survive while A is active")

    // Register B on the same branch — supersedes A.
    store.registerSession({
      clientId: "client-orphan2", sessionId: "sup-B", repo: "acme/repo",
      branch: "feature/x", isPrimary: true, status: "active", busyState: "idle",
    })
    assert.equal(store.getSession("sup-A")?.status, "closed")

    // B has no pr_number yet (recordBranchAssociation hasn't run for it).
    // So PR 7 now has zero active sessions — events are prunable.
    assert.equal(store.pruneOrphanedPrEvents(), 1, "events for orphaned PR should now be prunable")

    store.close()
  })
})
