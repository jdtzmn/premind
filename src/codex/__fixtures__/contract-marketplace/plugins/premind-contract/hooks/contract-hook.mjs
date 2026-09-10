import fs from "node:fs/promises"
import path from "node:path"

const eventName = process.argv[2]
const supportedEvents = new Set(["SessionStart", "UserPromptSubmit", "Stop"])

if (!supportedEvents.has(eventName)) {
  process.stderr.write(`unsupported fixture event: ${eventName ?? "missing"}\n`)
  process.exit(1)
}

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)

let input
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
} catch {
  console.error("hook stdin must contain one JSON object")
  process.exit(1)
}

if (!input || typeof input !== "object" || Array.isArray(input)) {
  process.stderr.write("hook stdin must contain one JSON object\n")
  process.exit(1)
}

const valueType = (value) => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const pluginData = process.env.PLUGIN_DATA
if (!pluginData) {
  process.stderr.write("PLUGIN_DATA is required\n")
  process.exit(1)
}

const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown"
const captureDir = path.join(pluginData, "premind-contract")
const capturePath = path.join(captureDir, "events.jsonl")
const externalCapturePath = process.env.PREMIND_CODEX_CONTRACT_OUTPUT
const safeSessionId = Buffer.from(sessionId).toString("base64url")
const stopMarkerPath = path.join(captureDir, `stop-${safeSessionId}.json`)

await fs.mkdir(captureDir, { recursive: true })
const captureRecord = `${JSON.stringify({
  event: eventName,
  keys: Object.keys(input).sort(),
  types: Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, valueType(value)]),
  ),
  source: typeof input.source === "string" ? input.source : undefined,
  stopHookActive:
    typeof input.stop_hook_active === "boolean"
      ? input.stop_hook_active
      : undefined,
})}\n`
await fs.appendFile(capturePath, captureRecord, "utf8")
if (externalCapturePath) {
  await fs.mkdir(path.dirname(externalCapturePath), { recursive: true })
  await fs.appendFile(externalCapturePath, captureRecord, "utf8")
}

if (eventName === "SessionStart") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "premind contract fixture: SessionStart context accepted",
      },
    })}\n`,
  )
} else if (eventName === "UserPromptSubmit") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "premind contract fixture: UserPromptSubmit context accepted",
      },
    })}\n`,
  )
} else if (input.stop_hook_active === true) {
  await fs.writeFile(
    stopMarkerPath,
    `${JSON.stringify({ continuationObserved: true })}\n`,
    "utf8",
  )
  process.stdout.write("{}\n")
} else {
  try {
    await fs.access(stopMarkerPath)
    process.stdout.write("{}\n")
  } catch {
    await fs.writeFile(
      stopMarkerPath,
      `${JSON.stringify({ continuationRequested: true })}\n`,
      "utf8",
    )
    process.stdout.write(
      `${JSON.stringify({
        decision: "block",
        reason: "premind contract fixture: run exactly one continuation",
      })}\n`,
    )
  }
}
