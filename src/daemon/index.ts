import { PREMIND_CLOSED_SESSION_RETENTION_MS, PREMIND_DAEMON_LOG_PATH, PREMIND_IDLE_SHUTDOWN_GRACE_MS, PREMIND_SESSION_STALE_MS } from "../shared/constants.ts"
import { createLogger } from "./logging/logger.ts"
import { IpcServer } from "./ipc/server.ts"
import { GitHubClient } from "./github/client.ts"
import { BranchDiscoveryWatcher } from "./watchers/branch-discovery.ts"
import { PullRequestWatcher } from "./watchers/pr-watcher.ts"
import { AdaptiveSchedule } from "./watchers/adaptive-schedule.ts"
import { PollScheduler } from "./watchers/poll-scheduler.ts"
import { createDisableGatedTick } from "./watchers/disable-gate.ts"
import { DetailFileWriter } from "./reminders/detail-files.ts"
import { createDaemonLifecycleActor } from "./lifecycle/daemon-machine.ts"

const logger = createLogger("daemon")

const STALENESS_SWEEP_INTERVAL_MS = 5 * 60 * 1000

async function main() {
  logger.info("daemon starting", { pid: process.pid, logFile: PREMIND_DAEMON_LOG_PATH })
  const server = new IpcServer()
  const lifecycle = createDaemonLifecycleActor()
  lifecycle.start()
  const github = new GitHubClient()
  const discoveryWatcher = new BranchDiscoveryWatcher(server.store, github, server.worktreeBindings)

  const recovery = server.store.recoverFromRestart()
  logger.info("startup recovery", {
    prunedClients: recovery.prunedClients,
    resetBatches: recovery.resetBatches,
    dedupedSessions: recovery.dedupedSessions,
    recoveredSessions: recovery.recoveredSessions,
    recoveredBranchWatchers: recovery.recoveredBranchWatchers,
    recoveredPrWatchers: recovery.recoveredPrWatchers,
  })

  // Adaptive per-PR scheduling: active PRs poll every 20s; quiet PRs stretch to
  // 5 minutes. The registry reconstructs canonical actors from SQLite here.
  const prSchedule = new AdaptiveSchedule()
  const pullRequestWatcher = new PullRequestWatcher(server.store, github, { schedule: prSchedule })

  // Reap sessions whose last_activity_at is older than the staleness threshold.
  // Runs once at startup to clean up any backlog carried across daemon restarts,
  // and periodically while the daemon is up.
  const startupReap = server.store.reapStaleSessions(PREMIND_SESSION_STALE_MS)
  server.worktreeBindings.closeInactiveSessions()
  if (startupReap.reaped > 0 || startupReap.oldestAgeMs !== null) {
    logger.info("startup reap", {
      reaped: startupReap.reaped,
      oldestAgeMs: startupReap.oldestAgeMs,
      thresholdMs: PREMIND_SESSION_STALE_MS,
    })
  }

  // Prune closed session rows and orphaned PR events at startup so any backlog
  // accumulated while the daemon was down is cleaned up immediately.
  const startupPrunedSessions = server.store.pruneClosedSessions(PREMIND_CLOSED_SESSION_RETENTION_MS)
  const startupPrunedEvents = server.store.pruneOrphanedPrEvents()
  if (startupPrunedSessions > 0 || startupPrunedEvents > 0) {
    logger.info("startup prune", {
      prunedClosedSessions: startupPrunedSessions,
      prunedOrphanedEvents: startupPrunedEvents,
    })
  }

  // Run cache cleanup on startup.
  const detailFiles = new DetailFileWriter()
  const cleanedFiles = detailFiles.cleanup()
  if (cleanedFiles > 0) {
    logger.info("detail file cleanup", { removed: cleanedFiles })
  }

  await server.listen()
  lifecycle.send({ type: "STARTUP_COMPLETE", hasDemand: server.hasDemand() })

  const discoveryScheduler = new PollScheduler(
    "branch-discovery",
    createDisableGatedTick("branch-discovery", server.store, () => discoveryWatcher.tick(), logger),
    { baseIntervalMs: 60_000, maxIntervalMs: 180_000, jitterFactor: 0.25 },
  )

  const prScheduler = new PollScheduler(
    "pr-watcher",
    createDisableGatedTick("pr-watcher", server.store, () => pullRequestWatcher.tick(), logger),
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
      pullRequestWatcher.setRateLimitReset(snapshot.resetAtMs)
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

  const reapInterval = setInterval(() => {
    const result = server.store.reapStaleSessions(PREMIND_SESSION_STALE_MS)
    server.worktreeBindings.closeInactiveSessions()
    if (result.reaped > 0) {
      logger.info("reaped stale sessions", {
        reaped: result.reaped,
        oldestAgeMs: result.oldestAgeMs,
        thresholdMs: PREMIND_SESSION_STALE_MS,
      })
    }
    const prunedSessions = server.store.pruneClosedSessions(PREMIND_CLOSED_SESSION_RETENTION_MS)
    const prunedEvents = server.store.pruneOrphanedPrEvents()
    if (prunedSessions > 0 || prunedEvents > 0) {
      logger.info("pruned closed sessions and orphaned events", {
        prunedClosedSessions: prunedSessions,
        prunedOrphanedEvents: prunedEvents,
      })
    }
  }, STALENESS_SWEEP_INTERVAL_MS)
  if (typeof reapInterval.unref === "function") reapInterval.unref()

  let stopping = false
  let shutdownDeadlineAt: number | null =
    lifecycle.getSnapshot().value === "shutdown_grace"
      ? Date.now() + PREMIND_IDLE_SHUTDOWN_GRACE_MS
      : null
  const stopDaemon = async (reason: string) => {
    if (stopping) return
    stopping = true
    lifecycle.send({ type: "STOP_REQUESTED", reason })
    clearInterval(shutdownCheck)
    clearInterval(reapInterval)
    discoveryScheduler.stop()
    prScheduler.stop()
    pullRequestWatcher.close()
    logger.info("graceful shutdown", { reason })
    await server.close()
    lifecycle.send({ type: "STOPPED" })
    process.exit(0)
  }

  const reconcileDemand = (now = Date.now()) => {
    lifecycle.send({ type: "DEMAND_CHANGED", hasDemand: server.hasDemand(now) })
    const state = lifecycle.getSnapshot().value
    if (state === "running") {
      shutdownDeadlineAt = null
      return
    }
    if (state !== "shutdown_grace") return
    shutdownDeadlineAt ??= now + PREMIND_IDLE_SHUTDOWN_GRACE_MS
    if (now >= shutdownDeadlineAt) {
      lifecycle.send({ type: "GRACE_EXPIRED" })
      void stopDaemon("idle_grace_expired")
    }
  }

  server.setDemandChangeListener(() => reconcileDemand())
  reconcileDemand()
  const shutdownCheck = setInterval(() => reconcileDemand(), Math.min(1_000, PREMIND_IDLE_SHUTDOWN_GRACE_MS))
  if (typeof shutdownCheck.unref === "function") shutdownCheck.unref()

  const cleanup = () => {
    void stopDaemon("signal")
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

void main().catch((error) => {
  logger.error("fatal error", { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
