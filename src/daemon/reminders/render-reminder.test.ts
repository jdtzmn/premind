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
const render = (
  rows: ReminderSourceEvent[], current: PullRequestSnapshot | null, source: "automatic" | "manual" = "automatic",
  policy?: "actionable" | "observe-only", worktreeMatchesTarget?: boolean,
 ) => renderReminder(rows, current, {
  repo: "acme/repo", prNumber: 7, source, policy, worktreeMatchesTarget,
 }).reminderText

for (const kind of ["pr.snapshot.initialized", "pr.review_decision.changes_requested", "review.changes_requested"]) {
  test(`${kind} gives scoped review guidance`, () => {
    const rows = [row(kind, { reviewId: 1 })]
    const text = render(rows, snapshot())
    assert.match(text, /Review action for this owned PR: triage the requested changes/)
    assert.match(text, /explain anything you decline or cannot resolve/)
    assert.match(text, /Continue unrelated assigned work if appropriate/)
    assert.doesNotMatch(text, /CI failure/)
    const manual = render(rows, snapshot(), "manual")
    assert.match(manual, /observation-only/i)
    assert.match(manual, /Do not edit, push to, rebase, merge, or comment on this PR/)
    assert.doesNotMatch(manual, /wait for authorization/i)
  })
}

for (const state of ["MERGED", "CLOSED"]) {
  test(`terminal ${state} does not request review work`, () => {
    const current = snapshot()
    current.core.state = state
    for (const kind of ["pr.snapshot.initialized", "pr.review_decision.changes_requested", "review.changes_requested"]) {
      assert.doesNotMatch(render([row(kind, { reviewId: 1 })], current), /Review action for this owned PR:/)
    }
  })
}

test("approved, dismissed and superseded reviews are not actionable", () => {
  const rows = [row("review.changes_requested", { reviewId: 1 })]
  const current = snapshot()
  current.core.reviewDecision = "APPROVED"
  assert.doesNotMatch(render(rows, current), /Review action for this owned PR:/)
  current.core.reviewDecision = "CHANGES_REQUESTED"
  current.reviews[0]!.state = "DISMISSED"
  assert.doesNotMatch(render(rows, current), /Review action for this owned PR:/)
  current.reviews[0]!.state = "CHANGES_REQUESTED"
  current.reviews.push({ id: 2, state: "APPROVED", user: { login: "ALICE" }, submitted_at: "2026-01-02T00:00:00Z" })
  assert.doesNotMatch(render(rows, current), /Review action for this owned PR:/)
})


test("verified self-owned manual subscriptions can act only from the target worktree", () => {
  const current = snapshot()
  current.checks = [{ name: "lint", state: "FAILURE" }]
  const failed = row("check.failed", { name: "lint", headSha: "head" })
  const ready = render([failed], current, "manual", "actionable", true)
  assert.match(ready, /explicit authorization/)
  assert.match(ready, /Action required for this owned PR/)
  assert.doesNotMatch(ready, /Observation-only CI\/conflict update/)
  const wrongWorktree = render([failed], current, "manual", "actionable", false)
  assert.match(wrongWorktree, /do not make changes until you activate the matching worktree/)
  assert.doesNotMatch(wrongWorktree, /resolve the failing check/)
})
test("unknown review history requires verification rather than asserting a current blocker", () => {
  for (const current of [null, { ...snapshot(), reviews: [] }]) {
    const text = render([row("review.changes_requested", { reviewId: 99 })], current)
    assert.match(text, /UNVERIFIED/)
    assert.doesNotMatch(text, /Review action for this owned PR:/)
  }
})

test("high-priority approvals and reviewer invitations do not request fixes", () => {
  const text = render([row("review.approved"), row("reviewer.requested")], snapshot())
  assert.doesNotMatch(text, /action required:/i)
})
test("write policy overrides manual provenance", () => {
  const current = snapshot()
  current.checks = [{ name: "lint", state: "FAILURE" }]
  const text = renderReminder(
    [row("check.failed", { name: "lint", headSha: "head" })],
    current,
    { repo: "acme/repo", prNumber: 7, source: "manual", writePolicy: "user-authorized" },
  ).reminderText
  assert.match(text, /User-authorized tracking/)
  assert.match(text, /Action required for this authorized PR/)
  assert.doesNotMatch(text, /Observation-only CI\/conflict update/)
})

test("persisted authority stays gated by the matching worktree", () => {
  const current = snapshot()
  current.checks = [{ name: "lint", state: "FAILURE" }]
  const text = renderReminder(
    [row("check.failed", { name: "lint", headSha: "head" })],
    current,
    { repo: "acme/repo", prNumber: 7, source: "manual", writePolicy: "user-authorized", worktreeMatchesTarget: false },
  ).reminderText
  assert.match(text, /User-authorized tracking/)
  assert.match(text, /target worktree is not active/)
  assert.doesNotMatch(text, /Action required for this authorized PR/)
})

test("persisted observe-only policy overrides automatic provenance", () => {
  const current = snapshot()
  current.checks = [{ name: "lint", state: "FAILURE" }]
  const text = renderReminder(
    [row("check.failed", { name: "lint", headSha: "head" })],
    current,
    { repo: "acme/repo", prNumber: 7, source: "automatic", writePolicy: "observe-only", worktreeMatchesTarget: true },
  ).reminderText
  assert.match(text, /This PR is observation-only/)
  assert.match(text, /Observation-only CI\/conflict update/)
  assert.match(text, /Do not edit, push to, rebase, merge, or comment on this PR/)
  assert.doesNotMatch(text, /Action required for this owned PR/)
})

test("terminal events stop PR-specific work", () => {
  const text = renderReminder([row("pr.merged")], snapshot(), { repo: "acme/repo", prNumber: 7, writePolicy: "owned-active" }).reminderText
  assert.match(text, /PR merged\. Stop making PR-specific changes/)
})



test("nested grouped reviews reconcile individually and request action only once", () => {
  const current = snapshot()
  current.reviews.push({ id: 2, state: "DISMISSED" })
  const text = render([row("review.changes_requested", { events: [
    { summary: "alice requested changes", payload: { reviewId: 1 } },
    { summary: "bob requested changes", payload: { reviewId: 2 } },
  ] })], current)
  assert.match(text, /review.resolved/)
  assert.equal(text.match(/Review action for this owned PR:/g)?.length, 1)
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
      const reviewInstruction = source === "manual"
        ? /Observation-only review feedback:/g
        : /Review action required:/g
      assert.match(batch.reminderText, reviewInstruction)
      assert.equal(batch.reminderText.match(reviewInstruction)?.length, 1)
      const max = store.getReminderBatchRecord(batch.batchId)!.maxEventSeq
      current.core.reviewDecision = "APPROVED"
      store.saveSnapshot("acme/repo", 7, current)
      const refreshed = registry.getPendingReminder("session")!
      assert.equal(refreshed.batchId, batch.batchId)
      assert.equal(store.getReminderBatchRecord(batch.batchId)!.maxEventSeq, max)
      assert.doesNotMatch(refreshed.reminderText, reviewInstruction)
    } finally {
      registry.close()
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
