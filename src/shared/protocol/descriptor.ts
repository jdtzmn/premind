import { z } from "zod";
import {
  daemonLifecycleStateSchema,
  isSelectableLifecycleState,
  protocolRangeSchema,
  storageCapabilitiesSchema,
} from "./capabilities.ts";

export const daemonInstanceIdentitySchema = z.object({
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.string().min(1),
  commit: z.string().min(1),
  socketPath: z.string().min(1),
  lifecycleState: daemonLifecycleStateSchema,
});

export const instanceDescriptorV1Schema = daemonInstanceIdentitySchema.extend({
  descriptorFormat: z.literal(1),
  protocols: protocolRangeSchema,
  storage: storageCapabilitiesSchema,
  heartbeatAt: z.number().int().nonnegative(),
});

export type InstanceDescriptorV1 = z.infer<
  typeof instanceDescriptorV1Schema
>;

export const isSelectableDescriptor = (
  descriptor: InstanceDescriptorV1,
): boolean => isSelectableLifecycleState(descriptor.lifecycleState);
