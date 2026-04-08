import { PREMIND_IDLE_SHUTDOWN_GRACE_MS } from "../shared/constants.js"
import { createLogger } from "./logging/logger.js"
import { IpcServer } from "./ipc/server.js"
import { GitHubClient } from "./github/client.js"
import { BranchDiscoveryWatcher } from "./watchers/branch-discovery.js"
import { PullRequestWatcher } from "./watchers/pr-watcher.js"
import { PollScheduler } from "./watchers/poll-scheduler.js"

const logger = createLogger("daemon")

async function main() {
  const server = new IpcServer()
  const github = new GitHubClient()
  const discoveryWatcher = new BranchDiscoveryWatcher(server.store, github)
  const pullRequestWatcher = new PullRequestWatcher(server.store, github)

  const recovery = server.store.recoverFromRestart()
  logger.info("startup recovery", {
    prunedClients: recovery.prunedClients,
    resetBatches: recovery.resetBatches,
    recoveredSessions: recovery.recoveredSessions,
    recoveredBranchWatchers: recovery.recoveredBranchWatchers,
    recoveredPrWatchers: recovery.recoveredPrWatchers,
  })

  await server.listen()

  const discoveryScheduler = new PollScheduler(
    "branch-discovery",
    () => discoveryWatcher.tick(),
    { baseIntervalMs: 60_000, maxIntervalMs: 180_000, jitterFactor: 0.25 },
  )

  const prScheduler = new PollScheduler(
    "pr-watcher",
    () => pullRequestWatcher.tick(),
    { baseIntervalMs: 20_000, maxIntervalMs: 120_000, jitterFactor: 0.2 },
  )

  discoveryScheduler.start()
  prScheduler.start()

  const shutdownCheck = setInterval(async () => {
    if (!server.shouldShutdown()) return
    clearInterval(shutdownCheck)
    discoveryScheduler.stop()
    prScheduler.stop()
    logger.info("graceful shutdown", { reason: "no_active_clients_or_sessions" })
    await server.close()
    process.exit(0)
  }, PREMIND_IDLE_SHUTDOWN_GRACE_MS)

  const cleanup = async () => {
    clearInterval(shutdownCheck)
    discoveryScheduler.stop()
    prScheduler.stop()
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

void main().catch((error) => {
  logger.error("fatal error", { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
