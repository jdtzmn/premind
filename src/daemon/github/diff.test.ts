import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { diffSnapshot } from "./diff.js"
import type { PullRequestSnapshot } from "./types.js"

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
})
