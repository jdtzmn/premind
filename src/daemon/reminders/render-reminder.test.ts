import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { renderReminder, type ReminderSourceEvent } from "./render-reminder.ts"
import type { PullRequestSnapshot } from "../github/types.ts"
import { diffSnapshot } from "../github/diff.ts"
import { StateStore } from "../persistence/store.ts"
import { ReminderHandoffRegistry } from "./reminder-handoff-registry.ts"

const snapshot = (): PullRequestSnapshot => ({
  core: { number: 7, title: "Review policy", url: "https://github.com/acme/repo/pull/7",
    state: "OPEN", isDraft: false, headRefName: "feature", baseRefName: "main",
    headRefOid: "head", mergeStateStatus: "CLEAN", reviewDecision: "CHANGES_REQUESTED" },
  reviews: [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "alice" }, submitted_at: "2026-01-01T00:00:00Z" }],
  checks: [], issueComments: [], reviewComments: [], fetchedAt: 1,
})
const row = (kind: string, payload: Record<string, unknown> = {}): ReminderSourceEvent => ({
  seq: 1, kind, priority: "high", summary: "alice requested changes", reference_link: null,
  payload_json: JSON.stringify(payload),
})
const render = (rows: ReminderSourceEvent[], current: PullRequestSnapshot | null, source: "automatic" | "manual" = "automatic") =>
  renderReminder(rows, current, { repo: "acme/repo", prNumber: 7, source }).reminderText

for (const kind of ["pr.snapshot.initialized", "pr.review_decision.changes_requested", "review.changes_requested"]) {
  test(`${kind} has explicit review policy without a CI instruction`, () => {
    const rows = [row(kind, { reviewId: 1 })]
    const text = render(rows, snapshot())
    assert.match(text, /Review action required: assess the requested changes/)
    assert.match(text, /explain anything you decline or cannot resolve/)
    assert.doesNotMatch(text, /Action required: resolve the failing/)
    const manual = render(rows, snapshot(), "manual")
    assert.match(manual, /report the requested changes and wait for authorization/)
    assert.doesNotMatch(manual, /assess the requested changes/)
  })
}

for (const state of ["MERGED", "CLOSED"]) {
  test(`terminal ${state} does not request review work`, () => {
    const current = snapshot()
    current.core.state = state
    for (const kind of ["pr.snapshot.initialized", "pr.review_decision.changes_requested", "review.changes_requested"]) {
      assert.doesNotMatch(render([row(kind, { reviewId: 1 })], current), /Review action required:/)
    }
  })
}

test("approved, dismissed and superseded reviews are not actionable", () => {
  const rows = [row("review.changes_requested", { reviewId: 1 })]
  const current = snapshot()
  current.core.reviewDecision = "APPROVED"
  assert.doesNotMatch(render(rows, current), /Review action required:/)
  current.core.reviewDecision = "CHANGES_REQUESTED"
  current.reviews[0]!.state = "DISMISSED"
  assert.doesNotMatch(render(rows, current), /Review action required:/)
  current.reviews[0]!.state = "CHANGES_REQUESTED"
  current.reviews.push({ id: 2, state: "APPROVED", user: { login: "ALICE" }, submitted_at: "2026-01-02T00:00:00Z" })
  assert.doesNotMatch(render(rows, current), /Review action required:/)
})

test("unknown review history requires verification rather than asserting a current blocker", () => {
  for (const current of [null, { ...snapshot(), reviews: [] }]) {
    const text = render([row("review.changes_requested", { reviewId: 99 })], current)
    assert.match(text, /UNVERIFIED/)
    assert.doesNotMatch(text, /Review action required:/)
  }
})

test("high-priority approvals and reviewer invitations do not request fixes", () => {
  const text = render([row("review.approved"), row("reviewer.requested")], snapshot())
  assert.doesNotMatch(text, /action required:/i)
})

test("nested grouped reviews reconcile individually and request action only once", () => {
  const current = snapshot()
  current.reviews.push({ id: 2, state: "DISMISSED" })
  const text = render([row("review.changes_requested", { events: [
    { summary: "alice requested changes", payload: { reviewId: 1 } },
    { summary: "bob requested changes", payload: { reviewId: 2 } },
  ] })], current)
  assert.match(text, /review.resolved/)
  assert.equal(text.match(/Review action required:/g)?.length, 1)
})

for (const source of ["automatic", "manual"] as const) {
  test(`queued ${source} review instructions disappear after approval without changing batch identity`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-review-policy-"))
    const store = new StateStore(path.join(dir, "state.db"))
    const registry = new ReminderHandoffRegistry(store)
    try {
      store.registerClient("client", { pid: 1, projectRoot: "/repo" })
      store.registerSession({ clientId: "client", sessionId: "session", repo: "acme/repo", branch: "feature",
        isPrimary: true, status: "active", busyState: "idle" })
      store.upsertSubscription({ sessionId: "session", repo: "acme/repo", prNumber: 7, source })
      const current = snapshot()
      const previous = { ...snapshot(), core: { ...snapshot().core, reviewDecision: "REVIEW_REQUIRED" }, reviews: [] }
      store.saveSnapshotAndEvents("acme/repo", 7, current, diffSnapshot(previous, current))
      const batch = registry.getPendingReminder("session")!
      assert.ok(batch)
      assert.match(batch.reminderText, /Review action required:/)
      assert.equal(batch.reminderText.match(/Review action required:/g)?.length, 1)
      const max = store.getReminderBatchRecord(batch.batchId)!.maxEventSeq
      current.core.reviewDecision = "APPROVED"
      store.saveSnapshot("acme/repo", 7, current)
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, batch.batchId)
      assert.equal(store.getReminderBatchRecord(batch.batchId)!.maxEventSeq, max)
      assert.doesNotMatch(refreshed.reminderText, /Review action required:/)
    } finally {
      registry.close()
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
