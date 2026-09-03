import { assign, createActor, setup } from "xstate"

export type PrWatcherState =
  | "stopped"
  | "warming_up"
  | "polling"
  | "idle_grace"
  | "backing_off"
  | "rate_limited"
  | "terminal"

export type PrWatcherContext = {
  repo: string
  prNumber: number
  subscriberCount: number
  idleDeadlineAt: number | null
  terminalAt: number | null
  nextEligiblePollAt: number | null
  consecutiveFailures: number
  lastFailureAt: number | null
  lastFailureMessage: string | null
  rateLimitResetAt: number | null
}

export type PrWatcherEvent =
  | { type: "SUBSCRIBERS_CHANGED"; count: number; now: number; idleGraceMs: number }
  | { type: "WARMED_UP" }
  | { type: "POLL_SUCCEEDED"; nextEligiblePollAt: number }
  | { type: "POLL_FAILED"; now: number; message: string; nextEligiblePollAt: number }
  | { type: "RATE_LIMITED"; resetAt: number }
  | { type: "TIME_ELAPSED"; now: number }
  | { type: "PR_TERMINAL"; now: number }

export type PrWatcherDurableSnapshot = PrWatcherContext & { state: PrWatcherState }

export const prWatcherMachine = setup({
  types: {
    context: {} as PrWatcherContext,
    input: {} as PrWatcherContext,
    events: {} as PrWatcherEvent,
  },
  guards: {
    hasSubscribers: ({ event }) => event.type === "SUBSCRIBERS_CHANGED" && event.count > 0,
    idleDeadlineElapsed: ({ context, event }) =>
      event.type === "TIME_ELAPSED" &&
      context.idleDeadlineAt !== null &&
      event.now >= context.idleDeadlineAt,
    pollEligible: ({ context, event }) =>
      event.type === "TIME_ELAPSED" &&
      context.nextEligiblePollAt !== null &&
      event.now >= context.nextEligiblePollAt,
  },
  actions: {
    assignActiveSubscribers: assign({
      subscriberCount: ({ event }) => event.type === "SUBSCRIBERS_CHANGED" ? event.count : 0,
      idleDeadlineAt: null,
    }),
    assignIdleSubscribers: assign({
      subscriberCount: ({ event }) => event.type === "SUBSCRIBERS_CHANGED" ? event.count : 0,
      idleDeadlineAt: ({ event }) =>
        event.type === "SUBSCRIBERS_CHANGED" ? event.now + event.idleGraceMs : null,
      nextEligiblePollAt: null,
    }),
  },
}).createMachine({
  id: "prWatcher",
  initial: "stopped",
  context: ({ input }) => input,
  on: {
    PR_TERMINAL: {
      target: ".terminal",
      actions: assign({
        terminalAt: ({ event }) => event.now,
        idleDeadlineAt: null,
        nextEligiblePollAt: null,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureMessage: null,
        rateLimitResetAt: null,
      }),
    },
  },
  states: {
    stopped: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", target: "warming_up", actions: "assignActiveSubscribers" },
          { actions: assign({ subscriberCount: ({ event }) => event.count }) },
        ],
      },
    },
    warming_up: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", actions: "assignActiveSubscribers" },
          { target: "idle_grace", actions: "assignIdleSubscribers" },
        ],
        WARMED_UP: { target: "polling" },
        RATE_LIMITED: {
          target: "rate_limited",
          actions: assign({
            rateLimitResetAt: ({ event }) => event.resetAt,
            nextEligiblePollAt: ({ event }) => event.resetAt,
          }),
        },
      },
    },
    polling: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", actions: "assignActiveSubscribers" },
          { target: "idle_grace", actions: "assignIdleSubscribers" },
        ],
        POLL_SUCCEEDED: {
          actions: assign({
            nextEligiblePollAt: ({ event }) => event.nextEligiblePollAt,
            consecutiveFailures: 0,
            lastFailureAt: null,
            lastFailureMessage: null,
            rateLimitResetAt: null,
          }),
        },
        POLL_FAILED: {
          target: "backing_off",
          actions: assign({
            nextEligiblePollAt: ({ event }) => event.nextEligiblePollAt,
            consecutiveFailures: ({ context }) => context.consecutiveFailures + 1,
            lastFailureAt: ({ event }) => event.now,
            lastFailureMessage: ({ event }) => event.message,
          }),
        },
        RATE_LIMITED: {
          target: "rate_limited",
          actions: assign({
            rateLimitResetAt: ({ event }) => event.resetAt,
            nextEligiblePollAt: ({ event }) => event.resetAt,
          }),
        },
      },
    },
    idle_grace: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", target: "warming_up", actions: "assignActiveSubscribers" },
          { actions: assign({ subscriberCount: ({ event }) => event.count }) },
        ],
        TIME_ELAPSED: {
          guard: "idleDeadlineElapsed",
          target: "stopped",
          actions: assign({ idleDeadlineAt: null, nextEligiblePollAt: null }),
        },
      },
    },
    backing_off: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", actions: "assignActiveSubscribers" },
          { target: "idle_grace", actions: "assignIdleSubscribers" },
        ],
        TIME_ELAPSED: { guard: "pollEligible", target: "polling" },
        RATE_LIMITED: {
          target: "rate_limited",
          actions: assign({
            rateLimitResetAt: ({ event }) => event.resetAt,
            nextEligiblePollAt: ({ event }) => event.resetAt,
          }),
        },
      },
    },
    rate_limited: {
      on: {
        SUBSCRIBERS_CHANGED: [
          { guard: "hasSubscribers", actions: "assignActiveSubscribers" },
          { target: "idle_grace", actions: "assignIdleSubscribers" },
        ],
        TIME_ELAPSED: {
          guard: "pollEligible",
          target: "polling",
          actions: assign({ rateLimitResetAt: null }),
        },
      },
    },
    terminal: {},
  },
})

const initialContext = (snapshot: PrWatcherDurableSnapshot): PrWatcherContext => ({
  repo: snapshot.repo,
  prNumber: snapshot.prNumber,
  subscriberCount: snapshot.subscriberCount,
  idleDeadlineAt: snapshot.idleDeadlineAt,
  terminalAt: snapshot.terminalAt,
  nextEligiblePollAt: snapshot.nextEligiblePollAt,
  consecutiveFailures:
    snapshot.state === "backing_off"
      ? Math.max(0, snapshot.consecutiveFailures - 1)
      : snapshot.consecutiveFailures,
  lastFailureAt: snapshot.lastFailureAt,
  lastFailureMessage: snapshot.lastFailureMessage,
  rateLimitResetAt: snapshot.rateLimitResetAt,
})

export const createPrWatcherActor = (snapshot: PrWatcherDurableSnapshot) => {
  const actor = createActor(prWatcherMachine, { input: initialContext(snapshot) })
  actor.start()

  if (snapshot.state === "terminal") {
    actor.send({ type: "PR_TERMINAL", now: snapshot.terminalAt ?? 0 })
    return actor
  }

  if (snapshot.state !== "stopped") {
    actor.send({
      type: "SUBSCRIBERS_CHANGED",
      count: Math.max(snapshot.subscriberCount, 1),
      now: snapshot.idleDeadlineAt ?? snapshot.nextEligiblePollAt ?? 0,
      idleGraceMs: 0,
    })
  }
  if (snapshot.state !== "stopped" && snapshot.state !== "warming_up") {
    actor.send({ type: "WARMED_UP" })
  }

  if (snapshot.state === "idle_grace") {
    actor.send({
      type: "SUBSCRIBERS_CHANGED",
      count: 0,
      now: snapshot.idleDeadlineAt ?? 0,
      idleGraceMs: 0,
    })
  } else if (snapshot.state === "backing_off") {
    actor.send({
      type: "POLL_FAILED",
      now: snapshot.lastFailureAt ?? 0,
      message: snapshot.lastFailureMessage ?? "poll failed",
      nextEligiblePollAt: snapshot.nextEligiblePollAt ?? 0,
    })
  } else if (snapshot.state === "rate_limited") {
    actor.send({ type: "RATE_LIMITED", resetAt: snapshot.rateLimitResetAt ?? snapshot.nextEligiblePollAt ?? 0 })
  }

  return actor
}
