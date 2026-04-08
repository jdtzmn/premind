import fs from "node:fs"
import path from "node:path"
import { PREMIND_EVENT_DETAIL_DIR } from "../../shared/constants.js"
import type { NormalizedPrEvent } from "../github/types.js"

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-")

export class DetailFileWriter {
  constructor(private readonly baseDir = PREMIND_EVENT_DETAIL_DIR) {
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  write(repo: string, prNumber: number, event: NormalizedPrEvent) {
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
      sourceLink: event.detailFilePath ?? null,
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
