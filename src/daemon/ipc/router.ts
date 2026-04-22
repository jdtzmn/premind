import { PREMIND_CLIENT_HEARTBEAT_MS, PREMIND_CLIENT_LEASE_TTL_MS, PREMIND_IDLE_SHUTDOWN_GRACE_MS } from "../../shared/constants.ts"
import { debugStatusResponseSchema, type AckReminderPayload, type RegisterClientPayload } from "../../shared/schema.ts"
import type { PremindRequest, PremindResponse } from "../../shared/ipc.ts"
import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"

export class Router {
  private readonly logger = createLogger("daemon.ipc")

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
      case "registerSession": {
        const { created, superseded } = this.store.registerSession(request.payload)
        this.logger.info(created ? "session registered" : "session re-registered", {
          sessionId: request.payload.sessionId,
          repo: request.payload.repo,
          branch: request.payload.branch,
          reattach: !created,
          ...(superseded > 0 ? { superseded } : {}),
        })
        return this.ok({ registered: true, created })
      }
      case "updateSessionState": {
        const updated = this.store.updateSessionState(request.payload)
        if (!updated) return this.fail("SESSION_NOT_FOUND", `Unknown session: ${request.payload.sessionId}`)
        return this.ok({ updated: true })
      }
      case "unregisterSession":
        this.store.unregisterSession(request.payload.sessionId)
        return this.ok({ unregistered: true })
      case "pauseSession": {
        const paused = this.store.setSessionPaused(request.payload.sessionId, true)
        if (!paused) return this.fail("SESSION_NOT_FOUND", `Unknown session: ${request.payload.sessionId}`)
        return this.ok({ paused: true })
      }
      case "resumeSession": {
        const resumed = this.store.setSessionPaused(request.payload.sessionId, false)
        if (!resumed) return this.fail("SESSION_NOT_FOUND", `Unknown session: ${request.payload.sessionId}`)
        return this.ok({ resumed: true })
      }
      case "getPendingReminder":
        return this.ok({ batch: this.store.buildReminderBatch(request.payload.sessionId) })
      case "ackReminder":
        return this.ok(this.handleAckReminder(request.payload))
      case "setGlobalDisabled":
        this.store.setGloballyDisabled(request.payload.disabled)
        return this.ok({ disabled: request.payload.disabled })
      case "getGlobalDisabled":
        return this.ok({ disabled: this.store.isGloballyDisabled() })
      case "debugStatus":
        return this.ok(
          debugStatusResponseSchema.parse({
            daemon: {
              protocolVersion: 1,
              heartbeatMs: PREMIND_CLIENT_HEARTBEAT_MS,
              leaseTtlMs: PREMIND_CLIENT_LEASE_TTL_MS,
              idleShutdownGraceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
            },
            globallyDisabled: this.store.isGloballyDisabled(),
            activeClients: this.store.countActiveClients(),
            activeSessions: this.store.countActiveSessions(),
            closedSessions: this.store.countClosedSessions(),
            activeWatchers: this.store.countActiveWatchers(),
            lastReapAt: this.store.getLastReapAt(),
            lastReapCount: this.store.getLastReapCount(),
            sessions: this.store.listSessionSummaries(),
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
