import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(THIS_DIR, "..", "..", "..")
const MARKETPLACE_ROOT = path.join(
  ROOT,
  "src",
  "codex",
  "__fixtures__",
  "contract-marketplace",
)
const PLUGIN_ROOT = path.join(MARKETPLACE_ROOT, "plugins", "premind-contract")
const HOOK_PATH = path.join(PLUGIN_ROOT, "hooks", "contract-hook.mjs")

type HookResult = {
  code: number | null
  stdout: string
  stderr: string
}

async function runHook(
  eventName: "SessionStart" | "UserPromptSubmit" | "Stop",
  input: Record<string, unknown>,
  pluginData: string,
): Promise<HookResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, eventName], {
      env: {
        ...process.env,
        PLUGIN_ROOT,
        PLUGIN_DATA: pluginData,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}

describe("Codex contract fixture", () => {
  test("portable marketplace and plugin manifests are internally consistent", async () => {
    const marketplace = JSON.parse(
      await fs.readFile(
        path.join(MARKETPLACE_ROOT, ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    )
    const plugin = JSON.parse(
      await fs.readFile(path.join(PLUGIN_ROOT, "plugin.json"), "utf8"),
    )
    const hooks = JSON.parse(
      await fs.readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
    )

    assert.equal(marketplace.name, "premind-contract")
    assert.equal(marketplace.plugins[0].name, plugin.name)
    assert.equal(
      marketplace.plugins[0].source.path,
      "./plugins/premind-contract",
    )
    assert.equal(plugin.extensions["com.openai"].hooks, "./hooks/hooks.json")
    assert.deepEqual(Object.keys(hooks.hooks).sort(), [
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ])
    assert.equal("PostToolUse" in hooks.hooks, false)
    await fs.access(HOOK_PATH)
  })

  test("captures only contract shape and emits accepted context responses", async () => {
    const pluginData = await fs.mkdtemp(
      path.join(os.tmpdir(), "premind-codex-contract-"),
    )
    try {
      const start = await runHook(
        "SessionStart",
        {
          session_id: "thread/with unsafe chars",
          transcript_path: "/private/transcript.jsonl",
          cwd: ROOT,
          hook_event_name: "SessionStart",
          model: "test-model",
          permission_mode: "default",
          source: "startup",
        },
        pluginData,
      )
      assert.equal(start.code, 0, start.stderr)
      assert.deepEqual(JSON.parse(start.stdout), {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "premind contract fixture: SessionStart context accepted",
        },
      })

      const prompt = await runHook(
        "UserPromptSubmit",
        {
          session_id: "thread/with unsafe chars",
          turn_id: "turn-1",
          transcript_path: "/private/transcript.jsonl",
          cwd: ROOT,
          hook_event_name: "UserPromptSubmit",
          model: "test-model",
          permission_mode: "default",
          prompt: "secret prompt text must not be captured",
        },
        pluginData,
      )
      assert.equal(prompt.code, 0, prompt.stderr)
      assert.equal(
        JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName,
        "UserPromptSubmit",
      )

      const capture = await fs.readFile(
        path.join(pluginData, "premind-contract", "events.jsonl"),
        "utf8",
      )
      assert.equal(capture.includes("secret prompt text"), false)
      assert.equal(capture.includes("/private/transcript.jsonl"), false)
      const events = capture
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.equal(events[0].types.session_id, "string")
      assert.equal(events[0].source, "startup")
      assert.equal(events[1].types.prompt, "string")
    } finally {
      await fs.rm(pluginData, { recursive: true, force: true })
    }
  })

  test("requests one Stop continuation and observes the recursion guard", async () => {
    const pluginData = await fs.mkdtemp(
      path.join(os.tmpdir(), "premind-codex-contract-"),
    )
    const input = {
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: ROOT,
      hook_event_name: "Stop",
      model: "test-model",
      permission_mode: "default",
      stop_hook_active: false,
      last_assistant_message: "done",
    }

    try {
      const first = await runHook("Stop", input, pluginData)
      assert.equal(first.code, 0, first.stderr)
      assert.deepEqual(JSON.parse(first.stdout), {
        decision: "block",
        reason: "premind contract fixture: run exactly one continuation",
      })

      const continuation = await runHook(
        "Stop",
        { ...input, turn_id: "turn-2", stop_hook_active: true },
        pluginData,
      )
      assert.equal(continuation.code, 0, continuation.stderr)
      assert.deepEqual(JSON.parse(continuation.stdout), {})

      const later = await runHook(
        "Stop",
        { ...input, turn_id: "turn-3" },
        pluginData,
      )
      assert.equal(later.code, 0, later.stderr)
      assert.deepEqual(JSON.parse(later.stdout), {})
    } finally {
      await fs.rm(pluginData, { recursive: true, force: true })
    }
  })
})
