import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"
import type { GitHubClientLike } from "../github/client.ts"

export class BranchDiscoveryWatcher {
  private readonly logger = createLogger("daemon.branch-discovery")

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClientLike,
  ) {}

  async tick(now = Date.now()) {
    const targets = this.store.listBranchWatchTargets(now)
    for (const target of targets) {
      try {
        const pr = await this.github.findOpenPullRequestForBranch(target.repo, target.branch)
        this.store.recordBranchAssociation(target.repo, target.branch, pr?.number ?? null, now)

        if (!pr) continue
        if (target.pr_number === pr.number) continue

        this.store.insertEvents(target.repo, pr.number, [
          {
            dedupeKey: `pr.discovered:${target.repo}:${target.branch}:${pr.number}`,
            kind: "pr.discovered",
            priority: "medium",
            summary: `Discovered open PR ${target.repo}#${pr.number}: ${pr.title}`,
            detailFilePath: pr.url,
            payload: {
              repo: target.repo,
              branch: target.branch,
              prNumber: pr.number,
              title: pr.title,
              url: pr.url,
            },
          },
        ], now)

        const sessions = this.store.listSessionsForBranch(target.repo, target.branch)
        for (const session of sessions) {
          this.store.buildReminderBatch(session.session_id, now)
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
