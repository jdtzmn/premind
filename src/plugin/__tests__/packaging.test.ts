import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(THIS_DIR, "..", "..", "..");

describe("plugin packaging", () => {
	test("package.json exports point at existing entry file", () => {
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

		const mainEntry = path.resolve(ROOT, pkg.main);
		assert.ok(
			fs.existsSync(mainEntry),
			`main entry ${pkg.main} does not exist at ${mainEntry}`,
		);

		const exportsEntry = path.resolve(ROOT, pkg.exports["."]);
		assert.ok(
			fs.existsSync(exportsEntry),
			`exports["."] ${pkg.exports["."]} does not exist`,
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
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
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
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		assert.ok(
			pkg.private !== true,
			"package.json should not be private for npm publishing",
		);
	});

	test("package declares Pi extension metadata", () => {
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

		assert.deepEqual(pkg.pi?.extensions, ["./extensions/premind.ts"]);
		assert.ok(
			pkg.files?.includes("extensions"),
			"package files should include extensions",
		);
		assert.ok(
			pkg.files?.includes("PI_PLAN.md"),
			"package files should include PI_PLAN.md",
		);
		assert.ok(
			pkg.keywords?.includes("pi-package"),
			"keywords should include pi-package",
		);
		assert.ok(
			pkg.keywords?.includes("pi-extension"),
			"keywords should include pi-extension",
		);
	});

	test("Pi extension entry exists and exports a factory", async () => {
		const entry = path.join(ROOT, "extensions", "premind.ts");
		assert.ok(
			fs.existsSync(entry),
			`Pi extension entry does not exist at ${entry}`,
		);

		const mod = await import("../../../extensions/premind.ts");
		assert.equal(typeof mod.default, "function");
		assert.equal(typeof mod.createPremindPiExtension, "function");
	});

	test("Pi peer dependencies are declared", () => {
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const peers = pkg.peerDependencies ?? {};

		assert.ok(
			"@earendil-works/pi-coding-agent" in peers,
			"missing Pi extension API peer dependency",
		);
		assert.ok(
			"@earendil-works/pi-tui" in peers,
			"missing Pi TUI peer dependency",
		);
		assert.ok("typebox" in peers, "missing typebox peer dependency");
	});
});
