import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in live behavioral check: requires an authenticated Pi model, never runs in CI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hosts = {
	pi: "skills/premind",
	codex: "plugins/codex/premind/skills/premind",
	claude: "plugin-claude/skills/premind",
};
const host = process.argv[2] ?? "pi";
const selectedCase = process.argv[3];
if (!(host in hosts)) throw new Error(`Unknown skill host: ${host}`);
const cases = JSON.parse(
	readFileSync(new URL("./premind-skill-evals.json", import.meta.url), "utf8"),
);
const targets = selectedCase
	? cases.filter((testCase) => testCase.name === selectedCase)
	: cases;
if (targets.length === 0)
	throw new Error(`Unknown skill case: ${selectedCase}`);
const skillDirectory = path.join(root, hosts[host]);
const model =
	process.env.PREMIND_SKILL_EVAL_MODEL ?? "openai-codex/gpt-5.6-terra";

for (const testCase of targets) {
	const result = spawnSync(
		"pi",
		[
			"--no-skills",
			"--skill",
			skillDirectory,
			"--no-extensions",
			"--no-context-files",
			"--tools",
			"read",
			"--no-session",
			"--mode",
			"json",
			"--model",
			model,
			...(host === "pi" || testCase.reference === null
				? []
				: [
						"--append-system-prompt",
						`For this read-only skill test, you are acting as a ${host === "claude" ? "Claude Code" : "Codex"} agent, not a Pi agent. Use only the selected skill's controls when explaining Premind behavior.`,
					]),
			testCase.prompt,
		],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
			timeout: 120_000,
		},
	);
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		`Pi failed for ${testCase.name}: ${result.stderr.slice(0, 1000)}`,
	);
	const events = result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const calls = events.filter((event) => event.type === "tool_execution_start");
	assert.ok(
		calls.every((event) => event.toolName === "read"),
		"Live skill evaluation must be read-only",
	);
	const paths = calls.map((event) => String(event.args?.path ?? ""));
	const skillLoaded = paths.some(
		(value) =>
			path.resolve(root, value) === path.join(skillDirectory, "SKILL.md"),
	);
	const references = paths
		.filter((value) =>
			path
				.resolve(root, value)
				.startsWith(path.join(skillDirectory, "references") + path.sep),
		)
		.map((value) => path.basename(value));
	const expected = testCase.reference;
	const routingPass =
		expected === null
			? !skillLoaded && references.length === 0
			: skillLoaded &&
				references.includes(expected) &&
				references.every((name) => name === expected);
	const answer = events
		.filter(
			(event) =>
				event.type === "message_end" && event.message?.role === "assistant",
		)
		.flatMap((event) => event.message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(" ")
		.replace(/\s+/g, " ");
	const subscriptionCase = expected === "subscriptions.md";
	const wrongTool =
		host === "claude"
			? /\bpremind_(?:set_active_checkout|subscribe|unsubscribe|status)\b/
			: host === "codex"
				? /\bpremind_activate_worktree\b/
				: null;
	const checkoutTool =
		host === "pi"
			? "premind_set_active_checkout"
			: host === "claude"
				? "set_active_checkout"
				: "premind_set_active_checkout";
	const needsCheckoutTool =
		subscriptionCase && (host !== "codex" || testCase.name !== "start-pr-work");
	const behaviorPass = subscriptionCase
		? (!wrongTool || !wrongTool.test(answer)) &&
			(!needsCheckoutTool || answer.includes(checkoutTool))
		: expected === "reminders.md"
			? /untrusted/i.test(answer)
			: true;
	const passed = routingPass && behaviorPass;
	console.log(
		JSON.stringify({
			host,
			case: testCase.name,
			routingPass,
			behaviorPass,
			passed,
			skillLoaded,
			references,
			answer: answer.slice(0, 320),
		}),
	);
	if (!passed) process.exitCode = 1;
}
