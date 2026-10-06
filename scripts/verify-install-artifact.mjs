import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredInstallFiles, validateInstallArtifact } from "./install-artifact-layout.mjs";

const codexFiles = [
	".agents/plugins/marketplace.json",
	"plugins/codex/premind/.codex-plugin/plugin.json",
	"plugins/codex/premind/.mcp.json",
	"plugins/codex/premind/hooks/hooks.json",
	"plugins/codex/premind/generated/premind-daemon.mjs",
	"plugins/codex/premind/generated/premind-hook.mjs",
	"plugins/codex/premind/generated/premind-mcp.mjs",
];
const claudeFiles = [
	".claude-plugin/plugin.json",
	".mcp.json",
	"hooks/hooks.json",
	"bin/mcp-server.mjs",
	"bin/ensure-daemon.mjs",
	"bin/lib.mjs",
	"bin/session-start.mjs",
	"bin/session-end.mjs",
	"bin/stop.mjs",
	"bin/user-prompt-submit.mjs",
	"generated/daemon-startup.mjs",
	"generated/premind-daemon.mjs",
];
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const verifyInstallArtifact = (directory) => {
	const metadata = JSON.parse(fs.readFileSync(path.join(directory, "artifact.json"), "utf8"));
	assert.equal(metadata.schemaVersion, 2);
	assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/);
	assert.equal(metadata.packageName, "premind");
	assert.equal(metadata.extractedRoot, "package");
	const { name, version } = validateInstallArtifact(path.join(directory, "package"));
	assert.equal(name, metadata.packageName);
	assert.equal(version, metadata.packageVersion);
	assert.match(metadata.claudeVersion, /^\d+\.\d+\.\d+$/);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(directory, "package/plugin-claude/.claude-plugin/plugin.json"), "utf8")).version,
		metadata.claudeVersion,
	);
	assert.deepEqual(Object.keys(metadata.archives).sort(), ["claude", "codex", "npm"]);
	const expectedNames = {
		npm: `premind-${version}.tgz`,
		codex: `premind-codex-${version}.tgz`,
		claude: `premind-claude-${metadata.claudeVersion}.tgz`,
	};
	const lines = [];
	for (const host of ["npm", "codex", "claude"]) {
		const asset = metadata.archives[host];
		assert.equal(asset.file, expectedNames[host]);
		assert.match(asset.sha256, /^[a-f0-9]{64}$/);
		assert.equal(digest(path.join(directory, asset.file)), asset.sha256, `${host} archive checksum differs`);
		lines.push(`${asset.sha256}  ${asset.file}`);
	}
	assert.equal(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), `${lines.join("\n")}\n`);

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "premind-dist-verify-"));
	try {
		for (const host of ["npm", "codex", "claude"]) {
			const extracted = path.join(temporary, host);
			fs.mkdirSync(extracted);
			const result = spawnSync("tar", ["-xzf", path.join(directory, metadata.archives[host].file), "-C", extracted], { encoding: "utf8" });
			if (result.error) throw result.error;
			assert.equal(result.status, 0, result.stderr);
			const source = host === "claude" ? path.join(directory, "package/plugin-claude") : path.join(directory, "package");
			const target = host === "npm" ? path.join(extracted, "package") : extracted;
			const files = host === "npm" ? ["package.json", ...requiredInstallFiles] : host === "codex" ? codexFiles : claudeFiles;
			for (const file of files) {
				assert.deepEqual(
					fs.readFileSync(path.join(target, file)),
					fs.readFileSync(path.join(source, file)),
					`extracted ${host} ${file} differs from archive`,
				);
			}
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
	return metadata;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) throw new Error("Usage: node scripts/verify-install-artifact.mjs <dist-directory>");
	const metadata = verifyInstallArtifact(path.resolve(process.argv[2]));
	process.stdout.write(`Verified dist ${metadata.sourceCommit} (${Object.values(metadata.archives).map((asset) => asset.file).join(", ")})\n`);
}
