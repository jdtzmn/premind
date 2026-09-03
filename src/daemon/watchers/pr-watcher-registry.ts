import { PREMIND_PR_WATCHER_IDLE_GRACE_MS } from "../../shared/constants.ts"
import type { PrWatcherRecord, StateStore } from "../persistence/store.ts"
import {
  createPrWatcherActor,
  type PrWatcherDurableSnapshot,
  type PrWatcherState,
} from "./pr-watcher-machine.ts"

export type PrWatcherActor = ReturnType<typeof createPrWatcherActor>

export type PrWatcherRegistryOptions = {
  idleGraceMs?: number
  failureBackoffBaseMs?: number
  failureBackoffMaxMs?: number
  now?: number
}

const watcherKey = (repo: string, prNumber: number) => `${repo}#${prNumber}`

const durableSnapshot = (record: PrWatcherRecord): PrWatcherDurableSnapshot => ({
  repo: record.repo,
  prNumber: record.prNumber,
  state: record.state,
  subscriberCount: record.activeSubscriberCount,
  idleDeadlineAt: record.idleDeadlineAt,
  terminalAt: record.terminalAt,
  nextEligiblePollAt: record.nextEligiblePollAt,
  consecutiveFailures: record.consecutiveFailures,
  lastFailureAt: record.lastFailureAt,
  lastFailureMessage: record.lastFailureMessage,
  rateLimitResetAt: record.rateLimitResetAt,
})

/**
 * Owns one canonical watcher actor per repository-qualified pull request.
 * SQLite remains authoritative: actors are restored from durable lifecycle rows,
 * reconciled against durable subscriptions, and persisted after each transition.
 */
export class PrWatcherRegistry {
  private readonly actors = new Map<string, PrWatcherActor>()
  private readonly idleGraceMs: number
  private readonly failureBackoffBaseMs: number
  private readonly failureBackoffMaxMs: number

  constructor(
    private readonly store: StateStore,
    options: PrWatcherRegistryOptions = {},
  ) {
    this.idleGraceMs = options.idleGraceMs ?? PREMIND_PR_WATCHER_IDLE_GRACE_MS
    this.failureBackoffBaseMs = options.failureBackoffBaseMs ?? 20_000
    this.failureBackoffMaxMs = options.failureBackoffMaxMs ?? 5 * 60_000
    this.reconstruct(options.now ?? Date.now())
  }

  get size(): number {
    return this.actors.size
  }

  has(repo: string, prNumber: number): boolean {
    return this.actors.has(watcherKey(repo, prNumber))
  }

  getSnapshot(repo: string, prNumber: number) {
    return this.actors.get(watcherKey(repo, prNumber))?.getSnapshot() ?? null
  }

  reconstruct(now = Date.now()): void {
    for (const actor of this.actors.values()) actor.stop()
    this.actors.clear()
    for (const record of this.store.listPrWatcherRecords(now)) {
      this.actors.set(watcherKey(record.repo, record.prNumber), createPrWatcherActor(durableSnapshot(record)))
    }
  }

  pollingTargets(now = Date.now()): Array<{ repo: string; prNumber: number }> {
    this.reconcile(now)
    const targets: Array<{ repo: string; prNumber: number }> = []
    for (const actor of this.actors.values()) {
      const snapshot = actor.getSnapshot()
      if (snapshot.value !== "polling") continue
      if (
        snapshot.context.nextEligiblePollAt !== null &&
        snapshot.context.nextEligiblePollAt > now
      ) {
        continue
      }
      targets.push({ repo: snapshot.context.repo, prNumber: snapshot.context.prNumber })
    }
    return targets
  }

  reconcile(now = Date.now()): void {
    const records = this.store.listPrWatcherRecords(now)
    const durableKeys = new Set(records.map((record) => watcherKey(record.repo, record.prNumber)))
    for (const [key, actor] of this.actors) {
      if (durableKeys.has(key)) continue
      actor.stop()
      this.actors.delete(key)
    }

    for (const record of records) {
      const key = watcherKey(record.repo, record.prNumber)
      let actor = this.actors.get(key)
      if (!actor) {
        actor = createPrWatcherActor(durableSnapshot(record))
        this.actors.set(key, actor)
      }

      let snapshot = actor.getSnapshot()
      if (
        snapshot.value !== "terminal" &&
        (snapshot.context.subscriberCount !== record.activeSubscriberCount ||
          (snapshot.value === "stopped" && record.activeSubscriberCount > 0))
      ) {
        actor.send({
          type: "SUBSCRIBERS_CHANGED",
          count: record.activeSubscriberCount,
          now,
          idleGraceMs: this.idleGraceMs,
        })
        this.persistActor(actor, now)
        snapshot = actor.getSnapshot()
      }

      if (snapshot.value === "idle_grace" || snapshot.value === "backing_off" || snapshot.value === "rate_limited") {
        const previousState = snapshot.value
        actor.send({ type: "TIME_ELAPSED", now })
        snapshot = actor.getSnapshot()
        if (snapshot.value !== previousState) this.persistActor(actor, now)
      }

      if (snapshot.value === "warming_up") {
        actor.send({ type: "WARMED_UP" })
        this.persistActor(actor, now)
      }
    }
  }

  recordPollSucceeded(repo: string, prNumber: number, nextEligiblePollAt: number, now = Date.now()): void {
    const actor = this.requireActor(repo, prNumber)
    actor.send({ type: "POLL_SUCCEEDED", nextEligiblePollAt })
    this.persistActor(actor, now)
  }

  recordPollFailure(repo: string, prNumber: number, error: unknown, now = Date.now()): void {
    const actor = this.requireActor(repo, prNumber)
    const failures = actor.getSnapshot().context.consecutiveFailures
    const delay = Math.min(this.failureBackoffBaseMs * 2 ** Math.min(failures, 6), this.failureBackoffMaxMs)
    actor.send({
      type: "POLL_FAILED",
      now,
      message: error instanceof Error ? error.message : String(error),
      nextEligiblePollAt: now + delay,
    })
    this.persistActor(actor, now)
  }

  rateLimit(resetAt: number, now = Date.now()): void {
    this.reconcile(now)
    for (const actor of this.actors.values()) {
      const state = actor.getSnapshot().value as PrWatcherState
      if (state === "stopped" || state === "idle_grace" || state === "terminal") continue
      actor.send({ type: "RATE_LIMITED", resetAt })
      this.persistActor(actor, now)
    }
  }

  recordTerminalPersisted(repo: string, prNumber: number, now = Date.now()): void {
    const actor = this.requireActor(repo, prNumber)
    actor.send({ type: "PR_TERMINAL", now })
  }

  close(): void {
    for (const actor of this.actors.values()) actor.stop()
    this.actors.clear()
  }

  private requireActor(repo: string, prNumber: number): PrWatcherActor {
    const actor = this.actors.get(watcherKey(repo, prNumber))
    if (!actor) throw new Error(`No canonical PR watcher for ${repo}#${prNumber}`)
    return actor
  }

  private persistActor(actor: PrWatcherActor, now: number): void {
    const snapshot = actor.getSnapshot()
    const context = snapshot.context
    try {
      this.store.persistPrWatcherLifecycle(
        {
          repo: context.repo,
          prNumber: context.prNumber,
          state: snapshot.value as PrWatcherState,
          idleDeadlineAt: context.idleDeadlineAt,
          terminalAt: context.terminalAt,
          nextEligiblePollAt: context.nextEligiblePollAt,
          consecutiveFailures: context.consecutiveFailures,
          lastFailureAt: context.lastFailureAt,
          lastFailureMessage: context.lastFailureMessage,
          rateLimitResetAt: context.rateLimitResetAt,
        },
        now,
      )
    } catch (error) {
      actor.stop()
      this.actors.delete(watcherKey(context.repo, context.prNumber))
      throw error
    }
  }
}
