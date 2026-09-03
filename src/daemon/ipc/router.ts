import {
	PREMIND_CLIENT_HEARTBEAT_MS,
	PREMIND_CLIENT_LEASE_TTL_MS,
	PREMIND_IDLE_SHUTDOWN_GRACE_MS,
} from "../../shared/constants.ts";
import {
	debugStatusResponseSchema,
	type AckReminderPayload,
	type ActivateWorktreePayload,
	type RegisterClientPayload,
	type SubscribePayload,
	type UnsubscribePayload,
} from "../../shared/schema.ts";
import type { PremindRequest, PremindResponse } from "../../shared/ipc.ts";
import { createLogger } from "../logging/logger.ts";
import { StateStore } from "../persistence/store.ts";
import { resolveGitWorktree } from "../worktrees/git-resolver.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";
import type { ActiveWorktree } from "../worktrees/worktree-binding.ts";

export type WorktreeResolver = (
	requestedPath: string,
) => Promise<ActiveWorktree>;

export class Router {
	private readonly logger = createLogger("daemon.ipc");

	constructor(
		private readonly store: StateStore,
		private readonly resolveWorktree: WorktreeResolver = resolveGitWorktree,
		private readonly worktreeBindings = new WorktreeBindingRegistry(store),
	) {}

	async handle(request: PremindRequest): Promise<PremindResponse> {
		switch (request.type) {
			case "registerClient":
				return this.ok(this.handleRegisterClient(request.payload));
			case "heartbeatClient": {
				const renewed = this.store.heartbeatClient(request.payload.clientId);
				if (!renewed)
					return this.fail(
						"CLIENT_NOT_FOUND",
						`Unknown client: ${request.payload.clientId}`,
					);
				return this.ok({ renewed: true });
			}
			case "releaseClient":
				this.store.releaseClient(request.payload.clientId);
				return this.ok({ released: true });
			case "registerSession": {
				const { created, superseded } = this.store.registerSession(
					request.payload,
				);
				this.logger.info(
					created ? "session registered" : "session re-registered",
					{
						sessionId: request.payload.sessionId,
						repo: request.payload.repo,
						branch: request.payload.branch,
						reattach: !created,
						...(superseded > 0 ? { superseded } : {}),
					},
				);
				return this.ok({ registered: true, created });
			}
			case "ensureSessionControl": {
				if (!this.store.hasActiveClient(request.payload.clientId)) {
					return this.fail(
						"CLIENT_NOT_FOUND",
						`Unknown client: ${request.payload.clientId}`,
					);
				}
				const { created, superseded } = this.store.ensureSessionControl(
					request.payload,
				);
				this.logger.info(
					created ? "session control attached" : "session control refreshed",
					{
						sessionId: request.payload.sessionId,
						repo: request.payload.repo,
						branch: request.payload.branch,
						paused: request.payload.paused,
						...(superseded > 0 ? { superseded } : {}),
					},
				);
				return this.ok({ attached: true, created, superseded });
			}
			case "updateSessionState": {
				const result = this.store.updateSessionState(request.payload);
				if (!result.updated)
					return this.fail(
						"SESSION_NOT_FOUND",
						`Unknown session: ${request.payload.sessionId}`,
					);
				if (result.revived) {
					this.logger.info("session revived from closed to active", {
						sessionId: request.payload.sessionId,
						trigger: request.payload.busyState,
					});
				} else if (request.payload.busyState) {
					this.logger.info("session state updated", {
						sessionId: request.payload.sessionId,
						busyState: request.payload.busyState,
					});
				}
				return this.ok({ updated: true, revived: result.revived });
			}
			case "unregisterSession":
				this.worktreeBindings.closeSession(request.payload.sessionId);
				this.store.unregisterSession(request.payload.sessionId);
				return this.ok({ unregistered: true });
			case "pauseSession": {
				const paused = this.store.setSessionPaused(
					request.payload.sessionId,
					true,
				);
				if (!paused)
					return this.fail(
						"SESSION_NOT_FOUND",
						`Unknown session: ${request.payload.sessionId}`,
					);
				return this.ok({ paused: true });
			}
			case "resumeSession": {
				const resumed = this.store.setSessionPaused(
					request.payload.sessionId,
					false,
				);
				if (!resumed)
					return this.fail(
						"SESSION_NOT_FOUND",
						`Unknown session: ${request.payload.sessionId}`,
					);
				return this.ok({ resumed: true });
			}
			case "activateWorktree":
				return await this.handleActivateWorktree(request.payload);
			case "subscribe":
				return this.handleSubscribe(request.payload);
			case "unsubscribe":
				return this.handleUnsubscribe(request.payload);
			case "getPendingReminder":
				return this.ok({
					batch: this.store.buildReminderBatch(request.payload.sessionId),
				});
			case "ackReminder":
				return this.ok(this.handleAckReminder(request.payload));
			case "setGlobalDisabled":
				this.store.setGloballyDisabled(request.payload.disabled);
				return this.ok({ disabled: request.payload.disabled });
			case "getGlobalDisabled":
				return this.ok({ disabled: this.store.isGloballyDisabled() });
			case "debugStatus":
				return this.ok(
					debugStatusResponseSchema.parse({
						daemon: {
							protocolVersion: 1,
							heartbeatMs: PREMIND_CLIENT_HEARTBEAT_MS,
							leaseTtlMs: PREMIND_CLIENT_LEASE_TTL_MS,
							idleShutdownGraceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
						},
						globallyDisabled: this.store.isGloballyDisabled(),
						activeClients: this.store.countActiveClients(),
						activeSessions: this.store.countActiveSessions(),
						closedSessions: this.store.countClosedSessions(),
						activeWatchers: this.store.countActiveWatchers(),
						lastReapAt: this.store.getLastReapAt(),
						lastReapCount: this.store.getLastReapCount(),
						sessions: this.store.listSessionSummaries(),
					}),
				);
			case "pruneClosedSessions":
				return this.ok(this.store.pruneClosedOrOrphanedSessions());
		}
	}

	hasActiveLeases() {
		return this.store.countActiveClients() > 0;
	}

	hasActiveSessions() {
		return this.store.countActiveSessions() > 0;
	}

	private async handleActivateWorktree(
		payload: ActivateWorktreePayload,
	): Promise<PremindResponse> {
		if (!this.store.getSession(payload.sessionId)) {
			return this.fail(
				"SESSION_NOT_FOUND",
				`Unknown session: ${payload.sessionId}`,
			);
		}

		try {
			const binding = await this.worktreeBindings.activateWorktree(
				payload.sessionId,
				payload.path,
				this.resolveWorktree,
			);
			return this.ok({ binding, watching: binding.branch !== null });
		} catch (error) {
			return this.fail(
				"WORKTREE_RESOLUTION_FAILED",
				error instanceof Error ? error.message : "Unable to resolve Git worktree",
			);
		}
	}

	private handleSubscribe(payload: SubscribePayload): PremindResponse {
		if (!this.store.getSession(payload.sessionId)) {
			return this.fail(
				"SESSION_NOT_FOUND",
				`Unknown session: ${payload.sessionId}`,
			);
		}
		const binding = this.store.getWorktreeBinding(payload.sessionId);
		const repo = payload.repo ?? binding?.repo;
		if (!repo) {
			return this.fail(
				"WORKTREE_NOT_ACTIVE",
				"An active worktree is required when repo is omitted",
			);
		}

		return this.ok({
			subscription: this.store.upsertSubscription({
				sessionId: payload.sessionId,
				repo,
				prNumber: payload.prNumber,
				source: "manual",
			}),
		});
	}

	private handleUnsubscribe(payload: UnsubscribePayload): PremindResponse {
		if (!this.store.getSession(payload.sessionId)) {
			return this.fail(
				"SESSION_NOT_FOUND",
				`Unknown session: ${payload.sessionId}`,
			);
		}
		const binding = this.store.getWorktreeBinding(payload.sessionId);
		const repo = payload.repo ?? binding?.repo;
		if (!repo) {
			return this.fail(
				"WORKTREE_NOT_ACTIVE",
				"An active worktree is required when repo is omitted",
			);
		}

		const subscription = this.store.getSubscription(
			payload.sessionId,
			repo,
			payload.prNumber,
		);
		if (
			subscription?.source === "automatic" &&
			binding?.repo === repo &&
			binding.branch !== null
		) {
			return this.ok(
				this.worktreeBindings.unsubscribeAutomatic(payload.sessionId, {
					repo,
					prNumber: payload.prNumber,
				}),
			);
		}

		const unsubscribed = this.store.unsubscribe(
			payload.sessionId,
			repo,
			payload.prNumber,
		);
		return this.ok({ unsubscribed, automaticOptOutRecorded: false });
	}

	private handleRegisterClient(payload: RegisterClientPayload) {
		this.store.registerClient(payload.clientId, payload.metadata);
		return {
			heartbeatMs: PREMIND_CLIENT_HEARTBEAT_MS,
			leaseTtlMs: PREMIND_CLIENT_LEASE_TTL_MS,
			idleShutdownGraceMs: PREMIND_IDLE_SHUTDOWN_GRACE_MS,
		};
	}

	private handleAckReminder(payload: AckReminderPayload) {
		const acknowledged = this.store.ackReminder(payload);
		if (!acknowledged) {
			return { acknowledged: false, retryable: payload.state === "failed" };
		}

		return { acknowledged: true, retryable: payload.state === "failed" };
	}

	private ok(result: unknown): PremindResponse {
		return { ok: true, protocolVersion: 1, result };
	}

	private fail(code: string, message: string): PremindResponse {
		return { ok: false, protocolVersion: 1, error: { code, message } };
	}
}
