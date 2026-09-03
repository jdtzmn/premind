import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"
import type { GitHubClientLike } from "../github/client.ts"

const BRANCH_PULLS_ETAG_SCOPE = "branch.pulls"

const etagKey = (repo: string, branch: string) => `${repo}#${branch}`

export class BranchDiscoveryWatcher {
  private readonly logger = createLogger("daemon.branch-discovery")

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClientLike,
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
        if (!pr) continue

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

        for (const binding of targets) {
          if (this.store.hasAutomaticSubscriptionOptOut({
            sessionId: binding.session_id,
            gitDir: binding.git_dir,
            repo: binding.repo,
            branch: binding.branch,
            prNumber: pr.number,
          })) continue
          this.store.baselineAutomaticSubscription({
            sessionId: binding.session_id,
            repo: binding.repo,
            prNumber: pr.number,
          }, now)
        }
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
