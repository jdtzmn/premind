import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, test } from "node:test"
import type {
  FindOpenPullRequestResult,
  GitHubClientLike,
  PullRequestSnapshotResult,
} from "../github/client.ts"
import type { PullRequestSnapshot } from "../github/types.ts"
import { StateStore } from "../persistence/store.ts"
import { PrWatcherRegistry } from "./pr-watcher-registry.ts"
import { PullRequestWatcher } from "./pr-watcher.ts"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-pr-registry-test-"))
  tempPaths.push(dir)
  return new StateStore(path.join(dir, "premind.db"))
}

const registerSubscription = (
  store: StateStore,
  sessionId = "session-1",
  prNumber = 13,
  now = 100,
) => {
  store.registerClient(`client-${sessionId}`, { pid: 1, projectRoot: "/repo" }, now)
  store.registerSession(
    {
      clientId: `client-${sessionId}`,
      sessionId,
      repo: "acme/repo",
      branch: `feature/${sessionId}`,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    },
    now,
  )
  return store.upsertSubscription(
    { sessionId, repo: "acme/repo", prNumber, source: "manual" },
    now,
  )
}

const snapshot = (state = "OPEN", prNumber = 13): PullRequestSnapshot => ({
  core: {
    number: prNumber,
    title: "Canonical watcher",
    url: `https://github.com/acme/repo/pull/${prNumber}`,
    state,
    isDraft: false,
    headRefName: "feature/watcher",
    baseRefName: "main",
    headRefOid: "abc123",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    reviewRequests: [],
  },
  reviews: [],
  issueComments: [],
  reviewComments: [],
  checks: [],
  fetchedAt: 100,
})

class FixtureGitHubClient implements GitHubClientLike {
  readonly results: PullRequestSnapshotResult[] = []
  fetchCount = 0


  async getViewerLogin(): Promise<string | null> {
    return "octocat"
  }
  async findOpenPullRequestForBranch(): Promise<FindOpenPullRequestResult> {
    return { kind: "ok", pr: null, etag: null }
  }

  async fetchPullRequestSnapshot(): Promise<PullRequestSnapshotResult> {
    const result = this.results[this.fetchCount++]
    if (!result) throw new Error("No fixture result")
    return result
  }
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("canonical PR watcher registry", () => {
  test("last subscriber enters idle grace before the actor stops", async () => {
    const store = createStore()
    registerSubscription(store)
    const github = new FixtureGitHubClient()
    github.results.push({ kind: "ok", snapshot: snapshot(), etag: null })
    const watcher = new PullRequestWatcher(store, github, { idleGraceMs: 100, now: 100 })

    await watcher.tick(100)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "polling")

    store.unsubscribe("session-1", "acme/repo", 13, 200)
    await watcher.tick(200)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "idle_grace")
    assert.equal(store.getPrWatcherRecord("acme/repo", 13)?.idleDeadlineAt, 300)

    await watcher.tick(299)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "idle_grace")
    await watcher.tick(300)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "stopped")
    assert.equal(github.fetchCount, 1)

    watcher.close()
    store.close()
  })

  test("resubscription during idle grace revives polling", async () => {
    const store = createStore()
    registerSubscription(store)
    const github = new FixtureGitHubClient()
    github.results.push(
      { kind: "ok", snapshot: snapshot(), etag: "v1" },
      { kind: "not_modified", etag: "v1" },
    )
    const watcher = new PullRequestWatcher(store, github, { idleGraceMs: 100, now: 100 })

    await watcher.tick(100)
    store.unsubscribe("session-1", "acme/repo", 13, 150)
    await watcher.tick(150)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "idle_grace")

    store.upsertSubscription(
      { sessionId: "session-1", repo: "acme/repo", prNumber: 13, source: "manual" },
      175,
    )
    await watcher.tick(175)
    assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "polling")
    assert.equal(store.getPrWatcherRecord("acme/repo", 13)?.idleDeadlineAt, null)
    assert.equal(github.fetchCount, 2)

    watcher.close()
    store.close()
  })

  for (const terminalState of ["MERGED", "CLOSED"] as const) {
    test(`${terminalState.toLowerCase()} terminal event stops polling`, async () => {
      const store = createStore()
      registerSubscription(store)
      const github = new FixtureGitHubClient()
      github.results.push(
        { kind: "ok", snapshot: snapshot(), etag: "open" },
        { kind: "ok", snapshot: snapshot(terminalState), etag: "terminal" },
      )
      const watcher = new PullRequestWatcher(store, github, { now: 100 })

      await watcher.tick(100)
      await watcher.tick(101)
      await watcher.tick(102)

      const expectedKind = terminalState === "MERGED" ? "pr.merged" : "pr.closed"
      assert.equal(watcher.getWatcherSnapshot("acme/repo", 13)?.value, "terminal")
      assert.equal(store.getPrWatcherRecord("acme/repo", 13)?.terminalAt, 101)
      assert.ok(store.listUndeliveredEvents("session-1").some((event) => event.kind === expectedKind))
      assert.equal(github.fetchCount, 2)

      watcher.close()
      store.close()
    })
  }

  test("reconstructs backoff actors and resumes only when their durable deadline is due", () => {
    const store = createStore()
    registerSubscription(store)
    const first = new PrWatcherRegistry(store, {
      failureBackoffBaseMs: 20,
      failureBackoffMaxMs: 100,
      now: 100,
    })

    assert.deepEqual(first.pollingTargets(100), [{ repo: "acme/repo", prNumber: 13 }])
    first.recordPollFailure("acme/repo", 13, new Error("boom"), 100)
    assert.equal(store.getPrWatcherRecord("acme/repo", 13)?.state, "backing_off")
    assert.equal(store.getPrWatcherRecord("acme/repo", 13)?.nextEligiblePollAt, 120)
    first.close()

    const second = new PrWatcherRegistry(store, {
      failureBackoffBaseMs: 20,
      failureBackoffMaxMs: 100,
      now: 110,
    })
    assert.equal(second.getSnapshot("acme/repo", 13)?.value, "backing_off")
    assert.deepEqual(second.pollingTargets(119), [])
    assert.deepEqual(second.pollingTargets(120), [{ repo: "acme/repo", prNumber: 13 }])

    second.close()
    store.close()
  })

  test("retention preserves fresh and actively subscribed streams, then prunes expired data", () => {
    const store = createStore()
    registerSubscription(store, "terminal-session", 13, 100)
    store.saveTerminalSnapshotAndEvents(
      "acme/repo",
      13,
      snapshot("CLOSED", 13),
      [{
        dedupeKey: "pr.closed:test",
        kind: "pr.closed",
        priority: "high",
        summary: "closed",
        payload: {},
      }],
      null,
      100,
    )

    registerSubscription(store, "active-session", 14, 100)
    store.saveSnapshot("acme/repo", 14, snapshot("OPEN", 14))
    store.insertEvents("acme/repo", 14, [{
      dedupeKey: "active:test",
      kind: "review.approved",
      priority: "high",
      summary: "active",
      payload: {},
    }], 100)

    registerSubscription(store, "stopped-session", 15, 100)
    store.saveSnapshot("acme/repo", 15, snapshot("OPEN", 15))
    store.insertEvents("acme/repo", 15, [{
      dedupeKey: "stopped:test",
      kind: "review.approved",
      priority: "high",
      summary: "stopped",
      payload: {},
    }], 100)

    let pruned = store.pruneExpiredPrStreams(10_000, 1, 1)
    assert.equal(pruned.events, 0, "active subscriptions must retain both streams")

    store.unsubscribe("terminal-session", "acme/repo", 13, 200)
    store.unsubscribe("stopped-session", "acme/repo", 15, 200)
    pruned = store.pruneExpiredPrStreams(1_099, 1_000, 2_000)
    assert.equal(pruned.events, 0, "stopped and terminal streams remain readable through retention")
    assert.ok(store.getSnapshot("acme/repo", 13))
    assert.ok(store.getSnapshot("acme/repo", 15))

    pruned = store.pruneExpiredPrStreams(1_101, 1_000, 2_000)
    assert.equal(pruned.events, 1)
    assert.equal(pruned.snapshots, 1)
    assert.equal(pruned.watchers, 1)
    assert.equal(store.getSnapshot("acme/repo", 13), null)
    assert.ok(store.getSnapshot("acme/repo", 15), "fresh stopped stream must still be retained")
    assert.ok(store.getSnapshot("acme/repo", 14), "active stream must never be pruned")

    pruned = store.pruneExpiredPrStreams(1_201, 1_000, 2_000)
    assert.equal(pruned.events, 1)
    assert.equal(store.getSnapshot("acme/repo", 15), null)

    pruned = store.pruneExpiredPrStreams(2_201, 1_000, 2_000)
    assert.equal(pruned.subscriptions, 2)
    assert.equal(store.getSubscription("terminal-session", "acme/repo", 13), null)
    assert.equal(store.getSubscription("stopped-session", "acme/repo", 15), null)

    store.close()
  })

  test("idempotently migrates legacy pr_watchers rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-pr-migration-test-"))
    tempPaths.push(dir)
    const dbPath = path.join(dir, "premind.db")
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE pr_watchers (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        last_checked_at INTEGER,
        active_session_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repo, pr_number)
      );
      INSERT INTO pr_watchers VALUES ('acme/repo', 13, 50, 0, 1, 50);
    `)
    legacy.close()

    const first = new StateStore(dbPath)
    assert.equal(first.getPrWatcherRecord("acme/repo", 13)?.state, "stopped")
    first.close()
    const second = new StateStore(dbPath)
    assert.equal(second.getPrWatcherRecord("acme/repo", 13)?.consecutiveFailures, 0)
    second.close()
  })
})
