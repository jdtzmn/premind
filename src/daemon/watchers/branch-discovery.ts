import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"
import type { GitHubClientLike } from "../github/client.ts"
import { WorktreeBindingRegistry } from "../worktrees/worktree-binding-registry.ts"

const BRANCH_PULLS_ETAG_SCOPE = "branch.pulls"

const etagKey = (repo: string, branch: string) => `${repo}#${branch}`

export class BranchDiscoveryWatcher {
  private readonly logger = createLogger("daemon.branch-discovery")

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClientLike,
    private readonly worktreeBindings = new WorktreeBindingRegistry(store),
  ) {}

  async tick(now = Date.now()) {
    const targetsByBranch = new Map<string, ReturnType<StateStore["listActiveWorktreeBranchTargets"]>>()
    for (const target of this.store.listActiveWorktreeBranchTargets(now)) {
      const key = etagKey(target.repo, target.branch)
      const targets = targetsByBranch.get(key)
      if (targets) targets.push(target)
      else targetsByBranch.set(key, [target])
    }

    for (const targets of targetsByBranch.values()) {
      const target = targets[0]!
      try {
        const cachedEtag = this.store.getEtag(BRANCH_PULLS_ETAG_SCOPE, etagKey(target.repo, target.branch))
        const result = await this.github.findOpenPullRequestForBranch(target.repo, target.branch, {
          etag: cachedEtag,
        })

        if (result.kind === "not_modified") {
          // Nothing changed on GitHub's side. If the server rotated the etag we still persist it.
          if (result.etag && result.etag !== cachedEtag) {
            this.store.saveEtag(BRANCH_PULLS_ETAG_SCOPE, etagKey(target.repo, target.branch), result.etag, now)
          }
          continue
        }

        if (result.etag !== null) {
          this.store.saveEtag(BRANCH_PULLS_ETAG_SCOPE, etagKey(target.repo, target.branch), result.etag, now)
        }

        const pr = result.pr
        if (pr && target.pr_number !== null && pr.number !== target.pr_number) {
          const previousState = this.store.getSnapshot(target.repo, target.pr_number)?.core.state
          if (previousState !== "MERGED" && previousState !== "CLOSED") {
            this.logger.info("deferring branch reassociation until prior PR reaches a terminal state", {
              repo: target.repo,
              branch: target.branch,
              previousPrNumber: target.pr_number,
              nextPrNumber: pr.number,
              previousState: previousState ?? null,
            })
            continue
          }
        }
        // Keep the legacy attachment synchronized during the subscription migration.
        // A missing open PR must not detach a previously resolved PR before its
        // terminal snapshot has been observed and delivered.
        this.store.recordBranchAssociation(
          target.repo,
          target.branch,
          pr?.number ?? target.pr_number,
          now,
        )
        if (!pr) {
          for (const binding of targets) {
            if (binding.git_dir !== "") {
              this.worktreeBindings.pullRequestNotFound(binding.session_id, now)
            }
          }
          continue
        }

        // Establish each automatic subscription at the existing stream high-water mark
        // before appending the discovery event, so the new association itself remains
        // pending for every session that just began following this PR.
        for (const binding of targets) {
          if (binding.git_dir !== "") {
            this.worktreeBindings.pullRequestFound(
              binding.session_id,
              { repo: binding.repo, prNumber: pr.number },
              now,
            )
          }
        }

        this.store.insertEvents(target.repo, pr.number, [
          {
            dedupeKey: `pr.discovered:${target.repo}:${target.branch}:${pr.number}`,
            kind: "pr.discovered",
            priority: "medium",
            summary: `Discovered open PR ${target.repo}#${pr.number}: ${pr.title}`,
            referenceLink: pr.url,
            payload: {
              repo: target.repo,
              branch: target.branch,
              prNumber: pr.number,
              title: pr.title,
              url: pr.url,
            },
          },
        ], now)
      } catch (error) {
        this.logger.warn("branch discovery failed", {
          repo: target.repo,
          branch: target.branch,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
