import type { DebugStatusResponse } from "./schema.ts";

export type StatusSignal = "error" | "warning" | "success" | "merged" | "muted" | "unknown";
type Subscription = NonNullable<DebugStatusResponse["sessions"][number]["subscriptions"]>[number];
export type CachedStatusSnapshot = NonNullable<Subscription["snapshot"]>;
export type PrSignal = { text: string; kind: StatusSignal; priority: number };

// The quiet watcher tier polls every five minutes; two missed polls make health evidence stale.
export const STATUS_FRESHNESS_MS = 10 * 60_000;

export function getPrSignal(
  snapshot: CachedStatusSnapshot | null | undefined,
  now = Date.now(),
  pollingDisabled = false,
): PrSignal {
  const unknown: PrSignal = { text: "? status unknown", kind: "unknown", priority: 4 };
  if (!snapshot) return unknown;

  // Terminal states remain meaningful even when live health evidence is stale.
  const state = snapshot.state.toUpperCase();
  if (state === "MERGED") return { text: "◆ merged", kind: "merged", priority: 5 };
  if (state === "CLOSED") return { text: "○ closed", kind: "muted", priority: 5 };
  if (state !== "OPEN" || pollingDisabled) return unknown;

  const age = now - snapshot.fetchedAt;
  if (!Number.isFinite(snapshot.fetchedAt) || age < 0 || age > STATUS_FRESHNESS_MS) {
    return unknown;
  }

  const merge = snapshot.mergeStateStatus?.toUpperCase();
  if (!merge || merge === "UNKNOWN") return unknown;

  const review = snapshot.reviewDecision?.toUpperCase();
  const checks = snapshot.checks.map((check) => check.state?.toLowerCase() ?? "unknown");
  const hasConflicts = merge === "DIRTY";
  const hasFailedChecks = checks.some((check) => ["fail", "failure", "error"].includes(check));
  const hasRequestedChanges = review === "CHANGES_REQUESTED";
  const needsReview = review === "REVIEW_REQUIRED";
  const hasBlockedMerge = ["BLOCKED", "BEHIND", "UNSTABLE"].includes(merge);
  const hasPendingChecks = checks.some((check) => ["pending", "in_progress", "queued", "requested", "waiting"].includes(check));
  const hasActionNeeded = checks.some((check) => ["action_required", "cancelled"].includes(check));
  const hasIncompleteChecks = checks.some((check) => !["pass", "success"].includes(check));

  if (hasConflicts || hasFailedChecks) {
    const problems: string[] = [];
    if (hasConflicts) problems.push("conflicts");
    if (hasFailedChecks) problems.push("CI failing");
    if (hasRequestedChanges) problems.push("changes requested");
    if (snapshot.isDraft) problems.push("draft");
    return { text: `✗ ${problems.join(", ")}`, kind: "error", priority: 0 };
  }

  if (hasRequestedChanges || hasBlockedMerge || needsReview || hasActionNeeded) {
    const warnings: string[] = [];
    if (hasRequestedChanges) warnings.push("changes requested");
    if (hasBlockedMerge) warnings.push(merge === "BEHIND" ? "branch behind" : "blocked");
    if (needsReview) warnings.push("review needed");
    if (hasActionNeeded) warnings.push("checks need action");
    if (snapshot.isDraft) warnings.push("draft");
    return { text: `! ${warnings.join(", ")}`, kind: "warning", priority: 1 };
  }

  if (snapshot.isDraft) {
    const pending = hasPendingChecks ? ", checks pending" : "";
    return { text: `○ draft${pending}`, kind: "muted", priority: 2 };
  }
  if (hasPendingChecks) return { text: "… checks pending", kind: "warning", priority: 2 };

  const checksPassed = checks.length > 0 && !hasIncompleteChecks;
  const reviewComplete = !review || review === "APPROVED";
  if (merge === "CLEAN" && checksPassed && reviewComplete) {
    return { text: "✓ ready to merge", kind: "success", priority: 3 };
  }
  return unknown;
}
