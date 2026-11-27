import { pullRequestDeliveryScenario } from "./scenarios.ts"
import { piDriver } from "./pi.ts"

// One entry per host driver. OpenCode joins once its V2 plugin tracks sessions
// (#121); Claude Code and Codex follow in #116.
for (const driver of [piDriver]) pullRequestDeliveryScenario(driver)
