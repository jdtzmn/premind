/**
 * The contract every supported agent harness must satisfy.
 *
 * Adding a production adapter without adding a driver here should be caught in
 * review: the fan-out test iterates this registry, so an absent adapter is
 * simply never proven to receive updates.
 */

import type {
	CapabilityException,
	CommandCapabilityId,
} from "../../../shared/command-capabilities.ts"
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

export type StartIdleArgs = DeliverArgs & {
	/** Advance host timers without making the session cross another lifecycle boundary. */
	advanceTime: (milliseconds: number) => Promise<void>
}

export type DeliverResult = {
	captured: DeliveryCapture[]
	/** Re-run the adapter's idle boundary; used to prove no duplicate delivery. */
	idleAgain: () => Promise<void>
}

export type IdleDeliveryHandle = DeliverResult & {
	/** Cross the earliest boundary this host supports after a late reminder arrives. */
	afterUpdate: () => Promise<void>
	shutdown: () => Promise<void>
}

export type AdapterDriver = {
	/** Stable key used for session naming and diagnostics. */
	key: string
	sessionId: string
	branch: string
	deliver: (args: DeliverArgs) => Promise<DeliverResult>
	startIdle: (args: StartIdleArgs) => Promise<IdleDeliveryHandle>
	/**
	 * Establish the session through the host's real lifecycle and expose its
	 * production model tools, resolved by capability through
	 * `command-capabilities.ts`.
	 */
	createControls: (args: DeliverArgs) => Promise<HarnessControls>
	/**
	 * Shared scenarios this host is excused from, with the same typed exceptions
	 * as `command-capabilities.ts`. A `deferred` entry must name a tracking issue.
	 */
	scenarioExceptions?: Partial<Record<SharedScenarioId, CapabilityException>>
}

/** Cross-adapter behaviors a driver may be excused from. */
export type SharedScenarioId = "bundlesPendingBatches"

export type ToolInvocationResult = { text: string; isError: boolean }

export type HarnessControls = {
	/** Call this harness's real model tool for a capability. */
	invoke: (
		capabilityId: CommandCapabilityId,
		params?: Record<string, unknown>,
	) => Promise<ToolInvocationResult>
	/** Messages the host injected into the session while controls were used. */
	captured: DeliveryCapture[]
	/**
	 * Cross the earliest lifecycle boundary at which this host delivers pending
	 * reminders, and settle any handoff the host confirms at the next boundary.
	 */
	crossDeliveryBoundary: () => Promise<void>
	/**
	 * Replay the host's real reload or restart of this same session: tear down
	 * the running instance the way the host does, then start a fresh instance.
	 */
	restart: () => Promise<HarnessControls>
	shutdown: () => Promise<void>
}
