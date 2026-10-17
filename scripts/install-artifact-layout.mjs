import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const readJson = (root, relative) =>
	JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

export const requiredInstallFiles = [
	".agents/plugins/marketplace.json",
	"extensions/premind.ts",
	"src/plugin-opencode/index.ts",
	"plugin-claude/.claude-plugin/plugin.json",
	"plugin-claude/.mcp.json",
	"plugin-claude/hooks/hooks.json",
	"plugin-claude/bin/mcp-server.mjs",
	"plugin-claude/bin/ensure-daemon.mjs",
	"plugin-claude/bin/lib.mjs",
	"plugin-claude/bin/session-start.mjs",
	"plugin-claude/bin/session-end.mjs",
	"plugin-claude/bin/stop.mjs",
	"plugin-claude/bin/user-prompt-submit.mjs",
	"plugin-claude/generated/daemon-startup.mjs",
	"plugin-claude/generated/premind-daemon.mjs",
	"plugins/premind/plugin.json",
	"plugins/premind/generated/premind-daemon.mjs",
	"plugins/premind/generated/premind-hook.mjs",
	"plugins/premind/generated/premind-mcp.mjs",
	"plugins/codex/premind/.codex-plugin/plugin.json",
	"plugins/codex/premind/.mcp.json",
	"plugins/codex/premind/hooks/hooks.json",
	"plugins/codex/premind/generated/premind-daemon.mjs",
	"plugins/codex/premind/generated/premind-hook.mjs",
	"plugins/codex/premind/generated/premind-mcp.mjs",
];

export const validateInstallArtifact = (root) => {
	const pkg = readJson(root, "package.json");
	assert.equal(pkg.name, "premind");
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	for (const file of requiredInstallFiles) {
		assert.ok(fs.statSync(path.join(root, file)).isFile(), `missing ${file}`);
	}
	assert.equal(pkg.pi?.extensions?.[0], "./extensions/premind.ts");
	assert.equal(pkg.main, "./src/plugin-opencode/index.ts");
	const portable = readJson(root, "plugins/premind/plugin.json");
	const codex = readJson(root, "plugins/codex/premind/.codex-plugin/plugin.json");
	assert.equal(portable.version, pkg.version, "portable plugin version differs");
	assert.equal(codex.version, pkg.version, "Codex plugin version differs");
	assert.equal(
		readJson(root, ".agents/plugins/marketplace.json").plugins[0]?.source?.path,
		"./plugins/codex/premind",
	);
	for (const name of ["premind-daemon.mjs", "premind-hook.mjs", "premind-mcp.mjs"]) {
		assert.equal(
			fs.readFileSync(path.join(root, "plugins/premind/generated", name), "utf8"),
			fs.readFileSync(path.join(root, "plugins/codex/premind/generated", name), "utf8"),
			`${name} differs between Codex package leaves`,
		);
	}
	assert.equal(
		fs.readFileSync(path.join(root, "plugin-claude/generated/premind-daemon.mjs"), "utf8"),
		fs.readFileSync(path.join(root, "plugins/premind/generated/premind-daemon.mjs"), "utf8"),
		"Claude and Codex daemon bundles differ",
	);
	return { name: pkg.name, version: pkg.version };
};
