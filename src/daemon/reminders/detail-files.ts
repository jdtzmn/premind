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
    const payload = {
      kind: event.kind,
      priority: event.priority,
      summary: event.summary,
      sourceLink: event.detailFilePath ?? null,
      payload: event.payload,
    }

    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    return filePath
  }
}
