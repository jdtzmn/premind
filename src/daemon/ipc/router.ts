import {
	PREMIND_CLIENT_HEARTBEAT_MS,
	PREMIND_CLIENT_LEASE_TTL_MS,
	PREMIND_IDLE_SHUTDOWN_GRACE_MS,
} from "../../shared/constants.ts";
import { CLAUDE_REQUIRED_DAEMON_OPERATIONS } from "../../shared/daemon-startup.ts";
import {
	debugStatusResponseSchema,
	type AckReminderPayload,
	type RegisterClientPayload,
	type SubscribePayload,
	type UnsubscribePayload,
} from "../../shared/schema.ts";
import type { PremindResponse, RoutedPremindRequest } from "../../shared/ipc.ts";
import { createLogger } from "../logging/logger.ts";
import type { StateStore } from "../persistence/store.ts";
import { ReminderHandoffRegistry } from "../reminders/reminder-handoff-registry.ts";
import { resolveGitWorktree } from "../worktrees/git-resolver.ts";
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts";
import type { ActiveWorktree } from "../worktrees/worktree-binding.ts";

const SESSION_LEASE_REQUIRED_OPERATIONS = new Set([
	"registerSession",
	"ensureSessionControl",
	"updateSessionState",
	"unregisterSession",
	"deleteSession",
	"pauseSession",
	"resumeSession",
	"activateWorktree",
	"subscribe",
	"unsubscribe",
	"claimReminderBundle",
	"ackReminderBundle",
	"getPendingReminder",
	"ackReminder",
]);

export type WorktreeResolver = (
	requestedPath: string,
) => Promise<ActiveWorktree>;

export class Router {
	private readonly logger = createLogger("daemon.ipc");

	constructor(
		private readonly store: StateStore,
		private readonly resolveWorktree: WorktreeResolver = resolveGitWorktree,
		private readonly worktreeBindings = new WorktreeBindingRegistry(store),
		private readonly reminderHandoffs = new ReminderHandoffRegistry(store),
		private readonly onDemandChanged: () => void = () => {},
	) {}

	async handle(request: RoutedPremindRequest): Promise<PremindResponse> {
		if (
			request.protocolVersion === 2 &&
			SESSION_LEASE_REQUIRED_OPERATIONS.has(request.type) &&
			!request.sessionLease
		) {
			return this.fail("SESSION_MOVED", "Protocol v2 session operation requires a lease");
		}
		const leaseFailure = this.attachedSessionLeaseFailure(request);
		if (leaseFailure) return leaseFailure;
		try {
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
				case "claimSessionLease":
					try {
						return this.ok({ lease: this.store.claimSessionLease(request.payload) });
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "renewSessionLease": {
					const lease = this.store.renewSessionLease(request.payload.lease);
					return lease
						? this.ok({ lease })
						: this.fail("SESSION_MOVED", "Session lease is stale or expired");
				}
				case "transferSessionLease":
					try {
						return this.ok({
							lease: this.store.transferSessionLease(
								request.payload.lease,
								request.payload.nextOwner,
							),
						});
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "releaseSessionLease": {
					const released = this.store.releaseSessionLease(request.payload.lease);
					return released
						? this.ok({ released: true })
						: this.fail("SESSION_MOVED", "Session lease is stale or expired");
				}
				case "registerSession": {
					let registered;
					try {
						registered = this.withAttachedSessionLease(request, () =>
							this.store.registerSession(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					const { created, superseded } = registered;
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
					let controlled;
					try {
						controlled = this.withAttachedSessionLease(request, () =>
							this.store.ensureSessionControl(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					const { created, superseded } = controlled;
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
				case "registerClaudeSession": {
					const { created } = this.store.registerSession({
						...request.payload,
						host: "claude",
						hostSessionId: request.payload.hostSessionId ?? request.payload.sessionId,
						clientId: `claude:${request.payload.sessionId}`,
						isPrimary: true,
						status: "active",
					});
					return this.ok({ registered: true, created });
				}
				case "touchClaudeSession": {
					const result = this.store.updateSessionState(request.payload);
					if (!result.updated)
						return this.fail(
							"SESSION_NOT_FOUND",
							`Unknown session: ${request.payload.sessionId}`,
						);
					return this.ok({ updated: true, revived: result.revived });
				}
				case "claimClaudeReminder":
					return this.ok({
						batch: this.reminderHandoffs.claimClaudeReminder(
							request.payload.sessionId,
						),
					});
				case "confirmClaudeHandoff":
					return this.ok({
						confirmed: this.reminderHandoffs.confirmClaudeHandoff(
							request.payload.sessionId,
						),
					});
				case "suspendClaudeSession": {
					const suspended = this.store.suspendClaudeSession(
						request.payload.sessionId,
					);
					if (!suspended)
						return this.fail(
							"SESSION_NOT_FOUND",
							`Unknown Claude session: ${request.payload.sessionId}`,
						);
					this.worktreeBindings.closeSession(request.payload.sessionId);
					return this.ok({ suspended: true });
				}
				case "updateSessionState": {
					let result;
					try {
						result = this.withAttachedSessionLease(request, () =>
							this.store.updateSessionState(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
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
					try {
						this.withAttachedSessionLease(request, () => {
							if (request.sessionLease) {
								this.store.releaseSessionLease(request.sessionLease);
							}
							this.store.unregisterSession(request.payload.sessionId);
						});
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					this.worktreeBindings.closeSession(request.payload.sessionId);
					return this.ok({ unregistered: true });
				case "deleteSession": {
					let deleted;
					try {
						deleted = this.withAttachedSessionLease(request, () =>
							this.store.deleteSession(request.payload.sessionId),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					if (!deleted)
						return this.fail(
							"SESSION_NOT_FOUND",
							`Unknown session: ${request.payload.sessionId}`,
						);
					this.worktreeBindings.closeSession(request.payload.sessionId);
					return this.ok({ deleted: true });
				}
				case "pauseSession": {
					let paused;
					try {
						paused = this.withAttachedSessionLease(request, () =>
							this.store.setSessionPaused(request.payload.sessionId, true),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					if (!paused)
						return this.fail(
							"SESSION_NOT_FOUND",
							`Unknown session: ${request.payload.sessionId}`,
						);
					return this.ok({ paused: true });
				}
				case "resumeSession": {
					let resumed;
					try {
						resumed = this.withAttachedSessionLease(request, () =>
							this.store.setSessionPaused(request.payload.sessionId, false),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
					if (!resumed)
						return this.fail(
							"SESSION_NOT_FOUND",
							`Unknown session: ${request.payload.sessionId}`,
						);
					return this.ok({ resumed: true });
				}
				case "activateWorktree":
					return await this.handleActivateWorktree(request);
				case "subscribe":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.handleSubscribe(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "unsubscribe":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.handleUnsubscribe(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "claimReminderBundle":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.ok({
								bundle: this.reminderHandoffs.claimReminderBundle(
									request.payload.sessionId,
								),
							}),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "ackReminderBundle":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.ok({
								acknowledged: this.reminderHandoffs.acknowledgeBundle(
									request.payload,
								),
							}),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "getPendingReminder":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.ok({
								batch: this.reminderHandoffs.getPendingReminder(
									request.payload.sessionId,
								),
							}),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
				case "ackReminder":
					try {
						return this.withAttachedSessionLease(request, () =>
							this.handleAckReminder(request.payload),
						);
					} catch (error) {
						return this.sessionLeaseFailure(error);
					}
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
								operations: [...CLAUDE_REQUIRED_DAEMON_OPERATIONS],
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
		} finally {
			this.onDemandChanged();
		}
	}

	hasActiveLeases() {
		return this.store.countActiveClients() > 0;
	}

	hasActiveSessions() {
		return this.store.countActiveSessions() > 0;
	}

	hasDaemonDemand(now = Date.now()) {
		return this.store.hasDaemonDemand(now);
	}

	private async handleActivateWorktree(
		request: RoutedPremindRequest & { type: "activateWorktree" },
	): Promise<PremindResponse> {
		const payload = request.payload;
		if (!this.store.getSession(payload.sessionId)) {
			return this.fail(
				"SESSION_NOT_FOUND",
				`Unknown session: ${payload.sessionId}`,
			);
		}

		let worktree: ActiveWorktree;
		try {
			worktree = await this.resolveWorktree(payload.path);
		} catch (error) {
			return this.fail(
				"WORKTREE_RESOLUTION_FAILED",
				error instanceof Error ? error.message : "Unable to resolve Git worktree",
			);
		}
		try {
			const binding = this.withAttachedSessionLease(request, () =>
				this.worktreeBindings.activateResolvedWorktree(
					payload.sessionId,
					payload.path,
					worktree,
				),
			);
			return this.ok({ binding, watching: binding.branch !== null });
		} catch (error) {
			return this.sessionLeaseFailure(error);
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

		const stored = this.store.upsertSubscription({
			sessionId: payload.sessionId,
			repo,
			prNumber: payload.prNumber,
			source: "manual",
		});
		return this.ok({
			subscription: {
				subscriptionId: stored.subscriptionId,
				sessionId: stored.sessionId,
				repo: stored.repo,
				prNumber: stored.prNumber,
				source: stored.source,
				state: stored.state,
				lastDeliveredEventSeq: stored.lastDeliveredEventSeq,
				updatedAt: stored.updatedAt,
			},
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

	private handleAckReminder(payload: AckReminderPayload): PremindResponse {
		const result = this.reminderHandoffs.acknowledge(payload);
		if (!result.acknowledged) {
			return this.fail(result.code, result.message);
		}
		return this.ok(result);
	}

	private attachedSessionLeaseFailure(
		request: RoutedPremindRequest,
	): PremindResponse | null {
		if (!request.sessionLease) return null;
		const sessionId = (request.payload as { sessionId?: unknown }).sessionId;
		if (
			typeof sessionId !== "string" ||
			request.sessionLease.sessionId !== sessionId ||
			!this.store.validateSessionLease(request.sessionLease)
		) {
			return this.fail("SESSION_MOVED", "Session lease is stale or belongs elsewhere");
		}
		return null;
	}


	private withAttachedSessionLease<T>(
		request: RoutedPremindRequest,
		operation: () => T,
	): T {
		if (!request.sessionLease) return operation();
		const sessionId = (request.payload as { sessionId?: unknown }).sessionId;
		if (
			typeof sessionId !== "string" ||
			request.sessionLease.sessionId !== sessionId
		) {
			throw new Error("SESSION_MOVED: session lease belongs elsewhere");
		}
		return this.store.withSessionLease(request.sessionLease, operation);
	}


	private sessionLeaseFailure(error: unknown): PremindResponse {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("SESSION_BUSY:")) {
			return this.fail("SESSION_BUSY", message);
		}
		if (message.startsWith("SESSION_MOVED:")) {
			return this.fail("SESSION_MOVED", message);
		}
		throw error;
	}

	private ok(result: unknown): PremindResponse {
		return { ok: true, protocolVersion: 1, result };
	}

	private fail(code: string, message: string): PremindResponse {
		return { ok: false, protocolVersion: 1, error: { code, message } };
	}
}
