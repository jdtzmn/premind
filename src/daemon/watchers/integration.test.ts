import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../persistence/store.js"
import { BranchDiscoveryWatcher } from "./branch-discovery.js"
import { PullRequestWatcher } from "./pr-watcher.js"
import type { GitHubClientLike, PullRequestSummary } from "../github/client.js"
import type { PullRequestSnapshot } from "../github/types.js"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-integration-test-"))
  const dbPath = path.join(dir, "premind.db")
  tempPaths.push(dir)
  return new StateStore(dbPath)
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

class FixtureGitHubClient implements GitHubClientLike {
  prForBranch: PullRequestSummary | null = null
  snapshots: PullRequestSnapshot[] = []
  private snapshotIndex = 0

  async findOpenPullRequestForBranch() {
    return this.prForBranch
  }

  async fetchPullRequestSnapshot() {
    const snapshot = this.snapshots[this.snapshotIndex]
    if (!snapshot) throw new Error("No more fixture snapshots")
    this.snapshotIndex++
    return snapshot
  }
}

const makeSnapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  core: {
    number: 42,
    title: "Test PR",
    url: "https://github.com/acme/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature/test",
    baseRefName: "main",
    headRefOid: "sha-1",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    reviewRequests: [],
    updatedAt: "2026-04-08T00:00:00Z",
    ...(overrides.core ?? {}),
  },
  reviews: overrides.reviews ?? [],
  issueComments: overrides.issueComments ?? [],
  reviewComments: overrides.reviewComments ?? [],
  checks: overrides.checks ?? [],
  fetchedAt: overrides.fetchedAt ?? Date.now(),
})

describe("watcher integration", () => {
  test("branch discovery finds a PR and attaches sessions", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const watcher = new BranchDiscoveryWatcher(store, github)

    store.registerClient("client-1", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-1",
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })

    // First tick: no PR yet.
    github.prForBranch = null
    await watcher.tick()
    assert.equal(store.getSession("session-1")?.pr_number, null)

    // Second tick: PR appears.
    github.prForBranch = { number: 42, title: "Test PR", url: "https://github.com/acme/repo/pull/42", draft: false, state: "open" }
    await watcher.tick()
    assert.equal(store.getSession("session-1")?.pr_number, 42)

    // A pr.discovered event should exist.
    const events = store.listUndeliveredEvents("session-1")
    assert.ok(events.length > 0)
    assert.ok(events.some((e) => e.kind === "pr.discovered"))

    store.close()
  })

  test("PR watcher detects new comments and check failures across ticks", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)

    // Set up a session already attached to a PR.
    store.registerClient("client-2", { pid: 2, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-2",
      sessionId: "session-2",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)

    // Tick 1: initial snapshot.
    const snap1 = makeSnapshot()
    github.snapshots.push(snap1)
    await prWatcher.tick()

    // Tick 2: new comment + failing check.
    const snap2 = makeSnapshot({
      issueComments: [
        { id: 100, body: "Please address this", user: { login: "reviewer" } },
      ],
      checks: [
        { name: "build", state: "fail", link: "https://ci.example/build" },
      ],
    })
    github.snapshots.push(snap2)
    await prWatcher.tick()

    const events = store.listUndeliveredEvents("session-2")
    const kinds = events.map((e) => e.kind)
    assert.ok(kinds.includes("issue_comment.created"), `expected issue_comment.created in ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes("check.failed"), `expected check.failed in ${JSON.stringify(kinds)}`)

    // A reminder batch should be buildable and include the new events.
    const batch = store.buildReminderBatch("session-2")
    assert.ok(batch)
    assert.ok(batch.reminderText.includes("<system-reminder>"))
    assert.ok(batch.events.length >= 1, `expected at least 1 event, got ${batch.events.length}`)

    store.close()
  })

  test("two sessions on same PR get independent delivery cursors", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-3", { pid: 3, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-3",
      sessionId: "session-a",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.registerSession({
      clientId: "client-3",
      sessionId: "session-b",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)

    // Tick 1: initial snapshot — produces pr.snapshot.initialized event.
    github.snapshots.push(makeSnapshot())
    await prWatcher.tick()

    // Drain the initial batch for both sessions so cursors advance past the init event.
    const initBatchA = store.buildReminderBatch("session-a")
    assert.ok(initBatchA)
    store.ackReminder({ batchId: initBatchA.batchId, sessionId: "session-a", state: "confirmed" })
    const initBatchB = store.buildReminderBatch("session-b")
    assert.ok(initBatchB)
    store.ackReminder({ batchId: initBatchB.batchId, sessionId: "session-b", state: "confirmed" })

    // Tick 2: new review.
    github.snapshots.push(makeSnapshot({
      reviews: [{ id: 200, state: "APPROVED", body: "LGTM", user: { login: "lead" } }],
    }))
    await prWatcher.tick()

    // Both sessions should have the new review event pending.
    const batchA = store.buildReminderBatch("session-a")
    const batchB = store.buildReminderBatch("session-b")
    assert.ok(batchA)
    assert.ok(batchB)

    // Confirm delivery for session-a only.
    store.ackReminder({ batchId: batchA.batchId, sessionId: "session-a", state: "confirmed" })

    // session-a should be caught up, session-b should still have pending.
    assert.equal(store.buildReminderBatch("session-a"), null)
    const stillPendingB = store.buildReminderBatch("session-b")
    assert.ok(stillPendingB)

    store.close()
  })
})
