import net from "node:net"
import { randomUUID } from "node:crypto"
import { PREMIND_PROTOCOL_VERSION, PREMIND_SOCKET_PATH } from "../shared/constants.ts"
import {
  debugStatusResponseSchema,
  getPendingReminderResponseSchema,
  registerClientResponseSchema,
  responseSchema,
} from "../shared/ipc.ts"
import type {
  AckReminderPayload,
  RegisterSessionPayload,
  UpdateSessionStatePayload,
} from "../shared/schema.ts"
import { ensureDaemonRunning } from "./daemon-launcher.ts"

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

export class PremindDaemonClient {
  readonly clientId = randomUUID()
  private registered = false
  private projectRoot?: string
  private sessionSource?: string

  async registerClient(projectRoot: string, sessionSource?: string) {
    this.projectRoot = projectRoot
    this.sessionSource = sessionSource
    const response = await this.requestWithRetry({
      type: "registerClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        clientId: this.clientId,
        metadata: {
          pid: process.pid,
          projectRoot,
          sessionSource,
        },
      },
    })
    this.registered = true
    return registerClientResponseSchema.parse(response)
  }

  async heartbeat() {
    await this.requestWithRetry({
      type: "heartbeatClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    })
  }

  async release() {
    await this.requestWithRetry({
      type: "releaseClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    })
    this.registered = false
  }

  async registerSession(payload: Omit<RegisterSessionPayload, "clientId">) {
    await this.requestWithRetry({
      type: "registerSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { ...payload, clientId: this.clientId },
    })
  }

  async updateSessionState(payload: UpdateSessionStatePayload) {
    await this.requestWithRetry({
      type: "updateSessionState",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
  }

  async unregisterSession(sessionId: string) {
    await this.requestWithRetry({
      type: "unregisterSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
  }

  async pauseSession(sessionId: string) {
    await this.requestWithRetry({
      type: "pauseSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
  }

  async resumeSession(sessionId: string) {
    await this.requestWithRetry({
      type: "resumeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
  }

  async getPendingReminder(sessionId: string) {
    const response = await this.requestWithRetry({
      type: "getPendingReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
    return getPendingReminderResponseSchema.parse(response)
  }

  async ackReminder(payload: AckReminderPayload) {
    await this.requestWithRetry({
      type: "ackReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
  }

  async debugStatus() {
    const response = await this.requestWithRetry({
      type: "debugStatus",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    })
    return debugStatusResponseSchema.parse(response)
  }

  private async requestWithRetry(message: unknown, attempt = 0): Promise<unknown> {
    try {
      return await this.request(message)
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error

      const isSocketError =
        error instanceof Error &&
        ("code" in error || error.message.includes("ECONNREFUSED") || error.message.includes("ENOENT"))

      if (!isSocketError) throw error

      // Daemon may have restarted or crashed. Try to bring it back.
      try {
        await ensureDaemonRunning()
      } catch {
        // If we can't start it, fall through to retry anyway.
      }

      // If we were previously registered, re-register after daemon restart.
      if (this.registered && this.projectRoot) {
        try {
          await this.request({
            type: "registerClient",
            protocolVersion: PREMIND_PROTOCOL_VERSION,
            payload: {
              clientId: this.clientId,
              metadata: {
                pid: process.pid,
                projectRoot: this.projectRoot,
                sessionSource: this.sessionSource,
              },
            },
          })
        } catch {
          // Re-registration failed, will retry the original request.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)))
      return this.requestWithRetry(message, attempt + 1)
    }
  }

  private async request(message: unknown) {
    const line = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(PREMIND_SOCKET_PATH)
      let buffer = ""

      socket.setEncoding("utf8")
      socket.once("error", reject)
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(message)}\n`)
      })
      socket.on("data", (chunk) => {
        buffer += chunk
        const newlineIndex = buffer.indexOf("\n")
        if (newlineIndex >= 0) {
          const result = buffer.slice(0, newlineIndex)
          socket.end()
          resolve(result)
        }
      })
    })

    const parsed = responseSchema.parse(JSON.parse(line))
    if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
    return parsed.result
  }
}
