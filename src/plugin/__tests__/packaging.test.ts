import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(THIS_DIR, "..", "..", "..");

const readPackageJson = () => {
	const pkgPath = path.join(ROOT, "package.json");
	try {
		return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	} catch (error) {
		assert.fail(
			`failed to read package.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

describe("plugin packaging", () => {
	test("package.json exports point at existing entry file", () => {
		const pkg = readPackageJson();

		const mainEntry = path.resolve(ROOT, pkg.main);
		assert.ok(
			fs.existsSync(mainEntry),
			`main entry ${pkg.main} does not exist at ${mainEntry}`,
		);

		const exportsEntry = path.resolve(ROOT, pkg.exports["."]);
		assert.ok(
			fs.existsSync(exportsEntry),
			`exports entry ${pkg.exports["."]} does not exist at ${exportsEntry}`,
		);
	});

	test("plugin entry exports PremindPlugin and createPremindPlugin", async () => {
		const mod = await import("../../plugin/index.ts");
		assert.equal(
			typeof mod.PremindPlugin,
			"function",
			"PremindPlugin should be a function",
		);
		assert.equal(
			typeof mod.createPremindPlugin,
			"function",
			"createPremindPlugin should be a function",
		);
		assert.equal(
			typeof mod.default,
			"object",
			"default export should be an object",
		);
		assert.equal(
			mod.default?.id,
			"premind",
			"default export should declare plugin id",
		);
		assert.equal(
			typeof mod.default?.server,
			"function",
			"default export should expose server plugin",
		);
	});

	test("daemon entry file exists relative to plugin", () => {
		const pluginDir = path.resolve(ROOT, "src", "plugin");
		const daemonEntry = path.resolve(pluginDir, "..", "daemon", "index.ts");
		assert.ok(
			fs.existsSync(daemonEntry),
			`daemon entry does not exist at ${daemonEntry}`,
		);
	});

	test("package includes required runtime dependencies", () => {
		const pkg = readPackageJson();
		const deps = pkg.dependencies ?? {};

		assert.ok("@opencode-ai/plugin" in deps, "missing @opencode-ai/plugin");
		assert.ok("zod" in deps, "missing zod");
		assert.ok("tsx" in deps, "missing tsx (needed for daemon launcher)");
		assert.ok(
			!("better-sqlite3" in deps),
			"better-sqlite3 must not be a dependency (native addon, not usable in plugin installs)",
		);
	});

	test("package is not marked private", () => {
		const pkg = readPackageJson();
		assert.ok(
			pkg.private !== true,
			"package.json should not be private for npm publishing",
		);
	});

	test("package declares Pi extension metadata", () => {
		const pkg = readPackageJson();

		assert.ok(
			pkg.keywords.includes("pi-package"),
			"missing pi-package keyword",
		);
		assert.ok(
			pkg.keywords.includes("pi-extension"),
			"missing pi-extension keyword",
		);
		assert.deepEqual(pkg.pi?.extensions, ["./extensions/premind.ts"]);
		assert.ok(
			pkg.files.includes("extensions"),
			"package files should include extensions",
		);
		assert.ok(
			pkg.files.includes("PI_PLAN.md"),
			"package files should include PI_PLAN.md",
		);
	});

	test("Pi extension entry exists and exports a factory", async () => {
		const pkg = readPackageJson();
		const extensionPath = path.resolve(ROOT, pkg.pi.extensions[0]);

		assert.ok(
			fs.existsSync(extensionPath),
			`Pi extension entry does not exist at ${extensionPath}`,
		);

		const mod = await import(extensionPath);
		assert.equal(
			typeof mod.default,
			"function",
			"Pi extension default export should be a factory function",
		);
	});

	test("Pi peer dependencies are declared", () => {
		const pkg = readPackageJson();
		const peers = pkg.peerDependencies ?? {};

		assert.equal(peers["@earendil-works/pi-coding-agent"], "*");
		assert.equal(peers.typebox, "*");
	});
});
