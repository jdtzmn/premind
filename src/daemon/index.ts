import { PREMIND_IDLE_SHUTDOWN_GRACE_MS } from "../shared/constants.ts"
import { createLogger } from "./logging/logger.ts"
import { IpcServer } from "./ipc/server.ts"
import { GitHubClient } from "./github/client.ts"
import { BranchDiscoveryWatcher } from "./watchers/branch-discovery.ts"
import { PullRequestWatcher } from "./watchers/pr-watcher.ts"
import { AdaptiveSchedule } from "./watchers/adaptive-schedule.ts"
import { PollScheduler } from "./watchers/poll-scheduler.ts"
import { DetailFileWriter } from "./reminders/detail-files.ts"

const logger = createLogger("daemon")

async function main() {
  const server = new IpcServer()
  const github = new GitHubClient()
  const discoveryWatcher = new BranchDiscoveryWatcher(server.store, github)
  // Adaptive per-PR scheduling: active PRs poll every 20s; quiet PRs stretch to
  // 5 minutes. Default tiers in AdaptiveSchedule match the documented cadence.
  const prSchedule = new AdaptiveSchedule()
  const pullRequestWatcher = new PullRequestWatcher(server.store, github, { schedule: prSchedule })

  const recovery = server.store.recoverFromRestart()
  logger.info("startup recovery", {
    prunedClients: recovery.prunedClients,
    resetBatches: recovery.resetBatches,
    recoveredSessions: recovery.recoveredSessions,
    recoveredBranchWatchers: recovery.recoveredBranchWatchers,
    recoveredPrWatchers: recovery.recoveredPrWatchers,
  })

  // Run cache cleanup on startup.
  const detailFiles = new DetailFileWriter()
  const cleanedFiles = detailFiles.cleanup()
  if (cleanedFiles > 0) {
    logger.info("detail file cleanup", { removed: cleanedFiles })
  }

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

  // Wire rate-limit observations from the HTTP client back into the poll
  // schedulers. When either the core (REST) or graphql bucket enters the
  // throttle zone, defer the next tick until the reset time. This both keeps
  // us from tripping GitHub's secondary rate limits and respects Retry-After.
  github.rateLimit.onUpdate((snapshot) => {
    if (!github.rateLimit.isThrottled(snapshot.resource)) return
    // Branch discovery hits REST (core); the PR watcher hits GraphQL.
    if (snapshot.resource === "core") {
      discoveryScheduler.setRateLimitReset(snapshot.resetAtMs)
      logger.warn("rate limit throttled; deferring branch discovery", {
        resource: snapshot.resource,
        remaining: snapshot.remaining,
        resetAtMs: snapshot.resetAtMs,
      })
    } else if (snapshot.resource === "graphql") {
      prScheduler.setRateLimitReset(snapshot.resetAtMs)
      logger.warn("rate limit throttled; deferring pr poll", {
        resource: snapshot.resource,
        remaining: snapshot.remaining,
        resetAtMs: snapshot.resetAtMs,
      })
    }
  })

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
