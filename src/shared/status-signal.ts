import type { DebugStatusResponse } from "./schema.ts";

export type StatusSignal = "error" | "warning" | "success" | "merged" | "muted" | "unknown";
export type CachedStatusSnapshot = NonNullable<NonNullable<DebugStatusResponse["sessions"][number]["subscriptions"]>[number]["snapshot"]>;

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
  const state = snapshot.state.toUpperCase();
  if (state === "MERGED") return { text: "◆ merged", kind: "merged", priority: 5 };
  if (state === "CLOSED") return { text: "○ closed", kind: "muted", priority: 5 };
  if (state !== "OPEN" || pollingDisabled || !Number.isFinite(snapshot.fetchedAt) ||
      snapshot.fetchedAt > now || now - snapshot.fetchedAt > STATUS_FRESHNESS_MS ||
      !snapshot.mergeStateStatus || snapshot.mergeStateStatus.toUpperCase() === "UNKNOWN") {
    return unknown;
  }

  const merge = snapshot.mergeStateStatus.toUpperCase();
  const review = snapshot.reviewDecision?.toUpperCase();
  const checks = snapshot.checks.map((check) => check.state?.toLowerCase() ?? "unknown");
  const conflicts = merge === "DIRTY";
  const failed = checks.some((check) => ["fail", "failure", "error"].includes(check));
  const draft = snapshot.isDraft;
  const changes = review === "CHANGES_REQUESTED";
  const reviewNeeded = review === "REVIEW_REQUIRED";
  const blocked = ["BLOCKED", "BEHIND", "UNSTABLE"].includes(merge);
  const pending = checks.some((check) => ["pending", "in_progress", "queued", "requested", "waiting"].includes(check));
  const actionNeeded = checks.some((check) => ["action_required", "cancelled"].includes(check));
  const incomplete = checks.some((check) => !["pass", "success"].includes(check));

  if (conflicts || failed) {
    const words = [conflicts && "conflicts", failed && "CI failing", changes && "changes requested", draft && "draft"].filter(Boolean);
    return { text: `✗ ${words.join(", ")}`, kind: "error", priority: 0 };
  }
  if (changes || blocked || reviewNeeded || actionNeeded) {
    const words = [changes && "changes requested", blocked && (merge === "BEHIND" ? "branch behind" : "blocked"), reviewNeeded && "review needed", actionNeeded && "checks need action", draft && "draft"].filter(Boolean);
    return { text: `! ${words.join(", ")}`, kind: "warning", priority: 1 };
  }
  if (draft) return { text: `○ draft${pending ? ", checks pending" : ""}`, kind: "muted", priority: 2 };
  if (pending) return { text: "… checks pending", kind: "warning", priority: 2 };
  if (merge === "CLEAN" && checks.length > 0 && !incomplete && (!review || review === "APPROVED")) {
    return { text: "✓ ready to merge", kind: "success", priority: 3 };
  }
  return unknown;
}
