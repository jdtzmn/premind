type CommandExecuteBeforeInput = {
  command?: string
  sessionID?: string
}

export const isPremindStatusCommand = (input: unknown) => {
  const record = (input ?? {}) as CommandExecuteBeforeInput
  return record.command === "premind-status"
}

export const isPremindPauseCommand = (input: unknown) => {
  const record = (input ?? {}) as CommandExecuteBeforeInput
  return record.command === "premind-pause"
}

export const isPremindResumeCommand = (input: unknown) => {
  const record = (input ?? {}) as CommandExecuteBeforeInput
  return record.command === "premind-resume"
}

export const getCommandSessionId = (input: unknown) => {
  const record = (input ?? {}) as CommandExecuteBeforeInput
  return typeof record.sessionID === "string" && record.sessionID.length > 0 ? record.sessionID : undefined
}

export const renderPremindStatus = (status: {
  daemon: { protocolVersion: number }
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
  return [
    "premind status",
    `- protocol: ${status.daemon.protocolVersion}`,
    `- active clients: ${status.activeClients}`,
    `- active sessions: ${status.activeSessions}`,
    `- active watchers: ${status.activeWatchers}`,
    ...status.sessions.map(
      (session) =>
        `- session ${session.sessionId}: ${session.repo} @ ${session.branch}${session.prNumber ? ` (PR #${session.prNumber})` : ""} | ${session.status}/${session.busyState} | pending ${session.pendingReminderCount}`,
    ),
  ].join("\n")
}
