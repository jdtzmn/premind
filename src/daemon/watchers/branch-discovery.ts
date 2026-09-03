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
    const targets = this.store.listBranchWatchTargets(now)
    for (const target of targets) {
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

        // result.kind === "ok"
        if (result.etag !== null) {
          this.store.saveEtag(BRANCH_PULLS_ETAG_SCOPE, etagKey(target.repo, target.branch), result.etag, now)
        }

        const pr = result.pr
        if (pr && target.pr_number !== null && pr.number !== target.pr_number) {
          const previousSnapshot = this.store.getSnapshot(target.repo, target.pr_number)
          const previousState = previousSnapshot?.core.state
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
        this.store.recordBranchAssociation(target.repo, target.branch, pr?.number ?? target.pr_number, now)
        if (!pr) continue
        if (target.pr_number === pr.number) continue

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
