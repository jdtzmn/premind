import assert from "node:assert/strict"
import { describe, test, beforeEach, afterEach } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadPremindConfig, ensureUserConfigTemplate, getDefaultUserConfigPath } from "./config-loader.ts"
import { PREMIND_IDLE_DELIVERY_THRESHOLD_MS } from "./constants.ts"

// Each test gets its own scratch dir so parallel runs and retries don't collide.
const makeScratchDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-config-test-"))
  return dir
}

const writeConfig = (dir: string, filename: string, body: string) => {
  const p = path.join(dir, filename)
  fs.writeFileSync(p, body, "utf8")
  return p
}

describe("loadPremindConfig", () => {
  let scratch: string

  beforeEach(() => {
    scratch = makeScratchDir()
  })

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  test("returns schema defaults when no config file or env vars are present", () => {
    const config = loadPremindConfig({
      userConfigPath: path.join(scratch, "does-not-exist.jsonc"),
      env: {},
    })

    assert.equal(config.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
    assert.equal(config.enabled, true)
    assert.equal(config.debugLogging, false)
  })

  test("reads a plain JSON user config", () => {
    const userConfigPath = writeConfig(
      scratch,
      "premind.json",
      JSON.stringify({ idleDeliveryThresholdMs: 30000, debugLogging: true }),
    )

    const config = loadPremindConfig({ userConfigPath, env: {} })

    assert.equal(config.idleDeliveryThresholdMs, 30000)
    assert.equal(config.debugLogging, true)
  })

  test("reads a JSONC user config with comments and trailing commas", () => {
    const userConfigPath = writeConfig(
      scratch,
      "premind.jsonc",
      `{
        // Line comment
        "idleDeliveryThresholdMs": 45000, /* inline block comment */
        "debugLogging": true, // trailing comma after this line
      }`,
    )

    const config = loadPremindConfig({ userConfigPath, env: {} })

    assert.equal(config.idleDeliveryThresholdMs, 45000)
    assert.equal(config.debugLogging, true)
  })

  test("env vars override file config", () => {
    const userConfigPath = writeConfig(
      scratch,
      "premind.json",
      JSON.stringify({ idleDeliveryThresholdMs: 30000, debugLogging: true }),
    )

    const config = loadPremindConfig({
      userConfigPath,
      env: {
        PREMIND_IDLE_DELIVERY_THRESHOLD_MS: "90000",
        PREMIND_DEBUG_LOGGING: "false",
      },
    })

    assert.equal(config.idleDeliveryThresholdMs, 90000)
    assert.equal(config.debugLogging, false)
  })

  test("env var names are derived from schema field names (UPPER_SNAKE with PREMIND_ prefix)", () => {
    const config = loadPremindConfig({
      userConfigPath: path.join(scratch, "missing.json"),
      env: {
        PREMIND_DISCOVERY_POLL_INTERVAL_MS: "123456",
        PREMIND_INLINE_EVENT_LIMIT: "3",
        PREMIND_AUTO_ATTACH: "false",
      },
    })

    assert.equal(config.discoveryPollIntervalMs, 123456)
    assert.equal(config.inlineEventLimit, 3)
    assert.equal(config.autoAttach, false)
  })

  test("boolean env vars accept true/false/1/0 case-insensitively", () => {
    const cases: Array<[string, boolean]> = [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["FALSE", false],
      ["0", false],
    ]
    for (const [value, expected] of cases) {
      const config = loadPremindConfig({
        userConfigPath: path.join(scratch, "missing.json"),
        env: { PREMIND_DEBUG_LOGGING: value },
      })
      assert.equal(config.debugLogging, expected, `value ${value} should be ${expected}`)
    }
  })

  test("malformed JSON falls back to defaults and logs a warning (no crash)", () => {
    const userConfigPath = writeConfig(scratch, "premind.json", "{ not valid json ")

    const logs: string[] = []
    const config = loadPremindConfig({
      userConfigPath,
      env: {},
      logger: (msg) => logs.push(msg),
    })

    // Still returns defaults — never crashes.
    assert.equal(config.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
    // Emits exactly one warning mentioning the bad path.
    assert.equal(logs.length, 1)
    assert.match(logs[0], /premind/i)
    assert.ok(logs[0].includes(userConfigPath))
  })

  test("invalid config values (fails schema) fall back to defaults and log a warning", () => {
    // idleDeliveryThresholdMs has a min of 5000 in the schema.
    const userConfigPath = writeConfig(
      scratch,
      "premind.json",
      JSON.stringify({ idleDeliveryThresholdMs: 100 }),
    )

    const logs: string[] = []
    const config = loadPremindConfig({
      userConfigPath,
      env: {},
      logger: (msg) => logs.push(msg),
    })

    assert.equal(config.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /premind/i)
  })

  test("unknown keys in user config are rejected (schema is strict) and fall back to defaults", () => {
    const userConfigPath = writeConfig(
      scratch,
      "premind.json",
      JSON.stringify({ idleDeliveryThresholdMs: 30000, unknownKey: "oops" }),
    )

    const logs: string[] = []
    const config = loadPremindConfig({
      userConfigPath,
      env: {},
      logger: (msg) => logs.push(msg),
    })

    // Strict mode rejects unknownKey → schema parse fails → defaults returned.
    assert.equal(config.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
    assert.equal(logs.length, 1)
  })

  test("invalid env var value is ignored and falls back to file/default (warning logged)", () => {
    const userConfigPath = writeConfig(
      scratch,
      "premind.json",
      JSON.stringify({ idleDeliveryThresholdMs: 30000 }),
    )

    const logs: string[] = []
    const config = loadPremindConfig({
      userConfigPath,
      env: { PREMIND_IDLE_DELIVERY_THRESHOLD_MS: "not-a-number" },
      logger: (msg) => logs.push(msg),
    })

    // Bad env var ignored → file value preserved.
    assert.equal(config.idleDeliveryThresholdMs, 30000)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /PREMIND_IDLE_DELIVERY_THRESHOLD_MS/)
  })

  test("env vars without matching schema field are silently ignored", () => {
    // We don't want to spam warnings if someone has unrelated PREMIND_* env vars set.
    const logs: string[] = []
    const config = loadPremindConfig({
      userConfigPath: path.join(scratch, "missing.json"),
      env: { PREMIND_TOTALLY_MADE_UP: "value" },
      logger: (msg) => logs.push(msg),
    })

    assert.equal(config.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
    assert.equal(logs.length, 0)
  })
})

describe("getDefaultUserConfigPath", () => {
  test("returns a path inside the user's opencode config directory", () => {
    const p = getDefaultUserConfigPath()
    // Must end in a premind.jsonc file inside an opencode-related directory.
    assert.match(p, /opencode[\/\\]premind\.jsonc$/)
  })
})

describe("ensureUserConfigTemplate", () => {
  let scratch: string

  beforeEach(() => {
    scratch = makeScratchDir()
  })

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  test("creates a template file with commented examples when it does not exist", () => {
    const target = path.join(scratch, "subdir", "premind.jsonc")

    const result = ensureUserConfigTemplate(target)

    assert.equal(result, "created")
    assert.ok(fs.existsSync(target), "template file should be written")
    const body = fs.readFileSync(target, "utf8")
    // The template should mention real config fields as examples.
    assert.match(body, /idleDeliveryThresholdMs/)
    // All example values should be commented out so the file itself parses to {} (defaults).
    // This means loading it back should return schema defaults.
    const cfg = loadPremindConfig({ userConfigPath: target, env: {} })
    assert.equal(cfg.idleDeliveryThresholdMs, PREMIND_IDLE_DELIVERY_THRESHOLD_MS)
  })

  test("does not overwrite an existing file", () => {
    const target = path.join(scratch, "premind.jsonc")
    fs.writeFileSync(target, '{"idleDeliveryThresholdMs": 30000}', "utf8")
    const before = fs.readFileSync(target, "utf8")

    const result = ensureUserConfigTemplate(target)

    assert.equal(result, "exists")
    const after = fs.readFileSync(target, "utf8")
    assert.equal(after, before)
  })

  test("returns 'failed' and does not throw when the directory cannot be created", () => {
    // Point at a path whose parent is a file — mkdir will reject.
    const blocker = path.join(scratch, "blocker")
    fs.writeFileSync(blocker, "not a dir", "utf8")
    const target = path.join(blocker, "nested", "premind.jsonc")

    const result = ensureUserConfigTemplate(target)

    assert.equal(result, "failed")
    assert.ok(!fs.existsSync(target))
  })
})
