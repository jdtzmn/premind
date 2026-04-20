import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { RateLimitTracker } from "./ratelimit.ts"

const makeHeaders = (entries: Record<string, string>) => {
  const map = new Map<string, string>(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    get(name: string) {
      return map.get(name.toLowerCase()) ?? null
    },
  }
}

describe("RateLimitTracker", () => {
  test("ingests standard GitHub rate-limit headers for the core bucket", () => {
    const tracker = new RateLimitTracker()
    const now = 1_700_000_000_000
    const resetSec = Math.floor(now / 1000) + 3600

    const snapshot = tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "core",
      }),
      now,
    )

    assert.ok(snapshot)
    assert.equal(snapshot!.limit, 5000)
    assert.equal(snapshot!.remaining, 4999)
    assert.equal(snapshot!.resetAtMs, resetSec * 1000)
    assert.equal(snapshot!.resource, "core")
    assert.equal(tracker.getSnapshot("core")?.remaining, 4999)
  })

  test("tracks graphql bucket independently from core", () => {
    const tracker = new RateLimitTracker()
    const now = 1_700_000_000_000
    const resetSec = Math.floor(now / 1000) + 60

    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4000",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "core",
      }),
      now,
    )
    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "graphql",
      }),
      now,
    )

    assert.equal(tracker.getSnapshot("core")?.remaining, 4000)
    assert.equal(tracker.getSnapshot("graphql")?.remaining, 10)
  })

  test("returns null when required headers are missing", () => {
    const tracker = new RateLimitTracker()
    const snapshot = tracker.ingest(makeHeaders({ "x-ratelimit-limit": "5000" }))
    assert.equal(snapshot, null)
    assert.equal(tracker.getSnapshot("core"), null)
  })

  test("isThrottled becomes true once remaining drops below 10% of limit", () => {
    const tracker = new RateLimitTracker()
    const now = 1_700_000_000_000
    const resetSec = Math.floor(now / 1000) + 600

    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "500",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "core",
      }),
      now,
    )
    assert.equal(tracker.isThrottled("core", now), true)

    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "501",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "core",
      }),
      now,
    )
    assert.equal(tracker.isThrottled("core", now), false)
  })

  test("isThrottled is false after reset time has passed", () => {
    const tracker = new RateLimitTracker()
    const now = 1_700_000_000_000
    const resetSec = Math.floor(now / 1000) - 10

    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "core",
      }),
      now,
    )
    assert.equal(tracker.isThrottled("core", now), false)
  })

  test("recordRetryAfter sets remaining to 0 and resetAt to now + retryAfter", () => {
    const tracker = new RateLimitTracker()
    const now = 1_700_000_000_000
    tracker.recordRetryAfter("core", 30, now)
    const snapshot = tracker.getSnapshot("core")
    assert.ok(snapshot)
    assert.equal(snapshot!.remaining, 0)
    assert.equal(snapshot!.resetAtMs, now + 30_000)
    assert.equal(tracker.isThrottled("core", now), true)
  })

  test("onUpdate fires for each successful ingest", () => {
    const tracker = new RateLimitTracker()
    const snapshots: number[] = []
    const off = tracker.onUpdate((snapshot) => {
      snapshots.push(snapshot.remaining)
    })

    const resetSec = Math.floor(Date.now() / 1000) + 60
    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4000",
        "x-ratelimit-reset": String(resetSec),
      }),
    )
    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "3999",
        "x-ratelimit-reset": String(resetSec),
      }),
    )
    off()
    tracker.ingest(
      makeHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "3998",
        "x-ratelimit-reset": String(resetSec),
      }),
    )
    assert.deepEqual(snapshots, [4000, 3999])
  })
})
