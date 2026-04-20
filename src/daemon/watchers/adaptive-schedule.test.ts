import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AdaptiveSchedule } from "./adaptive-schedule.ts"

describe("AdaptiveSchedule", () => {
  test("first check is always due", () => {
    const schedule = new AdaptiveSchedule()
    assert.equal(schedule.shouldFetch("pr:42"), true)
  })

  test("records a check and enforces the active interval before the next fetch", () => {
    const schedule = new AdaptiveSchedule({ idleIntervalMs: 300_000 })
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now)
    schedule.recordCheck("pr:42", now)

    assert.equal(schedule.shouldFetch("pr:42", now + 1_000), false, "active tier still locked")
    assert.equal(schedule.shouldFetch("pr:42", now + 19_999), false)
    assert.equal(schedule.shouldFetch("pr:42", now + 20_000), true, "20s active tier elapsed")
  })

  test("drops to the 45s tier after 2 minutes of silence", () => {
    const schedule = new AdaptiveSchedule()
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now)
    schedule.recordCheck("pr:42", now)

    const afterQuietPeriod = now + 2 * 60_000 + 1
    assert.equal(schedule.currentInterval("pr:42", afterQuietPeriod), 45_000)
  })

  test("drops to the 2-minute tier after 10 minutes of silence", () => {
    const schedule = new AdaptiveSchedule()
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now)
    schedule.recordCheck("pr:42", now)

    const afterQuietPeriod = now + 10 * 60_000 + 1
    assert.equal(schedule.currentInterval("pr:42", afterQuietPeriod), 120_000)
  })

  test("falls back to idleIntervalMs after 1 hour of silence", () => {
    const schedule = new AdaptiveSchedule({ idleIntervalMs: 600_000 })
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now)
    schedule.recordCheck("pr:42", now)

    const afterQuietPeriod = now + 60 * 60_000 + 1
    assert.equal(schedule.currentInterval("pr:42", afterQuietPeriod), 600_000)
  })

  test("recordActivity resets to the active tier immediately", () => {
    const schedule = new AdaptiveSchedule()
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now - 60 * 60_000)
    schedule.recordCheck("pr:42", now - 60 * 60_000)
    // Now we're in the idle tier.
    assert.ok(schedule.currentInterval("pr:42", now) >= 120_000)

    // Real activity lands.
    schedule.recordActivity("pr:42", now)
    assert.equal(schedule.currentInterval("pr:42", now + 1), 20_000)
  })

  test("forget clears state for a key", () => {
    const schedule = new AdaptiveSchedule()
    const now = 1_700_000_000_000
    schedule.recordActivity("pr:42", now)
    schedule.recordCheck("pr:42", now)
    schedule.forget("pr:42")
    assert.equal(schedule.shouldFetch("pr:42", now + 1_000), true)
  })
})
