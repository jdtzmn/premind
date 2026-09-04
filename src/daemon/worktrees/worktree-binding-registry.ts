import type { StateStore, WorktreeBinding } from "../persistence/store.ts";
import {
	createWorktreeBindingActor,
	type ActiveWorktree,
	type PullRequestRef,
} from "./worktree-binding.ts";

export type WorktreeBindingActor = ReturnType<typeof createWorktreeBindingActor>;
export type WorktreeResolver = (requestedPath: string) => Promise<ActiveWorktree>;

const durableBindingStates = new Set([
	"waiting_for_pr",
	"following_automatic_pr",
	"automatic_pr_unsubscribed",
	"foreign_pr",
	"detached_head",
]);

const samePullRequest = (
	left: PullRequestRef | null,
	right: PullRequestRef,
) => left?.repo === right.repo && left.prNumber === right.prNumber;

/**
 * Owns the live worktree-binding actors for one daemon process.
 *
 * SQLite is authoritative. Actors are reconstructed by replaying durable facts,
 * and any actor whose transition cannot be persisted is discarded immediately.
 */
export class WorktreeBindingRegistry {
	private readonly actors = new Map<string, WorktreeBindingActor>();

	constructor(private readonly store: StateStore) {}

	has(sessionId: string): boolean {
		return this.actors.has(sessionId);
	}

	get size(): number {
		return this.actors.size;
	}

	getSnapshot(sessionId: string) {
		return this.getOrCreate(sessionId).getSnapshot();
	}

	async activateWorktree(
		sessionId: string,
		requestedPath: string,
		resolveWorktree: WorktreeResolver,
	): Promise<WorktreeBinding> {
		const actor = this.getOrCreate(sessionId);
		actor.send({ type: "ACTIVATE_WORKTREE", path: requestedPath });

		let worktree: ActiveWorktree;
		try {
			worktree = await resolveWorktree(requestedPath);
		} catch (error) {
			actor.send({ type: "WORKTREE_RESOLUTION_FAILED" });
			this.discard(sessionId);
			throw error;
		}

		actor.send({ type: "WORKTREE_RESOLVED", worktree });
		return this.persist(sessionId, () => {
			const binding = this.bindingFromActor(sessionId, actor);
			return this.store.activateWorktree(binding);
		});
	}

	pullRequestFound(
		sessionId: string,
		pullRequest: PullRequestRef,
		now = Date.now(),
	): WorktreeBinding | null {
		const durableBinding = this.store.getWorktreeBinding(sessionId);
		if (!durableBinding) return null;
		const optedOut =
			durableBinding.branch !== null &&
			durableBinding.repo === pullRequest.repo &&
			this.store.hasAutomaticSubscriptionOptOut({
				sessionId,
				gitDir: durableBinding.gitDir,
				repo: durableBinding.repo,
				branch: durableBinding.branch,
				prNumber: pullRequest.prNumber,
			});

		const actor = this.getOrCreate(sessionId);
		if (actor.getSnapshot().value === "resolving_worktree") return null;
		const previousPullRequest = actor.getSnapshot().context.automaticPullRequest;
		actor.send({ type: "PR_FOUND", pullRequest });
		if (optedOut) {
			actor.send({ type: "UNSUBSCRIBE_AUTOMATIC", pullRequest });
		}

		return this.persist(sessionId, () =>
			this.store.transaction(() => {
				const binding = this.store.upsertWorktreeBinding(
					this.bindingFromActor(sessionId, actor),
					now,
				);
				if (binding.state === "following_automatic_pr") {
					if (!samePullRequest(previousPullRequest, pullRequest)) {
						this.store.deactivateAutomaticSubscriptions(sessionId, now);
					}
					this.store.baselineAutomaticSubscription(
						{ sessionId, repo: pullRequest.repo, prNumber: pullRequest.prNumber },
						now,
					);
				}
				return binding;
			}),
		);
	}

  pullRequestNotOwned(
    sessionId: string,
    pullRequest: PullRequestRef,
    now = Date.now(),
  ): WorktreeBinding | null {
    if (!this.store.getWorktreeBinding(sessionId)) return null;

    const actor = this.getOrCreate(sessionId);
    if (actor.getSnapshot().value === "resolving_worktree") return null;
    actor.send({ type: "PR_NOT_OWNED", pullRequest });
    return this.persist(sessionId, () =>
      this.store.transaction(() => {
        this.store.deactivateAutomaticSubscriptions(sessionId, now);
        return this.store.upsertWorktreeBinding(
          this.bindingFromActor(sessionId, actor),
          now,
        );
      }),
    );
  }

	pullRequestNotFound(sessionId: string, now = Date.now()): WorktreeBinding | null {
		if (!this.store.getWorktreeBinding(sessionId)) return null;

		const actor = this.getOrCreate(sessionId);
		if (actor.getSnapshot().value === "resolving_worktree") return null;
		actor.send({ type: "PR_NOT_FOUND" });
		return this.persist(sessionId, () =>
			this.store.upsertWorktreeBinding(
				this.bindingFromActor(sessionId, actor),
				now,
			),
		);
	}

	unsubscribeAutomatic(
		sessionId: string,
		pullRequest: PullRequestRef,
		now = Date.now(),
	): { unsubscribed: boolean; automaticOptOutRecorded: boolean } {
		const subscription = this.store.getSubscription(
			sessionId,
			pullRequest.repo,
			pullRequest.prNumber,
		);
		if (subscription?.source !== "automatic" || subscription.state !== "active") {
			return { unsubscribed: false, automaticOptOutRecorded: false };
		}

		let actor = this.getOrCreate(sessionId);
		if (!samePullRequest(actor.getSnapshot().context.automaticPullRequest, pullRequest)) {
			this.discard(sessionId);
			actor = this.getOrCreate(sessionId);
		}
		actor.send({ type: "UNSUBSCRIBE_AUTOMATIC", pullRequest });

		return this.persist(sessionId, () =>
			this.store.transaction(() => {
				const unsubscribed = this.store.unsubscribe(
					sessionId,
					pullRequest.repo,
					pullRequest.prNumber,
					now,
				);
				const binding = this.bindingFromActor(sessionId, actor);
				let automaticOptOutRecorded = false;
				if (
					unsubscribed &&
					binding.state === "automatic_pr_unsubscribed" &&
					binding.repo === pullRequest.repo &&
					binding.branch !== null
				) {
					this.store.recordAutomaticSubscriptionOptOut(
						{
							sessionId,
							gitDir: binding.gitDir,
							repo: binding.repo,
							branch: binding.branch,
							prNumber: pullRequest.prNumber,
						},
						now,
					);
					automaticOptOutRecorded = true;
				}
				this.store.upsertWorktreeBinding(binding, now);
				return { unsubscribed, automaticOptOutRecorded };
			}),
		);
	}

	closeSession(sessionId: string): void {
		const actor = this.actors.get(sessionId);
		if (!actor) return;
		actor.send({ type: "SESSION_CLOSED" });
		actor.stop();
		this.actors.delete(sessionId);
	}

	closeSessions(sessionIds: Iterable<string>): void {
		for (const sessionId of sessionIds) this.closeSession(sessionId);
	}

	closeInactiveSessions(): void {
		for (const sessionId of this.actors.keys()) {
			if (this.store.getSession(sessionId)?.status === "closed") {
				this.closeSession(sessionId);
			}
		}
	}

	close(): void {
		this.closeSessions([...this.actors.keys()]);
	}

	private getOrCreate(sessionId: string): WorktreeBindingActor {
		const existing = this.actors.get(sessionId);
		if (existing) return existing;

		const actor = createWorktreeBindingActor();
		actor.start();
		try {
			this.restoreFromStore(sessionId, actor);
			this.actors.set(sessionId, actor);
			return actor;
		} catch (error) {
			actor.stop();
			throw error;
		}
	}

	private restoreFromStore(sessionId: string, actor: WorktreeBindingActor): void {
		const binding = this.store.getWorktreeBinding(sessionId);
		if (!binding) return;

		actor.send({ type: "ACTIVATE_WORKTREE", path: binding.root });
		actor.send({
			type: "WORKTREE_RESOLVED",
			worktree: {
				root: binding.root,
				gitDir: binding.gitDir,
				repo: binding.repo,
				branch: binding.branch,
				headSha: binding.headSha,
			},
		});
		if (binding.branch === null) return;

		const automaticSubscription = this.store
			.listSessionSubscriptions(sessionId, "active")
			.filter(
				(subscription) =>
					subscription.source === "automatic" &&
					subscription.repo === binding.repo,
			)
			.at(-1);
		if (automaticSubscription) {
			actor.send({
				type: "PR_FOUND",
				pullRequest: {
					repo: automaticSubscription.repo,
					prNumber: automaticSubscription.prNumber,
				},
			});
			return;
		}

		const optOut = this.store.getAutomaticSubscriptionOptOutForBinding({
			sessionId,
			gitDir: binding.gitDir,
			repo: binding.repo,
			branch: binding.branch,
		});
		if (!optOut) return;
		const pullRequest = { repo: binding.repo, prNumber: optOut.prNumber };
		actor.send({ type: "PR_FOUND", pullRequest });
		actor.send({ type: "UNSUBSCRIBE_AUTOMATIC", pullRequest });
	}

	private bindingFromActor(
		sessionId: string,
		actor: WorktreeBindingActor,
	): Omit<WorktreeBinding, "updatedAt"> {
		const snapshot = actor.getSnapshot();
		const state = snapshot.value;
		const worktree = snapshot.context.worktree;
		if (!durableBindingStates.has(state) || !worktree) {
			throw new Error(
				`Worktree binding actor for ${sessionId} is not in a durable bound state`,
			);
		}
		return { sessionId, ...worktree, state };
	}

	private persist<T>(sessionId: string, operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			this.discard(sessionId);
			throw error;
		}
	}

	private discard(sessionId: string): void {
		const actor = this.actors.get(sessionId);
		actor?.stop();
		this.actors.delete(sessionId);
	}
}
