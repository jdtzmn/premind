import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectories = [
	path.join(ROOT, "plugin-claude", "generated"),
	path.join(ROOT, "plugins", "premind", "generated"),
	path.join(ROOT, "plugins", "codex", "premind", "generated"),
];
const requiredArtifacts = [
	"plugin-claude/generated/daemon-startup.mjs",
	"plugin-claude/generated/premind-daemon.mjs",
	"plugins/premind/generated/premind-daemon.mjs",
	"plugins/premind/generated/premind-hook.mjs",
	"plugins/premind/generated/premind-mcp.mjs",
	"plugins/codex/premind/generated/premind-daemon.mjs",
	"plugins/codex/premind/generated/premind-hook.mjs",
	"plugins/codex/premind/generated/premind-mcp.mjs",
];

const parseNpmPackOutput = (output) => {
	const jsonStart = output.lastIndexOf("\n[");
	return JSON.parse(output.slice(jsonStart === -1 ? 0 : jsonStart + 1));
};

for (const directory of generatedDirectories) {
	fs.rmSync(directory, { recursive: true, force: true });
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--silent"], {
	cwd: ROOT,
	encoding: "utf8",
});
if (packed.error) throw packed.error;
assert.equal(
	packed.status,
	0,
	`npm pack --dry-run failed:\n${packed.stderr || packed.stdout}`,
);

const files = new Set(
	parseNpmPackOutput(packed.stdout)[0]?.files?.map((file) => file.path),
);
for (const artifact of requiredArtifacts) {
	assert.ok(files.has(artifact), `npm package is missing ${artifact}`);
}

process.stdout.write("PASS: npm package regenerates and includes runtime artifacts\n");
