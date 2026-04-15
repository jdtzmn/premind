import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(THIS_DIR, "..", "..", "..")

describe("plugin packaging", () => {
  test("package.json exports point at existing entry file", () => {
    const pkgPath = path.join(ROOT, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))

    const mainEntry = path.resolve(ROOT, pkg.main)
    assert.ok(fs.existsSync(mainEntry), `main entry ${pkg.main} does not exist at ${mainEntry}`)

    const exportsEntry = path.resolve(ROOT, pkg.exports["."])
    assert.ok(fs.existsSync(exportsEntry), `exports entry ${pkg.exports["."]} does not exist at ${exportsEntry}`)
  })

  test("plugin entry exports PremindPlugin and createPremindPlugin", async () => {
    const mod = await import("../../plugin/index.ts")
    assert.equal(typeof mod.PremindPlugin, "function", "PremindPlugin should be a function")
    assert.equal(typeof mod.createPremindPlugin, "function", "createPremindPlugin should be a function")
    assert.equal(typeof mod.default, "object", "default export should be an object")
    assert.equal(mod.default?.id, "premind", "default export should declare plugin id")
    assert.equal(typeof mod.default?.server, "function", "default export should expose server plugin")
  })

  test("daemon entry file exists relative to plugin", () => {
    const pluginDir = path.resolve(ROOT, "src", "plugin")
    const daemonEntry = path.resolve(pluginDir, "..", "daemon", "index.ts")
    assert.ok(fs.existsSync(daemonEntry), `daemon entry does not exist at ${daemonEntry}`)
  })

  test("package includes required runtime dependencies", () => {
    const pkgPath = path.join(ROOT, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const deps = pkg.dependencies ?? {}

    assert.ok("@opencode-ai/plugin" in deps, "missing @opencode-ai/plugin")
    assert.ok("better-sqlite3" in deps, "missing better-sqlite3")
    assert.ok("zod" in deps, "missing zod")
    assert.ok("tsx" in deps, "missing tsx (needed for daemon launcher)")
  })

  test("package is not marked private", () => {
    const pkgPath = path.join(ROOT, "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    assert.ok(pkg.private !== true, "package.json should not be private for npm publishing")
  })
})
