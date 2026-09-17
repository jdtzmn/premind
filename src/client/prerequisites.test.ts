import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ensurePremindPrerequisites,
	PremindPrerequisiteError,
	type PrerequisiteCommandRunner,
} from "./prerequisites.ts";

const acceptsCommands =
	(seen: string[]): PrerequisiteCommandRunner =>
	async (command, args) => {
		seen.push(`${command} ${args.join(" ")}`);
	};

test("checks Git, GitHub CLI, then GitHub authentication", async () => {
	const seen: string[] = [];
	await ensurePremindPrerequisites(acceptsCommands(seen));
	assert.deepEqual(seen, ["git --version", "gh --version", "gh auth status"]);
});

test("reports missing Git with installation guidance", async () => {
	await assert.rejects(
		ensurePremindPrerequisites(async (command) => {
			if (command === "git") throw new Error("not found");
		}),
		(error: unknown) =>
			error instanceof PremindPrerequisiteError &&
			/Install Git/.test(error.message),
	);
});

test("reports missing GitHub CLI with installation guidance", async () => {
	await assert.rejects(
		ensurePremindPrerequisites(async (command) => {
			if (command === "gh") throw new Error("not found");
		}),
		(error: unknown) =>
			error instanceof PremindPrerequisiteError &&
			/GitHub CLI/.test(error.message),
	);
});

test("reports unauthenticated GitHub CLI with login guidance", async () => {
	await assert.rejects(
		ensurePremindPrerequisites(async (command, args) => {
			if (command === "gh" && args[0] === "auth") throw new Error("not logged in");
		}),
		(error: unknown) =>
			error instanceof PremindPrerequisiteError &&
			/gh auth login/.test(error.message),
	);
});
