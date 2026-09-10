import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	ensureCodexSessionBinding,
	resolveCodexSessionBinding,
} from "../session-binding.ts";

const createTempDir = () =>
	fs.mkdtempSync(path.join(os.tmpdir(), "premind-codex-binding-"));

const session = (sessionId: string) => ({
	sessionId,
	host: "codex",
	status: "active",
});

test("keeps one opaque handle while updating a session cwd", () => {
	const pluginData = createTempDir();
	try {
		const first = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			"/repo/one",
			1,
		);
		const second = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			"/repo/two",
			2,
		);
		assert.equal(second.sessionHandle, first.sessionHandle);
		assert.equal(second.cwd, path.resolve("/repo/two"));
	} finally {
		fs.rmSync(pluginData, { recursive: true, force: true });
	}
});

test("resolves an explicit handle only to a live Codex session", () => {
	const pluginData = createTempDir();
	try {
		const binding = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			"/repo",
		);
		assert.equal(
			resolveCodexSessionBinding({
				pluginData,
				sessions: [session(binding.sessionId)],
				sessionHandle: binding.sessionHandle,
			})?.sessionId,
			binding.sessionId,
		);
		assert.throws(
			() =>
				resolveCodexSessionBinding({
					pluginData,
					sessions: [{ ...session(binding.sessionId), status: "dormant" }],
					sessionHandle: binding.sessionHandle,
				}),
			/Unknown or inactive/,
		);
	} finally {
		fs.rmSync(pluginData, { recursive: true, force: true });
	}
});

test("never cwd-routes when two live Codex sessions share a directory", () => {
	const pluginData = createTempDir();
	try {
		const first = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			"/repo",
		);
		const second = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-2",
			"/repo",
		);
		assert.throws(
			() =>
				resolveCodexSessionBinding({
					pluginData,
					sessions: [session(first.sessionId), session(second.sessionId)],
					cwd: "/repo",
				}),
			/Multiple Codex sessions/,
		);
	} finally {
		fs.rmSync(pluginData, { recursive: true, force: true });
	}
});

test("treats symlinked working-directory aliases as ambiguous", (t) => {
	const pluginData = createTempDir();
	const checkout = path.join(pluginData, "checkout");
	const alias = path.join(pluginData, "checkout-alias");
	fs.mkdirSync(checkout);
	try {
		fs.symlinkSync(checkout, alias, "dir");
	} catch (error) {
		fs.rmSync(pluginData, { recursive: true, force: true });
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			t.skip("symlinks unavailable");
			return;
		}
		throw error;
	}
	try {
		const first = ensureCodexSessionBinding(
			pluginData,
			"codex:thread-1",
			checkout,
		);
		const second = ensureCodexSessionBinding(pluginData, "codex:thread-2", alias);
		assert.throws(
			() =>
				resolveCodexSessionBinding({
					pluginData,
					sessions: [session(first.sessionId), session(second.sessionId)],
					cwd: checkout,
				}),
			/Multiple Codex sessions/,
		);
	} finally {
		fs.rmSync(pluginData, { recursive: true, force: true });
	}
});
