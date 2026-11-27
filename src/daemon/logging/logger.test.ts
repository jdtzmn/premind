import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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
    assert.equal(entry.pid, process.pid)
    assert.equal(entry.level, "info")
    assert.equal(entry.extra?.testField, true)
    assert.ok(typeof entry.ts === "string", "entry should have a timestamp")
  })

  // Hosts used to spawn the daemon with piped stdio. When the host exited, the
  // daemon's next log line hit a closed pipe and EPIPE crashed it.
  test("keeps the process alive after the reader of its stdout and stderr exits", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-logger-"))
    const script = [
      `const { createLogger } = await import(${JSON.stringify(new URL("./logger.ts", import.meta.url).href)})`,
      `const logger = createLogger("logger-test")`,
      `process.stdin.once("data", async () => {`,
      `  for (let i = 0; i < 20; i++) { logger.info("after host exit"); logger.error("after host exit"); await new Promise((r) => setTimeout(r, 10)) }`,
      `  process.stdin.destroy()`,
      `})`,
      `logger.info("ready")`,
    ].join("\n")
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, PREMIND_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    })
    try {
      await once(child.stdout, "data")
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.write("go\n")
      const [code, signal] = await once(child, "exit")
      assert.deepEqual({ code, signal }, { code: 0, signal: null })
      const lines = fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8").trim().split("\n")
      assert.equal(lines.filter((line) => line.includes("after host exit")).length, 40)
    } finally {
      child.kill()
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
