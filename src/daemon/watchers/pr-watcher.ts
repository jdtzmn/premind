import { diffSnapshot } from "../github/diff.js"
import { GitHubClient } from "../github/client.js"
import { createLogger } from "../logging/logger.js"
import { StateStore } from "../persistence/store.js"

export class PullRequestWatcher {
  private readonly logger = createLogger("daemon.pr-watcher")

  constructor(
    private readonly store: StateStore,
    private readonly github: GitHubClient,
  ) {}

  async tick(now = Date.now()) {
    const targets = this.store.listPrWatchTargets(now)
    for (const target of targets) {
      try {
        const previous = this.store.getSnapshot(target.repo, target.pr_number)
        const next = await this.github.fetchPullRequestSnapshot(target.repo, target.pr_number)
        const events = diffSnapshot(previous, next)

        this.store.saveSnapshot(target.repo, target.pr_number, next)
        this.store.markPrWatchChecked(target.repo, target.pr_number, now)

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
