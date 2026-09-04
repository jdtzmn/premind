import { PREMIND_VERSION_LABEL } from "../shared/version.ts"

const RELATIVE_TIME_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
]

/**
 * Formats a past timestamp as a human-readable relative string using the
 * built-in Intl.RelativeTimeFormat. Returns strings like "3 minutes ago",
 * "yesterday", or "now".
 */
export const formatRelativeTime = (timestampMs: number, now = Date.now()): string => {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  const diffMs = timestampMs - now
  const absMs = Math.abs(diffMs)
  for (const { unit, ms } of RELATIVE_TIME_UNITS) {
    if (absMs >= ms || unit === "second") {
      return rtf.format(Math.round(diffMs / ms), unit)
    }
  }
  return rtf.format(0, "second")
}

export const renderPremindStatus = (status: {
  daemon: { protocolVersion: number }
  globallyDisabled?: boolean
  activeClients: number
  activeSessions: number
  closedSessions?: number
  activeWatchers: number
  lastReapAt: number | null
  lastReapCount: number
  sessions: Array<{
    sessionId: string
    repo: string
    branch: string
    prNumber: number | null
    status: string
    busyState: string
    pendingReminderCount: number
    worktreeBinding?: {
      root: string
      repo: string
      branch: string | null
      state: string
    } | null
    subscriptions?: Array<{
      repo: string
      prNumber: number
      source: string
      state: string
      pendingEventCount: number
    }>
  }>
}, now = Date.now(), versionLabel = PREMIND_VERSION_LABEL) => {
  const lastReapLine = status.lastReapAt === null
    ? "- last reap: never"
    : `- last reap: ${formatRelativeTime(status.lastReapAt, now)} (${status.lastReapCount} reaped)`

  const lines = [`premind status ${versionLabel}`]
  if (status.globallyDisabled) {
    lines.push("- globally disabled: yes (no GitHub polling — run /premind-enable to resume)")
  }
  lines.push(
    `- protocol: ${status.daemon.protocolVersion}`,
    `- active clients: ${status.activeClients}`,
    `- active sessions: ${status.activeSessions}`,
  )
  if ((status.closedSessions ?? 0) > 0) {
    lines.push(`- closed sessions (pending pruning): ${status.closedSessions}`)
  }
  lines.push(
    `- active watchers: ${status.activeWatchers}`,
    lastReapLine,
    ...status.sessions.map((session) => {
      const worktreeState = session.worktreeBinding?.state === "foreign_pr"
        ? "foreign PR; automatic watching disabled"
        : session.worktreeBinding?.state
      const worktree = session.worktreeBinding
        ? ` | worktree ${session.worktreeBinding.repo} @ ${session.worktreeBinding.branch ?? "detached"} (${worktreeState})`
        : ""
      const subscriptions = (session.subscriptions ?? [])
        .map(
          (subscription) =>
            `${subscription.repo}#${subscription.prNumber} (${subscription.source}/${subscription.state}, pending ${subscription.pendingEventCount})`,
        )
        .join(", ")
      const subscriptionSummary = subscriptions ? ` | subscriptions ${subscriptions}` : ""
      return `- session ${session.sessionId}: ${session.repo} @ ${session.branch}${session.prNumber ? ` (PR #${session.prNumber})` : ""} | ${session.status}/${session.busyState} | pending ${session.pendingReminderCount}${worktree}${subscriptionSummary}`
    }),
  )
  return lines.join("\n")
}
