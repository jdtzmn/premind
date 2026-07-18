import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, test } from "node:test"
import { PREMIND_DAEMON_LOG_PATH } from "../../shared/constants.ts"

// The logger writes to PREMIND_DAEMON_LOG_PATH which is the real state dir.
// We just verify that after a known write the file contains a parseable entry.

describe("Logger file output", () => {
  test("writes a parseable JSON entry to the daemon log file", async () => {
    const { createLogger } = await import("./logger.ts")
    const logger = createLogger("logger-test")

    const marker = `logger-test-${Date.now()}`
    logger.info(marker, { testField: true })

    // Give the stream a moment to flush.
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.ok(fs.existsSync(PREMIND_DAEMON_LOG_PATH), "daemon.log should exist after first write")

    const content = fs.readFileSync(PREMIND_DAEMON_LOG_PATH, "utf8")
    const lines = content.trim().split("\n").filter(Boolean)

    // Find our specific marker line.
    const matchingLine = lines.find((line) => {
      try {
        const entry = JSON.parse(line)
        return entry.message === marker
      } catch {
        return false
      }
    })

    assert.ok(matchingLine, `should find a log entry with message "${marker}"`)
    const entry = JSON.parse(matchingLine!)
    assert.equal(entry.service, "logger-test")
    assert.equal(entry.level, "info")
    assert.equal(entry.extra?.testField, true)
    assert.ok(typeof entry.ts === "string", "entry should have a timestamp")
  })
})
