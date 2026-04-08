import { z } from "zod"
import {
  PREMIND_CLIENT_HEARTBEAT_MS,
  PREMIND_CLIENT_LEASE_TTL_MS,
  PREMIND_IDLE_SHUTDOWN_GRACE_MS,
  PREMIND_PROTOCOL_VERSION,
} from "./constants.js"
import {
  ackReminderPayloadSchema,
  debugStatusPayloadSchema,
  debugStatusResponseSchema,
  getPendingReminderPayloadSchema,
  heartbeatClientPayloadSchema,
  registerClientPayloadSchema,
  registerSessionPayloadSchema,
  releaseClientPayloadSchema,
  reminderBatchSchema,
  unregisterSessionPayloadSchema,
  updateSessionStatePayloadSchema,
} from "./schema.js"

export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registerClient"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: registerClientPayloadSchema }),
  z.object({ type: z.literal("heartbeatClient"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: heartbeatClientPayloadSchema }),
  z.object({ type: z.literal("releaseClient"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: releaseClientPayloadSchema }),
  z.object({ type: z.literal("registerSession"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: registerSessionPayloadSchema }),
  z.object({ type: z.literal("updateSessionState"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: updateSessionStatePayloadSchema }),
  z.object({ type: z.literal("unregisterSession"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: unregisterSessionPayloadSchema }),
  z.object({ type: z.literal("getPendingReminder"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: getPendingReminderPayloadSchema }),
  z.object({ type: z.literal("ackReminder"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: ackReminderPayloadSchema }),
  z.object({ type: z.literal("debugStatus"), protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION), payload: debugStatusPayloadSchema }),
])

export const successResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION),
  result: z.unknown(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
})

export const responseSchema = z.union([successResponseSchema, errorResponseSchema])

export const registerClientResponseSchema = z.object({
  heartbeatMs: z.literal(PREMIND_CLIENT_HEARTBEAT_MS),
  leaseTtlMs: z.literal(PREMIND_CLIENT_LEASE_TTL_MS),
  idleShutdownGraceMs: z.literal(PREMIND_IDLE_SHUTDOWN_GRACE_MS),
})

export const getPendingReminderResponseSchema = z.object({
  batch: reminderBatchSchema.nullable(),
})

export { debugStatusResponseSchema }

export type PremindRequest = z.infer<typeof requestSchema>
export type PremindResponse = z.infer<typeof responseSchema>
