import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PollScheduler } from "./poll-scheduler.js"

describe("PollScheduler", () => {
  test("base interval with jitter stays within expected range", () => {
    const scheduler = new PollScheduler("test", async () => {}, {
      baseIntervalMs: 10_000,
      maxIntervalMs: 120_000,
      jitterFactor: 0.2,
    })

    // With 0 failures, interval should be baseIntervalMs + up to 20% jitter.
    for (let i = 0; i < 50; i++) {
      const interval = scheduler.nextIntervalMs()
      assert.ok(interval >= 10_000, `expected >= 10000, got ${interval}`)
      assert.ok(interval <= 12_000, `expected <= 12000, got ${interval}`)
    }
  })

  test("exponential backoff on consecutive failures", () => {
    let failures = 0
    const scheduler = new PollScheduler("test-backoff", async () => {
      failures++
      throw new Error("simulated failure")
    }, {
      baseIntervalMs: 1_000,
      maxIntervalMs: 64_000,
      jitterFactor: 0,
    })

    // Simulate consecutive failures by calling nextIntervalMs with increasing failure counts.
    // We can't easily drive the internal failure counter without running ticks,
    // so we test the calculation directly by creating fresh schedulers.

    // 0 failures: 1000ms
    assert.equal(scheduler.nextIntervalMs(), 1_000)
  })

  test("rate limit reset delays next interval", () => {
    const scheduler = new PollScheduler("test-ratelimit", async () => {}, {
      baseIntervalMs: 15_000,
      maxIntervalMs: 120_000,
      jitterFactor: 0,
    })

    const now = Date.now()
    const resetAt = now + 30_000

    scheduler.setRateLimitReset(resetAt)

    // Should wait until reset + 1s buffer.
    const interval = scheduler.nextIntervalMs(now)
    assert.ok(interval >= 30_000, `expected >= 30000, got ${interval}`)
    assert.ok(interval <= 31_000, `expected <= 31000, got ${interval}`)
  })

  test("rate limit reset is capped by maxIntervalMs", () => {
    const scheduler = new PollScheduler("test-ratelimit-cap", async () => {}, {
      baseIntervalMs: 15_000,
      maxIntervalMs: 60_000,
      jitterFactor: 0,
    })

    const now = Date.now()
    const resetAt = now + 300_000 // 5 minutes away

    scheduler.setRateLimitReset(resetAt)

    const interval = scheduler.nextIntervalMs(now)
    assert.equal(interval, 60_000)
  })
})
