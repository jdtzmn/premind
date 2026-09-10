import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_CODEX_VERSION = "codex-cli 0.150.1";
const PLUGIN_ID = "premind-contract@premind-contract";
const MARKETPLACE_NAME = "premind-contract";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE_ROOT = path.join(
  ROOT,
  "src",
  "codex",
  "__fixtures__",
  "contract-marketplace",
);

function runCodex(args, options = {}) {
  const result = spawnSync("codex", args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    encoding: options.stdio === "inherit" ? undefined : "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (options.allowFailure !== true) {
    assert.equal(
      result.status,
      0,
      `codex ${args.join(" ")} failed:\n${result.stderr || result.stdout || ""}`,
    );
  }
  return result;
}

function parseJson(input, label) {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`Codex returned invalid JSON for ${label}`, {
      cause: error,
    });
  }
}

function parseJsonLines(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line, index) => parseJson(line, `capture line ${index + 1}`));
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error(
    "Live Codex hook validation requires an interactive terminal. Run `bun run test:codex:live` directly, not through CI or codex exec.",
  );
}

const version = runCodex(["--version"]).stdout.trim();
assert.equal(
  version,
  PINNED_CODEX_VERSION,
  `Codex contract fixture is pinned to ${PINNED_CODEX_VERSION}; found ${version}`,
);

const marketplaces = parseJson(
  runCodex(["plugin", "marketplace", "list", "--json"]).stdout,
  "marketplace list",
).marketplaces;
const plugins = parseJson(
  runCodex(["plugin", "list", "--json"]).stdout,
  "plugin list",
).installed;
assert.equal(
  marketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME),
  false,
  `Refusing to replace existing marketplace ${MARKETPLACE_NAME}`,
);
assert.equal(
  plugins.some((plugin) => plugin.pluginId === PLUGIN_ID),
  false,
  `Refusing to replace existing plugin ${PLUGIN_ID}`,
);

const temporaryDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "premind codex contract "),
);
const capturePath = path.join(temporaryDir, "events.jsonl");
let marketplaceAdded = false;
let pluginAdded = false;
const hookTrustBypassProvidedByWrapper =
  process.env.CMUX_CODEX_WRAPPER_SHIM !== undefined;

try {
  runCodex(["plugin", "marketplace", "add", MARKETPLACE_ROOT, "--json"]);
  marketplaceAdded = true;
  runCodex(["plugin", "add", PLUGIN_ID, "--json"]);
  pluginAdded = true;

  console.log("Starting an interactive Codex contract session.");
  console.log("Review the injected fixture context, then use /exit when idle.");
  const execution = runCodex(
    [
      ...(hookTrustBypassProvidedByWrapper
        ? []
        : ["--dangerously-bypass-hook-trust"]),
      "-C",
      ROOT,
      "Respond with exactly CODEX_CONTRACT_OK. If a Stop-hook continuation asks you to continue, respond with exactly CODEX_CONTRACT_CONTINUED.",
    ],
    {
      allowFailure: true,
      env: { PREMIND_CODEX_CONTRACT_OUTPUT: capturePath },
      stdio: "inherit",
    },
  );
  assert.equal(execution.status, 0, "Interactive Codex session failed");
  assert.ok(
    fs.existsSync(capturePath),
    "Interactive hooks produced no capture",
  );

  const captures = parseJsonLines(fs.readFileSync(capturePath, "utf8"));
  const eventNames = captures.map((capture) => capture.event);
  assert.ok(eventNames.includes("SessionStart"), "SessionStart did not run");
  assert.ok(
    eventNames.includes("UserPromptSubmit"),
    "UserPromptSubmit did not run",
  );
  assert.ok(eventNames.includes("Stop"), "Stop did not run");
  assert.equal(
    captures.some(
      (capture) => capture.event === "Stop" && capture.stopHookActive === true,
    ),
    true,
    "Stop continuation did not expose stop_hook_active=true",
  );

  console.log(`Codex live contract passed (${version})`);
  console.log(`  events: ${eventNames.join(", ")}`);
  console.log(
    `  trust: one-off bypass via ${hookTrustBypassProvidedByWrapper ? "cmux wrapper" : "CLI flag"}`,
  );
} finally {
  if (pluginAdded) {
    runCodex(["plugin", "remove", PLUGIN_ID, "--json"], {
      allowFailure: true,
    });
  }
  if (marketplaceAdded) {
    runCodex(["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"], {
      allowFailure: true,
    });
  }
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
