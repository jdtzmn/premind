/**
 * Delivery reliability: the silent-stop paths.
 *
 * Issue #23 reports PR updates that are "missed entirely" — no error, no
 * reminder. That symptom does not come from bad parsing or diffing (those are
 * covered by github/graphql.test.ts and github/diff.test.ts); it comes from the
 * paths where premind stops watching or stops delivering without surfacing a
 * failure. Each test below pins one of those paths.
 *
 * These are deliberately store/watcher-level rather than adapter-level: the
 * mechanisms here are host-agnostic, and per-adapter delivery is covered by
 * plugin/__tests__ and extension/__tests__.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { StateStore } from "../daemon/persistence/store.ts"
import { ReminderHandoffRegistry } from "../daemon/reminders/reminder-handoff-registry.ts"
import { PullRequestWatcher } from "../daemon/watchers/pr-watcher.ts"
import { PrWatcherRegistry } from "../daemon/watchers/pr-watcher-registry.ts"
import { PREMIND_SESSION_STALE_MS } from "../shared/constants.ts"
import type { PullRequestSnapshot } from "../daemon/github/types.ts"
import type { GitHubClientLike, PullRequestSnapshotResult } from "../daemon/github/client.ts"

const REPO = "acme/repo"
const PR = 42

const tempDirs: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-reliability-"))
  tempDirs.push(dir)
  return new StateStore(path.join(dir, "premind.db"))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  core: {
    number: PR,
    title: "Test PR",
    url: `https://github.com/${REPO}/pull/${PR}`,
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
  fetchedAt: overrides.fetchedAt ?? 1_000,
})

const comment = (id: number) => ({ id, body: `comment ${id}`, user: { login: "reviewer" } })

const event = (n: number) => ({
  dedupeKey: `issue_comment.created:${n}`,
  kind: "issue_comment.created",
  priority: "high" as const,
  summary: `comment ${n}`,
  payload: { id: n },
})

/** Queue-backed GitHub client; the last queued snapshot repeats once drained. */
class ScriptedGitHub implements GitHubClientLike {
  private index = 0
  readonly requests: Array<{ etag: string | null }> = []

  constructor(private readonly snapshots: PullRequestSnapshot[]) {}

  async getViewerLogin() {
    return "octocat"
  }

  async findOpenPullRequestForBranch() {
    return { kind: "ok" as const, pr: null, etag: null }
  }

  async fetchPullRequestSnapshot(
    _repo: string,
    _prNumber: number,
    context: { etag?: string | null } = {},
  ): Promise<PullRequestSnapshotResult> {
    this.requests.push({ etag: context.etag ?? null })
    const next = this.snapshots[Math.min(this.index, this.snapshots.length - 1)]
    this.index++
    return { kind: "ok", snapshot: next, etag: `etag-${this.index}` }
  }
}

const attachSession = (
  store: StateStore,
  sessionId: string,
  branch: string,
  now = Date.now(),
) => {
  store.registerClient(`client-${sessionId}`, { pid: 1, projectRoot: "/tmp" }, now)
  store.registerSession(
    {
      clientId: `client-${sessionId}`,
      sessionId,
      repo: REPO,
      branch,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    },
    now,
  )
  return store.upsertSubscription({ sessionId, repo: REPO, prNumber: PR, source: "manual" }, now)
}

/** Attaches a session the way branch discovery does: an automatic subscription. */
const attachAutomatic = (
  store: StateStore,
  sessionId: string,
  branch: string,
  now = Date.now(),
) => {
  store.registerClient(`client-${sessionId}`, { pid: 1, projectRoot: "/tmp" }, now)
  store.registerSession(
    {
      clientId: `client-${sessionId}`,
      sessionId,
      repo: REPO,
      branch,
      isPrimary: true,
      status: "active",
      busyState: "idle",
    },
    now,
  )
  return store.baselineAutomaticSubscription({ sessionId, repo: REPO, prNumber: PR }, now)
}

const deliver = (store: StateStore, batchId: string, sessionId: string, now?: number) => {
  assert.equal(store.ackReminder({ batchId, sessionId, state: "handed_off" }, now), true)
  assert.equal(store.ackReminder({ batchId, sessionId, state: "confirmed" }, now), true)
}

describe("delivery reliability", () => {
  // -------------------------------------------------------------------------
  // 1. Stranded handoff — regression test for the wedge found while planning
  //    issue #23. `reminder_batches.subscription_id` is UNIQUE, so a batch left
  //    in `handed_off` (adapter crash, stale extension ctx, hung injection) is
  //    invisible to `getPendingReminderRecord` while still occupying the
  //    subscription's only batch slot. Building a replacement used to throw
  //    `UNIQUE constraint failed`, and `PullRequestWatcher.tick` swallows
  //    per-target errors — so every later poll failed silently and delivery for
  //    that PR never resumed until the daemon restarted.
  // -------------------------------------------------------------------------
  describe("stranded handoff", () => {
    test("a poll after an abandoned handoff neither throws nor loses events", async () => {
      const store = createStore()
      const t0 = 3_000_000_000_000
      const subscription = attachSession(store, "session-strand", "feature/test", t0)
      const github = new ScriptedGitHub([
        snapshot(),
        snapshot({ issueComments: [comment(1)] }),
        snapshot({ issueComments: [comment(1), comment(2)] }),
      ])
      const watcher = new PullRequestWatcher(store, github)

      await watcher.tick(t0)
      const first = store.getPendingReminder("session-strand")
      assert.ok(first, "baseline poll should build a batch")

      // Hand off, then die before confirming.
      assert.equal(
        store.ackReminder({ batchId: first.batchId, sessionId: "session-strand", state: "handed_off" }, t0),
        true,
      )
      assert.equal(store.getPendingReminder("session-strand"), null, "in-flight batch is not re-offered")

      // The next poll must not throw. Before the fix this raised
      // "UNIQUE constraint failed: reminder_batches.subscription_id".
      await watcher.tick(t0 + 60_000)
      await watcher.tick(t0 + 120_000)

      assert.equal(
        store.getReminderBatchRecord(first.batchId)?.state,
        "handed_off",
        "the in-flight batch is left alone while it may still be delivering",
      )
      assert.equal(
        store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq,
        0,
        "an unconfirmed handoff must not advance the delivery cursor",
      )
      assert.ok(
        store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length >= 2,
        "events observed while stranded are still queued, not dropped",
      )

      store.close()
    })

    test("an abandoned handoff is reclaimed and delivered without a daemon restart", async () => {
      const store = createStore()
      const t0 = 3_000_000_000_000
      const subscription = attachSession(store, "session-reclaim", "feature/test", t0)
      const github = new ScriptedGitHub([snapshot(), snapshot({ issueComments: [comment(1)] })])
      const watcher = new PullRequestWatcher(store, github)
      const handoffs = new ReminderHandoffRegistry(store)

      await watcher.tick(t0)
      const stranded = store.getPendingReminder("session-reclaim")!
      store.ackReminder({ batchId: stranded.batchId, sessionId: "session-reclaim", state: "handed_off" }, t0)

      // Still within the staleness window: the handoff may yet complete, so it
      // must not be stolen from the adapter that owns it.
      assert.equal(
        handoffs.getPendingReminder("session-reclaim", t0 + 1_000),
        null,
        "a fresh handoff is left in flight",
      )

      // Past the window the batch is presumed abandoned and becomes deliverable.
      const reclaimed = handoffs.getPendingReminder("session-reclaim", t0 + 10 * 60_000)
      assert.ok(reclaimed, "an abandoned handoff must become deliverable again")
      assert.equal(reclaimed.batchId, stranded.batchId, "the durable batch is reused, not duplicated")

      const expectedSeq = store.getReminderBatchRecord(reclaimed.batchId)?.maxEventSeq
      assert.ok(expectedSeq && expectedSeq > 0, "the reclaimed batch covers real events")

      deliver(store, reclaimed.batchId, "session-reclaim", t0 + 10 * 60_000)
      assert.equal(
        store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq,
        expectedSeq,
        "confirming the reclaimed batch advances the cursor past its events",
      )
      assert.equal(
        store.getPendingReminder("session-reclaim"),
        null,
        "nothing is left pending once the reclaimed batch is delivered",
      )

      handoffs.close()
      store.close()
    })

    test("a confirm arriving after reclamation cannot double-advance the cursor", async () => {
      const store = createStore()
      const t0 = 3_000_000_000_000
      const subscription = attachSession(store, "session-late", "feature/test", t0)
      store.insertEvents(REPO, PR, [event(1)], t0)

      const batch = store.buildReminderBatch("session-late", t0)!
      store.ackReminder({ batchId: batch.batchId, sessionId: "session-late", state: "handed_off" }, t0)
      assert.equal(store.expireStaleHandoffs(5 * 60_000, t0 + 10 * 60_000), 1)

      // The revived adapter confirms a batch that is no longer handed_off.
      assert.equal(
        store.ackReminder({ batchId: batch.batchId, sessionId: "session-late", state: "confirmed" }, t0 + 10 * 60_000),
        false,
        "a stale confirm is rejected rather than advancing the cursor",
      )
      assert.equal(
        store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq,
        0,
        "the cursor stays put until the reclaimed batch is properly delivered",
      )

      store.close()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Stale-session reap. `last_activity_at` only advances on session-state
  //    writes — the client heartbeat refreshes the *client lease*, not the
  //    session row — so a session with no agent turns is reaped after
  //    PREMIND_SESSION_STALE_MS and silently drops out of listPrWatchTargets.
  // -------------------------------------------------------------------------
  test("a reaped session stops being watched and resumes on revival", () => {
    const store = createStore()
    const t0 = 1_000_000_000_000
    attachSession(store, "session-reap", "feature/test", t0)

    assert.equal(store.listPrWatchTargets(t0).length, 1, "an active session is watched")

    const reapedAt = t0 + PREMIND_SESSION_STALE_MS + 1_000
    assert.equal(store.reapStaleSessions(PREMIND_SESSION_STALE_MS, reapedAt).reaped, 1)
    assert.equal(store.getSession("session-reap")?.status, "closed")
    assert.equal(
      store.listPrWatchTargets(reapedAt).length,
      0,
      "polling stops for a reaped session — this is the silent watch gap",
    )

    const revival = store.updateSessionState({ sessionId: "session-reap", busyState: "idle" }, reapedAt + 1_000)
    assert.deepEqual(revival, { updated: true, revived: true })
    assert.equal(
      store.listPrWatchTargets(reapedAt + 2_000).length,
      1,
      "activity revives the session and restores watching",
    )
    assert.equal(
      store.getSubscription("session-reap", REPO, PR)?.state,
      "active",
      "the subscription survives the reap so its cursor is reused",
    )

    store.close()
  })

  test("changes that land while a session is reaped are delivered after revival", async () => {
    const store = createStore()
    const t0 = 1_000_000_000_000
    const subscription = attachSession(store, "session-gap", "feature/test", t0)
    const github = new ScriptedGitHub([
      snapshot(),
      snapshot({ issueComments: [comment(1)] }),
    ])
    const watcher = new PullRequestWatcher(store, github)

    await watcher.tick(t0)
    const baseline = store.getPendingReminder("session-gap")!
    deliver(store, baseline.batchId, "session-gap", t0)

    const reapedAt = t0 + PREMIND_SESSION_STALE_MS + 1_000
    store.reapStaleSessions(PREMIND_SESSION_STALE_MS, reapedAt)
    await watcher.tick(reapedAt)
    assert.equal(
      store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length,
      0,
      "nothing is polled while reaped",
    )

    store.updateSessionState({ sessionId: "session-gap", busyState: "idle" }, reapedAt + 1_000)
    await watcher.tick(reapedAt + 2_000)

    const recovered = store.getPendingReminder("session-gap")
    assert.ok(recovered, "the comment posted during the gap is delivered after revival")
    assert.ok(
      recovered.events.some((candidate) => /comment 1/.test(candidate.summary)),
      `expected the gap comment in ${JSON.stringify(recovered.events.map((candidate) => candidate.summary))}`,
    )

    store.close()
  })

  // -------------------------------------------------------------------------
  // 2b. Session restart. The Pi extension calls activateWorktree on every
  //     session_start, and that deactivates the session's automatic
  //     subscriptions. BranchDiscoveryWatcher re-attaches them via
  //     baselineAutomaticSubscription — which used to reset the cursor to the
  //     current high-water mark, silently skipping anything queued but not yet
  //     delivered. That is the "I left a comment, restarted Pi, and never heard
  //     about it" report on issue #23.
  // -------------------------------------------------------------------------
  test("restarting a session keeps events that were queued but not yet delivered", () => {
    const store = createStore()
    attachAutomatic(store, "session-restart", "feature/test")

    // Caught up on the first comment.
    store.insertEvents(REPO, PR, [event(1)])
    const first = store.buildReminderBatch("session-restart")
    assert.ok(first)
    deliver(store, first.batchId, "session-restart")

    // A second comment lands and is still owed to this session.
    store.insertEvents(REPO, PR, [event(2)])
    const before = store.getSubscription("session-restart", REPO, PR)!
    assert.equal(
      store.listUndeliveredEventsForSubscription(before.subscriptionId).length,
      1,
      "the new comment is queued before the restart",
    )

    // Session start: activate the worktree, then let discovery re-attach.
    store.activateWorktree({
      sessionId: "session-restart",
      root: "/tmp/worktree",
      gitDir: "/tmp/.git/worktrees/test",
      repo: REPO,
      branch: "feature/test",
      headSha: "abc123",
      state: "waiting_for_pr",
    })
    assert.equal(
      store.getSubscription("session-restart", REPO, PR)?.state,
      "unsubscribed",
      "activateWorktree drops automatic subscriptions, so re-attach must restore them faithfully",
    )
    store.baselineAutomaticSubscription({ sessionId: "session-restart", repo: REPO, prNumber: PR })

    const after = store.getSubscription("session-restart", REPO, PR)
    assert.equal(after?.state, "active", "discovery re-attaches the subscription")
    assert.equal(
      after?.lastDeliveredEventSeq,
      before.lastDeliveredEventSeq,
      "a re-attach must preserve the session's own cursor, not jump to high water",
    )
    assert.equal(
      store.listUndeliveredEventsForSubscription(after!.subscriptionId).length,
      1,
      "the queued comment survives the restart",
    )
    const rebuilt = store.buildReminderBatchForSubscription(after!.subscriptionId)
    assert.ok(rebuilt, "the comment left before the restart is still delivered afterwards")
    assert.ok(
      rebuilt.events.some((candidate) => /comment 2/.test(candidate.summary)),
      `expected the pre-restart comment in ${JSON.stringify(rebuilt.events.map((candidate) => candidate.summary))}`,
    )

    store.close()
  })

  test("a first automatic attach still starts at high water instead of dumping history", () => {
    const store = createStore()
    store.registerClient("client-fresh", { pid: 1, projectRoot: "/tmp" })
    store.registerSession({
      clientId: "client-fresh",
      sessionId: "session-fresh",
      repo: REPO,
      branch: "feature/test",
      isPrimary: true,
      status: "active",
      busyState: "idle",
    })

    // History exists before this session ever attaches.
    store.insertEvents(REPO, PR, [event(1), event(2), event(3)])
    const subscription = store.baselineAutomaticSubscription({
      sessionId: "session-fresh",
      repo: REPO,
      prNumber: PR,
    })

    assert.ok(subscription.lastDeliveredEventSeq > 0, "a first attach starts at high water")
    assert.equal(
      store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length,
      0,
      "a brand-new subscription must not replay history it never saw",
    )

    store.close()
  })

  // -------------------------------------------------------------------------
  // 3. Cursor handling on reattach. ensureSessionControl starts *recreated* or
  //    context-changed sessions at the current high-water mark. That is
  //    intentional history-skipping, and from a user's seat it is
  //    indistinguishable from a dropped update — so both directions are pinned.
  // -------------------------------------------------------------------------
  test("reattaching the same session preserves its delivery cursor", () => {
    const store = createStore()
    const subscription = attachSession(store, "session-reattach", "feature/test")
    store.recordBranchAssociation(REPO, "feature/test", PR)
    store.insertEvents(REPO, PR, [event(1), event(2)])

    const batch = store.buildReminderBatch("session-reattach")!
    deliver(store, batch.batchId, "session-reattach")
    const cursor = store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq
    assert.ok(cursor && cursor > 0)

    store.insertEvents(REPO, PR, [event(3)])
    store.ensureSessionControl({
      clientId: "client-session-reattach",
      sessionId: "session-reattach",
      repo: REPO,
      branch: "feature/test",
      isPrimary: true,
      busyState: "idle",
      paused: false,
    })

    assert.equal(
      store.getSubscriptionById(subscription.subscriptionId)?.lastDeliveredEventSeq,
      cursor,
      "a same-context reattach must not skip history",
    )
    assert.equal(
      store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length,
      1,
      "the event queued during the gap is still pending after reattach",
    )

    store.close()
  })

  test("a context change resets the session cursor and clears its batches", () => {
    const store = createStore()
    attachSession(store, "session-moved", "feature/test")
    store.recordBranchAssociation(REPO, "feature/test", PR)
    store.insertEvents(REPO, PR, [event(1)])
    assert.ok(store.buildReminderBatch("session-moved"))

    store.ensureSessionControl({
      clientId: "client-session-moved",
      sessionId: "session-moved",
      repo: REPO,
      branch: "feature/somewhere-else",
      isPrimary: true,
      busyState: "idle",
      paused: false,
    })

    assert.equal(
      store.getSession("session-moved")?.last_delivered_event_seq,
      0,
      "a moved session starts from its new branch's high-water mark",
    )
    assert.equal(
      store.getPendingReminder("session-moved"),
      null,
      "batches belonging to the previous branch are discarded",
    )

    store.close()
  })

  // -------------------------------------------------------------------------
  // 4. Batch window. listUndeliveredEventsForSubscription caps at 20 events, so
  //    a burst larger than the window must drain across successive batches.
  // -------------------------------------------------------------------------
  test("a burst larger than the batch window drains completely and exactly once", () => {
    const store = createStore()
    const subscription = attachSession(store, "session-burst", "feature/test")
    const total = 25
    store.insertEvents(REPO, PR, Array.from({ length: total }, (_, index) => event(index + 1)))

    const delivered: string[] = []
    let rounds = 0
    while (rounds < total) {
      const batch = store.buildReminderBatchForSubscription(subscription.subscriptionId)
      if (!batch) break
      rounds++
      delivered.push(...batch.events.map((candidate) => candidate.summary))
      deliver(store, batch.batchId, "session-burst")
    }

    assert.equal(delivered.length, total, "every queued event is delivered")
    assert.equal(new Set(delivered).size, total, "no event is delivered twice")
    assert.ok(rounds > 1, "a burst beyond the window needs more than one batch")
    assert.equal(
      store.listUndeliveredEventsForSubscription(subscription.subscriptionId).length,
      0,
      "the queue is fully drained",
    )

    store.close()
  })

  // -------------------------------------------------------------------------
  // 5. Watcher recovery. pollingTargets only returns actors in `polling`, so a
  //    watcher parked in backing_off or rate_limited is invisible; if it never
  //    left those states the PR would stop being polled with no signal.
  // -------------------------------------------------------------------------
  test("a watcher resumes polling after failure backoff and after a rate limit", () => {
    const store = createStore()
    const t0 = 2_000_000_000_000
    attachSession(store, "session-backoff", "feature/test", t0)
    const registry = new PrWatcherRegistry(store, {
      failureBackoffBaseMs: 1_000,
      failureBackoffMaxMs: 4_000,
      now: t0,
    })

    assert.equal(registry.pollingTargets(t0).length, 1)

    registry.recordPollFailure(REPO, PR, new Error("boom"), t0 + 100)
    assert.equal(registry.getSnapshot(REPO, PR)?.value, "backing_off")
    assert.equal(registry.pollingTargets(t0 + 200).length, 0, "backoff suppresses polling")
    assert.equal(
      registry.pollingTargets(t0 + 5_000).length,
      1,
      "backoff must expire — a wedged watcher is a silent stop",
    )
    assert.equal(registry.getSnapshot(REPO, PR)?.value, "polling")

    registry.rateLimit(t0 + 20_000, t0 + 6_000)
    assert.equal(registry.getSnapshot(REPO, PR)?.value, "rate_limited")
    assert.equal(registry.pollingTargets(t0 + 7_000).length, 0, "rate limiting suppresses polling")
    assert.equal(
      registry.pollingTargets(t0 + 21_000).length,
      1,
      "polling resumes once the rate limit resets",
    )
    assert.equal(registry.getSnapshot(REPO, PR)?.value, "polling")

    registry.close()
    store.close()
  })
})
