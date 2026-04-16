import { z } from "zod"
import {
  PREMIND_CLIENT_HEARTBEAT_MS,
  PREMIND_CLIENT_LEASE_TTL_MS,
  PREMIND_IDLE_SHUTDOWN_GRACE_MS,
  PREMIND_PROTOCOL_VERSION,
} from "./constants.ts"

export const clientMetadataSchema = z
  .object({
    pid: z.number().int().positive(),
    projectRoot: z.string().min(1),
    sessionSource: z.string().min(1).optional(),
  })
  .strict()

export const sessionStatusSchema = z.enum(["active", "paused", "closed"])
export const busyStateSchema = z.enum(["busy", "idle"])

export const premindConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    autoAttach: z.boolean().default(true),
    discoveryPollIntervalMs: z.number().int().positive().default(90_000),
    activePollIntervalMs: z.number().int().positive().default(20_000),
    maxActivePollIntervalMs: z.number().int().positive().default(120_000),
    cacheTtlDays: z.number().int().positive().default(14),
    inlineEventLimit: z.number().int().positive().default(8),
    inlineCommentCharLimit: z.number().int().positive().default(320),
    debugLogging: z.boolean().default(false),
  })
  .strict()

export const registerClientPayloadSchema = z
  .object({
    clientId: z.string().min(1),
    metadata: clientMetadataSchema,
  })
  .strict()

export const heartbeatClientPayloadSchema = z
  .object({
    clientId: z.string().min(1),
  })
  .strict()

export const releaseClientPayloadSchema = z
  .object({
    clientId: z.string().min(1),
  })
  .strict()

export const registerSessionPayloadSchema = z
  .object({
    clientId: z.string().min(1),
    sessionId: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
    isPrimary: z.boolean().default(true),
    status: sessionStatusSchema.default("active"),
    busyState: busyStateSchema.default("idle"),
  })
  .strict()

export const updateSessionStatePayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    status: sessionStatusSchema.optional(),
    busyState: busyStateSchema.optional(),
    branch: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, {
    message: "At least one field besides sessionId must be provided",
  })

export const unregisterSessionPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict()

export const sessionControlPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict()

export const reminderEventSchema = z
  .object({
    eventId: z.string().min(1),
    kind: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]),
    summary: z.string().min(1),
    detailFilePath: z.string().min(1).optional(),
  })
  .passthrough()

export const reminderBatchSchema = z
  .object({
    batchId: z.string().min(1),
    sessionId: z.string().min(1),
    reminderText: z.string().min(1),
    events: z.array(reminderEventSchema),
  })
  .strict()

export const getPendingReminderPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict()

export const ackReminderPayloadSchema = z
  .object({
    batchId: z.string().min(1),
    sessionId: z.string().min(1),
    state: z.enum(["handed_off", "confirmed", "failed"]),
    error: z.string().min(1).optional(),
  })
  .strict()

export const debugStatusPayloadSchema = z.object({}).strict()

export const daemonInfoSchema = z
  .object({
    protocolVersion: z.literal(PREMIND_PROTOCOL_VERSION),
    heartbeatMs: z.literal(PREMIND_CLIENT_HEARTBEAT_MS),
    leaseTtlMs: z.literal(PREMIND_CLIENT_LEASE_TTL_MS),
    idleShutdownGraceMs: z.literal(PREMIND_IDLE_SHUTDOWN_GRACE_MS),
  })
  .strict()

export const debugStatusResponseSchema = z
  .object({
    daemon: daemonInfoSchema,
    activeClients: z.number().int().nonnegative(),
    activeSessions: z.number().int().nonnegative(),
    activeWatchers: z.number().int().nonnegative(),
    sessions: z.array(
      z
        .object({
          sessionId: z.string().min(1),
          repo: z.string().min(1),
          branch: z.string().min(1),
          prNumber: z.number().int().nullable(),
          status: sessionStatusSchema,
          busyState: busyStateSchema,
          pendingReminderCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()

export type ClientMetadata = z.infer<typeof clientMetadataSchema>
export type PremindConfig = z.infer<typeof premindConfigSchema>
export type RegisterClientPayload = z.infer<typeof registerClientPayloadSchema>
export type HeartbeatClientPayload = z.infer<typeof heartbeatClientPayloadSchema>
export type ReleaseClientPayload = z.infer<typeof releaseClientPayloadSchema>
export type RegisterSessionPayload = z.infer<typeof registerSessionPayloadSchema>
export type UpdateSessionStatePayload = z.infer<typeof updateSessionStatePayloadSchema>
export type UnregisterSessionPayload = z.infer<typeof unregisterSessionPayloadSchema>
export type SessionControlPayload = z.infer<typeof sessionControlPayloadSchema>
export type ReminderEvent = z.infer<typeof reminderEventSchema>
export type ReminderBatch = z.infer<typeof reminderBatchSchema>
export type AckReminderPayload = z.infer<typeof ackReminderPayloadSchema>
export type DebugStatusResponse = z.infer<typeof debugStatusResponseSchema>
