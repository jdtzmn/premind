import { randomUUID } from "node:crypto"
import fs from "node:fs"
import {
  PREMIND_CLOSED_SESSION_RETENTION_MS,
  PREMIND_COMPATIBILITY_LOCK_PATH,
  PREMIND_COMPATIBILITY_MARKER_PATH,
  PREMIND_DAEMON_LOG_PATH,
  PREMIND_DB_PATH,
  PREMIND_LEGACY_DB_PATH,
  PREMIND_MODERN_SOCKET_PATH,
  PREMIND_SOCKET_PATH,
  PREMIND_STATE_DIR,
  PREMIND_IDLE_SHUTDOWN_GRACE_MS,
  PREMIND_REMINDER_HANDOFF_STALE_MS,
  PREMIND_SESSION_STALE_MS,
} from "../shared/constants.ts"
import { isSocketReachable } from "../shared/daemon-startup.ts"
import { reconcileCompatibilityMarker } from "../shared/protocol/compatibility-marker-reconciler.ts"
import { LegacyV1GuardServer } from "../shared/protocol/legacy-v1-guard-server.ts"
import { LegacyV1ProxyRouter } from "../shared/protocol/legacy-v1-proxy.ts"
import { bridgeLegacyStorage } from "../shared/protocol/storage-bridge.ts"
import { PREMIND_VERSION } from "../shared/version.ts"
import { StateStore } from "./persistence/store.ts"
import { createLogger } from "./logging/logger.ts"
import { IpcServer } from "./ipc/server.ts"
import { GitHubClient } from "./github/client.ts"
import { BranchDiscoveryWatcher } from "./watchers/branch-discovery.ts"
import { PullRequestWatcher } from "./watchers/pr-watcher.ts"
import { AdaptiveSchedule } from "./watchers/adaptive-schedule.ts"
import { PollScheduler } from "./watchers/poll-scheduler.ts"
import { createDisableGatedTick } from "./watchers/disable-gate.ts"
import { DetailFileWriter } from "./reminders/detail-files.ts"
import { DaemonLifecycleRuntime } from "./lifecycle/daemon-lifecycle-runtime.ts"

const logger = createLogger("daemon")

const STALENESS_SWEEP_INTERVAL_MS = 5 * 60 * 1000

async function main() {
  logger.info("daemon starting", { pid: process.pid, logFile: PREMIND_DAEMON_LOG_PATH })
  if (await isSocketReachable()) {
    logger.info("daemon startup skipped; another process owns the socket")
    return
  }
  const compatibility = reconcileCompatibilityMarker({
    markerPath: PREMIND_COMPATIBILITY_MARKER_PATH,
    lockPath: PREMIND_COMPATIBILITY_LOCK_PATH,
    dbPath: fs.existsSync(PREMIND_DB_PATH) ? PREMIND_DB_PATH : PREMIND_LEGACY_DB_PATH,
    currentVersion: PREMIND_VERSION,
    candidate: {
      markerFormat: 1,
      highestDaemonVersion: PREMIND_VERSION,
      minimumDaemonVersion: "0.0.0",
      serviceSupportFloor: "0.0.0",
      serviceSupportNotBefore: Number.MAX_SAFE_INTEGER,
      storageEpoch: 1,
      generation: 0,
    },
  })
  let runtime: { server: IpcServer; guard: LegacyV1GuardServer } | undefined
  await bridgeLegacyStorage({
    stateDir: PREMIND_STATE_DIR,
    legacyDbPath: PREMIND_LEGACY_DB_PATH,
    modernDbPath: PREMIND_DB_PATH,
    historicalSocketPath: PREMIND_SOCKET_PATH,
    compatibilityLockPath: PREMIND_COMPATIBILITY_LOCK_PATH,
    bindGuard: async () => {
      const store = new StateStore(PREMIND_DB_PATH)
      const databaseStorageEpoch = store.getStorageEpoch()
      if (databaseStorageEpoch !== compatibility.storageEpoch) {
        store.close()
        throw new Error(
          `STORAGE_EPOCH_MISMATCH: marker=${compatibility.storageEpoch} database=${databaseStorageEpoch}`,
        )
      }
      const server = new IpcServer(store)
      const proxy = new LegacyV1ProxyRouter(
        store,
        server.daemonInstanceId,
        (request) => server.handleRequest(request),
      )
      const guard = new LegacyV1GuardServer(proxy)
      await guard.listen(PREMIND_SOCKET_PATH)
      runtime = { server, guard }
    },
  })
  if (!runtime) throw new Error("LEGACY_GUARD_NOT_BOUND")
  const { server, guard } = runtime
  let daemonLease = server.store.claimDaemonInstanceLease({
    instanceId: server.daemonInstanceId,
    incarnationNonce: randomUUID(),
  })
  let coordinatorLease = server.store.claimCoordinatorLease(daemonLease)
  const github = new GitHubClient()
  const discoveryWatcher = new BranchDiscoveryWatcher(server.store, github, server.worktreeBindings)

  const recovery = server.store.recoverFromRestartAsCoordinator(coordinatorLease)
  logger.info("startup recovery", {
    prunedClients: recovery.prunedClients,
    resetBatches: recovery.resetBatches,
    dedupedSessions: recovery.dedupedSessions,
    recoveredSessions: recovery.recoveredSessions,
    recoveredBranchWatchers: recovery.recoveredBranchWatchers,
    recoveredPrWatchers: recovery.recoveredPrWatchers,
  })


  const suspendedAutomaticSubscriptions = server.store.withCoordinatorLease(
    coordinatorLease,
    () => server.store.suspendAutomaticSubscriptions(),
  )
  if (suspendedAutomaticSubscriptions > 0) {
    logger.info("suspended automatic subscriptions pending author verification", {
      suspendedAutomaticSubscriptions,
    })
  }
  const resetInferredPolicies = server.store.resetInferredSubscriptionPolicies()
  if (resetInferredPolicies > 0) {
    logger.info("reset inferred subscription authority pending verification", { resetInferredPolicies })
  }
  // Adaptive per-PR scheduling: active PRs poll every 20s; quiet PRs stretch to
  // 5 minutes. The registry reconstructs canonical actors from SQLite here.
  const prSchedule = new AdaptiveSchedule()
  const pullRequestWatcher = new PullRequestWatcher(server.store, github, { schedule: prSchedule })

  // Reap sessions whose last_activity_at is older than the staleness threshold.
  // Runs once at startup to clean up any backlog carried across daemon restarts,
  // and periodically while the daemon is up.
  const startupReap = server.store.withCoordinatorLease(
    coordinatorLease,
    () => server.store.reapStaleSessions(PREMIND_SESSION_STALE_MS),
  )
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
  const [startupPrunedSessions, startupPrunedEvents] = server.store.withCoordinatorLease(
    coordinatorLease,
    () => [
      server.store.pruneClosedSessions(PREMIND_CLOSED_SESSION_RETENTION_MS),
      server.store.pruneOrphanedPrEvents(),
    ] as const,
  )
  if (startupPrunedSessions > 0 || startupPrunedEvents > 0) {
    logger.info("startup prune", {
      prunedClosedSessions: startupPrunedSessions,
      prunedOrphanedEvents: startupPrunedEvents,
    })
  }

  // Run cache cleanup on startup.
  const detailFiles = new DetailFileWriter()
  const cleanedFiles = server.store.withCoordinatorLease(
    coordinatorLease,
    () => detailFiles.cleanup(),
  )
  if (cleanedFiles > 0) {
    logger.info("detail file cleanup", { removed: cleanedFiles })
  }

  await server.listen(PREMIND_MODERN_SOCKET_PATH)

  const discoveryScheduler = new PollScheduler(
    "branch-discovery",
    createDisableGatedTick("branch-discovery", server.store, async () => {
      server.store.withCoordinatorLease(coordinatorLease, () => true)
      await discoveryWatcher.tick()
    }, logger),
    { baseIntervalMs: 60_000, maxIntervalMs: 180_000, jitterFactor: 0.25 },
  )

  const prScheduler = new PollScheduler(
    "pr-watcher",
    createDisableGatedTick("pr-watcher", server.store, async () => {
      server.store.withCoordinatorLease(coordinatorLease, () => true)
      await pullRequestWatcher.tick()
    }, logger),
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


  if (!server.store.isGloballyDisabled()) {
    server.store.withCoordinatorLease(coordinatorLease, () => true)
    await discoveryWatcher.tick()
  }
  discoveryScheduler.start()
  prScheduler.start()

  const reapInterval = setInterval(() => {
    server.store.withCoordinatorLease(coordinatorLease, () => {
    const result = server.store.reapStaleSessions(PREMIND_SESSION_STALE_MS)
    server.worktreeBindings.closeInactiveSessions()
    const reclaimedHandoffs = server.store.expireStaleHandoffs()
    if (reclaimedHandoffs > 0) {
      logger.info("reclaimed abandoned reminder handoffs", {
        reclaimed: reclaimedHandoffs,
        thresholdMs: PREMIND_REMINDER_HANDOFF_STALE_MS,
      })
    }
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
    })
  }, STALENESS_SWEEP_INTERVAL_MS)
  if (typeof reapInterval.unref === "function") reapInterval.unref()

  let authorityStopping = false
  const authorityInterval = setInterval(() => {
    const renewedDaemon = server.store.renewDaemonInstanceLease(daemonLease)
    if (!renewedDaemon) {
      authorityStopping = true
      logger.error("daemon instance lease lost; self-demoting")
    } else {
      daemonLease = renewedDaemon
      const renewedCoordinator = server.store.renewCoordinatorLease(coordinatorLease)
      if (!renewedCoordinator) {
        authorityStopping = true
        logger.error("coordinator lease lost; self-demoting")
      } else {
        coordinatorLease = renewedCoordinator
      }
    }
    if (!authorityStopping) return
    clearInterval(authorityInterval)
    clearInterval(reapInterval)
    discoveryScheduler.stop()
    prScheduler.stop()
    pullRequestWatcher.close()
    void guard.close()
      .then(() => server.close(PREMIND_MODERN_SOCKET_PATH))
      .finally(() => process.exit(1))
  }, 10_000)
  if (typeof authorityInterval.unref === "function") authorityInterval.unref()

  const lifecycle = new DaemonLifecycleRuntime({
    hasDemand: () => server.hasDemand(),
    graceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
    onStopping: async (reason) => {
      clearInterval(reapInterval)
      clearInterval(authorityInterval)
      discoveryScheduler.stop()
      prScheduler.stop()
      pullRequestWatcher.close()
      await guard.close()
      server.store.releaseCoordinatorLease(coordinatorLease)
      server.store.releaseDaemonInstanceLease(daemonLease)
      logger.info("graceful shutdown", { reason })
      await server.close(PREMIND_MODERN_SOCKET_PATH)
    },
    onStopped: () => process.exit(0),
    onError: (error) => {
      logger.error("graceful shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    },
  })
  server.setDemandChangeListener(() => lifecycle.evaluateDemand())
  lifecycle.start()

  const cleanup = () => lifecycle.requestStop("signal")
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

void main().catch((error) => {
  logger.error("fatal error", { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
