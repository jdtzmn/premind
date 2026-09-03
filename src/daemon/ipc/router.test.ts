import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { PREMIND_PROTOCOL_VERSION } from "../../shared/constants.ts"
import { Router } from "./router.ts"
import { StateStore } from "../persistence/store.ts"

const tempPaths: string[] = []

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-router-test-"))
  tempPaths.push(dir)
  return new StateStore(path.join(dir, "premind.db"))
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const dir = tempPaths.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const controlRequest = (clientId: string) => ({
  type: "ensureSessionControl" as const,
  protocolVersion: PREMIND_PROTOCOL_VERSION as 1,
  payload: {
    clientId,
    sessionId: "session-1",
    repo: "acme/repo",
    branch: "feature/x",
    isPrimary: true,
    busyState: "idle" as const,
    paused: false,
  },
})

describe("ensureSessionControl router", () => {
  test("rejects control from an unknown client without creating a session", () => {
    const store = createStore()
    const response = new Router(store).handle(controlRequest("missing-client"))

    assert.deepEqual(response, {
      ok: false,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      error: {
        code: "CLIENT_NOT_FOUND",
        message: "Unknown client: missing-client",
      },
    })
    assert.equal(store.getSession("session-1"), undefined)
    store.close()
  })

  test("allows a registered client to attach and control its session", () => {
    const store = createStore()
    store.registerClient("client-1", { pid: 123, projectRoot: "/tmp/project" })

    const response = new Router(store).handle(controlRequest("client-1"))

    assert.deepEqual(response, {
      ok: true,
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      result: { attached: true, created: true, superseded: 0 },
    })
    assert.equal(store.getSession("session-1")?.client_id, "client-1")
    store.close()
  })
})
