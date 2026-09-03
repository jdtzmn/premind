import { assign, createActor, setup } from "xstate"

export type ActiveWorktree = {
  root: string
  gitDir: string
  repo: string
  branch: string | null
  headSha: string
}

export type PullRequestRef = {
  repo: string
  prNumber: number
}

export type WorktreeBindingContext = {
  requestedPath: string | null
  worktree: ActiveWorktree | null
  automaticPullRequest: PullRequestRef | null
}

export type WorktreeBindingEvent =
  | { type: "ACTIVATE_WORKTREE"; path: string }
  | { type: "WORKTREE_RESOLVED"; worktree: ActiveWorktree }
  | { type: "WORKTREE_RESOLUTION_FAILED" }
  | { type: "PR_FOUND"; pullRequest: PullRequestRef }
  | { type: "PR_NOT_FOUND" }
  | { type: "UNSUBSCRIBE_AUTOMATIC"; pullRequest: PullRequestRef }
  | { type: "SESSION_CLOSED" }

const emptyContext = (): WorktreeBindingContext => ({
  requestedPath: null,
  worktree: null,
  automaticPullRequest: null,
})

/**
 * Models only the durable decision boundary for a session's active worktree.
 *
 * Git resolution, GitHub branch discovery, subscription mutations, and SQLite
 * writes remain daemon services. Their results are fed back to this machine as
 * events, keeping persistence authoritative and transition tests deterministic.
 */
export const worktreeBindingMachine = setup({
  types: {
    context: {} as WorktreeBindingContext,
    events: {} as WorktreeBindingEvent,
  },
  guards: {
    isDetachedHead: ({ event }) =>
      event.type === "WORKTREE_RESOLVED" && event.worktree.branch === null,
    isCurrentAutomaticPullRequest: ({ context, event }) =>
      event.type === "UNSUBSCRIBE_AUTOMATIC" &&
      context.automaticPullRequest?.repo === event.pullRequest.repo &&
      context.automaticPullRequest?.prNumber === event.pullRequest.prNumber,
  },
}).createMachine({
  id: "worktreeBinding",
  initial: "unbound",
  context: emptyContext(),
  on: {
    SESSION_CLOSED: {
      target: ".closed",
      actions: assign({
        requestedPath: null,
        worktree: null,
        automaticPullRequest: null,
      }),
    },
  },
  states: {
    unbound: {
      on: {
        ACTIVATE_WORKTREE: {
          target: "resolving_worktree",
          actions: assign({
            requestedPath: ({ event }) => event.path,
            worktree: null,
            automaticPullRequest: null,
          }),
        },
      },
    },
    resolving_worktree: {
      on: {
        WORKTREE_RESOLVED: [
          {
            guard: "isDetachedHead",
            target: "detached_head",
            actions: assign({
              worktree: ({ event }) => event.worktree,
              automaticPullRequest: null,
            }),
          },
          {
            target: "waiting_for_pr",
            actions: assign({
              worktree: ({ event }) => event.worktree,
              automaticPullRequest: null,
            }),
          },
        ],
        WORKTREE_RESOLUTION_FAILED: {
          target: "unbound",
          actions: assign(emptyContext),
        },
        ACTIVATE_WORKTREE: {
          actions: assign({ requestedPath: ({ event }) => event.path }),
        },
      },
    },
    waiting_for_pr: {
      on: {
        PR_FOUND: {
          target: "following_automatic_pr",
          actions: assign({
            automaticPullRequest: ({ event }) => event.pullRequest,
          }),
        },
        PR_NOT_FOUND: {},
        ACTIVATE_WORKTREE: {
          target: "resolving_worktree",
          actions: assign({
            requestedPath: ({ event }) => event.path,
            worktree: null,
            automaticPullRequest: null,
          }),
        },
      },
    },
    following_automatic_pr: {
      on: {
        PR_FOUND: {
          actions: assign({
            automaticPullRequest: ({ event }) => event.pullRequest,
          }),
        },
        UNSUBSCRIBE_AUTOMATIC: {
          guard: "isCurrentAutomaticPullRequest",
          target: "automatic_pr_unsubscribed",
        },
        ACTIVATE_WORKTREE: {
          target: "resolving_worktree",
          actions: assign({
            requestedPath: ({ event }) => event.path,
            worktree: null,
            automaticPullRequest: null,
          }),
        },
      },
    },
    automatic_pr_unsubscribed: {
      on: {
        // The branch resolver may keep finding this same PR. The persisted
        // opt-out prevents it from dispatching PR_FOUND for this binding.
        PR_FOUND: {},
        ACTIVATE_WORKTREE: {
          target: "resolving_worktree",
          actions: assign({
            requestedPath: ({ event }) => event.path,
            worktree: null,
            automaticPullRequest: null,
          }),
        },
      },
    },
    detached_head: {
      on: {
        ACTIVATE_WORKTREE: {
          target: "resolving_worktree",
          actions: assign({
            requestedPath: ({ event }) => event.path,
            worktree: null,
            automaticPullRequest: null,
          }),
        },
      },
    },
    closed: {
      type: "final",
    },
  },
})

export const createWorktreeBindingActor = () => createActor(worktreeBindingMachine)
