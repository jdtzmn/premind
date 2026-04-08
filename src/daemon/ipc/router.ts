import { PREMIND_CLIENT_HEARTBEAT_MS, PREMIND_CLIENT_LEASE_TTL_MS, PREMIND_IDLE_SHUTDOWN_GRACE_MS } from "../../shared/constants.js"
import { debugStatusResponseSchema, type AckReminderPayload, type RegisterClientPayload } from "../../shared/schema.js"
import type { PremindRequest, PremindResponse } from "../../shared/ipc.js"
import { StateStore } from "../persistence/store.js"

export class Router {
  constructor(private readonly store: StateStore) {}

  handle(request: PremindRequest): PremindResponse {
    switch (request.type) {
      case "registerClient":
        return this.ok(this.handleRegisterClient(request.payload))
      case "heartbeatClient": {
        const renewed = this.store.heartbeatClient(request.payload.clientId)
        if (!renewed) return this.fail("CLIENT_NOT_FOUND", `Unknown client: ${request.payload.clientId}`)
        return this.ok({ renewed: true })
      }
      case "releaseClient":
        this.store.releaseClient(request.payload.clientId)
        return this.ok({ released: true })
      case "registerSession":
        this.store.registerSession(request.payload)
        return this.ok({ registered: true })
      case "updateSessionState": {
        const updated = this.store.updateSessionState(request.payload)
        if (!updated) return this.fail("SESSION_NOT_FOUND", `Unknown session: ${request.payload.sessionId}`)
        return this.ok({ updated: true })
      }
      case "unregisterSession":
        this.store.unregisterSession(request.payload.sessionId)
        return this.ok({ unregistered: true })
      case "getPendingReminder":
        return this.ok({ batch: this.store.buildReminderBatch(request.payload.sessionId) })
      case "ackReminder":
        return this.ok(this.handleAckReminder(request.payload))
      case "debugStatus":
        return this.ok(
          debugStatusResponseSchema.parse({
            daemon: {
              protocolVersion: 1,
              heartbeatMs: PREMIND_CLIENT_HEARTBEAT_MS,
              leaseTtlMs: PREMIND_CLIENT_LEASE_TTL_MS,
              idleShutdownGraceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
            },
            activeClients: this.store.countActiveClients(),
            activeSessions: this.store.countActiveSessions(),
            activeWatchers: this.store.countActiveWatchers(),
          }),
        )
    }
  }

  hasActiveLeases() {
    return this.store.countActiveClients() > 0
  }

  hasActiveSessions() {
    return this.store.countActiveSessions() > 0
  }

  private handleRegisterClient(payload: RegisterClientPayload) {
    this.store.registerClient(payload.clientId, payload.metadata)
    return {
      heartbeatMs: PREMIND_CLIENT_HEARTBEAT_MS,
      leaseTtlMs: PREMIND_CLIENT_LEASE_TTL_MS,
      idleShutdownGraceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
    }
  }

  private handleAckReminder(payload: AckReminderPayload) {
    const acknowledged = this.store.ackReminder(payload)
    if (!acknowledged) {
      return { acknowledged: false, retryable: payload.state === "failed" }
    }

    return { acknowledged: true, retryable: payload.state === "failed" }
  }

  private ok(result: unknown): PremindResponse {
    return { ok: true, protocolVersion: 1, result }
  }

  private fail(code: string, message: string): PremindResponse {
    return { ok: false, protocolVersion: 1, error: { code, message } }
  }
}
