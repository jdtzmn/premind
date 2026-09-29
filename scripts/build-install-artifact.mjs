import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateInstallArtifact } from "./install-artifact-layout.mjs";
import { verifyInstallArtifact } from "./verify-install-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output || fs.existsSync(output) || output.startsWith(`${root}${path.sep}`)) {
	throw new Error("Pass a new output directory outside the source checkout");
}

const run = (command, args, cwd) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 5 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
};

const sha = run("git", ["rev-parse", "HEAD"], root);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "premind-install-build-"));
let staged;
try {
	const checkout = path.join(temporary, "checkout");
	run("git", ["clone", "--local", "--no-hardlinks", "--quiet", root, checkout], root);
	run("git", ["checkout", "--quiet", "--detach", sha], checkout);
	assert.equal(run("git", ["rev-parse", "HEAD"], checkout), sha);
	run("bun", ["install", "--frozen-lockfile"], checkout);

	staged = fs.mkdtempSync(path.join(path.dirname(output), ".premind-install-"));
	const packOutput = run("npm", ["pack", "--json", "--silent", "--pack-destination", staged], checkout);
	const jsonStart = packOutput.lastIndexOf("\n[");
	const packed = JSON.parse(packOutput.slice(jsonStart === -1 ? 0 : jsonStart + 1));
	assert.equal(packed.length, 1, "npm pack must produce one archive");
	const filename = packed[0].filename;
	assert.equal(path.basename(filename), filename, "unsafe npm archive filename");
	const archive = path.join(staged, filename);
	run("tar", ["-xzf", archive, "-C", staged], checkout);
	const { name, version } = validateInstallArtifact(path.join(staged, "package"));
	assert.equal(version, packed[0].version, "npm pack version differs from extracted package");
	const checksum = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
	fs.writeFileSync(
		path.join(staged, "artifact.json"),
		`${JSON.stringify({ schemaVersion: 1, sourceCommit: sha, packageName: name, packageVersion: version, archive: { file: filename, sha256: checksum }, extractedRoot: "package" }, null, 2)}\n`,
	);
	verifyInstallArtifact(staged);
	fs.renameSync(staged, output);
	staged = undefined;
	process.stdout.write(`Prepared ${output} from ${sha} (${filename}, sha256 ${checksum})\n`);
} finally {
	if (staged) fs.rmSync(staged, { recursive: true, force: true });
	fs.rmSync(temporary, { recursive: true, force: true });
}
