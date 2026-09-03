import { z } from "zod"
import {
  PREMIND_CLIENT_HEARTBEAT_MS,
  PREMIND_CLIENT_LEASE_TTL_MS,
  PREMIND_IDLE_DELIVERY_THRESHOLD_MS,
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

// Only idleDeliveryThresholdMs is actually consumed today. Add new fields
// here as they become real features. Defining fields that aren't wired
// through leads to config that silently does nothing — worse than no config.
export const premindConfigSchema = z
  .object({
    // How long the session must be idle before pending PR updates are delivered.
    // Minimum 5 seconds to ensure the countdown toast has time to display.
    idleDeliveryThresholdMs: z.number().int().min(5_000).default(PREMIND_IDLE_DELIVERY_THRESHOLD_MS),
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
export const ensureSessionControlPayloadSchema = z
  .object({
    clientId: z.string().min(1),
    sessionId: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
    isPrimary: z.boolean().default(true),
    busyState: busyStateSchema.default("idle"),
    paused: z.boolean(),
  })
  .strict()

export const sessionControlPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict()

export const activateWorktreePayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict()

const subscriptionControlPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    prNumber: z.number().int().positive(),
    repo: z.string().min(1).optional(),
  })
  .strict()

export const subscribePayloadSchema = subscriptionControlPayloadSchema
export const unsubscribePayloadSchema = subscriptionControlPayloadSchema

export const reminderEventSchema = z
  .object({
    eventId: z.string().min(1),
    kind: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]),
    summary: z.string().min(1),
    referenceLink: z.string().min(1).optional(),
  })
  .passthrough()

export const reminderBatchSchema = z
  .object({
    batchId: z.string().min(1),
    sessionId: z.string().min(1),
    repo: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    subscriptionId: z.string().min(1).optional(),
    source: z.enum(["automatic", "manual"]).optional(),
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

export const setGlobalDisabledPayloadSchema = z
  .object({
    disabled: z.boolean(),
  })
  .strict()

export const getGlobalDisabledPayloadSchema = z.object({}).strict()

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
    globallyDisabled: z.boolean().default(false),
    activeClients: z.number().int().nonnegative(),
    activeSessions: z.number().int().nonnegative(),
    closedSessions: z.number().int().nonnegative().default(0),
    activeWatchers: z.number().int().nonnegative(),
    lastReapAt: z.number().int().nullable(),
    lastReapCount: z.number().int().nonnegative(),
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
          worktreeBinding: z
            .object({
              root: z.string().min(1),
              gitDir: z.string().min(1),
              repo: z.string().min(1),
              branch: z.string().min(1).nullable(),
              headSha: z.string().min(1),
              state: z.string().min(1),
              updatedAt: z.number().int(),
            })
            .strict()
            .nullable()
            .optional(),
          subscriptions: z
            .array(
              z
                .object({
                  repo: z.string().min(1),
                  prNumber: z.number().int().positive(),
                  source: z.enum(["automatic", "manual"]),
                  state: z.enum(["active", "unsubscribed"]),
                  pendingEventCount: z.number().int().nonnegative(),
                })
                .strict(),
            )
            .optional(),
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
export type EnsureSessionControlPayload = z.infer<
  typeof ensureSessionControlPayloadSchema
>
export type UpdateSessionStatePayload = z.infer<typeof updateSessionStatePayloadSchema>
export type UnregisterSessionPayload = z.infer<typeof unregisterSessionPayloadSchema>
export type SessionControlPayload = z.infer<typeof sessionControlPayloadSchema>
export type ActivateWorktreePayload = z.infer<typeof activateWorktreePayloadSchema>
export type SubscribePayload = z.infer<typeof subscribePayloadSchema>
export type UnsubscribePayload = z.infer<typeof unsubscribePayloadSchema>
export type ReminderEvent = z.infer<typeof reminderEventSchema>
export type ReminderBatch = z.infer<typeof reminderBatchSchema>
export type AckReminderPayload = z.infer<typeof ackReminderPayloadSchema>
export type SetGlobalDisabledPayload = z.infer<typeof setGlobalDisabledPayloadSchema>
export type GetGlobalDisabledPayload = z.infer<typeof getGlobalDisabledPayloadSchema>
export type DebugStatusResponse = z.infer<typeof debugStatusResponseSchema>
