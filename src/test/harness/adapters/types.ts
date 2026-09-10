/**
 * The contract every supported agent harness must satisfy.
 *
 * Adding a production adapter without adding a driver here should be caught in
 * review: the fan-out test iterates this registry, so an absent adapter is
 * simply never proven to receive updates.
 */

import type { RouterDaemonClient } from "../router-daemon-client.ts"

/** One reminder as the host actually received it. */
export type DeliveryCapture = {
	sessionId: string
	text: string
	/** Host-specific delivery metadata, asserted per adapter. */
	meta?: Record<string, unknown>
}

export type DeliverArgs = {
	daemonClient: RouterDaemonClient
	sessionId: string
	branch: string
}

export type DeliverResult = {
	captured: DeliveryCapture[]
	/** Re-run the adapter's idle boundary; used to prove no duplicate delivery. */
	idleAgain: () => Promise<void>
}

export type AdapterDriver = {
	/** Stable key used for session naming and diagnostics. */
	key: string
	sessionId: string
	branch: string
	deliver: (args: DeliverArgs) => Promise<DeliverResult>
}
