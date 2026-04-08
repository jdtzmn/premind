import net from "node:net"
import { randomUUID } from "node:crypto"
import { PREMIND_PROTOCOL_VERSION, PREMIND_SOCKET_PATH } from "../shared/constants.js"
import {
  debugStatusResponseSchema,
  getPendingReminderResponseSchema,
  registerClientResponseSchema,
  responseSchema,
} from "../shared/ipc.js"
import type {
  AckReminderPayload,
  RegisterSessionPayload,
  UpdateSessionStatePayload,
} from "../shared/schema.js"

export class PremindDaemonClient {
  readonly clientId = randomUUID()

  async registerClient(projectRoot: string, sessionSource?: string) {
    const response = await this.request({
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
    return registerClientResponseSchema.parse(response)
  }

  async heartbeat() {
    await this.request({
      type: "heartbeatClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    })
  }

  async release() {
    await this.request({
      type: "releaseClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    })
  }

  async registerSession(payload: Omit<RegisterSessionPayload, "clientId">) {
    await this.request({
      type: "registerSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { ...payload, clientId: this.clientId },
    })
  }

  async updateSessionState(payload: UpdateSessionStatePayload) {
    await this.request({
      type: "updateSessionState",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
  }

  async unregisterSession(sessionId: string) {
    await this.request({
      type: "unregisterSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
  }

  async getPendingReminder(sessionId: string) {
    const response = await this.request({
      type: "getPendingReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    })
    return getPendingReminderResponseSchema.parse(response)
  }

  async ackReminder(payload: AckReminderPayload) {
    await this.request({
      type: "ackReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
  }

  async debugStatus() {
    const response = await this.request({
      type: "debugStatus",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    })
    return debugStatusResponseSchema.parse(response)
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
