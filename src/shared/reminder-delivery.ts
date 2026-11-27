import type { AckReminderBundlePayload, ReminderBatch } from "./schema.ts";

/** Daemon calls the delivery controller needs; satisfied by PremindDaemonClient. */
export type ReminderBundleClient = {
	claimReminderBundle: (sessionId: string) => Promise<{
		bundle: { handoffId: string; batches: ReminderBatch[] } | null;
	}>;
	ackReminderBundle: (
		payload: AckReminderBundlePayload,
	) => Promise<{ acknowledged: number }>;
};

/** One claimed bundle, merged into a single reminder for the host to show. */
export type ClaimedReminderBundle = {
	sessionId: string;
	handoffId: string;
	batches: ReminderBatch[];
	/** Every batch's reminder text, joined by blank lines. */
	reminderText: string;
	/** The first batch with the merged text and every batch's events. */
	details: ReminderBatch;
};

export type ReminderDeliveryResult =
	| { delivered: false }
	| { delivered: true; batches: ReminderBatch[] };

export type ReminderDeliveryControllerOptions = {
	getClient: () => ReminderBundleClient;
	/** Hands the merged reminder to the host. Throwing fails the handoff. */
	send: (bundle: ClaimedReminderBundle) => void | Promise<void>;
	/** Failure reason recorded when the session ends between claim and send. */
	sessionEndedError: string;
};

export function mergeReminderBatches(
	sessionId: string,
	handoffId: string,
	batches: ReminderBatch[],
): ClaimedReminderBundle {
	const reminderText = batches.map((batch) => batch.reminderText).join("\n\n");
	return {
		sessionId,
		handoffId,
		batches,
		reminderText,
		details: {
			...batches[0],
			reminderText,
			events: batches.flatMap((batch) => batch.events),
		},
	};
}

/**
 * Claims every pending batch for a session as one bundle, hands it to the
 * host, and acknowledges the handoff. One delivery runs per session at a time.
 * `isCurrent` lets the host abandon a delivery whose session ended mid-claim;
 * the bundle is then failed so the daemon offers it again.
 */
export function createReminderDeliveryController(
	options: ReminderDeliveryControllerOptions,
) {
	const inFlight = new Set<string>();

	const deliver = async (
		sessionId: string,
		isCurrent: () => boolean = () => true,
	): Promise<ReminderDeliveryResult> => {
		if (inFlight.has(sessionId) || !isCurrent()) return { delivered: false };
		inFlight.add(sessionId);
		const client = options.getClient();
		let handoffId: string | undefined;
		try {
			const bundle = (await client.claimReminderBundle(sessionId)).bundle;
			if (!bundle) return { delivered: false };
			handoffId = bundle.handoffId;
			const { batches } = bundle;

			if (!isCurrent()) {
				await client.ackReminderBundle({
					sessionId,
					handoffId,
					state: "failed",
					error: options.sessionEndedError,
				});
				handoffId = undefined;
				return { delivered: false };
			}

			await options.send(mergeReminderBatches(sessionId, handoffId, batches));
			const result = await client.ackReminderBundle({
				sessionId,
				handoffId,
				state: "confirmed",
			});
			if (result.acknowledged !== batches.length)
				throw new Error(
					`Confirmed ${result.acknowledged} of ${batches.length} reminder batches`,
				);
			handoffId = undefined;
			return { delivered: true, batches };
		} catch (error) {
			if (handoffId !== undefined) {
				try {
					await client.ackReminderBundle({
						sessionId,
						handoffId,
						state: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
				} catch {
					// Preserve the original delivery failure.
				}
			}
			throw error;
		} finally {
			inFlight.delete(sessionId);
		}
	};

	return {
		deliver,
		isInFlight: (sessionId: string) => inFlight.has(sessionId),
	};
}

export type ReminderDeliveryController = ReturnType<
	typeof createReminderDeliveryController
>;

/**
 * Keeps one poll running at a time, but lets a new poll replace one that has
 * run longer than `staleMs`, so a hung daemon request cannot stop polling for
 * good. A replaced poll may still finish late; it does not overwrite the record
 * of the poll that replaced it.
 */
export function createStalePollGuard(
	staleMs: number,
	now: () => number = () => Date.now(),
) {
	let startedAt: number | undefined;
	let token = 0;
	let lastCompletedAt: number | undefined;
	let lastError: string | undefined;

	return {
		/** Returns a token for the new poll, or undefined if one is still running. */
		begin(): number | undefined {
			const start = now();
			if (startedAt !== undefined && start - startedAt < staleMs) return undefined;
			startedAt = start;
			return ++token;
		},
		end(pollToken: number, error?: unknown) {
			if (pollToken !== token) return;
			startedAt = undefined;
			lastCompletedAt = now();
			lastError =
				error === undefined
					? undefined
					: error instanceof Error
						? error.message
						: String(error);
		},
		describe(at: number = now()) {
			if (startedAt !== undefined && at - startedAt >= staleMs)
				return `stuck for ${Math.round((at - startedAt) / 1000)}s; the next poll replaces it`;
			if (lastCompletedAt === undefined) return "no poll has completed yet";
			const age = `last completed ${Math.round((at - lastCompletedAt) / 1000)}s ago`;
			return lastError ? `${age} with an error: ${lastError}` : age;
		},
	};
}
