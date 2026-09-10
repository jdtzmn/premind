import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MARKETPLACE_ROOT = path.join(
  ROOT,
  "src",
  "codex",
  "__fixtures__",
  "contract-marketplace",
)
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "premind-codex-home-"))

function runCodex(args) {
  const result = spawnSync("codex", args, {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
  })
  if (result.error) throw result.error
  assert.equal(
    result.status,
    0,
    `codex ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  )
  return result.stdout.trim()
}

try {
  const version = runCodex(["--version"])
  console.log(`Codex contract fixture validation (${version})`)

  const marketplace = JSON.parse(
    runCodex(["plugin", "marketplace", "add", MARKETPLACE_ROOT, "--json"]),
  )
  assert.equal(marketplace.marketplaceName, "premind-contract")
  console.log("  PASS: local marketplace accepted")

  const installed = JSON.parse(
    runCodex([
      "plugin",
      "add",
      "premind-contract@premind-contract",
      "--json",
    ]),
  )
  assert.equal(installed.pluginId, "premind-contract@premind-contract")
  assert.equal(installed.version, "0.0.0")
  assert.ok(fs.existsSync(path.join(installed.installedPath, "plugin.json")))
  assert.ok(
    fs.existsSync(
      path.join(installed.installedPath, ".codex-plugin", "plugin.json"),
    ),
  )
  assert.ok(
    fs.existsSync(
      path.join(installed.installedPath, "hooks", "contract-hook.mjs"),
    ),
  )
  console.log("  PASS: fixture installed into an isolated Codex cache")

  const plugins = JSON.parse(runCodex(["plugin", "list", "--json"]))
  const fixture = plugins.installed.find(
    (plugin) => plugin.pluginId === "premind-contract@premind-contract",
  )
  assert.equal(fixture?.enabled, true)
  console.log("  PASS: installed fixture is enabled")
  console.log("\nContract-only marketplace validation passed.")
  console.log(
    "Live hook execution still requires a trusted interactive Codex session.",
  )
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true })
}
