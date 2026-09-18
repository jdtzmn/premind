import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireSessionLifecycleLock } from "../delivery-receipts.ts";
import type { CodexDeliveryReceipt } from "../schemas.ts";

const tempDirectories: string[] = [];
const createTempDir = () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "premind-codex-state-"),
	);
	tempDirectories.push(directory);
	return directory;
};

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

const receipt = (
	sessionId = "codex:thread/../../unsafe",
): CodexDeliveryReceipt => ({
	sessionId,
	batchId: "batch-1",
	handoffId: "00000000-0000-4000-8000-000000000001",
	boundary: "user_prompt_submit",
	sourceTurnId: "turn-1",
	outputFlushedAt: 100,
	leaseExpiresAt: 1_000,
});

describe("Codex delivery receipts", () => {
	test("encodes session paths and atomically publishes exact handoff evidence", async () => {
		const pluginData = createTempDir();
		const expected = receipt();
		const first = await acquireSessionLifecycleLock(
			pluginData,
			expected.sessionId,
		);
		first.publishReceipt(expected);

		const files = fs
			.readdirSync(path.join(pluginData, "premind", "v1", "sessions"), {
				recursive: true,
			})
			.map(String);
		assert.equal(
			files.some((file) => file.includes("../")),
			false,
		);
		assert.equal(
			files.some((file) => file.includes("thread")),
			false,
		);
		assert.equal(
			files.some((file) => file.endsWith("lifecycle.lock")),
			false,
		);
		assert.equal(
			files.some((file) => file.endsWith(`${expected.handoffId}.json`)),
			true,
		);

		const second = await acquireSessionLifecycleLock(
			pluginData,
			expected.sessionId,
		);
		assert.deepEqual(second.listReceipts(), [expected]);
		assert.equal(
			second.compareAndDeleteReceipt({ ...expected, batchId: "wrong-batch" }),
			false,
		);
		assert.equal(second.compareAndDeleteReceipt(expected), true);
		second.release();
	});

	test("serializes concurrent boundaries and times out without stealing a live lock", async () => {
		const pluginData = createTempDir();
		const sessionId = "codex:thread-1";
		const first = await acquireSessionLifecycleLock(pluginData, sessionId);
		await assert.rejects(
			acquireSessionLifecycleLock(pluginData, sessionId, {
				timeoutMs: 30,
				retryMs: 5,
				staleMs: 0,
				isProcessAlive: () => true,
			}),
			/Timed out acquiring Codex lifecycle lock/,
		);
		first.release();
		const second = await acquireSessionLifecycleLock(pluginData, sessionId, {
			timeoutMs: 30,
			retryMs: 5,
		});
		second.release();
	});

	test("recovers dead stale owners without allowing the old owner to delete the replacement", async () => {
		const pluginData = createTempDir();
		const sessionId = "codex:thread-1";
		const first = await acquireSessionLifecycleLock(pluginData, sessionId);
		const second = await acquireSessionLifecycleLock(pluginData, sessionId, {
			timeoutMs: 30,
			retryMs: 1,
			staleMs: 0,
			isProcessAlive: () => false,
		});
		first.release();
		second.publishReceipt(receipt(sessionId));

		const third = await acquireSessionLifecycleLock(pluginData, sessionId);
		assert.equal(third.listReceipts().length, 1);
		third.release();
	});

	test("atomically fences simultaneous stale-lock reclaimers", async () => {
		const pluginData = createTempDir();
		const sessionId = "codex:stale-race";
		const initialized = await acquireSessionLifecycleLock(
			pluginData,
			sessionId,
		);
		initialized.release();
		const database = new DatabaseSync(
			path.join(pluginData, "premind", "v1", "codex-lifecycle-locks.sqlite"),
		);
		database
			.prepare(
				`INSERT INTO codex_lifecycle_locks (session_id, token, pid, created_at)
         VALUES (?, ?, ?, ?)`,
			)
			.run(sessionId, "00000000-0000-4000-8000-000000000099", 999_999_999, 0);
		database.close();
		const goPath = path.join(pluginData, "go");
		const criticalPath = path.join(pluginData, "critical");
		const overlapPath = path.join(pluginData, "overlap");
		const moduleUrl = pathToFileURL(
			path.resolve("src/codex/delivery-receipts.ts"),
		).href;
		const childScript = `
      import fs from "node:fs";
      import { acquireSessionLifecycleLock } from ${JSON.stringify(moduleUrl)};
      while (!fs.existsSync(${JSON.stringify(goPath)})) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const lock = await acquireSessionLifecycleLock(
        ${JSON.stringify(pluginData)},
        ${JSON.stringify(sessionId)},
        { timeoutMs: 2_000, staleMs: 0, retryMs: 2 },
      );
      let descriptor;
      try {
        descriptor = fs.openSync(${JSON.stringify(criticalPath)}, "wx");
      } catch (error) {
        if (error.code === "EEXIST") {
          fs.writeFileSync(${JSON.stringify(overlapPath)}, "overlap");
        } else {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.rmSync(${JSON.stringify(criticalPath)}, { force: true });
      }
      lock.release();
    `;
		const children = Array.from({ length: 2 }, () =>
			spawn(
				process.execPath,
				["--import", "tsx", "--input-type=module", "--eval", childScript],
				{ stdio: ["ignore", "pipe", "pipe"] },
			),
		);
		fs.writeFileSync(goPath, "go");
		const results = await Promise.all(
			children.map(
				(child) =>
					new Promise<{ code: number | null; stderr: string }>((resolve) => {
						let stderr = "";
						child.stderr.setEncoding("utf8");
						child.stderr.on("data", (chunk) => {
							stderr += chunk;
						});
						child.once("exit", (code) => resolve({ code, stderr }));
					}),
			),
		);
		for (const result of results) assert.equal(result.code, 0, result.stderr);
		assert.equal(fs.existsSync(overlapPath), false);
	});

	test("ignores corrupt receipt evidence without treating it as confirmation", async () => {
		const pluginData = createTempDir();
		const sessionId = "codex:thread-1";
		const first = await acquireSessionLifecycleLock(pluginData, sessionId);
		first.release();
		const receiptsDirectory = path.join(
			pluginData,
			"premind",
			"v1",
			"sessions",
			Buffer.from(sessionId).toString("base64url"),
			"receipts",
		);
		fs.writeFileSync(path.join(receiptsDirectory, "corrupt.json"), "not-json");
		fs.writeFileSync(
			path.join(receiptsDirectory, "00000000-0000-4000-8000-000000000099.json"),
			JSON.stringify({
				...receipt("codex:other-session"),
				handoffId: "00000000-0000-4000-8000-000000000099",
			}),
		);
		const second = await acquireSessionLifecycleLock(pluginData, sessionId);
		assert.deepEqual(second.listReceipts(), []);
		second.release();
	});
});
