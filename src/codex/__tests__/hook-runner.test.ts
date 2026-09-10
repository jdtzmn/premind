import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { describe, test } from "node:test";
import {
	flushProtocolOutput,
	readHookInput,
	runHookMain,
} from "../hook-runner.ts";

class CapturingWritable extends Writable {
	value = "";
	constructor(private readonly delayMs = 0) {
		super();
	}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	) {
		setTimeout(() => {
			this.value += chunk.toString("utf8");
			callback();
		}, this.delayMs);
	}
}

describe("Codex hook runner", () => {
	test("reads exactly one bounded JSON input", async () => {
		assert.deepEqual(await readHookInput(Readable.from(['{"ok":true}\n'])), {
			ok: true,
		});
		await assert.rejects(
			readHookInput(Readable.from(["not-json"])),
			/not valid JSON/,
		);
		await assert.rejects(
			readHookInput(Readable.from(["x".repeat(1024 * 1024 + 1)])),
			/exceeds the supported size/,
		);
	});

	test("does not resolve protocol flush before the writable callback", async () => {
		const output = new CapturingWritable(25);
		let resolved = false;
		const flushing = flushProtocolOutput(output, "{}\n").then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(resolved, false);
		await flushing;
		assert.equal(output.value, "{}\n");
	});

	test("keeps malformed input fail-open and diagnostics off stdout", async () => {
		const output = new CapturingWritable();
		const diagnostics = new CapturingWritable();
		await runHookMain({
			eventName: "Stop",
			input: Readable.from(["not-json"]),
			output,
			diagnostics,
			environment: {},
		});
		await Promise.all([
			new Promise<void>((resolve) => output.end(resolve)),
			new Promise<void>((resolve) => diagnostics.end(resolve)),
		]);
		assert.equal(output.value, "{}\n");
		assert.match(diagnostics.value, /runner setup/);
		assert.equal(diagnostics.value.includes("not-json"), false);
	});

	test("emits no protocol output for unknown events or SessionEnd parse failure", async () => {
		const unknownOutput = new CapturingWritable();
		const diagnostics = new CapturingWritable();
		await runHookMain({
			eventName: "Unknown",
			input: Readable.from(["{}"]),
			output: unknownOutput,
			diagnostics,
		});
		const endOutput = new CapturingWritable();
		await runHookMain({
			eventName: "SessionEnd",
			input: Readable.from(["not-json"]),
			output: endOutput,
			diagnostics,
		});
		assert.equal(unknownOutput.value, "");
		assert.equal(endOutput.value, "");
	});
});
