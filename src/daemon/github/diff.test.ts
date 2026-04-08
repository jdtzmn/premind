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
})
