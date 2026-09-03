import { diffSnapshot, stableMergeStateStatus } from "../github/diff.ts"
import type { GitHubClientLike } from "../github/client.ts"
import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"
import { AdaptiveSchedule } from "./adaptive-schedule.ts"
import { PrWatcherRegistry, type PrWatcherRegistryOptions } from "./pr-watcher-registry.ts"

const PR_SNAPSHOT_ETAG_SCOPE = "pr.snapshot"
const etagKey = (repo: string, prNumber: number) => `${repo}#${prNumber}`
const targetKey = etagKey

export type PullRequestWatcherOptions = PrWatcherRegistryOptions & {
  /**
   * Adaptive per-PR scheduler. If omitted, every polling actor is immediately
   * eligible after a successful check (useful for tests that drive ticks).
   */
  schedule?: AdaptiveSchedule | null
}

export class PullRequestWatcher {
  private readonly logger = createLogger("daemon.pr-watcher")
  private readonly schedule: AdaptiveSchedule | null
  readonly registry: PrWatcherRegistry

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClientLike,
    options: PullRequestWatcherOptions = {},
  ) {
    this.schedule = options.schedule ?? null
    this.registry = new PrWatcherRegistry(store, options)
  }

  getWatcherSnapshot(repo: string, prNumber: number) {
    return this.registry.getSnapshot(repo, prNumber)
  }

  setRateLimitReset(resetAtMs: number, now = Date.now()): void {
    this.registry.rateLimit(resetAtMs, now)
  }

  close(): void {
    this.registry.close()
  }

  async tick(now = Date.now()) {
    const targets = this.registry.pollingTargets(now)
    for (const target of targets) {
      const key = targetKey(target.repo, target.prNumber)

      try {
        const previous = this.store.getSnapshot(target.repo, target.prNumber)
        const cachedEtag = this.store.getEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.prNumber))
        const result = await this.github.fetchPullRequestSnapshot(target.repo, target.prNumber, {
          etag: cachedEtag,
        })

        this.store.markPrWatchChecked(target.repo, target.prNumber, now)
        this.schedule?.recordCheck(key, now)

        if (result.kind === "not_modified") {
          if (result.etag && result.etag !== cachedEtag) {
            this.store.saveEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.prNumber), result.etag, now)
          }
          this.registry.recordPollSucceeded(target.repo, target.prNumber, this.nextPollAt(key, now), now)
          continue
        }

        if (result.kind === "not_found") {
          this.logger.info("pr not found; skipping", { repo: target.repo, prNumber: target.prNumber })
          this.registry.recordPollSucceeded(target.repo, target.prNumber, this.nextPollAt(key, now), now)
          continue
        }

        const stableMergeState = stableMergeStateStatus(result.snapshot.core.mergeStateStatus)
        const next = {
          ...result.snapshot,
          core: {
            ...result.snapshot.core,
            lastStableMergeStateStatus:
              stableMergeState ??
              previous?.core.lastStableMergeStateStatus ??
              stableMergeStateStatus(previous?.core.mergeStateStatus),
          },
        }
        const events = diffSnapshot(previous, next)
        const terminal = ["MERGED", "CLOSED"].includes(next.core.state.toUpperCase())

        if (terminal) {
          this.store.saveTerminalSnapshotAndEvents(
            target.repo,
            target.prNumber,
            next,
            events,
            result.etag,
            now,
          )
          this.registry.recordTerminalPersisted(target.repo, target.prNumber, now)
        } else {
          this.store.saveSnapshotAndEvents(target.repo, target.prNumber, next, events, now)
          this.store.saveEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.prNumber), result.etag, now)
          if (events.length > 0) this.schedule?.recordActivity(key, now)
          this.registry.recordPollSucceeded(target.repo, target.prNumber, this.nextPollAt(key, now), now)
        }

        for (const subscription of this.store.listActiveSubscriptionsForPr(target.repo, target.prNumber)) {
          this.store.buildReminderBatchForSubscription(subscription.subscriptionId, now)
        }
      } catch (error) {
        this.registry.recordPollFailure(target.repo, target.prNumber, error, now)
        this.logger.warn("pr watcher failed", {
          repo: target.repo,
          prNumber: target.prNumber,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private nextPollAt(key: string, now: number): number {
    return this.schedule ? now + this.schedule.currentInterval(key, now) : now
  }
}
