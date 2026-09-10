#!/usr/bin/env node
/**
 * Opt-in live contract check. It is intentionally outside plugin-claude/test/
 * so CI never launches Claude Code or spends authenticated model quota.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const claude = process.env.CLAUDE_BINARY ?? "claude";
const auth = spawnSync(claude, ["auth", "status"], { stdio: "ignore" });
if (auth.error || auth.status !== 0) {
  console.log(
    "SKIP: Claude Code is unavailable or unauthenticated; live contract was not run.",
  );
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "premind-claude-contract-"));
const logPath = path.join(root, "contract.jsonl");
const write = (relative, content, mode) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode) fs.chmodSync(target, mode);
};

write(
  ".claude-plugin/plugin.json",
  JSON.stringify({ name: "premind-contract", version: "0.0.0" }),
);
write(
  "hooks/hooks.json",
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hook.mjs" },
          ],
        },
      ],
    },
  }),
);
write(
  ".mcp.json",
  JSON.stringify({
    mcpServers: {
      premind_contract: { command: "${CLAUDE_PLUGIN_ROOT}/mcp.mjs" },
    },
  }),
);
write(
  "hook.mjs",
  `#!/usr/bin/env node
import fs from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || "{}");
const row = { scenario: process.env.PREMIND_CONTRACT_SCENARIO, kind: "hook", sessionId: event.session_id, environmentSessionId: process.env.CLAUDE_CODE_SESSION_ID };
fs.appendFileSync(process.env.PREMIND_LIVE_CONTRACT_LOG, JSON.stringify(row) + "\\n");
`,
  0o755,
);
write(
  "mcp.mjs",
  `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "premind-contract", version: "0" } });
  if (request.method === "tools/list") return reply(request.id, { tools: [{ name: "record_session", description: "Record the current Claude session identifier for a compatibility test.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  if (request.method === "tools/call") {
    fs.appendFileSync(process.env.PREMIND_LIVE_CONTRACT_LOG, JSON.stringify({ scenario: process.env.PREMIND_CONTRACT_SCENARIO, kind: "mcp", sessionId: process.env.CLAUDE_CODE_SESSION_ID }) + "\\n");
    return reply(request.id, { content: [{ type: "text", text: "recorded" }] });
  }
});
`,
  0o755,
);

const run = (scenario, args) => {
  const result = spawnSync(
    claude,
    [
      "-p",
      "--dangerously-skip-permissions",
      "--plugin-dir",
      root,
      ...args,
      "Use the available record_session MCP tool exactly once, then reply with recorded.",
    ],
    {
      env: {
        ...process.env,
        PREMIND_LIVE_CONTRACT_LOG: logPath,
        PREMIND_CONTRACT_SCENARIO: scenario,
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || "Claude command failed");
};

try {
  run("fresh", []);
  const rows = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const freshHook = rows.find(
    (row) => row.scenario === "fresh" && row.kind === "hook",
  );
  const freshMcp = rows.find(
    (row) => row.scenario === "fresh" && row.kind === "mcp",
  );
  assert.ok(freshHook?.sessionId, "fresh hook must record event.session_id");
  assert.equal(
    freshHook.environmentSessionId,
    freshHook.sessionId,
    "fresh hook env ID must match event ID",
  );
  assert.equal(
    freshMcp?.sessionId,
    freshHook.sessionId,
    "fresh MCP ID must match hook ID",
  );

  run("resume", ["--resume", freshHook.sessionId]);
  const resumedRows = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const resumeHook = resumedRows.find(
    (row) => row.scenario === "resume" && row.kind === "hook",
  );
  const resumeMcp = resumedRows.find(
    (row) => row.scenario === "resume" && row.kind === "mcp",
  );
  assert.equal(
    resumeHook?.sessionId,
    freshHook.sessionId,
    "resumed hook must retain the session ID",
  );
  assert.equal(
    resumeMcp?.sessionId,
    freshHook.sessionId,
    "resumed MCP ID must match hook ID",
  );
  console.log("PASS: fresh and resumed hook/MCP Claude session IDs match.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
