import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createReminderDeliveryController,
	createStalePollGuard,
	type ClaimedReminderBundle,
	type ReminderBundleClient,
} from "./reminder-delivery.ts";
import type { AckReminderBundlePayload, ReminderBatch } from "./schema.ts";

const batch = (id: string, text: string): ReminderBatch =>
	({
		batchId: id,
		reminderText: text,
		events: [{ eventId: `${id}-event` }],
	}) as unknown as ReminderBatch;

function fakeClient(batches: ReminderBatch[] | null) {
	const acks: AckReminderBundlePayload[] = [];
	let claims = 0;
	const client: ReminderBundleClient = {
		claimReminderBundle: async () => {
			claims++;
			return { bundle: batches ? { handoffId: "handoff-1", batches } : null };
		},
		ackReminderBundle: async (payload) => {
			acks.push(payload);
			return { acknowledged: payload.state === "confirmed" ? (batches?.length ?? 0) : 0 };
		},
	};
	return { client, acks, claims: () => claims };
}

test("delivers every claimed batch as one merged reminder and confirms it", async () => {
	const { client, acks } = fakeClient([batch("a", "first"), batch("b", "second")]);
	const sent: ClaimedReminderBundle[] = [];
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: (bundle) => {
			sent.push(bundle);
		},
		sessionEndedError: "ended",
	});

	const result = await controller.deliver("s1");

	assert.equal(result.delivered, true);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].reminderText, "first\n\nsecond");
	assert.equal(sent[0].details.reminderText, "first\n\nsecond");
	assert.deepEqual(
		sent[0].details.events.map((event) => event.eventId),
		["a-event", "b-event"],
	);
	assert.deepEqual(acks, [{ sessionId: "s1", handoffId: "handoff-1", state: "confirmed" }]);
});

test("does nothing when there is no pending bundle", async () => {
	const { client, acks } = fakeClient(null);
	let sends = 0;
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {
			sends++;
		},
		sessionEndedError: "ended",
	});

	assert.deepEqual(await controller.deliver("s1"), { delivered: false });
	assert.equal(sends, 0);
	assert.deepEqual(acks, []);
});

test("fails the handoff when the session ends between claim and send", async () => {
	const { client, acks } = fakeClient([batch("a", "first")]);
	let current = true;
	let sends = 0;
	const original = client.claimReminderBundle;
	client.claimReminderBundle = async (sessionId) => {
		const response = await original(sessionId);
		current = false;
		return response;
	};
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {
			sends++;
		},
		sessionEndedError: "session ended before reminder delivery",
	});

	assert.deepEqual(await controller.deliver("s1", () => current), { delivered: false });
	assert.equal(sends, 0);
	assert.deepEqual(acks, [
		{
			sessionId: "s1",
			handoffId: "handoff-1",
			state: "failed",
			error: "session ended before reminder delivery",
		},
	]);
});

test("does not claim for a session that is no longer current", async () => {
	const { client, claims } = fakeClient([batch("a", "first")]);
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {},
		sessionEndedError: "ended",
	});

	assert.deepEqual(await controller.deliver("s1", () => false), { delivered: false });
	assert.equal(claims(), 0);
});

test("fails the handoff and rethrows when the host cannot send", async () => {
	const { client, acks } = fakeClient([batch("a", "first")]);
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {
			throw new Error("host rejected the reminder");
		},
		sessionEndedError: "ended",
	});

	await assert.rejects(controller.deliver("s1"), /host rejected the reminder/);
	assert.deepEqual(acks, [
		{ sessionId: "s1", handoffId: "handoff-1", state: "failed", error: "host rejected the reminder" },
	]);
	assert.equal(controller.isInFlight("s1"), false);
});

test("fails the handoff when the daemon confirms fewer batches than were sent", async () => {
	const { client, acks } = fakeClient([batch("a", "first"), batch("b", "second")]);
	client.ackReminderBundle = async (payload) => {
		acks.push(payload);
		return { acknowledged: payload.state === "confirmed" ? 1 : 0 };
	};
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {},
		sessionEndedError: "ended",
	});

	await assert.rejects(controller.deliver("s1"), /Confirmed 1 of 2 reminder batches/);
	assert.deepEqual(
		acks.map((ack) => ack.state),
		["confirmed", "failed"],
	);
});

test("keeps an idempotent host's admitted handoff when confirmation fails", async () => {
	const { client, acks } = fakeClient([batch("a", "first")]);
	client.ackReminderBundle = async (payload) => {
		acks.push(payload);
		throw new Error("lost the acknowledgement");
	};
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: () => {},
		sessionEndedError: "ended",
		retainHandoffOnConfirmationFailure: true,
	});

	await assert.rejects(controller.deliver("s1"), /lost the acknowledgement/);
	assert.deepEqual(acks, [{ sessionId: "s1", handoffId: "handoff-1", state: "confirmed" }]);
});

test("runs one delivery per session at a time but lets other sessions proceed", async () => {
	const { client, claims } = fakeClient([batch("a", "first")]);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const controller = createReminderDeliveryController({
		getClient: () => client,
		send: async ({ sessionId }) => {
			if (sessionId === "s1") await blocked;
		},
		sessionEndedError: "ended",
	});

	const first = controller.deliver("s1");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(controller.isInFlight("s1"), true);
	assert.deepEqual(await controller.deliver("s1"), { delivered: false });
	assert.equal((await controller.deliver("s2")).delivered, true);
	release();
	assert.equal((await first).delivered, true);
	assert.equal(claims(), 2);
});

test("stale poll guard runs one poll at a time and replaces a stuck one", () => {
	let now = 0;
	const guard = createStalePollGuard(1_000, () => now);
	assert.equal(guard.describe(), "no poll has completed yet");

	const first = guard.begin();
	assert.notEqual(first, undefined);
	assert.equal(guard.begin(), undefined);

	now = 1_000;
	assert.equal(guard.describe(), "stuck for 1s; the next poll replaces it");
	const second = guard.begin();
	assert.notEqual(second, undefined);

	// The replaced poll finishing late does not clear the running poll.
	guard.end(first!, new Error("late"));
	assert.equal(guard.begin(), undefined);

	now = 1_500;
	guard.end(second!, new Error("daemon unreachable"));
	now = 3_500;
	assert.equal(guard.describe(), "last completed 2s ago with an error: daemon unreachable");

	const third = guard.begin();
	guard.end(third!);
	assert.equal(guard.describe(), "last completed 0s ago");
});
