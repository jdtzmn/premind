import { z } from "zod";
import { requestSchema } from "../ipc.ts";
import type { PremindRequest, PremindResponse } from "../ipc.ts";

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
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const protocolV2ResponseSchema = z.discriminatedUnion("ok", [
  protocolV2SuccessResponseSchema,
  protocolV2ErrorResponseSchema,
]);

export type ProtocolV2Response = z.infer<typeof protocolV2ResponseSchema>;

export const parseProtocolV2RequestForRouter = (
  value: unknown,
): PremindRequest => {
  if (typeof value !== "object" || value === null) {
    return requestSchema.parse(value);
  }

  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== PROTOCOL_V2) {
    throw new Error(`Expected protocol version ${PROTOCOL_V2}`);
  }

  return requestSchema.parse({ ...request, protocolVersion: 1 });
};

export const toProtocolV2Response = (
  response: PremindResponse,
  request?: PremindRequest,
): ProtocolV2Response => {
  if (
    response.ok &&
    request?.type === "debugStatus" &&
    typeof response.result === "object" &&
    response.result !== null &&
    "daemon" in response.result &&
    typeof response.result.daemon === "object" &&
    response.result.daemon !== null
  ) {
    return protocolV2ResponseSchema.parse({
      ...response,
      protocolVersion: PROTOCOL_V2,
      result: {
        ...response.result,
        daemon: { ...response.result.daemon, protocolVersion: PROTOCOL_V2 },
      },
    });
  }

  return protocolV2ResponseSchema.parse({
    ...response,
    protocolVersion: PROTOCOL_V2,
  });
}
