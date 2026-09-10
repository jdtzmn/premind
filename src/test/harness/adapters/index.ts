/**
 * The registry of supported agent harnesses.
 *
 * This list is the review gate for adapter coverage: the fan-out test iterates
 * it, so a new production adapter that is not added here is never proven to
 * receive PR updates from the database.
 *
 * Claude Code is intentionally absent — `docs/claude-code-support.md` is a
 * design document, not an implementation. A plan does not make an adapter
 * supported.
 */

import { opencodeDriver } from "./opencode.ts"
import { piDriver } from "./pi.ts"
import type { AdapterDriver } from "./types.ts"

export const ADAPTER_DRIVERS: AdapterDriver[] = [opencodeDriver, piDriver]

export type { AdapterDriver, DeliverArgs, DeliverResult, DeliveryCapture } from "./types.ts"
