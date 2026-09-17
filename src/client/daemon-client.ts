import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  PREMIND_PROTOCOL_VERSION,
  PREMIND_SOCKET_PATH,
} from "../shared/constants.ts";
import {
  ackReminderBundleResponseSchema,
  claimReminderBundleResponseSchema,
  activateWorktreeResponseSchema,
  debugStatusResponseSchema,
  claimReminderResponseSchema,
  getPendingReminderResponseSchema,
  globalDisabledResponseSchema,
  legacyClaimReminderBundleResponseSchema,
  registerClientResponseSchema,
  registerSessionResponseSchema,
  releaseSessionOwnerResponseSchema,
  settleReminderClaimResponseSchema,
  responseSchema,
  subscribeResponseSchema,
  unsubscribeResponseSchema,
} from "../shared/ipc.ts";
import type {
  AckReminderPayload,
  AckReminderBundlePayload,
  ClaimReminderPayload,
  CodexSessionPayload,
  SettleReminderClaimPayload,
  ActivateWorktreePayload,
  EnsureSessionControlPayload,
  RegisterSessionPayload,
  SubscribePayload,
  UnsubscribePayload,
  UpdateSessionStatePayload,
} from "../shared/schema.ts";
import { ensureDaemonRunning as ensureDefaultDaemon } from "./daemon-launcher.ts";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const isUnsupportedOperation = (error: unknown) =>
  error instanceof Error && error.message.startsWith("BAD_REQUEST:");
const REQUEST_TIMEOUT_MS = 30_000;

export type PremindDaemonClientOptions = {
  socketPath?: string;
  ensureDaemon?: () => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
};

export class PremindDaemonClient {
  readonly clientId = randomUUID();
  private readonly socketPath: string;
  private readonly ensureDaemon: () => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: PremindDaemonClientOptions = {}) {
    this.socketPath = options.socketPath ?? PREMIND_SOCKET_PATH;
    this.ensureDaemon = options.ensureDaemon ?? ensureDefaultDaemon;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      !Number.isFinite(this.retryDelayMs) ||
      this.retryDelayMs < 0 ||
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new Error("Invalid premind daemon client retry or timeout options");
    }
  }
  private registered = false;
  private projectRoot?: string;
  private sessionSource?: string;

  private readonly legacyBundleClaims = new Map<
    string,
    {
      handoffId: string
      batchIds: string[]
      mode: "single" | "legacy-bundle"
    }
  >()
  async registerClient(projectRoot: string, sessionSource?: string) {
    this.projectRoot = projectRoot;
    this.sessionSource = sessionSource;
    const response = await this.requestWithRetry({
      type: "registerClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {
        clientId: this.clientId,
        metadata: {
          pid: process.pid,
          projectRoot,
          sessionSource,
        },
      },
    });
    this.registered = true;
    return registerClientResponseSchema.parse(response);
  }

  async heartbeat() {
    await this.requestWithRetry({
      type: "heartbeatClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    });
  }

  async release() {
    await this.requestWithRetry({
      type: "releaseClient",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { clientId: this.clientId },
    });
    this.registered = false;
  }

  async registerSession(payload: Omit<RegisterSessionPayload, "clientId">) {
    await this.requestWithRetry({
      type: "registerSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { ...payload, clientId: this.clientId },
    });
  }

  async registerCodexSession(payload: CodexSessionPayload) {
    const response = await this.requestWithRetry({
      type: "registerCodexSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return registerSessionResponseSchema.parse(response);
  }

  async claimReminder(payload: ClaimReminderPayload) {
    const response = await this.requestWithRetry({
      type: "claimReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return claimReminderResponseSchema.parse(response);
  }

  async settleReminderClaim(payload: SettleReminderClaimPayload) {
    const response = await this.requestWithRetry({
      type: "settleReminderClaim",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return settleReminderClaimResponseSchema.parse(response);
  }

  async releaseSessionOwner(sessionId: string) {
    const response = await this.requestWithRetry({
      type: "releaseSessionOwner",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
    return releaseSessionOwnerResponseSchema.parse(response);
  }

  async ensureSessionControl(
    payload: Omit<EnsureSessionControlPayload, "clientId">,
  ) {
    try {
      await this.requestWithRetry({
        type: "ensureSessionControl",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { ...payload, clientId: this.clientId },
      });
    } catch (error) {
      // A long-lived daemon from a pre-control-operation package reports the new
      // request as BAD_REQUEST. Fall back to its compatible registration path so
      // clients keep working until that daemon exits naturally.
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("BAD_REQUEST:")
      ) {
        throw error;
      }
      const { paused, ...session } = payload;
      await this.registerSession({
        ...session,
        status: paused ? "paused" : "active",
      });
    }
  }

  async updateSessionState(payload: UpdateSessionStatePayload) {
    await this.requestWithRetry({
      type: "updateSessionState",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
  }

  async unregisterSession(sessionId: string) {
    await this.requestWithRetry({
      type: "unregisterSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
  }

  async pauseSession(sessionId: string) {
    await this.requestWithRetry({
      type: "pauseSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
  }

  async resumeSession(sessionId: string) {
    await this.requestWithRetry({
      type: "resumeSession",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
  }

  async activateWorktree(payload: ActivateWorktreePayload) {
    const response = await this.requestWithRetry({
      type: "activateWorktree",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return activateWorktreeResponseSchema.parse(response);
  }

  async subscribe(payload: SubscribePayload) {
    const response = await this.requestWithRetry({
      type: "subscribe",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return subscribeResponseSchema.parse(response);
  }

  async unsubscribe(payload: UnsubscribePayload) {
    const response = await this.requestWithRetry({
      type: "unsubscribe",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
    return unsubscribeResponseSchema.parse(response);
  }

  async claimReminderBundle(sessionId: string) {
    try {
      const response = await this.requestWithRetry({
        type: "claimReminderBundle",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload: { sessionId },
      })
      const current = claimReminderBundleResponseSchema.safeParse(response)
      if (current.success) return current.data

      const legacy = legacyClaimReminderBundleResponseSchema.safeParse(response)
      if (!legacy.success) return claimReminderBundleResponseSchema.parse(response)
      if (legacy.data.batches.length === 0) return { bundle: null }
      const handoffId = randomUUID()
      this.legacyBundleClaims.set(sessionId, {
        handoffId,
        batchIds: legacy.data.batches.map(({ batchId }) => batchId),
        mode: "legacy-bundle",
      })
      return { bundle: { handoffId, batches: legacy.data.batches } }
    } catch (error) {
      if (!isUnsupportedOperation(error)) throw error
      const pending = await this.getPendingReminder(sessionId)
      if (!pending.batch) return { bundle: null }

      await this.ackReminder({
        batchId: pending.batch.batchId,
        sessionId,
        state: "handed_off",
      })
      const handoffId = randomUUID()
      this.legacyBundleClaims.set(sessionId, {
        handoffId,
        batchIds: [pending.batch.batchId],
        mode: "single",
      })
      return { bundle: { handoffId, batches: [pending.batch] } }
    }
  }

  async ackReminderBundle(payload: AckReminderBundlePayload) {
    try {
      const response = await this.requestWithRetry({
        type: "ackReminderBundle",
        protocolVersion: PREMIND_PROTOCOL_VERSION,
        payload,
      })
      return ackReminderBundleResponseSchema.parse(response)
    } catch (error) {
      if (!isUnsupportedOperation(error)) throw error
      const claim = this.legacyBundleClaims.get(payload.sessionId)
      if (!claim || claim.handoffId !== payload.handoffId) {
        return { acknowledged: 0 }
      }

      if (claim.mode === "legacy-bundle") {
        const response = await this.requestWithRetry({
          type: "ackReminderBundle",
          protocolVersion: PREMIND_PROTOCOL_VERSION,
          payload: {
            sessionId: payload.sessionId,
            state: payload.state,
            ...(payload.error ? { error: payload.error } : {}),
          },
        })
        const acknowledged = ackReminderBundleResponseSchema.parse(response)
        this.legacyBundleClaims.delete(payload.sessionId)
        return acknowledged
      }

      for (const batchId of claim.batchIds) {
        await this.ackReminder({
          batchId,
          sessionId: payload.sessionId,
          state: payload.state,
          ...(payload.error ? { error: payload.error } : {}),
        })
      }
      this.legacyBundleClaims.delete(payload.sessionId)
      return { acknowledged: claim.batchIds.length }
    }
  }

  async getPendingReminder(sessionId: string) {
    const response = await this.requestWithRetry({
      type: "getPendingReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { sessionId },
    });
    return getPendingReminderResponseSchema.parse(response);
  }

  async ackReminder(payload: AckReminderPayload) {
    await this.requestWithRetry({
      type: "ackReminder",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload,
    });
  }

  async setGlobalDisabled(disabled: boolean) {
    const response = await this.requestWithRetry({
      type: "setGlobalDisabled",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: { disabled },
    });
    return globalDisabledResponseSchema.parse(response);
  }

  async getGlobalDisabled() {
    const response = await this.requestWithRetry({
      type: "getGlobalDisabled",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    });
    return globalDisabledResponseSchema.parse(response);
  }

  async debugStatus() {
    const response = await this.requestWithRetry({
      type: "debugStatus",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    });
    return debugStatusResponseSchema.parse(response);
  }

  async pruneClosedSessions() {
    return await this.requestWithRetry({
      type: "pruneClosedSessions",
      protocolVersion: PREMIND_PROTOCOL_VERSION,
      payload: {},
    });
  }

  private async requestWithRetry(
    message: unknown,
    attempt = 0,
  ): Promise<unknown> {
    try {
      return await this.request(message);
    } catch (error) {
      if (attempt >= this.maxRetries) throw error;

      const isSocketError =
        error instanceof Error &&
        ("code" in error ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ENOENT"));

      if (!isSocketError) throw error;

      // Startup errors (including unsupported Node and incompatible daemons)
      // are actionable and must not be hidden behind a later socket retry.
      await this.ensureDaemon();

      // If we were previously registered, re-register after daemon restart.
      if (this.registered && this.projectRoot) {
        try {
          await this.request({
            type: "registerClient",
            protocolVersion: PREMIND_PROTOCOL_VERSION,
            payload: {
              clientId: this.clientId,
              metadata: {
                pid: process.pid,
                projectRoot: this.projectRoot,
                sessionSource: this.sessionSource,
              },
            },
          });
        } catch {
          // Re-registration failed, will retry the original request.
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.retryDelayMs * (attempt + 1)),
      );
      return this.requestWithRetry(message, attempt + 1);
    }
  }

  private async request(message: unknown) {
    const line = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";

      socket.setEncoding("utf8");
      socket.setTimeout(this.requestTimeoutMs, () => {
        const error = Object.assign(
          new Error(
            `Premind daemon request timed out after ${this.requestTimeoutMs}ms`,
          ),
          { code: "ETIMEDOUT" },
        );
        socket.destroy(error);
      });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(message)}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex >= 0) {
          const result = buffer.slice(0, newlineIndex);
          socket.end();
          resolve(result);
        }
      });
    });

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      throw new Error("premind daemon returned invalid JSON", { cause: error });
    }
    const parsed = responseSchema.parse(payload);
    if (!parsed.ok)
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return parsed.result;
  }
}
