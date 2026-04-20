import { diffSnapshot } from "../github/diff.ts"
import type { GitHubClientLike } from "../github/client.ts"
import { createLogger } from "../logging/logger.ts"
import { StateStore } from "../persistence/store.ts"

const PR_SNAPSHOT_ETAG_SCOPE = "pr.snapshot"

const etagKey = (repo: string, prNumber: number) => `${repo}#${prNumber}`

export class PullRequestWatcher {
  private readonly logger = createLogger("daemon.pr-watcher")

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClientLike,
  ) {}

  async tick(now = Date.now()) {
    const targets = this.store.listPrWatchTargets(now)
    for (const target of targets) {
      try {
        const previous = this.store.getSnapshot(target.repo, target.pr_number)
        const cachedEtag = this.store.getEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.pr_number))
        const result = await this.github.fetchPullRequestSnapshot(target.repo, target.pr_number, {
          etag: cachedEtag,
        })

        this.store.markPrWatchChecked(target.repo, target.pr_number, now)

        if (result.kind === "not_modified") {
          // Nothing changed server-side. No diff, no events, no DB churn.
          // Refresh the stored etag if the server rotated it.
          if (result.etag && result.etag !== cachedEtag) {
            this.store.saveEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.pr_number), result.etag, now)
          }
          continue
        }

        if (result.kind === "not_found") {
          this.logger.info("pr not found; skipping", { repo: target.repo, prNumber: target.pr_number })
          continue
        }

        const next = result.snapshot
        const events = diffSnapshot(previous, next)

        this.store.saveSnapshot(target.repo, target.pr_number, next)
        this.store.saveEtag(PR_SNAPSHOT_ETAG_SCOPE, etagKey(target.repo, target.pr_number), result.etag, now)

        if (events.length === 0) continue

        this.store.insertEvents(target.repo, target.pr_number, events, now)
        const sessions = this.store.listSessionsForPr(target.repo, target.pr_number)
        for (const session of sessions) {
          this.store.buildReminderBatch(session.session_id, now)
        }
      } catch (error) {
        this.logger.warn("pr watcher failed", {
          repo: target.repo,
          prNumber: target.pr_number,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
