import { createLogger } from "../logging/logger.js"

type PollSchedulerOptions = {
  /** Base interval in ms between successful ticks. */
  baseIntervalMs: number
  /** Maximum interval in ms after repeated failures. */
  maxIntervalMs: number
  /** Jitter factor: 0 = no jitter, 1 = up to 100% of interval added. */
  jitterFactor: number
}

const DEFAULT_OPTIONS: PollSchedulerOptions = {
  baseIntervalMs: 15_000,
  maxIntervalMs: 120_000,
  jitterFactor: 0.2,
}

export class PollScheduler {
  private readonly logger = createLogger("daemon.poll-scheduler")
  private consecutiveFailures = 0
  private rateLimitResetAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly options: PollSchedulerOptions

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<void>,
    options: Partial<PollSchedulerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  start() {
    this.scheduleNext()
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Call this if a tick received a GitHub rate-limit reset timestamp. */
  setRateLimitReset(resetAtMs: number) {
    this.rateLimitResetAt = resetAtMs
  }

  nextIntervalMs(now = Date.now()) {
    // If rate-limited, wait until the reset time plus a small buffer.
    if (this.rateLimitResetAt !== null && this.rateLimitResetAt > now) {
      const waitMs = this.rateLimitResetAt - now + 1_000
      return Math.min(waitMs, this.options.maxIntervalMs)
    }

    // Exponential backoff on consecutive failures.
    const backoffMultiplier = Math.pow(2, Math.min(this.consecutiveFailures, 6))
    const interval = Math.min(this.options.baseIntervalMs * backoffMultiplier, this.options.maxIntervalMs)

    // Add jitter.
    const jitter = interval * this.options.jitterFactor * Math.random()
    return Math.round(interval + jitter)
  }

  private scheduleNext() {
    const intervalMs = this.nextIntervalMs()
    this.timer = setTimeout(async () => {
      try {
        await this.tick()
        this.consecutiveFailures = 0
        // Clear rate limit if we're past the reset time.
        if (this.rateLimitResetAt !== null && Date.now() >= this.rateLimitResetAt) {
          this.rateLimitResetAt = null
        }
      } catch (error) {
        this.consecutiveFailures++
        this.logger.warn(`${this.name} tick failed`, {
          consecutiveFailures: this.consecutiveFailures,
          nextIntervalMs: this.nextIntervalMs(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
      this.scheduleNext()
    }, intervalMs)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }
}
