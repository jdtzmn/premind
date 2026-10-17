import { isDaemonError } from "./daemon-error.ts";

/** Only operations that reject missing registration before producing effects. */
const recoveryOperations = [
  "subscribe",
  "unsubscribe",
  "activateWorktree",
  "pauseSession",
  "resumeSession",
  "updateSessionState",
] as const;
const recoverableOperations = new Set<string>(recoveryOperations);
export type RecoverableSessionOperation = (typeof recoveryOperations)[number];

export type SessionRecoveryAdapter = {
  /** Verify the exact host incarnation, not merely a session ID or context file. */
  isCurrent: () => boolean | Promise<boolean>;
  /** Must fence daemon mutations against lifecycle end and explicit deletion. */
  reattach: () => Promise<void>;
};

/**
 * One controller belongs to one verified host/session lifecycle incarnation.
 * This policy is intentionally independent of host APIs, storage and transport.
 * Call invalidate before shutdown; a new incarnation needs a new controller.
 * Adapter checks cannot undo late IPC: reattach must also use daemon-side fences.
 */
export const createSessionRecovery = (adapter: SessionRecoveryAdapter) => {
  let invalidated = false;
  let revision = 0;
  let attachment: Promise<void> | undefined;

  const requireCurrent = async () => {
    if (invalidated || !(await adapter.isCurrent()) || invalidated) {
      throw new Error("Session recovery context is no longer current");
    }
  };

  const attach = async () => {
    await requireCurrent();
    await adapter.reattach();
    await requireCurrent();
    revision++;
  };

  return {
    invalidate() {
      invalidated = true;
    },
    async run<T>(operation: RecoverableSessionOperation, action: () => Promise<T>): Promise<T> {
      // Runtime guard also protects JavaScript adapters using the generated module.
      if (!recoverableOperations.has(operation)) {
        throw new Error(`Session operation is not eligible for recovery: ${operation}`);
      }
      await requireCurrent();
      const attemptedRevision = revision;
      try {
        return await action();
      } catch (error) {
        if (!isDaemonError(error, "SESSION_NOT_FOUND")) throw error;
        await requireCurrent();
        if (attemptedRevision === revision) {
          if (!attachment) {
            attachment = attach().finally(() => { attachment = undefined; });
          }
          await attachment;
        }
        await requireCurrent();
        // Deliberately outside the catch: a failed replay never recurses.
        return action();
      }
    },
  };
};
