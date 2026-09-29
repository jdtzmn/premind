import assert from "node:assert/strict";
import { test } from "node:test";
import { getPrSignal, STATUS_FRESHNESS_MS, type CachedStatusSnapshot } from "./status-signal.ts";

const now = 1_000_000;
const clean: CachedStatusSnapshot = {
  title: "Ready", url: "https://github.com/acme/repo/pull/42", state: "OPEN",
  isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
  checks: [{ state: "pass" }], fetchedAt: now - 10_000,
};

test("verified signals distinguish terminal states from historical blockers", () => {
  const failed = { ...clean, mergeStateStatus: "DIRTY", checks: [{ state: "fail" }], reviewDecision: "CHANGES_REQUESTED" };
  assert.deepEqual(getPrSignal(failed, now), { text: "✗ conflicts, CI failing, changes requested", kind: "error", priority: 0 });
  assert.equal(getPrSignal({ ...failed, isDraft: true }, now).text, "✗ conflicts, CI failing, changes requested, draft");
  assert.equal(getPrSignal({ ...failed, state: "MERGED" }, now).text, "◆ merged");
  assert.equal(getPrSignal({ ...failed, state: "CLOSED" }, now).text, "○ closed");
});

test("draft, review, pending, and blocked states have distinct words", () => {
  assert.equal(getPrSignal({ ...clean, isDraft: true }, now).text, "○ draft");
  assert.equal(getPrSignal({ ...clean, isDraft: true, checks: [{ state: "pending" }] }, now).text, "○ draft, checks pending");
  assert.equal(getPrSignal({ ...clean, checks: [{ state: "in_progress" }] }, now).text, "… checks pending");
  assert.equal(getPrSignal({ ...clean, reviewDecision: "CHANGES_REQUESTED" }, now).text, "! changes requested");
  assert.equal(getPrSignal({ ...clean, reviewDecision: "REVIEW_REQUIRED" }, now).text, "! review needed");
  assert.equal(getPrSignal({ ...clean, mergeStateStatus: "BEHIND" }, now).text, "! branch behind");
  assert.equal(getPrSignal({ ...clean, mergeStateStatus: "BLOCKED" }, now).text, "! blocked");
  assert.equal(getPrSignal({ ...clean, checks: [{ state: "action_required" }] }, now).text, "! checks need action");
});

test("ready requires recent clean mergeability and complete passing checks", () => {
  assert.equal(getPrSignal(clean, now).text, "✓ ready to merge");
  for (const snapshot of [
    null,
    { ...clean, checks: [] },
    { ...clean, checks: [{ state: "neutral" }] },
    { ...clean, reviewDecision: "UNKNOWN" },
    { ...clean, mergeStateStatus: "UNKNOWN" },
    { ...clean, mergeStateStatus: undefined },
    { ...clean, fetchedAt: now - STATUS_FRESHNESS_MS - 1 },
    { ...clean, fetchedAt: now + 1 },
  ]) assert.equal(getPrSignal(snapshot, now).text, "? status unknown");
  assert.equal(getPrSignal(clean, now, true).text, "? status unknown");
  assert.equal(getPrSignal({ ...clean, state: "MERGED", fetchedAt: 0 }, now, true).text, "◆ merged");
});
