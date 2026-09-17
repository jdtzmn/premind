import { debugStatusResponseSchema } from "../schema.ts";
import type { DebugStatusResponse } from "../schema.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
