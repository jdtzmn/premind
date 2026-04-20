import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { formatRelativeTime, renderPremindStatus } from "../commands.ts"

describe("plugin commands", () => {
  test("renders rich status output", () => {
    const rendered = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      activeClients: 1,
      activeSessions: 2,
      activeWatchers: 1,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [
        {
          sessionId: "session-1",
          repo: "acme/repo",
          branch: "feature/x",
          prNumber: 42,
          status: "active",
          busyState: "idle",
          pendingReminderCount: 3,
        },
      ],
    })

    assert.match(rendered, /premind status/)
    assert.match(rendered, /session session-1: acme\/repo @ feature\/x \(PR #42\) \| active\/idle \| pending 3/)
    // When not disabled, the disabled line should not appear.
    assert.ok(!/globally disabled/.test(rendered))
  })

  test("shows globally-disabled banner when flag is set", () => {
    const rendered = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      globallyDisabled: true,
      activeClients: 1,
      activeSessions: 1,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [],
    })

    assert.match(rendered, /premind status/)
    assert.match(rendered, /globally disabled: yes/)
    assert.match(rendered, /no GitHub polling/)
  })

  test("omits globally-disabled banner when flag is false or missing", () => {
    const renderedFalse = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      globallyDisabled: false,
      activeClients: 0,
      activeSessions: 0,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [],
    })
    assert.ok(!/globally disabled/.test(renderedFalse))

    const renderedMissing = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      activeClients: 0,
      activeSessions: 0,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [],
    })
    assert.ok(!/globally disabled/.test(renderedMissing))
  })

  test("renders 'last reap: never' when lastReapAt is null", () => {
    const rendered = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      activeClients: 0,
      activeSessions: 0,
      activeWatchers: 0,
      lastReapAt: null,
      lastReapCount: 0,
      sessions: [],
    })
    assert.match(rendered, /- last reap: never/)
  })

  test("renders 'last reap' with relative time and reaped count", () => {
    const now = 10_000_000_000
    const threeMinAgo = now - 3 * 60 * 1000
    const rendered = renderPremindStatus(
      {
        daemon: { protocolVersion: 1 },
        activeClients: 1,
        activeSessions: 5,
        activeWatchers: 1,
        lastReapAt: threeMinAgo,
        lastReapCount: 7,
        sessions: [],
      },
      now,
    )
    assert.match(rendered, /- last reap: 3 minutes ago \(7 reaped\)/)
  })
})

describe("formatRelativeTime", () => {
  const now = 10_000_000_000

  test("seconds ago", () => {
    assert.equal(formatRelativeTime(now - 30 * 1000, now), "30 seconds ago")
  })

  test("minutes ago", () => {
    assert.equal(formatRelativeTime(now - 5 * 60 * 1000, now), "5 minutes ago")
  })

  test("hours ago", () => {
    assert.equal(formatRelativeTime(now - 2 * 60 * 60 * 1000, now), "2 hours ago")
  })

  test("days ago (uses 'yesterday' for 1 day with numeric: auto)", () => {
    assert.equal(formatRelativeTime(now - 24 * 60 * 60 * 1000, now), "yesterday")
  })

  test("boundary — exactly at a unit threshold picks that unit", () => {
    // Exactly 60s → 1 minute ago.
    assert.equal(formatRelativeTime(now - 60 * 1000, now), "1 minute ago")
    // Exactly 3600s → 1 hour ago.
    assert.equal(formatRelativeTime(now - 60 * 60 * 1000, now), "1 hour ago")
  })

  test("future timestamp formats with 'in ...' prefix", () => {
    const result = formatRelativeTime(now + 5 * 60 * 1000, now)
    assert.match(result, /in 5 minutes/)
  })

  test("zero diff returns 'now'", () => {
    // With numeric: "auto", Intl renders 0 seconds as "now".
    assert.equal(formatRelativeTime(now, now), "now")
  })
})
