import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { diffSnapshot } from "./diff.ts"
import type { PullRequestSnapshot } from "./types.ts"

const baseSnapshot = (): PullRequestSnapshot => ({
  core: {
    number: 42,
    title: "Improve reminders",
    url: "https://github.com/acme/repo/pull/42",
    state: "OPEN",
    isDraft: true,
    headRefName: "feature/reminders",
    baseRefName: "main",
    headRefOid: "sha-1",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    reviewRequests: [],
    updatedAt: "2026-04-08T00:00:00Z",
  },
  reviews: [],
  issueComments: [],
  reviewComments: [],
  checks: [],
  fetchedAt: Date.now(),
})

describe("diffSnapshot", () => {
  test("emits a low-priority initialized event for a clean PR", () => {
    const next: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: { ...baseSnapshot().core, isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null },
    }

    const events = diffSnapshot(null, next)
    assert.equal(events.length, 1)
    const init = events[0]
    assert.equal(init.kind, "pr.snapshot.initialized")
    assert.equal(init.priority, "low")
    assert.equal(init.summary, "Started tracking 42: Improve reminders")
    assert.equal(init.payload.mergeStateStatus, "CLEAN")
    assert.deepEqual(init.payload.failingChecks, [])
  })

  test("surfaces existing merge conflicts on the initialized event", () => {
    const next: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: { ...baseSnapshot().core, isDraft: false, mergeStateStatus: "DIRTY" },
    }

    const events = diffSnapshot(null, next)
    const init = events.find((event) => event.kind === "pr.snapshot.initialized")
    assert.ok(init)
    assert.equal(init.priority, "high")
    assert.match(init.summary, /merge conflict/i)
    assert.equal(init.payload.mergeStateStatus, "DIRTY")
  })

  test("surfaces existing failing checks on the initialized event", () => {
    const next: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: { ...baseSnapshot().core, isDraft: false },
      checks: [
        { name: "build", state: "fail", link: "https://ci.example/build" },
        { name: "lint", state: "success" },
      ],
    }

    const events = diffSnapshot(null, next)
    const init = events.find((event) => event.kind === "pr.snapshot.initialized")
    assert.ok(init)
    assert.equal(init.priority, "high")
    assert.match(init.summary, /build/)
    assert.deepEqual(init.payload.failingChecks, ["build"])
  })

  test("surfaces an existing changes-requested decision on the initialized event", () => {
    const next: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: { ...baseSnapshot().core, isDraft: false, reviewDecision: "CHANGES_REQUESTED" },
    }

    const events = diffSnapshot(null, next)
    const init = events.find((event) => event.kind === "pr.snapshot.initialized")
    assert.ok(init)
    assert.equal(init.priority, "high")
    assert.match(init.summary, /changes requested/i)
    assert.equal(init.payload.reviewDecision, "CHANGES_REQUESTED")
  })

  test("does not flag UNKNOWN merge state as a conflict on initialization", () => {
    const next: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: { ...baseSnapshot().core, isDraft: false, mergeStateStatus: "UNKNOWN" },
    }

    const events = diffSnapshot(null, next)
    const init = events.find((event) => event.kind === "pr.snapshot.initialized")
    assert.ok(init)
    assert.equal(init.priority, "low")
    assert.doesNotMatch(init.summary, /merge conflict/i)
  })

  test("detects high-signal PR events", () => {
    const previous = baseSnapshot()
    const next: PullRequestSnapshot = {
      ...previous,
      core: {
        ...previous.core,
        isDraft: false,
        headRefOid: "sha-2",
        mergeStateStatus: "DIRTY",
      },
      reviews: [
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          body: "Please fix the failing path",
          user: { login: "alice" },
        },
      ],
      issueComments: [
        {
          id: 11,
          body: "Can you also add tests?",
          user: { login: "bob" },
        },
      ],
      reviewComments: [
        {
          id: 21,
          body: "This branch should be renamed",
          path: "src/plugin/index.ts",
          line: 10,
          user: { login: "carol" },
        },
      ],
      checks: [
        {
          name: "lint",
          state: "fail",
          link: "https://ci.example/lint",
        },
      ],
    }

    const events = diffSnapshot(previous, next)
    const kinds = events.map((event) => event.kind)

    assert.ok(kinds.includes("pr.ready_for_review"))
    assert.ok(kinds.includes("pr.synchronized"))
    assert.ok(kinds.includes("merge_conflict.detected"))
    assert.ok(kinds.includes("review.changes_requested"))
    assert.ok(kinds.includes("issue_comment.created"))
    assert.ok(kinds.includes("review_comment.created"))
    assert.ok(kinds.includes("check.failed"))
  })

  test("detects edited issue and review comments", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: {
        ...baseSnapshot().core,
        isDraft: false,
      },
      issueComments: [
        {
          id: 31,
          body: "Original issue comment",
          updated_at: "2026-04-08T00:00:00Z",
          user: { login: "dana" },
        },
      ],
      reviewComments: [
        {
          id: 41,
          body: "Original review comment",
          updated_at: "2026-04-08T00:00:00Z",
          path: "src/daemon/index.ts",
          line: 12,
          user: { login: "erin" },
        },
      ],
    }

    const next: PullRequestSnapshot = {
      ...previous,
      issueComments: [
        {
          id: 31,
          body: "Edited issue comment with more detail",
          updated_at: "2026-04-08T00:10:00Z",
          user: { login: "dana" },
        },
      ],
      reviewComments: [
        {
          id: 41,
          body: "Edited review comment with more detail",
          updated_at: "2026-04-08T00:12:00Z",
          path: "src/daemon/index.ts",
          line: 12,
          user: { login: "erin" },
        },
      ],
    }

    const events = diffSnapshot(previous, next)
    const issueEdit = events.find((event) => event.kind === "issue_comment.edited")
    const reviewEdit = events.find((event) => event.kind === "review_comment.edited")

    assert.ok(issueEdit)
    assert.equal(issueEdit.priority, "medium")
    assert.equal(issueEdit.payload.previousBody, "Original issue comment")

    assert.ok(reviewEdit)
    assert.equal(reviewEdit.priority, "medium")
    assert.equal(reviewEdit.payload.previousBody, "Original review comment")
  })

  test("detects deleted comments and groups repeated low-signal changes", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: {
        ...baseSnapshot().core,
        isDraft: false,
      },
      issueComments: [
        { id: 51, body: "Old issue comment A", user: { login: "frank" } },
        { id: 52, body: "Old issue comment B", user: { login: "frank" } },
      ],
      reviewComments: [
        { id: 61, body: "Old review comment", path: "src/a.ts", line: 1, user: { login: "grace" } },
      ],
      checks: [
        { name: "unit", state: "queued" },
        { name: "lint", state: "queued" },
      ],
    }

    const next: PullRequestSnapshot = {
      ...previous,
      issueComments: [],
      reviewComments: [],
      checks: [
        { name: "unit", state: "success" },
        { name: "lint", state: "success" },
      ],
    }

    const events = diffSnapshot(previous, next)
    const issueDeleted = events.find((event) => event.kind === "issue_comment.deleted")
    const reviewDeleted = events.find((event) => event.kind === "review_comment.deleted")
    const groupedChecks = events.find((event) => event.kind === "check.succeeded")

    assert.ok(issueDeleted)
    assert.equal(issueDeleted.payload.count, 2)
    assert.ok(reviewDeleted)
    assert.equal(reviewDeleted.payload.previousBody, "Old review comment")
    assert.ok(groupedChecks)
    assert.equal(groupedChecks.payload.count, 2)
    assert.equal(Array.isArray(groupedChecks.payload.samples), true)
  })

  test("detects reviewer request changes and dismissed reviews", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: {
        ...baseSnapshot().core,
        isDraft: false,
        reviewRequests: [{ login: "alice" }],
      },
      reviews: [],
    }

    const next: PullRequestSnapshot = {
      ...previous,
      core: {
        ...previous.core,
        reviewRequests: [{ login: "bob" }],
      },
      reviews: [
        {
          id: 71,
          state: "DISMISSED",
          body: "Superseded by new commits",
          user: { login: "maintainer" },
        },
      ],
    }

    const events = diffSnapshot(previous, next)
    const reviewerRequested = events.find((event) => event.kind === "reviewer.requested")
    const reviewerRemoved = events.find((event) => event.kind === "reviewer.removed")
    const dismissed = events.find((event) => event.kind === "review.dismissed")

    assert.ok(reviewerRequested)
    assert.equal(reviewerRequested.payload.reviewer, "bob")
    assert.ok(reviewerRemoved)
    assert.equal(reviewerRemoved.payload.reviewer, "alice")
    assert.ok(dismissed)
    assert.equal(dismissed.payload.state, "DISMISSED")
  })

  test("detects review decision changes from core state", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      core: {
        ...baseSnapshot().core,
        isDraft: false,
        reviewDecision: "REVIEW_REQUIRED",
      },
    }

    const next: PullRequestSnapshot = {
      ...previous,
      core: {
        ...previous.core,
        reviewDecision: "CHANGES_REQUESTED",
      },
    }

    const events = diffSnapshot(previous, next)
    const decisionEvent = events.find((event) => event.kind === "pr.review_decision.changes_requested")

    assert.ok(decisionEvent)
    assert.equal(decisionEvent.priority, "high")
    assert.equal(decisionEvent.payload.reviewDecision, "CHANGES_REQUESTED")
  })

  test("suppresses UNKNOWN merge states while retaining the last stable baseline", () => {
    const clean = { ...baseSnapshot().core, isDraft: false, mergeStateStatus: "CLEAN" }
    const unknown = { ...clean, mergeStateStatus: "UNKNOWN", lastStableMergeStateStatus: "CLEAN" }

    // Transition from CLEAN to UNKNOWN should not emit.
    const events1 = diffSnapshot(
      { ...baseSnapshot(), core: clean },
      { ...baseSnapshot(), core: unknown },
    )
    assert.ok(!events1.some((event) => event.kind === "merge_conflict.detected"))
    assert.ok(!events1.some((event) => event.kind === "merge_conflict.cleared"))

    // A stable outcome after UNKNOWN compares against the retained CLEAN baseline.
    const events2 = diffSnapshot(
      { ...baseSnapshot(), core: unknown },
      { ...baseSnapshot(), core: { ...unknown, mergeStateStatus: "DIRTY" } },
    )
    assert.ok(events2.some((event) => event.kind === "merge_conflict.detected"))

    // A stable direct transition still emits as before.
    const events3 = diffSnapshot(
      { ...baseSnapshot(), core: clean },
      { ...baseSnapshot(), core: { ...clean, mergeStateStatus: "DIRTY" } },
    )
    assert.ok(events3.some((event) => event.kind === "merge_conflict.detected"))

    const events4 = diffSnapshot(
      { ...baseSnapshot(), core: { ...clean, mergeStateStatus: "DIRTY" } },
      { ...baseSnapshot(), core: clean },
    )
    assert.ok(events4.some((event) => event.kind === "merge_conflict.cleared"))
  })
  test("emits a merge reminder when a PR becomes merged", () => {
    const previous = baseSnapshot()
    const next = { ...previous, core: { ...previous.core, state: "MERGED" } }

    const merged = diffSnapshot(previous, next).find((event) => event.kind === "pr.merged")

    assert.ok(merged)
    assert.equal(merged.priority, "high")
    assert.equal(merged.dedupeKey, "pr.merged:https://github.com/acme/repo/pull/42")
    assert.equal(merged.payload.previousState, "OPEN")
    assert.equal(merged.payload.state, "MERGED")
  })

  test("surfaces an already-merged initial snapshot", () => {
    const next = { ...baseSnapshot(), core: { ...baseSnapshot().core, state: "MERGED" } }

    const merged = diffSnapshot(null, next).find((event) => event.kind === "pr.merged")

    assert.ok(merged)
    assert.equal(merged.payload.previousState, null)
  })

  test("emits pr.closed, not pr.merged, for an unmerged OPEN to CLOSED transition", () => {
    const previous = baseSnapshot()
    const next = { ...previous, core: { ...previous.core, state: "CLOSED" } }

    const events = diffSnapshot(previous, next)
    const closed = events.find((event) => event.kind === "pr.closed")
    assert.ok(closed)
    assert.equal(closed.priority, "high")
    assert.equal(closed.payload.previousState, "OPEN")
    assert.equal(closed.payload.state, "CLOSED")
    assert.ok(!events.some((event) => event.kind === "pr.merged"))
  })

  test("uses a repository-qualified merge dedupe key", () => {
    const previous = baseSnapshot()
    const first = { ...previous, core: { ...previous.core, state: "MERGED" } }
    const second = { ...previous, core: { ...previous.core, url: "https://github.com/other/repo/pull/42", state: "MERGED" } }

    const firstMerge = diffSnapshot(previous, first).find((event) => event.kind === "pr.merged")
    const secondMerge = diffSnapshot(previous, second).find((event) => event.kind === "pr.merged")

    assert.ok(firstMerge)
    assert.ok(secondMerge)
    assert.notEqual(firstMerge.dedupeKey, secondMerge.dedupeKey)
  })

  test("maps a cancelled check conclusion to check.cancelled at low priority, not check.created", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      checks: [{ name: "ai-review", state: "queued" }],
    }
    const next: PullRequestSnapshot = {
      ...previous,
      checks: [{ name: "ai-review", state: "cancelled", link: "https://ci.example/ai-review" }],
    }

    const cancelled = diffSnapshot(previous, next).find((event) => event.kind === "check.cancelled")

    assert.ok(cancelled)
    assert.equal(cancelled.priority, "low")
    assert.match(cancelled.summary, /cancelled/i)
    assert.ok(!diffSnapshot(previous, next).some((event) => event.kind === "check.created"))
  })

  test("tags check events with the head SHA they were observed on", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      checks: [{ name: "build", state: "queued" }],
    }
    const next: PullRequestSnapshot = {
      ...previous,
      core: { ...previous.core, headRefOid: "sha-2" },
      checks: [{ name: "build", state: "fail", link: "https://ci.example/build" }],
    }

    const failed = diffSnapshot(previous, next).find((event) => event.kind === "check.failed")

    assert.ok(failed)
    assert.equal(failed.payload.headSha, "sha-2")
  })

  test("an active rerun of a check supersedes a stale failure of the same name in the same tick", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      checks: [{ name: "ai-review", state: "queued" }],
    }
    // Two check-runs named "ai-review" show up in the same rollup: the old
    // run's failure from a race, and a fresh run already back in progress.
    const next: PullRequestSnapshot = {
      ...previous,
      checks: [
        { name: "ai-review", state: "fail", link: "https://ci.example/old-run" },
        { name: "ai-review", state: "in_progress", link: "https://ci.example/new-run" },
      ],
    }

    const events = diffSnapshot(previous, next)
    const aiReviewEvents = events.filter((event) => event.payload.name === "ai-review")

    assert.equal(aiReviewEvents.length, 1)
    assert.equal(aiReviewEvents[0]!.kind, "check.in_progress")
  })

  test("a failing aggregate gate is treated as a cancellation artifact when a sibling in its workflow was cancelled", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      checks: [
        { name: "unit-tests (shard 1)", state: "cancelled", workflow: "CI" },
        { name: "Fail if any shard failed", state: "queued", workflow: "CI" },
      ],
    }
    const next: PullRequestSnapshot = {
      ...previous,
      checks: [
        // unit-tests stays cancelled (no state change, so it emits no event
        // of its own this tick — only the gate's state actually changes).
        { name: "unit-tests (shard 1)", state: "cancelled", workflow: "CI" },
        { name: "Fail if any shard failed", state: "fail", workflow: "CI", link: "https://ci.example/gate" },
      ],
    }

    const events = diffSnapshot(previous, next)
    const gate = events.find((event) => event.payload.name === "Fail if any shard failed")

    assert.ok(gate)
    assert.equal(gate.kind, "check.cancelled")
    assert.equal(gate.priority, "low")
    assert.match(gate.summary, /cancelled/i)
  })

  test("a genuine failure in a workflow with no cancellations stays check.failed", () => {
    const previous: PullRequestSnapshot = {
      ...baseSnapshot(),
      checks: [{ name: "unit-tests", state: "queued", workflow: "CI" }],
    }
    const next: PullRequestSnapshot = {
      ...previous,
      checks: [{ name: "unit-tests", state: "fail", workflow: "CI", link: "https://ci.example/unit" }],
    }

    const failed = diffSnapshot(previous, next).find((event) => event.payload.name === "unit-tests")

    assert.ok(failed)
    assert.equal(failed.kind, "check.failed")
    assert.equal(failed.priority, "high")
  })
})
