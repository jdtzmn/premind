import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requiredInstallFiles, validateInstallArtifact } from "./install-artifact-layout.mjs";
import { verifyInstallArtifact } from "./verify-install-artifact.mjs";

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

test("verifies archive checksum and extracted contents", (t) => {
  const { root } = makeFixture();
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "premind-install-bundle-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.renameSync(root, path.join(bundle, "package"));
  const filename = "premind-0.1.0.tgz";
  const packed = spawnSync("tar", ["-czf", filename, "package"], { cwd: bundle });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const archive = path.join(bundle, filename);
  const original = fs.readFileSync(archive);
  const sha256 = createHash("sha256").update(original).digest("hex");
  fs.writeFileSync(
    path.join(bundle, "artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceCommit: "a".repeat(40),
      packageName: "premind",
      packageVersion: "0.1.0",
      archive: { file: filename, sha256 },
      extractedRoot: "package",
    }),
  );
  assert.equal(verifyInstallArtifact(bundle).archive.sha256, sha256);
  fs.appendFileSync(archive, "corrupt");
  assert.throws(() => verifyInstallArtifact(bundle), /archive checksum differs/);
  fs.writeFileSync(archive, original);
  fs.writeFileSync(path.join(bundle, "package/extensions/premind.ts"), "different");
  assert.throws(() => verifyInstallArtifact(bundle), /extracted extensions\/premind\.ts differs/);
});
