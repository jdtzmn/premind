import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parseJson = (input, label) => {
	try {
		return JSON.parse(input);
	} catch (error) {
		throw new Error(`Invalid JSON from ${label}`, { cause: error });
	}
};
const parseNpmPackOutput = (output) => {
	const jsonStart = output.lastIndexOf("\n[");
	return parseJson(
		output.slice(jsonStart === -1 ? 0 : jsonStart + 1),
		"npm pack --dry-run",
	);
};
const packageJson = parseJson(
	fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
	"package.json",
);
const codexHome = fs.mkdtempSync(
	path.join(os.tmpdir(), "premind-codex-package-home-"),
);

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		cwd: ROOT,
		encoding: "utf8",
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
	);
	return result.stdout.trim();
};

const runCodex = (args) =>
	run("codex", args, { env: { ...process.env, CODEX_HOME: codexHome } });

const generatedDirectories = [
	path.join(ROOT, "runtime"),
	path.join(ROOT, "plugins", "premind", "dist"),
	path.join(ROOT, "plugin-claude", "runtime"),
];

for (const directory of generatedDirectories) {
	fs.rmSync(directory, { recursive: true, force: true });
}
try {
	const packed = parseNpmPackOutput(
		run("npm", ["pack", "--dry-run", "--json", "--silent"]),
	);
	const files = new Set(packed[0]?.files?.map((file) => file.path));
	for (const file of [
		"plugins/premind/plugin.json",
		"plugins/premind/.codex-plugin/plugin.json",
		"plugins/premind/hooks/hooks.json",
		"plugins/premind/mcp.json",
		"plugins/premind/skills/premind/SKILL.md",
		"plugins/premind/dist/premind-daemon.mjs",
		"plugins/premind/dist/premind-hook.mjs",
		"plugins/premind/dist/premind-mcp.mjs",
	]) {
		assert.ok(files.has(file), `npm package is missing ${file}`);
	}
	process.stdout.write("PASS: npm package includes portable Codex plugin artifacts\n");

	const artifactNames = [
		"premind-daemon.mjs",
		"premind-hook.mjs",
		"premind-mcp.mjs",
	];
	const artifactsBeforeFailedBuild = new Map(
		artifactNames.map((name) => [
			name,
			fs.readFileSync(path.join(ROOT, "plugins", "premind", "dist", name), "utf8"),
		]),
	);
	const failedBuild = spawnSync(
		process.execPath,
		["scripts/build-runtime.mjs"],
		{
			cwd: ROOT,
			encoding: "utf8",
			env: { ...process.env, PREMIND_BUILD_FAIL_BEFORE_PLUGIN_SYNC: "1" },
		},
	);
	assert.notEqual(
		failedBuild.status,
		0,
		"failure injection unexpectedly succeeded",
	);
	for (const name of artifactNames) {
		assert.equal(
			fs.readFileSync(path.join(ROOT, "plugins", "premind", "dist", name), "utf8"),
			artifactsBeforeFailedBuild.get(name),
		);
	}
	process.stdout.write(
		"PASS: failed runtime rebuild leaves the portable plugin artifact set intact\n",
	);

	const marketplace = parseJson(
		runCodex(["plugin", "marketplace", "add", ROOT, "--json"]),
		"codex plugin marketplace add",
	);
	assert.equal(marketplace.marketplaceName, "premind");
	process.stdout.write("PASS: repository-local marketplace accepted\n");

	const installed = parseJson(
		runCodex(["plugin", "add", "premind@premind", "--json"]),
		"codex plugin add",
	);
	assert.equal(installed.pluginId, "premind@premind");
	assert.equal(installed.version, packageJson.version);
	for (const file of [
		"plugin.json",
		".codex-plugin/plugin.json",
		"hooks/hooks.json",
		"mcp.json",
		"dist/premind-daemon.mjs",
		"dist/premind-hook.mjs",
		"dist/premind-mcp.mjs",
	]) {
		assert.ok(
			fs.existsSync(path.join(installed.installedPath, file)),
			`installed plugin is missing ${file}`,
		);
	}

	const installedPluginData = fs.mkdtempSync(
		path.join(codexHome, "premind-plugin-data-"),
	);
	const isolatedCwd = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-package-cwd-"),
	);
	const isolatedEnvironment = {
		...process.env,
		PATH: "",
		PLUGIN_DATA: installedPluginData,
		PREMIND_SOCKET_PATH: path.join(installedPluginData, "premind.sock"),
		PREMIND_STATE_DIR: path.join(installedPluginData, "state"),
	};
	const mcpExecution = spawnSync(
		process.execPath,
		[path.join(installed.installedPath, "dist", "premind-mcp.mjs")],
		{
			cwd: isolatedCwd,
			encoding: "utf8",
			env: isolatedEnvironment,
			input: `${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05" },
			})}\n`,
		},
	);
	assert.equal(mcpExecution.status, 0, mcpExecution.stderr);
	assert.equal(
		parseJson(mcpExecution.stdout.trim(), "installed MCP response").result
			?.protocolVersion,
		"2024-11-05",
	);
	const hookExecution = spawnSync(
		process.execPath,
		[
			path.join(installed.installedPath, "dist", "premind-hook.mjs"),
			"SessionEnd",
		],
		{
			cwd: isolatedCwd,
			encoding: "utf8",
			env: isolatedEnvironment,
			input: `${JSON.stringify({
				session_id: "package-validation",
				transcript_path: null,
				cwd: isolatedCwd,
				model: "test",
				hook_event_name: "SessionEnd",
				reason: "other",
			})}\n`,
		},
	);
	assert.equal(hookExecution.status, 0, hookExecution.stderr);
	assert.equal(hookExecution.stdout.trim(), "");
	process.stdout.write(
		"PASS: installed hook and MCP execute without source dependencies\n",
	);
	process.stdout.write("PASS: portable plugin installed into isolated Codex cache\n");
} finally {
	fs.rmSync(codexHome, { recursive: true, force: true });
}
