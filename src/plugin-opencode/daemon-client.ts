import net from "node:net"
import { randomUUID } from "node:crypto"
import { PREMIND_PROTOCOL_VERSION, PREMIND_SOCKET_PATH } from "../shared/constants.ts"
import {
  ackReminderBundleResponseSchema,
  activateWorktreeResponseSchema,
  getPendingReminderResponseSchema,
  globalDisabledResponseSchema,
  registerClientResponseSchema,
  responseSchema,
  subscribeResponseSchema,
  unsubscribeResponseSchema,
} from "../shared/ipc.ts"
import { bootstrapResponseSchema } from "../shared/protocol/bootstrap.ts"
import { PROTOCOL_V2, protocolV2ResponseSchema } from "../shared/protocol/v2.ts"
import {
  decodeV1ClaimReminderBundleResponse,
  decodeV1DebugStatusResponse,
  isV1UnsupportedOperation,
} from "../shared/protocol/v1.ts"
import type {
  AckReminderPayload,
  AckReminderBundlePayload,
  ActivateWorktreePayload,
  EnsureSessionControlPayload,
  RegisterSessionPayload,
  SessionHost,
  SubscribePayload,
  UnsubscribePayload,
  UpdateSessionStatePayload,
} from "../shared/schema.ts"
import { PREMIND_COMMIT, PREMIND_VERSION } from "../shared/version.ts"
import { ensureDaemonRunning } from "./daemon-launcher.ts"

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

type PremindDaemonClientOptions = {
  host?: SessionHost
  socketPath?: string
}

export class PremindDaemonClient {
  readonly clientId = randomUUID()
  private readonly host: SessionHost
  private readonly socketPath: string
  private protocolVersion: 1 | typeof PROTOCOL_V2 = PREMIND_PROTOCOL_VERSION
  private initialized = false

  constructor(options: PremindDaemonClientOptions = {}) {
    this.host = options.host ?? "opencode"
    this.socketPath = options.socketPath ?? PREMIND_SOCKET_PATH
  }

  get selectedProtocolVersion() {
    return this.protocolVersion
  }
  private registered = false
  private projectRoot?: string
  private sessionSource?: string

  private readonly legacyBundleClaims = new Map<
    string,
    {
      handoffId: string
      batchIds: string[]
      mode: "single" | "legacy-bundle"
    }
  >()
  async registerClient(projectRoot: string, sessionSource?: string) {
    await this.initializeProtocol()
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

  async ensureSessionControl(
    payload: Omit<EnsureSessionControlPayload, "clientId">,
  ) {
    try {
      await this.requestWithRetry({
        type: "ensureSessionControl",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { ...payload, clientId: this.clientId },
      })
    } catch (error) {
      // A long-lived daemon from a pre-control-operation package reports the new
      // request as BAD_REQUEST. Fall back to its compatible registration path so
      // clients keep working until that daemon exits naturally.
      if (!isV1UnsupportedOperation(error)) throw error
      const { paused, ...session } = payload
      await this.registerSession({
        ...session,
        status: paused ? "paused" : "active",
      })
    }
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

  async activateWorktree(payload: ActivateWorktreePayload) {
    const response = await this.requestWithRetry({
      type: "activateWorktree",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
    return activateWorktreeResponseSchema.parse(response)
  }

  async subscribe(payload: SubscribePayload) {
    const response = await this.requestWithRetry({
      type: "subscribe",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
    return subscribeResponseSchema.parse(response)
  }

  async unsubscribe(payload: UnsubscribePayload) {
    const response = await this.requestWithRetry({
      type: "unsubscribe",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    })
    return unsubscribeResponseSchema.parse(response)
  }

  async claimReminderBundle(sessionId: string) {
    try {
      const response = await this.requestWithRetry({
        type: "claimReminderBundle",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId },
      })
      const decoded = decodeV1ClaimReminderBundleResponse(response)
      if (decoded.variant === "tokenized") return decoded.response
      if (decoded.response.batches.length === 0) return { bundle: null }
      const handoffId = randomUUID()
      this.legacyBundleClaims.set(sessionId, {
        handoffId,
        batchIds: decoded.response.batches.map(({ batchId }) => batchId),
        mode: "legacy-bundle",
      })
      return { bundle: { handoffId, batches: decoded.response.batches } }
    } catch (error) {
      if (!isV1UnsupportedOperation(error)) throw error
      const pending = await this.getPendingReminder(sessionId)
      if (!pending.batch) return { bundle: null }

      await this.ackReminder({
        batchId: pending.batch.batchId,
        sessionId,
        state: "handed_off",
      })
      const handoffId = randomUUID()
      this.legacyBundleClaims.set(sessionId, {
        handoffId,
        batchIds: [pending.batch.batchId],
        mode: "single",
      })
      return { bundle: { handoffId, batches: [pending.batch] } }
    }
  }

  async ackReminderBundle(payload: AckReminderBundlePayload) {
    try {
      const response = await this.requestWithRetry({
        type: "ackReminderBundle",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload,
      })
      return ackReminderBundleResponseSchema.parse(response)
    } catch (error) {
      if (!isV1UnsupportedOperation(error)) throw error
      const claim = this.legacyBundleClaims.get(payload.sessionId)
      if (!claim || claim.handoffId !== payload.handoffId) {
        return { acknowledged: 0 }
      }

      if (claim.mode === "legacy-bundle") {
        const response = await this.requestWithRetry({
          type: "ackReminderBundle",
          protocolVersion: PREMIND_PROTOCOL_VERSION,
          payload: {
            sessionId: payload.sessionId,
            state: payload.state,
            ...(payload.error ? { error: payload.error } : {}),
          },
        })
        const acknowledged = ackReminderBundleResponseSchema.parse(response)
        this.legacyBundleClaims.delete(payload.sessionId)
        return acknowledged
      }

      for (const batchId of claim.batchIds) {
        await this.ackReminder({
          batchId,
          sessionId: payload.sessionId,
          state: payload.state,
          ...(payload.error ? { error: payload.error } : {}),
        })
      }
      this.legacyBundleClaims.delete(payload.sessionId)
      return { acknowledged: claim.batchIds.length }
    }
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

  async setGlobalDisabled(disabled: boolean) {
    const response = await this.requestWithRetry({
      type: "setGlobalDisabled",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { disabled },
    })
    return globalDisabledResponseSchema.parse(response)
  }

  async getGlobalDisabled() {
    const response = await this.requestWithRetry({
      type: "getGlobalDisabled",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    })
    return globalDisabledResponseSchema.parse(response)
  }

  async debugStatus() {
    const response = await this.requestWithRetry({
      type: "debugStatus",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    })
    return decodeV1DebugStatusResponse(response)
  }

  async pruneClosedSessions() {
    return await this.requestWithRetry({
      type: "pruneClosedSessions",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    })
  }

  private async initializeProtocol() {
    if (this.initialized) return
    const response = await this.requestRaw({
      type: "initialize",
      bootstrapVersion: 1,
      payload: {
        client: {
          host: this.host,
          version: PREMIND_VERSION,
          commit: PREMIND_COMMIT,
          incarnationNonce: this.clientId,
        },
        protocols: { min: PREMIND_PROTOCOL_VERSION, max: PROTOCOL_V2 },
      },
    })
    const bootstrap = bootstrapResponseSchema.safeParse(response)
    if (bootstrap.success) {
      if (!bootstrap.data.ok) {
        throw new Error(
          `${bootstrap.data.error.code}: ${bootstrap.data.error.message}`,
        )
      }
      const selected = bootstrap.data.result.protocols.selected
      if (selected !== PREMIND_PROTOCOL_VERSION && selected !== PROTOCOL_V2) {
        throw new Error(`PROTOCOL_UNSUPPORTED: Unexpected protocol ${selected}`)
      }
      this.protocolVersion = selected
      this.initialized = true
      return
    }

    const legacy = responseSchema.safeParse(response)
    if (
      legacy.success &&
      !legacy.data.ok &&
      legacy.data.error.code === "BAD_REQUEST"
    ) {
      this.protocolVersion = PREMIND_PROTOCOL_VERSION
      this.initialized = true
      return
    }

    throw bootstrap.error
  }

  private withNegotiatedProtocol(message: unknown): unknown {
    if (typeof message !== "object" || message === null) return message
    if (!("protocolVersion" in message)) return message
    return {
      ...(message as Record<string, unknown>),
      protocolVersion: this.protocolVersion,
    }
  }

  private async requestWithRetry(message: unknown, attempt = 0): Promise<unknown> {
    try {
      return await this.request(this.withNegotiatedProtocol(message))
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error

      const isSocketError =
        error instanceof Error &&
        ("code" in error || error.message.includes("ECONNREFUSED") || error.message.includes("ENOENT"))

      if (!isSocketError) throw error

      // Daemon may have restarted or crashed. Try to bring it back.
      try {
        await ensureDaemonRunning()
        this.initialized = false
        await this.initializeProtocol()
      } catch {
        // If we can't start it, fall through to retry anyway.
      }

      // If we were previously registered, re-register after daemon restart.
      if (this.registered && this.projectRoot) {
        try {
          await this.request({
            type: "registerClient",
            protocolVersion: this.protocolVersion,
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
    const response = await this.requestRaw(message)
    const protocolVersion =
      typeof message === "object" &&
      message !== null &&
      "protocolVersion" in message
        ? (message as { protocolVersion?: unknown }).protocolVersion
        : PREMIND_PROTOCOL_VERSION
    const parsed =
      protocolVersion === PROTOCOL_V2
        ? protocolV2ResponseSchema.parse(response)
        : responseSchema.parse(response)
    if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
    return parsed.result
  }

  private async requestRaw(message: unknown): Promise<unknown> {
    const line = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
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

    return JSON.parse(line)
  }
}
