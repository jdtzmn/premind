import { PREMIND_IDLE_SHUTDOWN_GRACE_MS } from "../shared/constants.js"
import { createLogger } from "./logging/logger.js"
import { IpcServer } from "./ipc/server.js"
import { GitHubClient } from "./github/client.js"
import { BranchDiscoveryWatcher } from "./watchers/branch-discovery.js"
import { PullRequestWatcher } from "./watchers/pr-watcher.js"

const logger = createLogger("daemon")

async function main() {
  const server = new IpcServer()
  const github = new GitHubClient()
  const discoveryWatcher = new BranchDiscoveryWatcher(server.store, github)
  const pullRequestWatcher = new PullRequestWatcher(server.store, github)
  await server.listen()

  const watcherInterval = setInterval(() => {
    void Promise.all([discoveryWatcher.tick(), pullRequestWatcher.tick()]).catch((error) => {
      logger.warn("watcher tick failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, 15_000)

  const interval = setInterval(async () => {
    if (!server.shouldShutdown()) return
    clearInterval(interval)
    clearInterval(watcherInterval)
    logger.info("graceful shutdown", { reason: "no_active_clients_or_sessions" })
    await server.close()
    process.exit(0)
  }, PREMIND_IDLE_SHUTDOWN_GRACE_MS)

  process.on("SIGINT", async () => {
    clearInterval(interval)
    clearInterval(watcherInterval)
    await server.close()
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    clearInterval(interval)
    clearInterval(watcherInterval)
    await server.close()
    process.exit(0)
  })
}

void main().catch((error) => {
  logger.error("fatal error", { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
