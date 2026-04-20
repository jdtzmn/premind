export const renderPremindStatus = (status: {
  daemon: { protocolVersion: number }
  globallyDisabled?: boolean
  activeClients: number
  activeSessions: number
  activeWatchers: number
  sessions: Array<{
    sessionId: string
    repo: string
    branch: string
    prNumber: number | null
    status: string
    busyState: string
    pendingReminderCount: number
  }>
}) => {
  const lines = ["premind status"]
  if (status.globallyDisabled) {
    lines.push("- globally disabled: yes (no GitHub polling — run /premind-enable to resume)")
  }
  lines.push(
    `- protocol: ${status.daemon.protocolVersion}`,
    `- active clients: ${status.activeClients}`,
    `- active sessions: ${status.activeSessions}`,
    `- active watchers: ${status.activeWatchers}`,
    ...status.sessions.map(
      (session) =>
        `- session ${session.sessionId}: ${session.repo} @ ${session.branch}${session.prNumber ? ` (PR #${session.prNumber})` : ""} | ${session.status}/${session.busyState} | pending ${session.pendingReminderCount}`,
    ),
  )
  return lines.join("\n")
}
