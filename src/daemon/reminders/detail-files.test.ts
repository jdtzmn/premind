import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { DetailFileWriter } from "./detail-files.ts"

const tempPaths: string[] = []

const createWriter = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-detail-test-"))
  tempPaths.push(dir)
  return new DetailFileWriter(dir)
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("DetailFileWriter", () => {
  test("writes detail files for body-rich events and cleans up old ones", () => {
    const writer = createWriter()

    // issue_comment.* — rich body content; gets a file.
    const issuePath = writer.write("acme/repo", 42, {
      dedupeKey: "issue_comment.created:100",
      kind: "issue_comment.created",
      priority: "high",
      summary: "New comment",
      payload: { commentId: 100, user: "alice", body: "Please fix this" },
    })
    // review_comment.* — body + file/line context; gets a file.
    const reviewCommentPath = writer.write("acme/repo", 42, {
      dedupeKey: "review_comment.created:200",
      kind: "review_comment.created",
      priority: "high",
      summary: "New review comment",
      payload: {
        commentId: 200,
        user: "bob",
        path: "src/foo.ts",
        line: 42,
        body: "nit: rename this",
      },
    })
    // review.* — review body; gets a file.
    const reviewPath = writer.write("acme/repo", 42, {
      dedupeKey: "review.commented:300",
      kind: "review.commented",
      priority: "medium",
      summary: "Review comment from carol",
      payload: { reviewId: 300, user: "carol", state: "commented", body: "looks good" },
    })

    assert.ok(issuePath !== null && fs.existsSync(issuePath))
    assert.ok(reviewCommentPath !== null && fs.existsSync(reviewCommentPath))
    assert.ok(reviewPath !== null && fs.existsSync(reviewPath))

    // Verify content shape.
    const issue = JSON.parse(fs.readFileSync(issuePath as string, "utf8"))
    assert.equal(issue.type, "issue_comment")
    assert.equal(issue.author, "alice")
    assert.equal(issue.body, "Please fix this")

    const reviewComment = JSON.parse(fs.readFileSync(reviewCommentPath as string, "utf8"))
    assert.equal(reviewComment.type, "review_comment")
    assert.equal(reviewComment.file, "src/foo.ts")
    assert.equal(reviewComment.line, 42)

    // Both files are fresh, so cleanup with a 14-day TTL should remove nothing.
    const removedNone = writer.cleanup(14 * 24 * 60 * 60 * 1000)
    assert.equal(removedNone, 0)

    // Cleanup with TTL=0 and a slightly future now should remove everything.
    const removedAll = writer.cleanup(0, Date.now() + 1_000)
    assert.equal(removedAll, 3)
    assert.ok(!fs.existsSync(issuePath as string))
    assert.ok(!fs.existsSync(reviewCommentPath as string))
    assert.ok(!fs.existsSync(reviewPath as string))
  })

  test("returns null and skips file creation for check.* events", () => {
    const writer = createWriter()

    const result = writer.write("acme/repo", 42, {
      dedupeKey: "check.failed:lint:sha-1",
      kind: "check.failed",
      priority: "high",
      summary: "Check failed: lint",
      referenceLink: "https://github.com/acme/repo/runs/1",
      payload: { name: "lint", state: "fail" },
    })

    assert.equal(result, null, "check events must not get a local detail file")
    // No file should have been created on disk for this PR directory.
    const prDir = path.join((writer as unknown as { baseDir: string }).baseDir, "acme-repo", "42")
    if (fs.existsSync(prDir)) {
      const entries = fs.readdirSync(prDir)
      assert.deepEqual(entries, [], "no files for check.* events")
    }
  })

  test("returns null for unrecognized event kinds (no rich body)", () => {
    const writer = createWriter()
    const result = writer.write("acme/repo", 42, {
      dedupeKey: "label.added:bug",
      kind: "label.added",
      priority: "low",
      summary: "label added",
      payload: { name: "bug" },
    })
    assert.equal(result, null)
  })
})
