/**
 * An OpenCode session must survive its daemon session lease expiring.
 *
 * Mirrors src/extension/__tests__/stale-session-lease.test.ts: the real plugin,
 * client, socket, router, and store, with only the clock moved past the lease.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, mock, test } from "node:test"
import { PremindDaemonClient } from "../../client/daemon-client.ts"
import { IpcServer } from "../../daemon/ipc/server.ts"
import { StateStore } from "../../daemon/persistence/store.ts"
import { PREMIND_CLIENT_LEASE_TTL_MS } from "../../shared/constants.ts"
import { createPremindPlugin } from "../index.ts"

const SESSION_ID = "opencode-stale-lease"
const THRESHOLD_MS = 50
const tempDirs: string[] = []

afterEach(() => {
  mock.timers.reset()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("OpenCode session lease expiry", () => {
  test("idle delivery recovers after the session lease expires", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() })
    const dir = fs.mkdtempSync("/tmp/premind-opencode-stale-lease-")
    tempDirs.push(dir)
    const socketPath = path.join(dir, "premind.sock")
    const server = new IpcServer(new StateStore(path.join(dir, "state.db")))
    await server.listen(socketPath)
    const daemon = new PremindDaemonClient({ host: "opencode", socketPath, ensureDaemon: async () => {} })
    const prompts: string[] = []
    try {
      const plugin = await createPremindPlugin({
        createDaemonClient: () => daemon,
        detectGit: async () => ({ repo: "acme/repo", branch: "feature/lease" }),
        ensureDaemon: async () => {},
        idleDeliveryThresholdMs: THRESHOLD_MS,
      })({
        directory: process.cwd(),
        worktree: process.cwd(),
        client: {
          session: {
            get: async () => ({ data: {} }),
            prompt: async () => {},
            promptAsync: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
              prompts.push(body.parts[0]!.text)
              return {}
            },
          },
          tui: { showToast: async () => undefined },
        },
      } as never)
      const runtime = plugin as unknown as {
        config: (input: Record<string, unknown>) => Promise<void>
        event: (input: { event: unknown }) => Promise<void>
      }
      await runtime.config({})
      const fire = (type: string) =>
        runtime.event({ event: { type, properties: { sessionID: SESSION_ID } } })

      await fire("session.created")
      await fire("session.idle")
      await sleep(THRESHOLD_MS * 3)
      assert.deepEqual(prompts, [])

      server.store.upsertSubscription({ sessionId: SESSION_ID, repo: "acme/repo", prNumber: 13, source: "manual" })
      server.store.insertEvents("acme/repo", 13, [
        { dedupeKey: "comment:1", kind: "issue_comment.created", priority: "high", summary: "New review comment", payload: {} },
      ])

      // No renewal reaches the daemon for longer than the lease lifetime.
      mock.timers.tick(PREMIND_CLIENT_LEASE_TTL_MS + 1_000)
      await fire("session.idle")
      await sleep(THRESHOLD_MS * 3)

      assert.equal(prompts.length, 1)
      assert.match(prompts[0]!, /acme\/repo#13/)
    } finally {
      await daemon.release().catch(() => {})
      await server.close(socketPath)
    }
  })
})
