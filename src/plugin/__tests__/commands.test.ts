import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { renderPremindStatus } from "../commands.ts"

describe("plugin commands", () => {
  test("renders rich status output", () => {
    const rendered = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      activeClients: 1,
      activeSessions: 2,
      activeWatchers: 1,
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
      sessions: [],
    })
    assert.ok(!/globally disabled/.test(renderedFalse))

    const renderedMissing = renderPremindStatus({
      daemon: { protocolVersion: 1 },
      activeClients: 0,
      activeSessions: 0,
      activeWatchers: 0,
      sessions: [],
    })
    assert.ok(!/globally disabled/.test(renderedMissing))
  })
})
