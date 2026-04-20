import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../persistence/store.ts"
import { BranchDiscoveryWatcher } from "./branch-discovery.ts"
import { PullRequestWatcher } from "./pr-watcher.ts"
import type { FindOpenPullRequestResult, GitHubClientLike, PullRequestSnapshotResult, PullRequestSummary } from "../github/client.ts"
import type { PullRequestSnapshot } from "../github/types.ts"
import { AdaptiveSchedule } from "./adaptive-schedule.ts"

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

type FixtureResult = { kind: "ok"; snapshot: PullRequestSnapshot; etag?: string | null } | { kind: "not_modified"; etag: string | null } | { kind: "not_found" }

type BranchFixture = { kind: "ok"; pr: PullRequestSummary | null; etag?: string | null } | { kind: "not_modified"; etag: string | null }

class FixtureGitHubClient implements GitHubClientLike {
  prForBranch: PullRequestSummary | null = null
  branchResults: BranchFixture[] = []
  results: FixtureResult[] = []
  lastBranchEtag: string | null | undefined = undefined
  private resultIndex = 0
  private branchIndex = 0

  async findOpenPullRequestForBranch(
    _repo: string,
    _branch: string,
    context?: { etag?: string | null },
  ): Promise<FindOpenPullRequestResult> {
    this.lastBranchEtag = context?.etag ?? null
    if (this.branchIndex < this.branchResults.length) {
      const next = this.branchResults[this.branchIndex++]
      if (next.kind === "ok") {
        return { kind: "ok", pr: next.pr, etag: next.etag ?? null }
      }
      return next
    }
    // Fallback to the legacy `prForBranch` field for older tests that set it.
    return { kind: "ok", pr: this.prForBranch, etag: null }
  }

  async fetchPullRequestSnapshot(): Promise<PullRequestSnapshotResult> {
    const next = this.results[this.resultIndex]
    if (!next) throw new Error("No more fixture results")
    this.resultIndex++
    if (next.kind === "ok") {
      return { kind: "ok", snapshot: next.snapshot, etag: next.etag ?? null }
    }
    return next
  }

  pushSnapshot(snapshot: PullRequestSnapshot, etag: string | null = null) {
    this.results.push({ kind: "ok", snapshot, etag })
  }

  pushNotModified(etag: string | null = null) {
    this.results.push({ kind: "not_modified", etag })
  }

  pushBranchResult(pr: PullRequestSummary | null, etag: string | null = null) {
    this.branchResults.push({ kind: "ok", pr, etag })
  }

  pushBranchNotModified(etag: string | null = null) {
    this.branchResults.push({ kind: "not_modified", etag })
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
    github.pushSnapshot(snap1)
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
    github.pushSnapshot(snap2)
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
    github.pushSnapshot(makeSnapshot())
    await prWatcher.tick()

    // Drain the initial batch for both sessions so cursors advance past the init event.
    const initBatchA = store.buildReminderBatch("session-a")
    assert.ok(initBatchA)
    store.ackReminder({ batchId: initBatchA.batchId, sessionId: "session-a", state: "confirmed" })
    const initBatchB = store.buildReminderBatch("session-b")
    assert.ok(initBatchB)
    store.ackReminder({ batchId: initBatchB.batchId, sessionId: "session-b", state: "confirmed" })

    // Tick 2: new review.
    github.pushSnapshot(makeSnapshot({
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

  test("branch discovery stores ETag, sends If-None-Match, and short-circuits on 304", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const watcher = new BranchDiscoveryWatcher(store, github)

    store.registerClient("client-be", { pid: 11, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-be",
      sessionId: "session-be",
      repo: "acme/repo",
      branch: "feature/etag",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })

    // Tick 1: first real response, returns etag.
    github.pushBranchResult(null, 'W/"branch-1"')
    await watcher.tick()
    assert.equal(github.lastBranchEtag, null, "first poll should send no If-None-Match")
    assert.equal(store.getEtag("branch.pulls", "acme/repo#feature/etag"), 'W/"branch-1"')

    // Tick 2: server returns 304, etag preserved.
    github.pushBranchNotModified('W/"branch-1"')
    await watcher.tick()
    assert.equal(github.lastBranchEtag, 'W/"branch-1"', "subsequent poll should send If-None-Match")
    assert.equal(store.getEtag("branch.pulls", "acme/repo#feature/etag"), 'W/"branch-1"')

    // Tick 3: server rotates etag on 304 — we persist the new one.
    github.pushBranchNotModified('W/"branch-2"')
    await watcher.tick()
    assert.equal(store.getEtag("branch.pulls", "acme/repo#feature/etag"), 'W/"branch-2"')

    store.close()
  })

  test("PR watcher skips fetches for quiet PRs until the active tier elapses", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    // Tight tiers so the test runs fast.
    const schedule = new AdaptiveSchedule({
      tiers: [
        { sinceMs: 1_000, intervalMs: 100 },
        { sinceMs: 5_000, intervalMs: 500 },
      ],
      idleIntervalMs: 2_000,
    })
    const prWatcher = new PullRequestWatcher(store, github, { schedule })

    store.registerClient("client-adap", { pid: 77, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-adap",
      sessionId: "session-adap",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)

    // t=0: first poll — always runs, gets initial snapshot.
    github.pushSnapshot(makeSnapshot(), 'W/"v1"')
    await prWatcher.tick(0)
    assert.equal(github.results.length - 1 /* results[0] consumed */, 0)

    // t=50ms: active tier says 100ms; should be skipped (no fetch issued).
    await prWatcher.tick(50)
    // If a fetch had been issued, the fixture would throw "No more fixture results".

    // t=150ms: 100ms elapsed → due. Fixture returns 304.
    github.pushNotModified('W/"v1"')
    await prWatcher.tick(150)

    // t=200ms: still too soon.
    await prWatcher.tick(200)

    // t=260ms: due again (100ms past 150). Fixture returns a real change — activity!
    github.pushSnapshot(
      makeSnapshot({
        issueComments: [{ id: 9001, body: "new!", user: { login: "reviewer" } }],
      }),
      'W/"v2"',
    )
    await prWatcher.tick(260)

    // Because activity just landed, we re-enter the active tier: 100ms from now.
    await prWatcher.tick(300) // skipped
    github.pushNotModified('W/"v2"')
    await prWatcher.tick(370) // due again (110ms after last check at 260)

    // Confirm we emitted the comment event.
    const events = store.listUndeliveredEvents("session-adap")
    const kinds = events.map((event) => event.kind)
    assert.ok(kinds.includes("issue_comment.created"), `expected issue_comment.created in ${JSON.stringify(kinds)}`)

    store.close()
  })

  test("PR watcher stores ETag and short-circuits on 304 not_modified", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-4", { pid: 4, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-4",
      sessionId: "session-etag",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)

    // Tick 1: real snapshot with ETag.
    github.pushSnapshot(makeSnapshot(), 'W/"etag-1"')
    await prWatcher.tick()

    assert.equal(store.getEtag("pr.snapshot", "acme/repo#42"), 'W/"etag-1"')
    const eventsAfterFirst = store.listUndeliveredEvents("session-etag")
    assert.ok(eventsAfterFirst.length > 0, "initial tick should produce init event")

    // Tick 2: 304 not modified. No new events expected.
    github.pushNotModified('W/"etag-1"')
    await prWatcher.tick()

    const eventsAfterSecond = store.listUndeliveredEvents("session-etag")
    assert.equal(
      eventsAfterSecond.length,
      eventsAfterFirst.length,
      "304 should not produce new events",
    )

    // Tick 3: 304 with a rotated ETag — should be persisted.
    github.pushNotModified('W/"etag-2"')
    await prWatcher.tick()
    assert.equal(store.getEtag("pr.snapshot", "acme/repo#42"), 'W/"etag-2"')

    store.close()
  })
})
