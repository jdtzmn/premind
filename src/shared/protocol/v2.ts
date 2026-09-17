import { z } from "zod";
import { protocolErrorCodeSchema } from "./capabilities.ts";

export const PROTOCOL_V2 = 2 as const;

export const protocolV2SuccessResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(PROTOCOL_V2),
  result: z.unknown(),
});

export const protocolV2ErrorResponseSchema = z.object({
  ok: z.literal(false),
  protocolVersion: z.literal(PROTOCOL_V2),
  error: z.object({
    code: protocolErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const protocolV2ResponseSchema = z.discriminatedUnion("ok", [
  protocolV2SuccessResponseSchema,
  protocolV2ErrorResponseSchema,
]);
