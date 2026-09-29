import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requiredInstallFiles, validateInstallArtifact } from "./install-artifact-layout.mjs";

const makeFixture = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "premind-artifact-layout-"));
	for (const file of requiredInstallFiles) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "bundle\n");
	}
	const json = (file, value) =>
		fs.writeFileSync(path.join(root, file), `${JSON.stringify(value)}\n`);
	json("package.json", {
		name: "premind",
		version: "0.1.0",
		main: "./src/plugin-opencode/index.ts",
		pi: { extensions: ["./extensions/premind.ts"] },
	});
	json("plugins/premind/plugin.json", { version: "0.1.0" });
	json("plugins/codex/premind/.codex-plugin/plugin.json", { version: "0.1.0" });
	json(".agents/plugins/marketplace.json", {
		plugins: [{ source: { path: "./plugins/codex/premind" } }],
	});
	return { root, json };
};

test("validates a packaged plugin layout", (t) => {
	const { root } = makeFixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	assert.deepEqual(validateInstallArtifact(root), { name: "premind", version: "0.1.0" });
});

test("rejects a missing installed entrypoint", (t) => {
	const { root } = makeFixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.rmSync(path.join(root, "extensions/premind.ts"));
	assert.throws(() => validateInstallArtifact(root), /extensions\/premind\.ts/);
});

test("rejects Codex manifest version drift", (t) => {
	const { root, json } = makeFixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	json("plugins/codex/premind/.codex-plugin/plugin.json", { version: "0.2.0" });
	assert.throws(() => validateInstallArtifact(root), /Codex plugin version differs/);
});

test("rejects diverging generated bundles", (t) => {
	const { root } = makeFixture();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(path.join(root, "plugins/codex/premind/generated/premind-mcp.mjs"), "stale");
	assert.throws(() => validateInstallArtifact(root), /premind-mcp\.mjs differs/);
});
