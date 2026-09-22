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

const portableArtifactNames = [
	"premind-daemon.mjs",
	"premind-hook.mjs",
	"premind-mcp.mjs",
];
const codexGeneratedPath = path.join(ROOT, "plugins", "premind", "generated");
const codexCompatibilityGeneratedPath = path.join(
	ROOT,
	"plugins",
	"codex",
	"premind",
	"generated",
);
const trackedPluginArtifacts = new Set(
	run("git", [
		"ls-files",
		"--",
		"plugins/premind/generated",
		"plugins/codex/premind/generated",
	])
		.split("\n")
		.filter(Boolean),
);
for (const directory of ["plugins/premind", "plugins/codex/premind"]) {
	for (const name of portableArtifactNames) {
		const artifact = `${directory}/generated/${name}`;
		assert.ok(trackedPluginArtifacts.has(artifact), `${artifact} is not tracked`);
		assert.ok(fs.existsSync(path.join(ROOT, artifact)), `${artifact} is missing`);
	}
}

const runCodex = (args) =>
	run("codex", args, { env: { ...process.env, CODEX_HOME: codexHome } });

const generatedDirectories = [
	path.join(ROOT, "generated"),
	codexGeneratedPath,
	codexCompatibilityGeneratedPath,
	path.join(ROOT, "plugin-claude", "generated"),
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
		"plugins/premind/generated/premind-daemon.mjs",
		"plugins/premind/generated/premind-hook.mjs",
		"plugins/premind/generated/premind-mcp.mjs",
		"plugins/codex/premind/.codex-plugin/plugin.json",
		"plugins/codex/premind/.mcp.json",
		"plugins/codex/premind/hooks/hooks.json",
		"plugins/codex/premind/skills/premind/SKILL.md",
		"plugins/codex/premind/generated/premind-daemon.mjs",
		"plugins/codex/premind/generated/premind-hook.mjs",
		"plugins/codex/premind/generated/premind-mcp.mjs",
	]) {
		assert.ok(files.has(file), `npm package is missing ${file}`);
	}
	process.stdout.write(
		"PASS: npm package includes portable and Codex compatibility artifacts\n",
	);

	const artifactNames = [
		"premind-daemon.mjs",
		"premind-hook.mjs",
		"premind-mcp.mjs",
	];
	const artifactPaths = [codexGeneratedPath, codexCompatibilityGeneratedPath]
		.flatMap((directory) =>
			artifactNames.map((name) => path.join(directory, name)),
		);
	const artifactsBeforeFailedBuild = new Map(
		artifactPaths.map((artifactPath) => [
			artifactPath,
			fs.readFileSync(artifactPath, "utf8"),
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
	for (const artifactPath of artifactPaths) {
		assert.equal(
			fs.readFileSync(artifactPath, "utf8"),
			artifactsBeforeFailedBuild.get(artifactPath),
		);
	}
	process.stdout.write(
		"PASS: failed runtime rebuild leaves both Codex artifact sets intact\n",
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
	assert.equal(
		fs.existsSync(path.join(installed.installedPath, "plugin.json")),
		false,
		"Codex marketplace install must select the compatibility manifest",
	);
	for (const file of [
		".codex-plugin/plugin.json",
		".mcp.json",
		"hooks/hooks.json",
		"generated/premind-daemon.mjs",
		"generated/premind-hook.mjs",
		"generated/premind-mcp.mjs",
	]) {
		assert.ok(
			fs.existsSync(path.join(installed.installedPath, file)),
			`installed plugin is missing ${file}`,
		);
	}
	const contributedMcp = parseJson(
		runCodex(["mcp", "get", "premind", "--json"]),
		"codex mcp get premind",
	);
	assert.equal(contributedMcp.transport.command, "node");
	assert.deepEqual(contributedMcp.transport.args, [
		"generated/premind-mcp.mjs",
	]);
	assert.equal(
		path.resolve(contributedMcp.transport.cwd),
		path.resolve(installed.installedPath),
		"Codex must resolve the compatibility MCP cwd to the installed plugin root",
	);

	const installedPluginData = fs.mkdtempSync(
		path.join(codexHome, "premind-plugin-data-"),
	);
	const isolatedCwd = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-package-cwd-"),
	);
	const isolatedEnvironment = {
		...process.env,
		PATH: "",
		PREMIND_SOCKET_PATH: path.join(installedPluginData, "premind.sock"),
		PREMIND_STATE_DIR: path.join(installedPluginData, "state"),
	};
	const mcpExecution = spawnSync(
		process.execPath,
		[path.join(installed.installedPath, "generated", "premind-mcp.mjs")],
		{
			cwd: isolatedCwd,
			encoding: "utf8",
			env: isolatedEnvironment,
			input: `${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			})}\n`,
		},
	);
	assert.equal(mcpExecution.status, 0, mcpExecution.stderr);
	assert.equal(
		parseJson(mcpExecution.stdout.trim(), "installed MCP response").result
			?.protocolVersion,
		"2025-06-18",
	);
	const hookExecution = spawnSync(
		process.execPath,
		[
			path.join(installed.installedPath, "generated", "premind-hook.mjs"),
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
	process.stdout.write(
		"PASS: Codex compatibility plugin installed into isolated cache\n",
	);
} finally {
	fs.rmSync(codexHome, { recursive: true, force: true });
}
