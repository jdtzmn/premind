/**
 * Per-target adaptive scheduling.
 *
 * Decides how long to wait between polls for a single resource (a PR, or a
 * branch) based on recent observed activity. Active resources poll at the
 * configured `activeIntervalMs`; quieter resources stretch toward `idleIntervalMs`.
 *
 * Tiers (default activity thresholds):
 *   activity within 2 minutes  -> activeIntervalMs (20s by default)
 *   activity within 10 minutes -> 45s
 *   activity within 1 hour     -> 2 minutes
 *   otherwise                  -> idleIntervalMs (5 minutes)
 *
 * Any call to `recordActivity()` immediately snaps the tier back to active.
 */

export type AdaptiveScheduleOptions = {
  activeIntervalMs?: number
  idleIntervalMs?: number
  /** Tier thresholds in ms since last activity, paired with the interval to use while inside that tier. */
  tiers?: Array<{ sinceMs: number; intervalMs: number }>
}

const DEFAULT_TIERS = [
  { sinceMs: 2 * 60_000, intervalMs: 20_000 },
  { sinceMs: 10 * 60_000, intervalMs: 45_000 },
  { sinceMs: 60 * 60_000, intervalMs: 120_000 },
]

const DEFAULT_IDLE_INTERVAL_MS = 5 * 60_000

export class AdaptiveSchedule {
  private readonly lastActivityAt = new Map<string, number>()
  private readonly lastCheckedAt = new Map<string, number>()
  private readonly tiers: Array<{ sinceMs: number; intervalMs: number }>
  private readonly idleIntervalMs: number

  constructor(options: AdaptiveScheduleOptions = {}) {
    this.tiers = options.tiers
      ? [...options.tiers].sort((a, b) => a.sinceMs - b.sinceMs)
      : [...DEFAULT_TIERS]
    this.idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS
  }

  /** Record that the target produced new events or was first seen. */
  recordActivity(key: string, now = Date.now()) {
    this.lastActivityAt.set(key, now)
  }

  /**
   * Called each time the watcher *considers* the target. The last-checked
   * timestamp is what we compare against the interval to decide whether to
   * actually fetch. Call this whether or not the fetch succeeded.
   */
  recordCheck(key: string, now = Date.now()) {
    this.lastCheckedAt.set(key, now)
  }

  /**
   * Returns true if this target is due for a real fetch. If no activity has
   * ever been observed we always return true (first sighting).
   */
  shouldFetch(key: string, now = Date.now()): boolean {
    const lastChecked = this.lastCheckedAt.get(key)
    if (lastChecked === undefined) return true
    const interval = this.currentInterval(key, now)
    return now - lastChecked >= interval
  }

  /** The interval currently applied to this target based on tiered activity. */
  currentInterval(key: string, now = Date.now()): number {
    const lastActivity = this.lastActivityAt.get(key)
    if (lastActivity === undefined) return this.tiers[0]?.intervalMs ?? this.idleIntervalMs
    const sinceActivity = now - lastActivity
    for (const tier of this.tiers) {
      if (sinceActivity <= tier.sinceMs) return tier.intervalMs
    }
    return this.idleIntervalMs
  }

  forget(key: string) {
    this.lastActivityAt.delete(key)
    this.lastCheckedAt.delete(key)
  }
}
