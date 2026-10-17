import { z } from "zod";

const protocolRangeFields = {
  min: z.number().int().positive(),
  max: z.number().int().positive(),
};

export const protocolRangeSchema = z
  .object(protocolRangeFields)
  .refine(({ min, max }) => min <= max, {
    message: "Protocol minimum must not exceed maximum",
  });

export const selectedProtocolRangeSchema = z
  .object({
    ...protocolRangeFields,
    selected: z.number().int().positive(),
  })
  .refine(
    ({ min, max, selected }) =>
      min <= max && selected >= min && selected <= max,
    { message: "Selected protocol must be within the supported range" },
  );

export const storageCapabilitiesSchema = z.object({
  epoch: z.number().int().nonnegative(),
  capabilities: z.array(z.string().min(1)),
});

export const operationCapabilitiesSchema = z.object({
  operations: z.array(z.string().min(1)),
  rollingSessions: z.boolean(),
});

export const daemonLifecycleStateSchema = z.string().min(1);

export const isSelectableLifecycleState = (state: string): boolean =>
  state === "ready";

export const protocolErrorCodeSchema = z.enum([
  "PROTOCOL_UNSUPPORTED",
  "CLIENT_UPGRADE_REQUIRED",
  "DAEMON_UPGRADE_REQUIRED",
  "DAEMON_STARTING",
  "DAEMON_DOWNGRADE_BLOCKED",
  "SESSION_MOVED",
  "SESSION_BUSY",
  "SCHEMA_UNSUPPORTED",
  "SUPPORT_EXPIRED",
]);

export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;
