import type { Logger } from "../logging/logger.ts"

/**
 * Minimal store contract needed for the disable gate. Keeps this module
 * trivially testable without pulling in the full StateStore.
 */
export type DisableGateStore = {
  isGloballyDisabled(): boolean
}

/**
 * Wrap a poller tick with a check against the store's global-disable flag.
 * When disabled, the tick is short-circuited (no GitHub API calls). The logger
 * emits a single "skipped" message per transition into the disabled state and
 * a matching "resumed" message when it transitions back, so we don't spam the
 * log on every tick while disabled.
 */
export const createDisableGatedTick = (
  name: string,
  store: DisableGateStore,
  tick: () => Promise<void>,
  logger: Pick<Logger, "info">,
) => {
  let lastLoggedDisabled: boolean | undefined
  return async () => {
    if (store.isGloballyDisabled()) {
      if (lastLoggedDisabled !== true) {
        logger.info(`${name} skipped: premind globally disabled`)
        lastLoggedDisabled = true
      }
      return
    }
    if (lastLoggedDisabled === true) {
      logger.info(`${name} resumed: premind globally re-enabled`)
    }
    lastLoggedDisabled = false
    await tick()
  }
}
