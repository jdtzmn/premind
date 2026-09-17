import { z } from "zod";
import { sessionHostSchema } from "../schema.ts";
import {
  isSelectableLifecycleState,
  operationCapabilitiesSchema,
  protocolErrorCodeSchema,
  protocolRangeSchema,
  selectedProtocolRangeSchema,
  storageCapabilitiesSchema,
} from "./capabilities.ts";
import { daemonInstanceIdentitySchema } from "./descriptor.ts";

export const BOOTSTRAP_VERSION = 1 as const;

export const bootstrapInitializeRequestSchema = z.object({
  type: z.literal("initialize"),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  payload: z.object({
    client: z.object({
      host: sessionHostSchema,
      version: z.string().min(1),
      commit: z.string().min(1),
      incarnationNonce: z.string().uuid(),
    }),
    protocols: protocolRangeSchema,
  }),
});

export const bootstrapSuccessResponseSchema = z.object({
  ok: z.literal(true),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  result: z.object({
    daemon: daemonInstanceIdentitySchema,
    protocols: selectedProtocolRangeSchema,
    capabilities: operationCapabilitiesSchema,
    storage: storageCapabilitiesSchema,
  }),
});

export const bootstrapErrorResponseSchema = z.object({
  ok: z.literal(false),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  error: z.object({
    code: protocolErrorCodeSchema,
    message: z.string().min(1),
    supported: protocolRangeSchema.optional(),
  }),
});

export const bootstrapResponseSchema = z.discriminatedUnion("ok", [
  bootstrapSuccessResponseSchema,
  bootstrapErrorResponseSchema,
]);

export { isSelectableLifecycleState };

export type BootstrapInitializeRequest = z.infer<
  typeof bootstrapInitializeRequestSchema
>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
