import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { StateStore } from "../persistence/store.ts";
import { WorktreeBindingRegistry } from "./worktree-binding-registry.ts";

const tempPaths: string[] = [];

const createStore = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "premind-binding-registry-test-"));
	tempPaths.push(dir);
	return new StateStore(path.join(dir, "premind.db"));
};

const registerSession = (store: StateStore) => {
	store.registerClient("client-1", { pid: 1, projectRoot: "/repo" });
	store.registerSession({
		clientId: "client-1",
		sessionId: "session-1",
		repo: "acme/repo",
		branch: "feature/legacy",
		isPrimary: true,
		status: "active",
		busyState: "idle",
	});
};

const worktree = {
	root: "/repo/.trees/feature",
	gitDir: "/repo/.git/worktrees/feature",
	repo: "acme/repo",
	branch: "feature/worktree",
	headSha: "abc123",
};

const pullRequest = { repo: "acme/repo", prNumber: 13 };

afterEach(() => {
	while (tempPaths.length > 0) {
		const dir = tempPaths.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("WorktreeBindingRegistry", () => {
	test("reconstructs following and opt-out states from durable facts", async () => {
		const store = createStore();
		registerSession(store);

		const firstRegistry = new WorktreeBindingRegistry(store);
		await firstRegistry.activateWorktree(
			"session-1",
			worktree.root,
			async () => worktree,
		);
		firstRegistry.pullRequestFound("session-1", pullRequest, 10);
		assert.equal(
			firstRegistry.getSnapshot("session-1").value,
			"following_automatic_pr",
		);
		assert.equal(
			store.getWorktreeBinding("session-1")?.state,
			"following_automatic_pr",
		);
		assert.equal(
			store.getSubscription("session-1", "acme/repo", 13)?.state,
			"active",
		);
		firstRegistry.close();

		const secondRegistry = new WorktreeBindingRegistry(store);
		assert.equal(secondRegistry.has("session-1"), false);
		assert.equal(
			secondRegistry.getSnapshot("session-1").value,
			"following_automatic_pr",
		);
		assert.deepEqual(
			secondRegistry.getSnapshot("session-1").context.automaticPullRequest,
			pullRequest,
		);

		assert.deepEqual(
			secondRegistry.unsubscribeAutomatic("session-1", pullRequest, 20),
			{ unsubscribed: true, automaticOptOutRecorded: true },
		);
		assert.equal(
			store.getWorktreeBinding("session-1")?.state,
			"automatic_pr_unsubscribed",
		);
		secondRegistry.close();

		const thirdRegistry = new WorktreeBindingRegistry(store);
		assert.equal(
			thirdRegistry.getSnapshot("session-1").value,
			"automatic_pr_unsubscribed",
		);
		assert.deepEqual(
			thirdRegistry.getSnapshot("session-1").context.automaticPullRequest,
			pullRequest,
		);
		thirdRegistry.close();
		store.close();
	});

	test("discards a transitioned actor when persistence fails", async () => {
		const store = createStore();
		registerSession(store);
		const registry = new WorktreeBindingRegistry(store);
		await registry.activateWorktree(
			"session-1",
			worktree.root,
			async () => worktree,
		);

		const originalUpsert = store.upsertWorktreeBinding.bind(store);
		store.upsertWorktreeBinding = (() => {
			throw new Error("simulated persistence failure");
		}) as StateStore["upsertWorktreeBinding"];
		assert.throws(
			() => registry.pullRequestNotFound("session-1", 10),
			/simulated persistence failure/,
		);
		assert.equal(registry.has("session-1"), false);

		store.upsertWorktreeBinding = originalUpsert;
		assert.equal(registry.getSnapshot("session-1").value, "waiting_for_pr");
		registry.close();
		store.close();
	});

	test("removes actors for sessions closed by the stale-session reaper", () => {
		const store = createStore();
		registerSession(store);
		const registry = new WorktreeBindingRegistry(store);
		registry.getSnapshot("session-1");
		assert.equal(registry.has("session-1"), true);

		store.reapStaleSessions(0, Date.now() + 1);
		registry.closeInactiveSessions();
		assert.equal(registry.has("session-1"), false);
		store.close();
	});
});
