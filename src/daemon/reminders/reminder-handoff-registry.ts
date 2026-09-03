import type { AckReminderPayload, ReminderBatch } from "../../shared/schema.ts"
import type { ReminderBatchRecord, StateStore } from "../persistence/store.ts"
import {
  createReminderHandoffActor,
  eventForReminderState,
  type ReminderHandoffState,
} from "./reminder-handoff-machine.ts"

type ReminderActor = ReturnType<typeof createReminderHandoffActor>

/**
 * Owns the live handoff actors while SQLite remains the source of truth.
 * Actors are reconstructed from durable batch rows after every daemon start.
 */
export class ReminderHandoffRegistry {
  private readonly actors = new Map<string, ReminderActor>()

  constructor(private readonly store: StateStore) {
    for (const record of store.listPendingReminderBatchRecords()) {
      this.actors.set(record.batchId, createReminderHandoffActor(record.state))
    }
  }

  getPendingReminder(sessionId: string, now = Date.now()): ReminderBatch | null {
    let record = this.store.getPendingReminderRecord(sessionId)
    if (!record) {
      const built = this.store.buildReminderBatch(sessionId, now)
      if (!built) return null
      record = this.store.getReminderBatchRecord(built.batchId, sessionId)
      if (!record) return null
    }

    if (record.state === "failed") {
      if (!this.retry(record, now)) return null
    }

    return this.store.getPendingReminder(sessionId)
  }

  acknowledge(payload: AckReminderPayload, now = Date.now()) {
    const record = this.store.getReminderBatchRecord(payload.batchId, payload.sessionId)
    if (!record) {
      return { acknowledged: false as const, code: "BATCH_NOT_FOUND", message: "Reminder batch is missing or already confirmed" }
    }

    const actor = this.actorFor(record)
    actor.send(eventForReminderState(payload.state))
    if (actor.getSnapshot().value !== payload.state) {
      return {
        acknowledged: false as const,
        code: "INVALID_HANDOFF_TRANSITION",
        message: `Cannot transition reminder batch from ${record.state} to ${payload.state}`,
      }
    }

    try {
      const persisted = this.store.ackReminder(payload, now)
      if (!persisted) {
        this.discard(payload.batchId)
        return { acknowledged: false as const, code: "HANDOFF_CONFLICT", message: "Reminder batch changed concurrently" }
      }
      if (payload.state === "confirmed") this.discard(payload.batchId)
      return { acknowledged: true as const, retryable: payload.state === "failed" }
    } catch (error) {
      this.discard(payload.batchId)
      throw error
    }
  }

  close() {
    for (const actor of this.actors.values()) actor.stop()
    this.actors.clear()
  }

  private retry(record: ReminderBatchRecord, now: number) {
    const actor = this.actorFor(record)
    actor.send({ type: "RETRY" })
    if (actor.getSnapshot().value !== "built") return false
    const persisted = this.store.transitionReminderBatchState(
      record.batchId,
      record.sessionId,
      "failed",
      "built",
      now,
    )
    if (!persisted) this.discard(record.batchId)
    return persisted
  }

  private actorFor(record: ReminderBatchRecord) {
    const existing = this.actors.get(record.batchId)
    if (existing && existing.getSnapshot().value === record.state) return existing
    if (existing) existing.stop()
    const actor = createReminderHandoffActor(record.state as ReminderHandoffState)
    this.actors.set(record.batchId, actor)
    return actor
  }

  private discard(batchId: string) {
    this.actors.get(batchId)?.stop()
    this.actors.delete(batchId)
  }
}
