import { pullRequestDeliveryScenario } from "./scenarios.ts"
import { piDriver } from "./pi.ts"

// One entry per host driver. Claude Code and Codex follow in #116.
for (const driver of [piDriver]) pullRequestDeliveryScenario(driver)
