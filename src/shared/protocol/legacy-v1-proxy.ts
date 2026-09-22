import { randomUUID } from "node:crypto";
import { legacyRequestSchema, type RoutedPremindRequest } from "../ipc.ts";
import { sessionLeaseTokenSchema, type SessionLeaseToken } from "../schema.ts";
import type { StateStore } from "../../daemon/persistence/store.ts";

export const SAFE_V1_PROXY_OPERATIONS = new Set([
  "registerClient",
  "heartbeatClient",
  "releaseClient",
  "registerSession",
  "ensureSessionControl",
  "registerClaudeSession",
  "touchClaudeSession",
  "claimClaudeReminder",
  "confirmClaudeHandoff",
  "suspendClaudeSession",
  "updateSessionState",
  "unregisterSession",
  "pauseSession",
  "resumeSession",
  "activateWorktree",
  "subscribe",
  "unsubscribe",
  "claimReminderBundle",
  "ackReminderBundle",
  "getPendingReminder",
  "ackReminder",
  "setGlobalDisabled",
  "getGlobalDisabled",
  "debugStatus",
]);

type ProxyResponse =
  | { ok: true; protocolVersion: number; result?: unknown }
  | { ok: false; protocolVersion: number; error: { code: string; message: string } };

export type ModernProxyRequester = (
  request: RoutedPremindRequest,
) => Promise<ProxyResponse>;

const v1Response = (response: ProxyResponse): ProxyResponse => ({
  ...response,
  protocolVersion: 1,
});
export const projectV1ProxyResponse = (
  operation: string,
  response: ProxyResponse,
): ProxyResponse => {
  const projected = v1Response(response);
  if (operation !== "claimReminderBundle" || !projected.ok) return projected;
  const result = projected.result as {
    bundle?: { batches?: unknown[] } | null;
  };
  return {
    ...projected,
    result: {
      ...result,
      batches: result.bundle?.batches ?? [],
    },
  };
};


const failure = (code: string, message: string): ProxyResponse => ({
  ok: false,
  protocolVersion: 1,
  error: { code, message },
});

export class LegacyV1ProxyRouter {
  constructor(
    private readonly store: StateStore,
    private readonly modernInstanceId: string,
    private readonly requestModern: ModernProxyRequester,
  ) {}

  async handle(value: unknown): Promise<ProxyResponse> {
    const parsed = legacyRequestSchema.safeParse(value);
    if (!parsed.success) return failure("BAD_REQUEST", "Unsupported protocol-v1 request");
    const request = parsed.data;
    if (!SAFE_V1_PROXY_OPERATIONS.has(request.type)) {
      return failure("BAD_REQUEST", `Unsupported protocol-v1 operation: ${request.type}`);
    }

    if (request.type === "registerSession" || request.type === "ensureSessionControl") {
      return this.registerSession(request);
    }
    if (request.type === "heartbeatClient") return this.heartbeatClient(request);
    if (request.type === "releaseClient") return this.releaseClient(request);
    if (request.type === "unregisterSession") return this.unregisterSession(request);

    const sessionId =
      "sessionId" in request.payload && typeof request.payload.sessionId === "string"
        ? request.payload.sessionId
        : undefined;
    const isClaudeOperation =
      request.type === "registerClaudeSession" ||
      request.type === "touchClaudeSession" ||
      request.type === "claimClaudeReminder" ||
      request.type === "confirmClaudeHandoff" ||
      request.type === "suspendClaudeSession";
    if (sessionId && !isClaudeOperation) {
      const mapping = this.store.getLegacyProxyLease(sessionId);
      if (!mapping) return failure("SESSION_MOVED", "Legacy session must re-register");
      return projectV1ProxyResponse(
        request.type,
        await this.requestModern({
          ...request,
          protocolVersion: 2,
          sessionLease: mapping.lease,
        } as RoutedPremindRequest),
      );
    }

    return projectV1ProxyResponse(
      request.type,
      await this.requestModern({ ...request, protocolVersion: 2 } as RoutedPremindRequest),
    );
  }

  private async registerSession(
    request: Extract<
      typeof legacyRequestSchema._output,
      { type: "registerSession" | "ensureSessionControl" }
    >,
  ): Promise<ProxyResponse> {
    const existing = this.store.getLegacyProxyLease(request.payload.sessionId);
    const proxyIncarnationNonce = randomUUID();
    const leaseResponse = existing
      ? await this.requestModern({
          type: "transferSessionLease",
          protocolVersion: 2,
          payload: {
            lease: existing.lease,
            nextOwner: {
              ownerInstanceId: this.modernInstanceId,
              clientIncarnationNonce: proxyIncarnationNonce,
            },
          },
        })
      : await this.requestModern({
          type: "claimSessionLease",
          protocolVersion: 2,
          payload: {
            sessionId: request.payload.sessionId,
            ownerInstanceId: this.modernInstanceId,
            clientIncarnationNonce: proxyIncarnationNonce,
          },
        });
    if (!leaseResponse.ok) return v1Response(leaseResponse);
    const lease = sessionLeaseTokenSchema.parse(
      (leaseResponse.result as { lease?: unknown }).lease,
    );
    const response = await this.requestModern({
      ...request,
      protocolVersion: 2,
      sessionLease: lease,
    } as RoutedPremindRequest);
    if (!response.ok) {
      await this.requestModern({
        type: "releaseSessionLease",
        protocolVersion: 2,
        payload: { lease },
      });
      return v1Response(response);
    }
    this.store.saveLegacyProxyLease({
      clientId: request.payload.clientId,
      proxyIncarnationNonce,
      lease,
    });
    return v1Response(response);
  }

  private async heartbeatClient(
    request: Extract<typeof legacyRequestSchema._output, { type: "heartbeatClient" }>,
  ): Promise<ProxyResponse> {
    const response = await this.requestModern({ ...request, protocolVersion: 2 });
    if (!response.ok) return v1Response(response);
    for (const mapping of this.store.listLegacyProxyLeases(request.payload.clientId)) {
      const renewed = await this.requestModern({
        type: "renewSessionLease",
        protocolVersion: 2,
        payload: { lease: mapping.lease },
      });
      if (!renewed.ok) {
        this.store.deleteLegacyProxyLease(mapping.lease.sessionId);
        continue;
      }
      const lease = sessionLeaseTokenSchema.parse(
        (renewed.result as { lease?: SessionLeaseToken }).lease,
      );
      this.store.saveLegacyProxyLease({ ...mapping, lease });
    }
    return v1Response(response);
  }

  private async unregisterSession(
    request: Extract<typeof legacyRequestSchema._output, { type: "unregisterSession" }>,
  ): Promise<ProxyResponse> {
    const mapping = this.store.getLegacyProxyLease(request.payload.sessionId);
    if (!mapping) return failure("SESSION_MOVED", "Legacy session must re-register");
    const response = await this.requestModern({
      ...request,
      protocolVersion: 2,
      sessionLease: mapping.lease,
    });
    if (response.ok) this.store.deleteLegacyProxyLease(request.payload.sessionId);
    return v1Response(response);
  }

  private async releaseClient(
    request: Extract<typeof legacyRequestSchema._output, { type: "releaseClient" }>,
  ): Promise<ProxyResponse> {
    for (const mapping of this.store.listLegacyProxyLeases(request.payload.clientId)) {
      await this.requestModern({
        type: "unregisterSession",
        protocolVersion: 2,
        sessionLease: mapping.lease,
        payload: { sessionId: mapping.lease.sessionId },
      });
      this.store.deleteLegacyProxyLease(mapping.lease.sessionId);
    }
    return v1Response(
      await this.requestModern({ ...request, protocolVersion: 2 }),
    );
  }
}
