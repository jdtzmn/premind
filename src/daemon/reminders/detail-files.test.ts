import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { DetailFileWriter } from "./detail-files.js"

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
  test("writes detail files and cleans up old ones", () => {
    const writer = createWriter()

    // Write two events.
    const path1 = writer.write("acme/repo", 42, {
      dedupeKey: "issue_comment.created:100",
      kind: "issue_comment.created",
      priority: "high",
      summary: "New comment",
      payload: { commentId: 100, user: "alice", body: "Please fix this" },
    })

    const path2 = writer.write("acme/repo", 42, {
      dedupeKey: "check.failed:lint:sha-1",
      kind: "check.failed",
      priority: "high",
      summary: "Check failed: lint",
      payload: { name: "lint", state: "fail" },
    })

    assert.ok(fs.existsSync(path1))
    assert.ok(fs.existsSync(path2))

    // Verify content shape.
    const content1 = JSON.parse(fs.readFileSync(path1, "utf8"))
    assert.equal(content1.type, "issue_comment")
    assert.equal(content1.author, "alice")

    const content2 = JSON.parse(fs.readFileSync(path2, "utf8"))
    assert.equal(content2.type, "check")
    assert.equal(content2.name, "lint")

    // Both files are fresh, so cleanup with a 14-day TTL should remove nothing.
    const removedNone = writer.cleanup(14 * 24 * 60 * 60 * 1000)
    assert.equal(removedNone, 0)

    // Cleanup with TTL=0 and a slightly future now should remove everything.
    const removedAll = writer.cleanup(0, Date.now() + 1_000)
    assert.equal(removedAll, 2)
    assert.ok(!fs.existsSync(path1))
    assert.ok(!fs.existsSync(path2))
  })
})
