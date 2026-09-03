import { createActor, setup } from "xstate"

export type ReminderHandoffState = "built" | "handed_off" | "failed" | "confirmed"

export type ReminderHandoffEvent =
  | { type: "HAND_OFF" }
  | { type: "CONFIRM" }
  | { type: "FAIL" }
  | { type: "RETRY" }

/**
 * Models the acknowledgement boundary for one durable reminder batch.
 * Persistence and delivery are services around this machine; invalid events are
 * intentionally ignored so callers can reject them before changing SQLite.
 */
export const reminderHandoffMachine = setup({
  types: {
    events: {} as ReminderHandoffEvent,
  },
}).createMachine({
  id: "reminderHandoff",
  initial: "built",
  states: {
    built: {
      on: {
        HAND_OFF: "handed_off",
      },
    },
    handed_off: {
      on: {
        CONFIRM: "confirmed",
        FAIL: "failed",
      },
    },
    failed: {
      on: {
        RETRY: "built",
      },
    },
    confirmed: {
      type: "final",
    },
  },
})

export const eventForReminderState = (
  state: Exclude<ReminderHandoffState, "built">,
): ReminderHandoffEvent => {
  switch (state) {
    case "handed_off":
      return { type: "HAND_OFF" }
    case "failed":
      return { type: "FAIL" }
    case "confirmed":
      return { type: "CONFIRM" }
  }
}

export const createReminderHandoffActor = (state: ReminderHandoffState = "built") => {
  const actor = createActor(reminderHandoffMachine)
  actor.start()
  if (state === "built") return actor

  actor.send({ type: "HAND_OFF" })
  if (state === "failed") actor.send({ type: "FAIL" })
  else if (state === "confirmed") actor.send({ type: "CONFIRM" })
  return actor
}
