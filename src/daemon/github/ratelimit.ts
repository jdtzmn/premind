import { createLogger } from "../logging/logger.ts"

/**
 * Tracks GitHub rate-limit state parsed from response headers.
 *
 * Two independent buckets are tracked:
 * - `core`: REST API calls outside the search and GraphQL budgets.
 * - `graphql`: GraphQL POST /graphql.
 *
 * Both share the same header schema; GitHub reports the bucket via the
 * `X-RateLimit-Resource` response header.
 */
export type RateLimitResource = "core" | "graphql" | "search" | "other"

export type RateLimitSnapshot = {
  limit: number
  remaining: number
  resetAtMs: number
  resource: RateLimitResource
  updatedAtMs: number
}

export type RateLimitListener = (snapshot: RateLimitSnapshot) => void

const parseIntHeader = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeResource = (value: string | null | undefined): RateLimitResource => {
  const normalized = (value ?? "core").toLowerCase()
  if (normalized === "graphql") return "graphql"
  if (normalized === "search") return "search"
  if (normalized === "core") return "core"
  return "other"
}

export class RateLimitTracker {
  private readonly logger = createLogger("daemon.github.ratelimit")
  private readonly snapshots = new Map<RateLimitResource, RateLimitSnapshot>()
  private readonly listeners = new Set<RateLimitListener>()
  /**
   * Fraction of `limit` at or below which we consider ourselves in the
   * "throttle zone" and the poll scheduler should back off.
   */
  private readonly throttleThreshold = 0.1

  /**
   * Parse headers from a GitHub API response.
   *
   * Accepts a `Headers` instance (browser/Node fetch) or any object with a
   * `.get(name)` method returning string | null.
   */
  ingest(headers: Pick<Headers, "get">, now = Date.now()): RateLimitSnapshot | null {
    const limit = parseIntHeader(headers.get("x-ratelimit-limit"))
    const remaining = parseIntHeader(headers.get("x-ratelimit-remaining"))
    const resetSeconds = parseIntHeader(headers.get("x-ratelimit-reset"))
    if (limit === null || remaining === null || resetSeconds === null) return null

    const resource = normalizeResource(headers.get("x-ratelimit-resource"))
    const snapshot: RateLimitSnapshot = {
      limit,
      remaining,
      resource,
      resetAtMs: resetSeconds * 1000,
      updatedAtMs: now,
    }
    this.snapshots.set(resource, snapshot)
    this.fanout(snapshot)
    return snapshot
  }

  /**
   * Record an explicit retry-after hint (used when GitHub returns a 403/429
   * with a Retry-After header instead of rate-limit headers). Stored against
   * the given resource bucket.
   */
  recordRetryAfter(resource: RateLimitResource, retryAfterSeconds: number, now = Date.now()) {
    const resetAtMs = now + Math.max(0, retryAfterSeconds) * 1000
    const existing = this.snapshots.get(resource)
    const snapshot: RateLimitSnapshot = {
      limit: existing?.limit ?? 0,
      remaining: 0,
      resource,
      resetAtMs,
      updatedAtMs: now,
    }
    this.snapshots.set(resource, snapshot)
    this.logger.warn("retry-after observed", { resource, retryAfterSeconds, resetAtMs })
    this.fanout(snapshot)
  }

  /** Returns the most recent snapshot for a resource bucket, or null. */
  getSnapshot(resource: RateLimitResource): RateLimitSnapshot | null {
    return this.snapshots.get(resource) ?? null
  }

  /** True when `remaining` is at or below `threshold * limit` for the bucket. */
  isThrottled(resource: RateLimitResource, now = Date.now()): boolean {
    const snapshot = this.snapshots.get(resource)
    if (!snapshot) return false
    if (snapshot.resetAtMs <= now) return false
    if (snapshot.limit <= 0) return snapshot.remaining <= 0
    return snapshot.remaining <= Math.max(1, Math.floor(snapshot.limit * this.throttleThreshold))
  }

  /**
   * Returns the UTC ms timestamp when the given resource will reset, or null
   * when no recent observation exists. Useful to hand to PollScheduler.
   */
  resetAt(resource: RateLimitResource): number | null {
    return this.snapshots.get(resource)?.resetAtMs ?? null
  }

  onUpdate(listener: RateLimitListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private fanout(snapshot: RateLimitSnapshot) {
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.logger.warn("ratelimit listener failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
