import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  getCommandSessionId,
  isPremindPauseCommand,
  isPremindResumeCommand,
  isPremindStatusCommand,
  renderPremindStatus,
} from "../commands.js"

describe("plugin commands", () => {
  test("recognizes premind command names", () => {
    assert.equal(isPremindStatusCommand({ command: "premind-status" }), true)
    assert.equal(isPremindPauseCommand({ command: "premind-pause" }), true)
    assert.equal(isPremindResumeCommand({ command: "premind-resume" }), true)
    assert.equal(isPremindStatusCommand({ command: "other" }), false)
  })

  test("extracts session id and renders rich status output", () => {
    assert.equal(getCommandSessionId({ sessionID: "session-1" }), "session-1")
    assert.equal(getCommandSessionId({}), undefined)

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
