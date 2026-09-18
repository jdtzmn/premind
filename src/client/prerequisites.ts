import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class PremindPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PremindPrerequisiteError";
	}
}

export type PrerequisiteCommandRunner = (
	command: string,
	args: string[],
) => Promise<void>;

const runCommand: PrerequisiteCommandRunner = async (command, args) => {
	await execFileAsync(command, args);
};

const verifyCommand = async (
	run: PrerequisiteCommandRunner,
	command: "git" | "gh",
	remediation: string,
) => {
	try {
		await run(command, ["--version"]);
	} catch {
		throw new PremindPrerequisiteError(remediation);
	}
};

/** Verifies the external executables and GitHub authentication Premind needs. */
export const ensurePremindPrerequisites = async (
	run: PrerequisiteCommandRunner = runCommand,
) => {
	await verifyCommand(
		run,
		"git",
		"Premind requires Git. Install Git and restart Codex.",
	);
	await verifyCommand(
		run,
		"gh",
		"Premind requires the GitHub CLI (`gh`). Install it and restart Codex.",
	);
	try {
		await run("gh", ["auth", "status"]);
	} catch {
		throw new PremindPrerequisiteError(
			"Premind requires an authenticated GitHub CLI. Run `gh auth login` and restart Codex.",
		);
	}
};
