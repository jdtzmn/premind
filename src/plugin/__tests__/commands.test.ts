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
  })
})
