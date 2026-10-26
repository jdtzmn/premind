import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DaemonResponseError } from "../../shared/daemon-error.ts";
import { createPremindPiExtension, type PremindPiExtensionDependencies } from "../index.ts";

type Client = ReturnType<NonNullable<PremindPiExtensionDependencies["createDaemonClient"]>>;
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
};
const missing = new DaemonResponseError("SESSION_NOT_FOUND", "registration was lost");

const fixture = () => {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown>;
	const events = new Map<string, EventHandler>();
	const calls: Array<{ operation: string; payload?: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let registered = true;
	let hostId = "host-1";
	let file: string | undefined = "/tmp/pi-recovery-session.jsonl";
	let failure: Error | undefined;
	let recover: (() => Promise<void>) | undefined;
	let beforeAction: ((operation: string) => Promise<void>) | undefined;
	let beforeRegister: (() => Promise<void>) | undefined;
	let beforeRegisterClient: (() => Promise<void>) | undefined;
	let beforeDetectGit: (() => Promise<void>) | undefined;
	let nextClient: Client | undefined;
	const dispatch = async (operation: string, payload?: unknown) => {
		calls.push({ operation, payload });
		await beforeAction?.(operation);
		if (failure) throw failure;
		if (!registered) throw missing;
	};
	const client: Client = {
		registerClient: async () => {
			calls.push({ operation: "registerClient" });
			await beforeRegisterClient?.();
			return {};
		},
		registerSession: async (payload) => {
			calls.push({ operation: "registerSession", payload });
			await beforeRegister?.();
			registered = true;
		},
		recoverSession: async (sessionId) => {
			calls.push({ operation: "recoverSession", payload: sessionId });
			if (recover) await recover();
			else registered = true;
		},
		activateWorktree: (payload) => dispatch("activateWorktree", payload),
		subscribe: async (payload) => {
			await dispatch("subscribe", payload);
			return { subscription: { writePolicy: "observe-only" } };
		},
		unsubscribe: (payload) => dispatch("unsubscribe", payload),
		pauseSession: (id) => dispatch("pauseSession", id),
		resumeSession: (id) => dispatch("resumeSession", id),
		updateSessionState: (payload) => dispatch("updateSessionState", payload),
		heartbeat: async () => {},
		release: async () => { calls.push({ operation: "release" }); },
		releaseSessionOwner: async (id) => { calls.push({ operation: "releaseSessionOwner", payload: id }); },
		ensureSessionControl: async () => { throw new Error("unexpected fallback"); },
		setGlobalDisabled: async (disabled) => ({ disabled }),
		claimReminderBundle: async () => { await dispatch("claimReminderBundle"); return { bundle: null }; },
		ackReminderBundle: async () => ({ acknowledged: 0 }),
		getPendingReminder: async () => ({ batch: null }),
		ackReminder: async () => {},
		debugStatus: async () => ({ sessions: [] }) as never,
		pruneClosedSessions: async () => ({}),
	};
	const ctx = {
		cwd: "/tmp/premind-pi-recovery-tests",
		hasUI: false,
		sessionManager: { getSessionFile: () => file, getSessionId: () => hostId },
		ui: {
			notify: (message: string, level: string) => { notifications.push({ message, level }); },
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	createPremindPiExtension({
		createDaemonClient: () => nextClient ?? client,
		detectGit: async () => {
			await beforeDetectGit?.();
			return { repo: "owner/repo", branch: "feature" };
		},
		config: { statusPollIntervalMs: 0 },
	})({
		on: (name: string, handler: EventHandler) => events.set(name, handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerMessageRenderer: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI);
	return {
		client, ctx, calls, notifications,
		count: (operation: string) => calls.filter((call) => call.operation === operation).length,
		lose: () => { registered = false; },
		setFailure: (error: Error) => { failure = error; },
		setRecover: (hook: () => Promise<void>) => { recover = hook; },
		setAction: (hook: (operation: string) => Promise<void>) => { beforeAction = hook; },
		setRegister: (hook: () => Promise<void>) => { beforeRegister = hook; },
		setRegisterClient: (hook: () => Promise<void>) => { beforeRegisterClient = hook; },
		setDetectGit: (hook: () => Promise<void>) => { beforeDetectGit = hook; },
		setClient: (replacement: Client) => { nextClient = replacement; },
		setIdentity: (id: string, sessionFile = file) => { hostId = id; file = sessionFile; },
		event: (name: string) => events.get(name)!({} as never, ctx),
		tool: (name: string, params: Record<string, unknown> = {}, context = ctx) =>
			tools.get(name)!.execute("call", params, undefined, undefined, context),
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx as never),
	};
};

test("a transient initial registration failure permits a same-incarnation control retry", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	const failure = new Error("transient registerClient failure");
	f.setRegisterClient(async () => { throw failure; });
	await f.event("session_start");
	assert.equal(f.count("registerClient"), 1);
	assert.equal(f.count("registerSession"), 0);
	f.setRegisterClient(async () => {});
	await f.tool("premind_pause");
	assert.equal(f.count("registerClient"), 2);
	assert.equal(f.count("registerSession"), 1);
	assert.equal(f.count("pauseSession"), 1);
	assert.equal(f.count("recoverSession"), 0);
});

for (const stage of ["registerClient", "registerSession"] as const) {
	test(`a synchronous initial ${stage} throw rejects ready without an unhandled rejection`, async (t) => {
		const f = fixture();
		t.after(() => f.event("session_shutdown"));
		const failure = new Error(`synchronous ${stage} failure`);
		f.client[stage] = () => { throw failure; };
		await assert.rejects(f.tool("premind_pause"), (error) => error === failure);
		// Cross an event-loop boundary so node:test observes any unhandled rejection.
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(f.count("pauseSession"), 0);
		assert.equal(f.count("recoverSession"), 0);
	});
}

test("a discarded initial attachment cannot retry for another live host", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	f.setRegisterClient(async () => { throw new Error("transient"); });
	await f.event("session_start");
	f.setRegisterClient(async () => {});
	const other = { ...f.ctx, sessionManager: { getSessionFile: () => "/tmp/other.jsonl", getSessionId: () => "host-2" } } as unknown as ExtensionContext;
	await assert.rejects(f.tool("premind_pause", {}, other), /no longer current/);
	f.setIdentity("host-2");
	await assert.rejects(f.tool("premind_pause"), /no longer current/);
	assert.equal(f.count("registerClient"), 1);
});

test("a late initial rejection cannot discard a newer generation's attachment", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	const entered = deferred();
	const finish = deferred();
	const failure = new Error("old initial registration failed");
	f.setRegisterClient(async () => {
		entered.resolve();
		await finish.promise;
		throw failure;
	});
	const pending = f.tool("premind_subscribe", { prNumber: 123 });
	const rejected = assert.rejects(pending, (error) => error === failure);
	await entered.promise;
	f.setRegisterClient(async () => {});
	await f.event("session_start");
	finish.resolve();
	await rejected;
	await f.tool("premind_pause");
	assert.equal(f.count("registerClient"), 2);
	assert.equal(f.count("registerSession"), 1);
	assert.equal(f.count("pauseSession"), 1);
	assert.equal(f.count("subscribe"), 0);
});

test("initial ready rejection is observed when the caller's identity check fails first", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	const finish = deferred();
	f.setRegisterClient(async () => {
		f.setIdentity("host-2");
		await finish.promise;
	});
	await assert.rejects(f.tool("premind_pause"), /no longer current/);
	finish.resolve();
	// Cross an event-loop boundary so node:test also observes any unhandled rejection.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.count("registerSession"), 0);
});

const controls = [
	["subscribe", "subscribe", "123 owner/repo", { prNumber: 123, repo: "owner/repo" }],
	["unsubscribe", "unsubscribe", "123 owner/repo", { prNumber: 123, repo: "owner/repo" }],
	["set-active-checkout", "activateWorktree", "/tmp/other", { path: "/tmp/other" }],
	["pause", "pauseSession", "", {}],
	["resume", "resumeSession", "", {}],
] as const;

for (const [name, operation, args, params] of controls) {
	for (const surface of ["command", "tool"] as const) {
		test(`${surface} ${name} repairs directly once using the retained attachment`, async (t) => {
			const f = fixture();
			t.after(() => f.event("session_shutdown"));
			await f.event("session_start");
			const baseline = f.count(operation);
			f.lose();
			if (surface === "command") await f.command(`premind:${name}`, args);
			else await f.tool(`premind_${name.replaceAll("-", "_")}`, params);
			assert.equal(f.count(operation), baseline + 2);
			assert.equal(f.count("recoverSession"), 1);
			assert.equal(f.count("registerClient"), 1);
			assert.equal(f.count("registerSession"), 1);
			assert.equal(f.notifications.some((n) => n.level === "error"), false);
			assert.deepEqual(f.calls.find((call) => call.operation === "recoverSession")?.payload, "/tmp/pi-recovery-session.jsonl");
		});
	}
}

for (const event of ["agent_start", "agent_end"]) {
	test(`${event} advisory update repairs without ordinary registration`, async (t) => {
		const f = fixture();
		t.after(() => f.event("session_shutdown"));
		await f.event("session_start");
		f.lose();
		await f.event(event);
		assert.equal(f.count("updateSessionState"), 2);
		assert.equal(f.count("recoverSession"), 1);
		assert.equal(f.count("registerSession"), 1);
	});
}

test("concurrent actions share one recovery", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	await f.event("session_start");
	f.lose();
	const entered = deferred();
	const finish = deferred();
	f.setRecover(async () => { entered.resolve(); await finish.promise; });
	const first = f.tool("premind_subscribe", { prNumber: 123 });
	const second = f.tool("premind_pause");
	await entered.promise;
	assert.equal(f.count("recoverSession"), 1);
	finish.resolve();
	// Recovery deliberately leaves registration absent: both replays fail once.
	await Promise.all([assert.rejects(first, (e) => e === missing), assert.rejects(second, (e) => e === missing)]);
	assert.equal(f.count("subscribe"), 2);
	assert.equal(f.count("pauseSession"), 2);
	assert.equal(f.count("recoverSession"), 1);
});

test("a still-missing replay is bounded to one retry", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	await f.event("session_start");
	f.lose();
	f.setRecover(async () => {});
	await assert.rejects(f.tool("premind_subscribe", { prNumber: 123 }), (e) => e === missing);
	assert.equal(f.count("subscribe"), 2);
	assert.equal(f.count("recoverSession"), 1);
});

for (const error of [
	new DaemonResponseError("SESSION_ENDED", "ended"),
	new DaemonResponseError("INVALID_LEASE", "lease expired"),
	new DaemonResponseError("INTERNAL_ERROR", "unexpected"),
	Object.assign(new Error("SESSION_NOT_FOUND: transport failed"), { code: "ECONNRESET" }),
	new Error("unrelated"),
]) {
	test(`does not recover ${error.message}`, async (t) => {
		const f = fixture();
		t.after(() => f.event("session_shutdown"));
		await f.event("session_start");
		f.setFailure(error);
		await assert.rejects(f.tool("premind_subscribe", { prNumber: 123 }), (e) => e === error);
		assert.equal(f.count("subscribe"), 1);
		assert.equal(f.count("recoverSession"), 0);
	});
}

test("a client without recovery preserves the original error and never re-registers", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	delete f.client.recoverSession;
	await f.event("session_start");
	f.lose();
	await assert.rejects(f.tool("premind_subscribe", { prNumber: 123 }), (e) => e === missing);
	assert.equal(f.count("subscribe"), 1);
	assert.equal(f.count("registerClient"), 1);
	assert.equal(f.count("registerSession"), 1);
});

for (const boundary of ["session_shutdown", "session_start", "live identity"] as const) {
	test(`${boundary} during recovery blocks replay and cannot revive old work`, async (t) => {
		const f = fixture();
		t.after(() => f.event("session_shutdown"));
		await f.event("session_start");
		f.lose();
		const entered = deferred();
		const finish = deferred();
		f.setRecover(async () => { entered.resolve(); await finish.promise; });
		const pending = f.tool("premind_subscribe", { prNumber: 123 });
		const rejected = assert.rejects(pending, /no longer current/);
		await entered.promise;
		if (boundary === "live identity") f.setIdentity("host-2");
		else await f.event(boundary);
		finish.resolve();
		await rejected;
		assert.equal(f.count("subscribe"), 1);
		assert.equal(f.count("recoverSession"), 1);
		assert.equal(f.count("registerSession"), boundary === "session_start" ? 2 : 1);
		if (boundary === "session_shutdown") {
			await assert.rejects(f.tool("premind_pause"), /no longer current/);
			assert.equal(f.count("registerClient"), 1);
		}
	});
}

test("shutdown while the initial action is pending prevents recovery", async () => {
	const f = fixture();
	await f.event("session_start");
	const entered = deferred();
	const finish = deferred();
	f.setAction(async (operation) => {
		if (operation === "subscribe") { entered.resolve(); await finish.promise; }
	});
	f.lose();
	const pending = f.tool("premind_subscribe", { prNumber: 123 });
	const rejected = assert.rejects(pending, /no longer current/);
	await entered.promise;
	await f.event("session_shutdown");
	finish.resolve();
	await rejected;
	assert.equal(f.count("recoverSession"), 0);
	assert.equal(f.count("registerSession"), 1);
});

test("pending initial attachment cannot adopt a new lifecycle controller", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	const entered = deferred();
	const finish = deferred();
	f.setRegister(async () => { entered.resolve(); await finish.promise; });
	const pending = f.tool("premind_subscribe", { prNumber: 123 });
	const rejected = assert.rejects(pending, /no longer current/);
	await entered.promise;
	const shutdown = f.event("session_shutdown");
	f.setRegister(async () => {});
	await f.event("session_start");
	finish.resolve();
	await Promise.all([shutdown, rejected]);
	assert.equal(f.count("subscribe"), 0);
	assert.equal(f.count("recoverSession"), 0);
});

for (const stage of ["registerClient", "registerSession"] as const) {
	for (const fails of [false, true]) {
		test(`shutdown during initial ${stage} waits for ${fails ? "failure" : "settlement"} before cleanup`, async () => {
			const f = fixture();
			const entered = deferred();
			const finish = deferred();
			const order: string[] = [];
			const failure = new Error(`initial ${stage} failed`);
			const hook = async () => {
				entered.resolve();
				await finish.promise;
				order.push("initial settled");
				if (fails) throw failure;
			};
			if (stage === "registerClient") f.setRegisterClient(hook);
			else f.setRegister(hook);
			f.client.releaseSessionOwner = async (id) => {
				order.push("release owner");
				assert.equal(id, "/tmp/pi-recovery-session.jsonl");
			};
			f.client.release = async () => { order.push("release client"); };
			const pending = f.tool("premind_pause");
			const rejected = assert.rejects(pending, fails ? (error) => error === failure : /no longer current/);
			await entered.promise;
			const shutdown = f.event("session_shutdown");
			assert.deepEqual(order, []);
			await assert.rejects(f.tool("premind_resume"), /no longer current/);
			assert.deepEqual(order, []);
			finish.resolve();
			await Promise.all([shutdown, rejected]);
			assert.deepEqual(order, ["initial settled", "release owner", "release client"]);
			assert.equal(f.count("registerClient"), 1);
			assert.equal(f.count("registerSession"), stage === "registerSession" ? 1 : 0);
			assert.equal(f.count("pauseSession"), 0);
			assert.equal(f.count("resumeSession"), 0);
			assert.equal(f.count("recoverSession"), 0);
			await assert.rejects(f.tool("premind_pause"), /no longer current/);
			assert.equal(f.count("registerClient"), 1);
		});
	}
}

for (const fails of [false, true]) {
	test(`shutdown does not wait for hung Git discovery; late ${fails ? "failure" : "success"} cannot dispatch`, { timeout: 1_000 }, async () => {
		const f = fixture();
		const entered = deferred();
		const finish = deferred();
		const order: string[] = [];
		const failure = new Error("initial detectGit failed");
		f.setDetectGit(async () => {
			entered.resolve();
			await finish.promise;
			order.push("discovery settled");
			if (fails) throw failure;
		});
		f.client.releaseSessionOwner = async () => { order.push("release owner"); };
		f.client.release = async () => { order.push("release client"); };
		const pending = f.tool("premind_pause");
		const rejected = assert.rejects(pending, fails ? (error) => error === failure : /no longer current/);
		await entered.promise;
		// Discovery stays unresolved until shutdown has completed, not just started.
		await f.event("session_shutdown");
		assert.deepEqual(order, ["release owner", "release client"]);
		await assert.rejects(f.tool("premind_resume"), /no longer current/);
		assert.equal(f.count("registerSession"), 0);
		finish.resolve();
		await rejected;
		// Also let node:test observe any unhandled late rejection.
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(order, ["release owner", "release client", "discovery settled"]);
		assert.equal(f.count("registerClient"), 1);
		assert.equal(f.count("registerSession"), 0);
		assert.equal(f.count("pauseSession"), 0);
		assert.equal(f.count("resumeSession"), 0);
		assert.equal(f.count("recoverSession"), 0);
	});
}

test("late shutdown cleanup uses only the old client and leaves a replacement generation attached", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	const entered = deferred();
	const finish = deferred();
	f.setRegister(async () => { entered.resolve(); await finish.promise; });
	const pending = f.tool("premind_subscribe", { prNumber: 123 });
	const rejected = assert.rejects(pending, /no longer current/);
	await entered.promise;
	const shutdown = f.event("session_shutdown");
	f.setRegister(async () => {});
	const replacementCleanup: string[] = [];
	f.setClient({
		...f.client,
		releaseSessionOwner: async () => { replacementCleanup.push("owner"); },
		release: async () => { replacementCleanup.push("client"); },
	});
	await f.event("session_start");
	assert.equal(f.count("registerClient"), 2);
	finish.resolve();
	await Promise.all([shutdown, rejected]);
	assert.equal(f.count("releaseSessionOwner"), 1);
	assert.equal(f.count("release"), 1);
	assert.deepEqual(replacementCleanup, []);
	await f.tool("premind_pause");
	assert.equal(f.count("pauseSession"), 1);
	assert.equal(f.count("registerClient"), 2);
	assert.equal(f.count("registerSession"), 2);
	assert.equal(f.count("recoverSession"), 0);
	assert.equal(f.count("subscribe"), 0);
	await f.event("session_shutdown");
	assert.deepEqual(replacementCleanup, ["owner", "client"]);
});

test("cached identity refuses another context or a changed live file", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	await f.event("session_start");
	const other = { ...f.ctx, sessionManager: { getSessionFile: () => "/tmp/other.jsonl", getSessionId: () => "host-2" } } as unknown as ExtensionContext;
	await assert.rejects(f.tool("premind_pause", {}, other), /no longer current/);
	f.setIdentity("host-1", "/tmp/changed.jsonl");
	await assert.rejects(f.tool("premind_pause"), /no longer current/);
	assert.equal(f.count("pauseSession"), 0);
	assert.equal(f.count("registerSession"), 1);
});

test("delivery does not use session recovery", async (t) => {
	const f = fixture();
	t.after(() => f.event("session_shutdown"));
	await f.event("session_start");
	f.lose();
	await f.command("premind:deliver");
	assert.equal(f.count("claimReminderBundle"), 1);
	assert.equal(f.count("recoverSession"), 0);
});
