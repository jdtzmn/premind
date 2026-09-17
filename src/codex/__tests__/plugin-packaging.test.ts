import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const PLUGIN_ROOT = path.join(ROOT, "plugins", "premind");
const PLUGIN_ROOT_VARIABLE = "$" + "{PLUGIN_ROOT}";

const readJson = <T>(filePath: string): T =>
	JSON.parse(fs.readFileSync(filePath, "utf8")) as T;

test("ships a version-synchronized portable Codex plugin", () => {
	const packageJson = readJson<{
		version: string;
		files?: string[];
		engines?: { node?: string };
	}>(path.join(ROOT, "package.json"));
	const plugin = readJson<{
		name: string;
		version: string;
		extensions?: { "com.openai"?: { hooks?: string } };
	}>(path.join(PLUGIN_ROOT, "plugin.json"));
	const compatibility = readJson<{
		name: string;
		version: string;
		hooks?: string;
	}>(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"));

	assert.equal(plugin.name, "premind");
	assert.equal(plugin.version, packageJson.version);
	assert.equal(compatibility.name, plugin.name);
	assert.equal(compatibility.version, packageJson.version);
	assert.equal(plugin.extensions?.["com.openai"]?.hooks, "./hooks/hooks.json");
	assert.equal(compatibility.hooks, "./hooks/hooks.json");
	assert.ok(packageJson.files?.includes("plugins"));
	assert.equal(packageJson.engines?.node, ">=22.13.0");
});

test("exposes only the required lifecycle hooks and Codex MCP bridge", () => {
	const hooks = readJson<{
		hooks: Record<
			string,
			Array<{ hooks: Array<{ command: string; timeout: number }> }>
		>;
	}>(path.join(PLUGIN_ROOT, "hooks", "hooks.json"));
	const expectedEvents = [
		["SessionStart", 10],
		["UserPromptSubmit", 10],
		["Stop", 10],
		["Interrupt", 3],
		["SessionEnd", 3],
	] as const;
	assert.deepEqual(
		Object.keys(hooks.hooks).sort(),
		expectedEvents.map(([event]) => event).sort(),
	);
	assert.equal("PostToolUse" in hooks.hooks, false);
	for (const [event, timeout] of expectedEvents) {
		const hook = hooks.hooks[event]?.[0]?.hooks[0];
		assert.equal(hook?.timeout, timeout);
		assert.equal(
			hook?.command,
			`node "${PLUGIN_ROOT_VARIABLE}/dist/premind-hook.mjs" ${event}`,
		);
	}

	const mcp = readJson<{
		mcpServers: Record<
			string,
			{ type: string; command: string; args: string[]; cwd: string }
		>;
	}>(path.join(PLUGIN_ROOT, "mcp.json"));
	assert.deepEqual(mcp.mcpServers.premind, {
		type: "stdio",
		command: "node",
		args: [`${PLUGIN_ROOT_VARIABLE}/dist/premind-mcp.mjs`],
		cwd: PLUGIN_ROOT_VARIABLE,
	});
});

test("keeps dependency-closed runtime artifacts beside the plugin manifests", () => {
	for (const name of [
		"premind-daemon.mjs",
		"premind-hook.mjs",
		"premind-mcp.mjs",
	]) {
		const packaged = path.join(PLUGIN_ROOT, "dist", name);
		const runtime = path.join(ROOT, "runtime", name);
		assert.ok(fs.existsSync(packaged), `missing plugin artifact ${name}`);
		assert.equal(
			fs.readFileSync(packaged, "utf8"),
			fs.readFileSync(runtime, "utf8"),
		);
	}
});

test("registers the portable plugin in the repository-local marketplace", () => {
	const marketplace = readJson<{
		name: string;
		plugins: Array<{ name: string; source: { source: string; path: string } }>;
	}>(path.join(ROOT, ".agents", "plugins", "marketplace.json"));
	assert.equal(marketplace.name, "premind");
	assert.equal(marketplace.plugins.length, 1);
	assert.equal(marketplace.plugins[0]?.name, "premind");
	assert.deepEqual(marketplace.plugins[0]?.source, {
		source: "local",
		path: "./plugins/premind",
	});
});
