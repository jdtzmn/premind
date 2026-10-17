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
const output = path.resolve(process.argv[2] ?? path.join(root, "dist"));
if (fs.existsSync(output) || (output.startsWith(`${root}${path.sep}`) && output !== path.join(root, "dist"))) {
	throw new Error("Use a new dist directory or a new output directory outside the checkout");
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
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const sha = run("git", ["rev-parse", "HEAD"], root);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "premind-dist-build-"));
let staged;
try {
	const checkout = path.join(temporary, "checkout");
	run("git", ["clone", "--local", "--no-hardlinks", "--quiet", root, checkout], root);
	run("git", ["checkout", "--quiet", "--detach", sha], checkout);
	assert.equal(run("git", ["rev-parse", "HEAD"], checkout), sha);
	run("bun", ["install", "--frozen-lockfile"], checkout);

	staged = fs.mkdtempSync(path.join(path.dirname(output), ".premind-dist-"));
	const packOutput = run("npm", ["pack", "--json", "--silent", "--pack-destination", staged], checkout);
	const jsonStart = packOutput.lastIndexOf("\n[");
	const packed = JSON.parse(packOutput.slice(jsonStart === -1 ? 0 : jsonStart + 1));
	assert.equal(packed.length, 1, "npm pack must produce one archive");
	const filename = packed[0].filename;
	assert.equal(path.basename(filename), filename, "unsafe npm archive filename");
	const npmArchive = path.join(staged, filename);
	run("tar", ["-xzf", npmArchive, "-C", staged], checkout);
	const packageRoot = path.join(staged, "package");
	const { name, version } = validateInstallArtifact(packageRoot);
	assert.equal(version, packed[0].version, "npm pack version differs from extracted package");
	const claudeVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-claude/.claude-plugin/plugin.json"), "utf8")).version;
	assert.match(claudeVersion, /^\d+\.\d+\.\d+$/);

	// These host archives come only from the npm archive extracted above, never a second build.
	const codexRoot = path.join(temporary, "codex");
	fs.mkdirSync(path.join(codexRoot, "plugins", "codex"), { recursive: true });
	fs.cpSync(path.join(packageRoot, ".agents"), path.join(codexRoot, ".agents"), { recursive: true });
	fs.cpSync(path.join(packageRoot, "plugins/codex/premind"), path.join(codexRoot, "plugins/codex/premind"), { recursive: true });
	const codexFile = `premind-codex-${version}.tgz`;
	run("tar", ["-czf", path.join(staged, codexFile), "-C", codexRoot, "."], checkout);
	const claudeFile = `premind-claude-${claudeVersion}.tgz`;
	run("tar", ["-czf", path.join(staged, claudeFile), "-C", path.join(packageRoot, "plugin-claude"), "."], checkout);

	const files = [filename, codexFile, claudeFile];
	const hashes = Object.fromEntries(files.map((file) => [file, digest(path.join(staged, file))]));
	fs.writeFileSync(path.join(staged, "SHA256SUMS"), `${files.map((file) => `${hashes[file]}  ${file}`).join("\n")}\n`);
	fs.writeFileSync(
		path.join(staged, "artifact.json"),
		`${JSON.stringify({ schemaVersion: 2, sourceCommit: sha, packageName: name, packageVersion: version, claudeVersion, archives: { npm: { file: filename, sha256: hashes[filename] }, codex: { file: codexFile, sha256: hashes[codexFile] }, claude: { file: claudeFile, sha256: hashes[claudeFile] } }, extractedRoot: "package" }, null, 2)}\n`,
	);
	verifyInstallArtifact(staged);
	fs.renameSync(staged, output);
	staged = undefined;
	process.stdout.write(`Prepared dist ${output} from ${sha} (${files.join(", ")})\n`);
} finally {
	if (staged) fs.rmSync(staged, { recursive: true, force: true });
	fs.rmSync(temporary, { recursive: true, force: true });
}
