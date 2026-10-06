import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInstallArtifact } from "./verify-install-artifact.mjs";

export const releaseAssets = (directory, metadata, tag, commit) => {
	assert.equal(tag, `v${metadata.packageVersion}`, "tag does not match the built package version");
	assert.equal(commit, metadata.sourceCommit, "tag commit does not match the built dist");
	return ["npm", "codex", "claude"].map((host) => path.join(directory, metadata.archives[host].file))
		.concat([path.join(directory, "SHA256SUMS"), path.join(directory, "artifact.json")]);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = process.argv[2] && path.resolve(process.argv[2]);
	if (!directory) throw new Error("Usage: node scripts/publish-dist.mjs <downloaded-dist-directory>");
	const { GITHUB_SHA: commit, GITHUB_REF: ref, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: event } = process.env;
	assert.equal(repo, "jdtzmn/premind", "only the upstream repository may publish");
	assert.equal(event, "push", "release requires a tag push");
	assert.equal(ref, `refs/tags/${tag}`, "release requires a tag ref");
	const metadata = verifyInstallArtifact(directory);
	const assets = releaseAssets(directory, metadata, tag, commit);
	const notesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-release-notes-"));
	try {
		const notes = path.join(notesDirectory, "notes.md");
		fs.writeFileSync(notes, `Premind release ${tag} from commit ${commit}. Download the host archive and verify it with SHA256SUMS. The npm archive contains the Pi and OpenCode package; the Claude plugin retains its independently versioned manifest (${metadata.claudeVersion}).\n\n_(Drafted by Jacob's coding agent on his behalf)_\n`);
		const result = spawnSync("gh", ["release", "create", tag, ...assets, "--verify-tag", "--repo", repo, "--title", `Premind ${tag}`, "--notes-file", notes], { stdio: "inherit" });
		if (result.error) throw result.error;
		assert.equal(result.status, 0, "GitHub Release creation failed; no assets were rebuilt");
	} finally {
		fs.rmSync(notesDirectory, { recursive: true, force: true });
	}
}
