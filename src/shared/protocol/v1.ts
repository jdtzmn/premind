import {
  claimReminderBundleResponseSchema,
  legacyClaimReminderBundleResponseSchema,
} from "../ipc.ts";
import { debugStatusResponseSchema } from "../schema.ts";
import type { DebugStatusResponse } from "../schema.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isV1UnsupportedOperation = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("BAD_REQUEST:");

export const decodeV1ClaimReminderBundleResponse = (value: unknown) => {
  const tokenized = claimReminderBundleResponseSchema.safeParse(value);
  if (tokenized.success) {
    return { variant: "tokenized" as const, response: tokenized.data };
  }

  const firstBundle = legacyClaimReminderBundleResponseSchema.safeParse(value);
  if (firstBundle.success) {
    return { variant: "first-bundle" as const, response: firstBundle.data };
  }

  return {
    variant: "tokenized" as const,
    response: claimReminderBundleResponseSchema.parse(value),
  };
};

export const decodeV1DebugStatusResponse = (
  value: unknown,
): DebugStatusResponse => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return debugStatusResponseSchema.parse(value);
  }

  return debugStatusResponseSchema.parse({
    ...value,
    sessions: value.sessions.map((session) =>
      isRecord(session) && session.host === undefined
        ? { ...session, host: "unknown" }
        : session,
    ),
  });
};
