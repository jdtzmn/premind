/** A rejected daemon response, never a socket/transport failure. */
export class DaemonResponseError extends Error {
  readonly domain = "daemon";

  constructor(
    readonly code: string,
    readonly daemonMessage: string,
  ) {
    // Keep the existing display contract for older callers and compatibility checks.
    super(`${code}: ${daemonMessage}`);
    this.name = "DaemonResponseError";
  }
}

/** The single compatibility seam for old CODE: message errors and Claude's MJS shape. */
export const normalizeDaemonError = (error: unknown): DaemonResponseError | null => {
  if (!(error instanceof Error)) return null;
  if (error instanceof DaemonResponseError) return error;
  if ("domain" in error) {
    if (error.domain !== "daemon" || !("code" in error) || typeof error.code !== "string") return null;
    const message = "daemonMessage" in error && typeof error.daemonMessage === "string"
      ? error.daemonMessage
      : error.message;
    return new DaemonResponseError(error.code, message);
  }
  // Node errno errors are transport failures even if their message looks legacy.
  if ("code" in error) return null;
  const legacy = /^([A-Z][A-Z0-9_]*): ([\s\S]*)$/.exec(error.message);
  return legacy ? new DaemonResponseError(legacy[1]!, legacy[2]!) : null;
};

export const isDaemonError = (error: unknown, code?: string): boolean => {
  const normalized = normalizeDaemonError(error);
  return normalized !== null && (code === undefined || normalized.code === code);
};
