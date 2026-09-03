import { assign, createActor, setup } from "xstate"

export type DaemonLifecycleState =
  | "startup"
  | "running"
  | "shutdown_grace"
  | "stopping"
  | "stopped"

export type DaemonLifecycleContext = {
  stopReason: string | null
}

export type DaemonLifecycleEvent =
  | { type: "STARTUP_COMPLETE"; hasDemand: boolean }
  | { type: "DEMAND_CHANGED"; hasDemand: boolean }
  | { type: "GRACE_EXPIRED" }
  | { type: "STOP_REQUESTED"; reason: string }
  | { type: "STOPPED" }

export const daemonLifecycleMachine = setup({
  types: {
    context: {} as DaemonLifecycleContext,
    events: {} as DaemonLifecycleEvent,
  },
  guards: {
    startupHasDemand: ({ event }) =>
      event.type === "STARTUP_COMPLETE" && event.hasDemand,
    demandReturned: ({ event }) =>
      event.type === "DEMAND_CHANGED" && event.hasDemand,
  },
  actions: {
    clearStopReason: assign({ stopReason: null }),
    assignIdleReason: assign({ stopReason: "idle" }),
    assignRequestedReason: assign({
      stopReason: ({ event }) =>
        event.type === "STOP_REQUESTED" ? event.reason : "requested",
    }),
  },
}).createMachine({
  id: "daemonLifecycle",
  initial: "startup",
  context: { stopReason: null },
  on: {
    STOP_REQUESTED: {
      target: ".stopping",
      actions: "assignRequestedReason",
    },
  },
  states: {
    startup: {
      on: {
        STARTUP_COMPLETE: [
          { guard: "startupHasDemand", target: "running" },
          { target: "shutdown_grace", actions: "assignIdleReason" },
        ],
      },
    },
    running: {
      on: {
        DEMAND_CHANGED: [
          { guard: "demandReturned" },
          { target: "shutdown_grace", actions: "assignIdleReason" },
        ],
      },
    },
    shutdown_grace: {
      on: {
        DEMAND_CHANGED: [
          {
            guard: "demandReturned",
            target: "running",
            actions: "clearStopReason",
          },
          {},
        ],
        GRACE_EXPIRED: "stopping",
      },
    },
    stopping: {
      on: {
        STOPPED: "stopped",
      },
    },
    stopped: {
      type: "final",
    },
  },
})

export const createDaemonLifecycleActor = () => createActor(daemonLifecycleMachine)
