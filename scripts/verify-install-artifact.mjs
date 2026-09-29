import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredInstallFiles, validateInstallArtifact } from "./install-artifact-layout.mjs";

export const verifyInstallArtifact = (directory) => {
	const metadata = JSON.parse(fs.readFileSync(path.join(directory, "artifact.json"), "utf8"));
	assert.equal(metadata.schemaVersion, 1);
	assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/);
	assert.equal(metadata.packageName, "premind");
	assert.equal(metadata.extractedRoot, "package");
	assert.equal(path.basename(metadata.archive.file), metadata.archive.file);
	assert.match(metadata.archive.sha256, /^[a-f0-9]{64}$/);
	const archive = path.join(directory, metadata.archive.file);
	const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
	assert.equal(actual, metadata.archive.sha256, "install archive checksum differs");
	const packageRoot = path.join(directory, metadata.extractedRoot);
	const { name, version } = validateInstallArtifact(packageRoot);
	assert.equal(name, metadata.packageName);
	assert.equal(version, metadata.packageVersion);

	// Do not trust the extracted copy merely because the tarball itself is intact.
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "premind-install-verify-"));
	try {
		const extracted = spawnSync("tar", ["-xzf", archive, "-C", temporary], { encoding: "utf8" });
		if (extracted.error) throw extracted.error;
		assert.equal(extracted.status, 0, extracted.stderr);
		for (const file of ["package.json", ...requiredInstallFiles]) {
			assert.deepEqual(
				fs.readFileSync(path.join(packageRoot, file)),
				fs.readFileSync(path.join(temporary, "package", file)),
				`extracted ${file} differs from archive`,
			);
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
	return metadata;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) throw new Error("Usage: node scripts/verify-install-artifact.mjs <directory>");
	const metadata = verifyInstallArtifact(path.resolve(process.argv[2]));
	process.stdout.write(`Verified ${metadata.sourceCommit} (${metadata.archive.file})\n`);
}
