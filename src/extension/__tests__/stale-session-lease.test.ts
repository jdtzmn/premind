/**
 * A Pi session must survive its daemon session lease expiring.
 *
 * Leases last PREMIND_CLIENT_LEASE_TTL_MS after their last renewal. A host that
 * misses renewals for that long (a suspended laptop, a stalled event loop)
 * comes back holding an expired lease. This runs the real extension, client,
 * socket, router, and store so the failure is the one users see.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, mock, test } from "node:test";
import { PremindDaemonClient } from "../../client/daemon-client.ts";
import { IpcServer } from "../../daemon/ipc/server.ts";
import { StateStore } from "../../daemon/persistence/store.ts";
import { PREMIND_CLIENT_LEASE_TTL_MS } from "../../shared/constants.ts";
import { createPremindPiExtension } from "../index.ts";

type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;

const SESSION_FILE = "/tmp/stale-lease-session.jsonl";
const tempDirs: string[] = [];

afterEach(() => {
	mock.timers.reset();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

const startDaemon = async () => {
	const dir = fs.mkdtempSync("/tmp/premind-stale-lease-");
	tempDirs.push(dir);
	const socketPath = path.join(dir, "premind.sock");
	const server = new IpcServer(new StateStore(path.join(dir, "state.db")));
	await server.listen(socketPath);
	return { server, socketPath };
};

const startPiSession = async (socketPath: string) => {
	const events = new Map<string, EventHandler>();
	const sentMessages: unknown[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const clients: PremindDaemonClient[] = [];
	const pi = {
		on: (name: string, handler: EventHandler) => events.set(name, handler),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: (message: unknown) => sentMessages.push(message),
	};
	createPremindPiExtension({
		createDaemonClient: () => {
			const client = new PremindDaemonClient({ host: "pi", socketPath, ensureDaemon: async () => {} });
			clients.push(client);
			return client;
		},
		config: { statusPollIntervalMs: 0 },
		detectGit: async () => ({ repo: "acme/repo", branch: "feature/lease" }),
	})(pi as never);
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getSessionFile: () => SESSION_FILE },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
		},
	};
	const emit = async (name: string) => {
		const handler = events.get(name);
		assert.ok(handler, `extension registers ${name}`);
		await handler({}, ctx);
	};
	await emit("session_start");
	return { emit, sentMessages, notifications, clients };
};

const queueReminder = (store: StateStore) => {
	store.upsertSubscription({
		sessionId: SESSION_FILE,
		repo: "acme/repo",
		prNumber: 13,
		source: "manual",
	});
	store.insertEvents("acme/repo", 13, [
		{
			dedupeKey: "comment:1",
			kind: "issue_comment.created",
			priority: "high",
			summary: "New review comment",
			payload: {},
		},
	]);
};

describe("Pi session lease expiry", () => {
	for (const heartbeatAfterExpiry of [false, true]) {
		const when = heartbeatAfterExpiry ? " and a renewal is rejected" : "";
		test(`automatic delivery recovers after the session lease expires${when}`, async () => {
			mock.timers.enable({ apis: ["Date"], now: Date.now() });
			const { server, socketPath } = await startDaemon();
			const session = await startPiSession(socketPath);
			try {
				assert.deepEqual(session.notifications, []);
				queueReminder(server.store);

				// No renewal reaches the daemon for longer than the lease lifetime.
				mock.timers.tick(PREMIND_CLIENT_LEASE_TTL_MS + 1_000);
				if (heartbeatAfterExpiry) {
					// The extension's heartbeat timer fires first and swallows this rejection.
					await assert.rejects(session.clients[0]!.heartbeat(), /SESSION_MOVED/);
				}
				await session.emit("turn_end");

				assert.deepEqual(session.notifications, []);
				assert.equal(session.sentMessages.length, 1);
			} finally {
				await session.emit("session_shutdown");
				await server.close(socketPath);
			}
		});
	}
});
