/**
 * The registry of supported agent harnesses.
 *
 * This list is the review gate for adapter coverage: the fan-out test iterates
 * it, so a new production adapter that is not added here is never proven to
 * receive PR updates from the database.
 * Keep this registry exhaustive: both the fan-out and late-arrival contract
 * suites iterate it for every production coding-agent integration.
 */

import { claudeDriver } from "./claude.ts"
import { codexDriver } from "./codex.ts"
import { opencodeDriver } from "./opencode.ts"
import { piDriver } from "./pi.ts"
import type { AdapterDriver } from "./types.ts"

export const ADAPTER_DRIVERS: AdapterDriver[] = [claudeDriver, codexDriver, opencodeDriver, piDriver]

export type {
	AdapterDriver,
	DeliverArgs,
	DeliverResult,
	DeliveryCapture,
	IdleDeliveryHandle,
	StartIdleArgs,
} from "./types.ts"
