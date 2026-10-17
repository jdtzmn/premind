import type { DebugStatusResponse } from "./schema.ts";
import { getPrSignal, type PrSignal, type StatusSignal } from "./status-signal.ts";

export type { StatusSignal } from "./status-signal.ts";
export type StatusStyler = (text: string, signal: StatusSignal) => string;
export type CurrentStatusLine = string | { prefix: string; signal: PrSignal; link: string };

type Session = DebugStatusResponse["sessions"][number];
type Subscription = NonNullable<Session["subscriptions"]>[number];

const subscriptionKey = (subscription: Subscription) =>
  `${subscription.repo.toLowerCase()}#${subscription.prNumber}`;

function prLink(repo: string, number: number): string {
  const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo);
  if (!validRepo || !Number.isSafeInteger(number) || number <= 0) {
    return "link unavailable";
  }
  return `https://github.com/${repo}/pull/${number}`;
}

function snapshotLink(repo: string, number: number, url: string | undefined): string {
  if (!url) return prLink(repo, number);

  try {
    const parsed = new URL(url);
    const matchesPr = parsed.pathname.toLowerCase() === `/${repo}/pull/${number}`.toLowerCase();
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.username &&
      !parsed.password &&
      matchesPr &&
      !parsed.search &&
      !parsed.hash
    ) {
      return url;
    }
  } catch {
    // Ignore malformed cached URLs.
  }
  return prLink(repo, number);
}

function activeSubscriptions(session: Session): Map<string, Subscription> {
  const watched = new Map<string, Subscription>();
  for (const subscription of session.subscriptions ?? []) {
    if (subscription.state === "active") {
      watched.set(subscriptionKey(subscription), subscription);
    }
  }
  return watched;
}

export function getCurrentStatusLines(
  status: DebugStatusResponse,
  sessionId: string | undefined,
  options: { debugCommand?: string; now?: number } = {},
): CurrentStatusLine[] {
  const session = status.sessions.find((item) => item.sessionId === sessionId);
  const otherCount = status.sessions.length - (session ? 1 : 0);
  const polling = status.globallyDisabled ? "off" : "on";
  const watcherCount = `${status.activeWatchers} watcher${status.activeWatchers === 1 ? "" : "s"}`;
  const enableHint = status.globallyDisabled ? " · /premind:enable" : "";
  const lines: CurrentStatusLine[] = [
    `premind · running · polling ${polling} · ${watcherCount}${enableHint}`,
  ];

  if (!session) {
    lines.push("no premind session attached");
  } else {
    const repo = session.worktreeBinding?.repo ?? session.repo;
    const branch = session.worktreeBinding?.branch ?? session.branch;
    lines.push(`${repo} @ ${branch} · ${session.status}/${session.busyState} · ${session.pendingReminderCount} pending`);

    const watched = activeSubscriptions(session);
    const branchPr = session.prNumber;
    const branchKey = branchPr === null ? null : `${repo.toLowerCase()}#${branchPr}`;
    const branchWatched = branchKey !== null && watched.has(branchKey);
    const branchLabel = branchPr === null
      ? ""
      : ` · branch PR #${branchPr}${branchWatched ? "" : " (not watched)"}`;
    lines.push("", `Watching ${watched.size} PR${watched.size === 1 ? "" : "s"}${branchLabel}`);

    const ranked = [...watched.values()].map((subscription) => ({
      subscription,
      signal: getPrSignal(subscription.snapshot, options.now, status.globallyDisabled),
    }));
    ranked.sort((left, right) => {
      const leftIsBranch = subscriptionKey(left.subscription) === branchKey;
      const rightIsBranch = subscriptionKey(right.subscription) === branchKey;
      if (leftIsBranch !== rightIsBranch) return leftIsBranch ? -1 : 1;

      return left.signal.priority - right.signal.priority ||
        left.subscription.repo.localeCompare(right.subscription.repo) ||
        left.subscription.prNumber - right.subscription.prNumber;
    });

    for (const { subscription, signal } of ranked) {
      const label = subscription.repo.toLowerCase() === repo.toLowerCase()
        ? `#${subscription.prNumber}`
        : `${subscription.repo}#${subscription.prNumber}`;
      const title = subscription.snapshot?.title.replace(/[\x00-\x1f\x7f]/g, " ").trim();
      const prefix = `  ${label}${title ? ` ${title}` : ""} · `;
      const link = snapshotLink(subscription.repo, subscription.prNumber, subscription.snapshot?.url);
      lines.push({ prefix, signal, link });
    }
  }

  if (otherCount > 0) {
    const label = `${otherCount} other session${otherCount === 1 ? "" : "s"}`;
    lines.push("", `${label}: ${options.debugCommand ?? "/premind:debug-status"}`);
  }
  return lines;
}

export function renderCurrentStatus(
  status: DebugStatusResponse,
  sessionId: string | undefined,
  options: { style?: StatusStyler; debugCommand?: string; now?: number } = {},
): string {
  return getCurrentStatusLines(status, sessionId, options).map((line) => {
    if (typeof line === "string") return line;
    const signal = options.style?.(line.signal.text, line.signal.kind) ?? line.signal.text;
    return `${line.prefix}${signal} — ${line.link}`;
  }).join("\n");
}
