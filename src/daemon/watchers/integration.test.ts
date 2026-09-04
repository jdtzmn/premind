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
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-integration-test-"))
  const dbPath = path.join(dir, "premind.db")
  tempPaths.push(dir)
  return new StateStore(dbPath)
}

const confirmReminder = (store: StateStore, batchId: string, sessionId: string) => {
  assert.equal(store.ackReminder({ batchId, sessionId, state: "handed_off" }), true)
  assert.equal(store.ackReminder({ batchId, sessionId, state: "confirmed" }), true)
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
  viewerLogin: string | null = "octocat"
  private branchIndex = 0

  async getViewerLogin(): Promise<string | null> {
    return this.viewerLogin
  }

  private withAuthor(pr: PullRequestSummary | null): PullRequestSummary | null {
    return pr ? { ...pr, authorLogin: pr.authorLogin ?? this.viewerLogin } : null
  }

  async findOpenPullRequestForBranch(
    _repo: string,
    _branch: string,
    context?: { etag?: string | null },
  ): Promise<FindOpenPullRequestResult> {
    this.lastBranchEtag = context?.etag ?? null
    if (this.branchIndex < this.branchResults.length) {
      const next = this.branchResults[this.branchIndex++]
      if (next.kind === "ok") {
        return { kind: "ok", pr: this.withAuthor(next.pr), etag: next.etag ?? null }
      }
      return next
    }
    // Fallback to the legacy `prForBranch` field for older tests that set it.
    return { kind: "ok", pr: this.withAuthor(this.prForBranch), etag: null }
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
  test("branch discovery baselines an automatic subscription from an active worktree", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const worktreeBindings = new WorktreeBindingRegistry(store)
    const watcher = new BranchDiscoveryWatcher(store, github, worktreeBindings)

    store.registerClient("client-1", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-1",
      sessionId: "session-1",
      repo: "acme/repo",
      branch: "legacy-branch",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.upsertWorktreeBinding({
      sessionId: "session-1",
      root: "/tmp/worktree",
      gitDir: "/tmp/.git/worktrees/test",
      repo: "acme/repo",
      branch: "feature/test",
      headSha: "abc123",
      state: "waiting_for_pr",
    })

    github.prForBranch = null
    assert.equal(worktreeBindings.has("session-1"), false)
    await watcher.tick()
    assert.equal(worktreeBindings.has("session-1"), true)
    assert.equal(worktreeBindings.getSnapshot("session-1").value, "waiting_for_pr")
    assert.equal(store.getSubscription("session-1", "acme/repo", 42), null)

    github.prForBranch = { number: 42, title: "Test PR", url: "https://github.com/acme/repo/pull/42", draft: false, state: "open" }
    await watcher.tick()

    assert.equal(worktreeBindings.getSnapshot("session-1").value, "following_automatic_pr")
    assert.equal(store.getWorktreeBinding("session-1")?.state, "following_automatic_pr")
    assert.equal(store.getSession("session-1")?.pr_number, null)
    const subscription = store.getSubscription("session-1", "acme/repo", 42)
    assert.equal(subscription?.source, "automatic")
    assert.equal(subscription?.state, "active")
    assert.deepEqual(
      store.listUndeliveredEventsForSubscription(subscription!.subscriptionId)
        .map((event) => event.kind),
      ["pr.discovered"],
    )

    store.close()
  })

  test("does not automatically watch a PR authored by another GitHub user", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const watcher = new BranchDiscoveryWatcher(store, github)

    store.registerClient("client-foreign", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-foreign",
      sessionId: "session-foreign",
      repo: "acme/repo",
      branch: "feature/foreign",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.upsertWorktreeBinding({
      sessionId: "session-foreign",
      root: "/tmp/worktree-foreign",
      gitDir: "/tmp/.git/worktrees/foreign",
      repo: "acme/repo",
      branch: "feature/foreign",
      headSha: "abc123",
      state: "waiting_for_pr",
    })
    store.upsertSubscription({
      sessionId: "session-foreign",
      repo: "acme/repo",
      prNumber: 99,
      source: "manual",
    })
    github.prForBranch = {
      number: 42,
      title: "Foreign PR",
      url: "https://github.com/acme/repo/pull/42",
      draft: false,
      state: "open",
      authorLogin: "someone-else",
    }

    await watcher.tick()

    assert.equal(store.getWorktreeBinding("session-foreign")?.state, "foreign_pr")
    assert.equal(store.getSubscription("session-foreign", "acme/repo", 42), null)
    assert.equal(store.getSubscription("session-foreign", "acme/repo", 99)?.source, "manual")
    assert.equal(store.listPrWatchTargets().some((target) => target.pr_number === 42), false)
    store.close()
  })
  test("revokes legacy automatic subscriptions for foreign-authored PRs", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const watcher = new BranchDiscoveryWatcher(store, github)

    store.registerClient("client-legacy-foreign", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-legacy-foreign",
      sessionId: "session-legacy-foreign",
      repo: "acme/repo",
      branch: "feature/legacy-foreign",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/legacy-foreign", 42)
    github.prForBranch = {
      number: 42,
      title: "Foreign PR",
      url: "https://github.com/acme/repo/pull/42",
      draft: false,
      state: "open",
      authorLogin: "someone-else",
    }

    await watcher.tick()

    assert.equal(store.getSubscription("session-legacy-foreign", "acme/repo", 42)?.state, "unsubscribed")
    assert.equal(store.getSession("session-legacy-foreign")?.pr_number, null)
    assert.equal(store.listPrWatchTargets().some((target) => target.pr_number === 42), false)
    store.close()
  })


  test("branch discovery honors automatic opt-outs without touching manual subscriptions", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const watcher = new BranchDiscoveryWatcher(store, github)

    store.registerClient("client-opt-out", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-opt-out",
      sessionId: "session-opt-out",
      repo: "acme/repo",
      branch: "legacy-branch",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    const binding = store.upsertWorktreeBinding({
      sessionId: "session-opt-out",
      root: "/tmp/worktree-opt-out",
      gitDir: "/tmp/.git/worktrees/opt-out",
      repo: "acme/repo",
      branch: "feature/opt-out",
      headSha: "abc123",
      state: "waiting_for_pr",
    })
    github.prForBranch = { number: 42, title: "Test PR", url: "https://github.com/acme/repo/pull/42", draft: false, state: "open" }
    await watcher.tick()

    assert.equal(store.unsubscribe("session-opt-out", "acme/repo", 42), true)
    store.recordAutomaticSubscriptionOptOut({
      sessionId: "session-opt-out",
      gitDir: binding.gitDir,
      repo: binding.repo,
      branch: binding.branch!,
      prNumber: 42,
    })
    store.upsertSubscription({
      sessionId: "session-opt-out",
      repo: "other/repo",
      prNumber: 99,
      source: "manual",
    })

    await watcher.tick()

    assert.equal(store.getSubscription("session-opt-out", "acme/repo", 42)?.state, "unsubscribed")
    assert.equal(store.getSubscription("session-opt-out", "other/repo", 99)?.state, "active")
    store.close()
  })

  test("keeps a resolved PR attached until its merge snapshot is delivered", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const branchWatcher = new BranchDiscoveryWatcher(store, github)
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-merged", { pid: 2, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-merged",
      sessionId: "session-merged",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)

    github.pushSnapshot(makeSnapshot())
    await prWatcher.tick()
    const initialBatch = store.getPendingReminder("session-merged")
    assert.ok(initialBatch)
    confirmReminder(store, initialBatch.batchId, "session-merged")


    // The open-PR query no longer finds the PR after it merges, but that must
    // not detach the existing session before the PR snapshot is diffed.
    github.pushBranchResult(null)
    await branchWatcher.tick()
    assert.equal(store.getSession("session-merged")?.pr_number, 42)

    const mergedSnapshot = makeSnapshot()
    github.pushSnapshot({ ...mergedSnapshot, core: { ...mergedSnapshot.core, state: "MERGED" } })
    await prWatcher.tick()

    const batch = store.buildReminderBatch("session-merged")
    assert.ok(batch)
    assert.ok(batch.events.some((event) => event.kind === "pr.merged"))
    assert.match(batch.reminderText, /Branch feature\/test was merged/)

    store.close()
  })

  test("attaches a replacement session to a retained PR", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const branchWatcher = new BranchDiscoveryWatcher(store, github)
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-replacement", { pid: 3, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-replacement",
      sessionId: "session-before-replacement",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)
    github.pushSnapshot(makeSnapshot())
    await prWatcher.tick()
    const initialBatch = store.getPendingReminder("session-before-replacement")
    assert.ok(initialBatch)
    confirmReminder(store, initialBatch.batchId, "session-before-replacement")

    store.registerSession({
      clientId: "client-replacement",
      sessionId: "session-after-replacement",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    github.pushBranchResult(null)
    await branchWatcher.tick()
    assert.equal(store.getSession("session-after-replacement")?.pr_number, 42)

    const mergedSnapshot = makeSnapshot()
    github.pushSnapshot({ ...mergedSnapshot, core: { ...mergedSnapshot.core, state: "MERGED" } })
    await prWatcher.tick()
    const mergeBatch = store.getPendingReminder("session-after-replacement")
    assert.ok(mergeBatch?.events.some((event) => event.kind === "pr.merged"))

    store.close()
  })

  test("defers a new PR association until the previous PR reaches a terminal state", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const branchWatcher = new BranchDiscoveryWatcher(store, github)
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-reassociation", { pid: 4, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-reassociation",
      sessionId: "session-reassociation",
      repo: "acme/repo",
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/test", 42)
    github.pushSnapshot(makeSnapshot())
    await prWatcher.tick()
    const initialBatch = store.getPendingReminder("session-reassociation")
    assert.ok(initialBatch)
    confirmReminder(store, initialBatch.batchId, "session-reassociation")

    const nextPr = { number: 43, title: "Replacement PR", url: "https://github.com/acme/repo/pull/43", draft: false, state: "open" }
    github.pushBranchResult(nextPr)
    await branchWatcher.tick()
    assert.equal(store.getSession("session-reassociation")?.pr_number, 42)

    const mergedSnapshot = makeSnapshot()
    github.pushSnapshot({ ...mergedSnapshot, core: { ...mergedSnapshot.core, state: "MERGED" } })
    await prWatcher.tick()
    assert.ok(store.getPendingReminder("session-reassociation")?.events.some((event) => event.kind === "pr.merged"))

    github.pushBranchResult(nextPr)
    await branchWatcher.tick()
    assert.equal(store.getSession("session-reassociation")?.pr_number, 43)

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

  test("PR watcher detects conflicts after GitHub transiently reports UNKNOWN", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)

    store.registerClient("client-conflict", { pid: 3, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-conflict",
      sessionId: "session-conflict",
      repo: "acme/repo",
      branch: "feature/conflict",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.recordBranchAssociation("acme/repo", "feature/conflict", 42)

    const snapshotWithMergeState = (mergeStateStatus: string) => {
      const snapshot = makeSnapshot()
      return { ...snapshot, core: { ...snapshot.core, mergeStateStatus } }
    }
    github.pushSnapshot(snapshotWithMergeState("CLEAN"))
    github.pushSnapshot(snapshotWithMergeState("UNKNOWN"))
    github.pushSnapshot(snapshotWithMergeState("DIRTY"))

    await prWatcher.tick()
    await prWatcher.tick()
    await prWatcher.tick()

    const events = store.listUndeliveredEvents("session-conflict")
    assert.ok(events.some((event) => event.kind === "merge_conflict.detected"))
    assert.equal(store.getSnapshot("acme/repo", 42)?.core.lastStableMergeStateStatus, "DIRTY")

    store.close()
  })

  test("two sessions on same PR get independent delivery cursors", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)

    // Use different branches so supersession doesn't close either session.
    // Both branches point at PR #42 (simulating two devs working on the same PR
    // via different checkout paths, or a branch + its worktree).
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
      branch: "feature/test-worktree",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })
    store.upsertSubscription({ sessionId: "session-a", repo: "acme/repo", prNumber: 42, source: "manual" })
    store.upsertSubscription({ sessionId: "session-b", repo: "acme/repo", prNumber: 42, source: "manual" })

    // Tick 1: initial snapshot — produces pr.snapshot.initialized event.
    github.pushSnapshot(makeSnapshot())
    await prWatcher.tick()

    // Drain the initial batch for both sessions so cursors advance past the init event.
    const initBatchA = store.buildReminderBatch("session-a")
    assert.ok(initBatchA)
    confirmReminder(store, initBatchA.batchId, "session-a")
    const initBatchB = store.buildReminderBatch("session-b")
    assert.ok(initBatchB)
    confirmReminder(store, initBatchB.batchId, "session-b")

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
    confirmReminder(store, batchA.batchId, "session-a")

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
    store.upsertWorktreeBinding({
      sessionId: "session-be",
      root: "/tmp/worktree-etag",
      gitDir: "/tmp/.git/worktrees/etag",
      repo: "acme/repo",
      branch: "feature/etag",
      headSha: "etag-sha",
      state: "waiting_for_pr",
    })

    // Tick 1: first real response, returns etag.
    github.pushBranchResult(null, 'W/"branch-1"')
    await watcher.tick()
    assert.equal(github.lastBranchEtag, null, "first poll should send no If-None-Match")
    assert.equal(store.getEtag("branch.pulls.author-gate.v1", "acme/repo#feature/etag"), 'W/"branch-1"')

    // Tick 2: server returns 304, etag preserved.
    github.pushBranchNotModified('W/"branch-1"')
    await watcher.tick()
    assert.equal(github.lastBranchEtag, 'W/"branch-1"', "subsequent poll should send If-None-Match")
    assert.equal(store.getEtag("branch.pulls.author-gate.v1", "acme/repo#feature/etag"), 'W/"branch-1"')

    // Tick 3: server rotates etag on 304 — we persist the new one.
    github.pushBranchNotModified('W/"branch-2"')
    await watcher.tick()
    assert.equal(store.getEtag("branch.pulls.author-gate.v1", "acme/repo#feature/etag"), 'W/"branch-2"')

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

  test("reapStaleSessions drops watcher targets so PR watcher stops polling closed sessions", async () => {
    const store = createStore()
    const github = new FixtureGitHubClient()
    const prWatcher = new PullRequestWatcher(store, github)
    const threshold = 6 * 60 * 60 * 1000
    const now = 10_000_000_000

    store.registerClient("client-reap", { pid: 99, projectRoot: "/tmp" })
    // A stale session (last activity older than threshold) attached to a PR.
    store.registerSession(
      {
        clientId: "client-reap",
        sessionId: "session-stale",
        repo: "acme/repo",
        branch: "feature/stale",
        isPrimary: true,
        status: "active",
        busyState: "idle",
      },
      now - threshold - 10_000,
    )
    store.recordBranchAssociation("acme/repo", "feature/stale", 42, now - threshold - 10_000)

    // Before reap: PR watcher sees one target.
    const beforeTargets = store.listPrWatchTargets(now - threshold - 5_000)
    assert.equal(beforeTargets.length, 1)

    // Reap the stale session.
    const result = store.reapStaleSessions(threshold, now)
    assert.equal(result.reaped, 1)

    // After reap: no targets to poll, so the PR watcher's tick makes no fetches.
    await prWatcher.tick(now)
    // FixtureGitHubClient would throw "No more fixture results" if any fetch were issued.
    assert.equal(store.listPrWatchTargets(now).length, 0)

    store.close()
  })
})
