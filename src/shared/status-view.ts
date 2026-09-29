import type { DebugStatusResponse } from "./schema.ts";
import { getPrSignal, type StatusSignal } from "./status-signal.ts";

export type { StatusSignal } from "./status-signal.ts";
export type StatusStyler = (text: string, signal: StatusSignal) => string;

const prLink = (repo: string, number: number) =>
  /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0
    ? `https://github.com/${repo}/pull/${number}`
    : "link unavailable";

const snapshotLink = (repo: string, number: number, url: string | undefined) => {
  if (!url) return prLink(repo, number);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password &&
        parsed.pathname.toLowerCase() === `/${repo}/pull/${number}`.toLowerCase() && !parsed.search && !parsed.hash) return url;
  } catch { /* Ignore malformed cached URLs. */ }
  return prLink(repo, number);
};
export const renderCurrentStatus = (
  status: DebugStatusResponse,
  sessionId: string | undefined,
  options: { style?: StatusStyler; debugCommand?: string; now?: number } = {},
): string => {
  const session = status.sessions.find((item) => item.sessionId === sessionId);
  const otherCount = status.sessions.length - (session ? 1 : 0);
  const lines = [
    `premind · running · polling ${status.globallyDisabled ? "off" : "on"} · ${status.activeWatchers} watcher${status.activeWatchers === 1 ? "" : "s"}${status.globallyDisabled ? " · /premind:enable" : ""}`,
  ];
  if (!session) {
    lines.push("no premind session attached");
  } else {
    const repo = session.worktreeBinding?.repo ?? session.repo;
    const branch = session.worktreeBinding?.branch ?? session.branch;
    lines.push(`${repo} @ ${branch} · ${session.status}/${session.busyState} · ${session.pendingReminderCount} pending`);

    const watched = new Map<string, NonNullable<typeof session.subscriptions>[number]>();
    for (const subscription of session.subscriptions ?? []) {
      if (subscription.state !== "active") continue;
      watched.set(`${subscription.repo.toLowerCase()}#${subscription.prNumber}`, subscription);
    }
    const branchPr = session.prNumber;
    const branchKey = branchPr === null ? null : `${repo.toLowerCase()}#${branchPr}`;
    const branchLabel = branchPr === null ? "" : ` · branch PR #${branchPr}${branchKey && !watched.has(branchKey) ? " (not watched)" : ""}`;
    lines.push("", `Watching ${watched.size} PR${watched.size === 1 ? "" : "s"}${branchLabel}`);
    const sorted = [...watched.values()].sort((left, right) =>
      Number(`${right.repo.toLowerCase()}#${right.prNumber}` === branchKey) -
        Number(`${left.repo.toLowerCase()}#${left.prNumber}` === branchKey) ||
      getPrSignal(left.snapshot, options.now, status.globallyDisabled).priority -
        getPrSignal(right.snapshot, options.now, status.globallyDisabled).priority ||
      left.repo.localeCompare(right.repo) || left.prNumber - right.prNumber,
    );
    for (const subscription of sorted) {
      const label = subscription.repo.toLowerCase() === repo.toLowerCase()
        ? `#${subscription.prNumber}`
        : `${subscription.repo}#${subscription.prNumber}`;
      const { text, kind } = getPrSignal(subscription.snapshot, options.now, status.globallyDisabled);
      const signal = options.style?.(text, kind) ?? text;
      const title = subscription.snapshot?.title.replace(/[\x00-\x1f\x7f]/g, " ").trim();
      const link = snapshotLink(subscription.repo, subscription.prNumber, subscription.snapshot?.url);
      lines.push(`  ${label}${title ? ` ${title}` : ""} · ${signal} — ${link}`);
    }
  }
  if (otherCount > 0) {
    lines.push("", `${otherCount} other session${otherCount === 1 ? "" : "s"}: ${options.debugCommand ?? "/premind:debug-status"}`);
  }
  return lines.join("\n");
};
