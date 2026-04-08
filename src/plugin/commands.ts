type CommandExecuteBeforeInput = {
  command?: string
}

export const isPremindStatusCommand = (input: unknown) => {
  const record = (input ?? {}) as CommandExecuteBeforeInput
  return record.command === "premind-status"
}

export const renderPremindStatus = (status: {
  daemon: { protocolVersion: number }
  activeClients: number
  activeSessions: number
  activeWatchers: number
}) => {
  return [
    "premind status",
    `- protocol: ${status.daemon.protocolVersion}`,
    `- active clients: ${status.activeClients}`,
    `- active sessions: ${status.activeSessions}`,
    `- active watchers: ${status.activeWatchers}`,
  ].join("\n")
}
