import fs from "node:fs"
import path from "node:path"
import { PREMIND_EVENT_DETAIL_DIR } from "../../shared/constants.ts"
import { createLogger } from "../logging/logger.ts"
import type { NormalizedPrEvent } from "../github/types.ts"

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-")

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/**
 * Returns true when an event kind carries enough body content (comment text,
 * review body, file/line context, etc.) to justify a local detail file.
 *
 * For kinds that only have shallow metadata already in the reminder summary
 * (notably `check.*` events, whose richer info lives in GitHub's CI logs we
 * never fetch) we skip the file write — the reminder template falls back to
 * the GitHub URL stored on the event itself, which is more useful than a
 * local file the agent would have to open just to learn it has nothing new.
 */
const shouldWriteDetailFile = (kind: string): boolean => {
  if (kind.startsWith("issue_comment.")) return true
  if (kind.startsWith("review_comment.")) return true
  if (kind.startsWith("review.")) return true
  return false
}

export class DetailFileWriter {
  private readonly logger = createLogger("daemon.detail-files")

  constructor(private readonly baseDir = PREMIND_EVENT_DETAIL_DIR) {
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  cleanup(ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
    let removed = 0
    const cutoff = now - ttlMs

    try {
      removed = this.cleanDir(this.baseDir, cutoff)
    } catch (error) {
      this.logger.warn("detail file cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return removed
  }

  private cleanDir(dirPath: string, cutoff: number): number {
    if (!fs.existsSync(dirPath)) return 0

    let removed = 0
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        removed += this.cleanDir(entryPath, cutoff)
        // Remove empty directories.
        const remaining = fs.readdirSync(entryPath)
        if (remaining.length === 0) {
          fs.rmdirSync(entryPath)
        }
        continue
      }

      try {
        const stat = fs.statSync(entryPath)
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(entryPath)
          removed++
        }
      } catch {
        // File may have been removed concurrently; skip.
      }
    }

    return removed
  }

  /**
   * Writes a detail file for the given event, returning the resulting absolute
   * path. Returns `null` when the event kind is not eligible (see
   * shouldWriteDetailFile) — in that case the caller should fall back to the
   * event's referenceLink (GitHub URL) so the reminder still carries a useful
   * link rather than a path to a redundant metadata-only file.
   */
  write(repo: string, prNumber: number, event: NormalizedPrEvent): string | null {
    if (!shouldWriteDetailFile(event.kind)) return null

    const repoDir = path.join(this.baseDir, sanitize(repo), String(prNumber))
    fs.mkdirSync(repoDir, { recursive: true })

    const filePath = path.join(repoDir, `${sanitize(event.dedupeKey)}.json`)
    const payload = this.render(repo, prNumber, event)

    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    return filePath
  }

  private render(repo: string, prNumber: number, event: NormalizedPrEvent) {
    const payload = event.payload
    const common = {
      repo,
      prNumber,
      kind: event.kind,
      priority: event.priority,
      summary: event.summary,
      referenceLink: event.referenceLink ?? null,
      generatedAt: new Date().toISOString(),
    }

    if (event.kind.startsWith("issue_comment.")) {
      return {
        ...common,
        type: "issue_comment",
        commentId: payload.commentId ?? null,
        author: payload.user ?? null,
        body: payload.body ?? null,
        previousBody: payload.previousBody ?? null,
        updatedAt: payload.updatedAt ?? null,
      }
    }

    if (event.kind.startsWith("review_comment.")) {
      return {
        ...common,
        type: "review_comment",
        commentId: payload.commentId ?? null,
        author: payload.user ?? null,
        file: payload.path ?? null,
        line: payload.line ?? null,
        body: payload.body ?? null,
        previousBody: payload.previousBody ?? null,
        updatedAt: payload.updatedAt ?? null,
      }
    }

    if (event.kind.startsWith("review.")) {
      return {
        ...common,
        type: "review",
        reviewId: payload.reviewId ?? null,
        author: payload.user ?? null,
        state: payload.state ?? null,
        body: payload.body ?? null,
      }
    }

    if (event.kind.startsWith("check.")) {
      return {
        ...common,
        type: "check",
        name: payload.name ?? null,
        state: payload.state ?? null,
        workflow: payload.workflow ?? null,
        event: payload.event ?? null,
      }
    }

    return {
      ...common,
      type: "generic",
      payload,
    }
  }
}
