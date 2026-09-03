import { createActor } from "xstate"
import {
  PREMIND_CLIENT_HEARTBEAT_MS,
  PREMIND_IDLE_SHUTDOWN_GRACE_MS,
} from "../../shared/constants.ts"
import {
  daemonLifecycleMachine,
  type DaemonLifecycleState,
} from "./daemon-machine.ts"

type TimerHandle = ReturnType<typeof setTimeout>

type LifecycleClock = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
  setInterval: (callback: () => void, intervalMs: number) => TimerHandle
  clearInterval: (handle: TimerHandle) => void
}

export type DaemonLifecycleRuntimeOptions = {
  hasDemand: () => boolean
  onStopping: (reason: string) => void | Promise<void>
  onStopped?: (reason: string) => void
  onError?: (error: unknown) => void
  graceMs?: number
  demandPollMs?: number
  clock?: LifecycleClock
}

const systemClock: LifecycleClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
}

/** Owns cancellable shutdown grace and invokes teardown exactly once. */
export class DaemonLifecycleRuntime {
  private readonly actor = createActor(daemonLifecycleMachine)
  private readonly graceMs: number
  private readonly demandPollMs: number
  private readonly clock: LifecycleClock
  private graceTimer: TimerHandle | null = null
  private demandPoll: TimerHandle | null = null
  private started = false
  private stoppingStarted = false
  private stoppedNotified = false
  private stopReason = "requested"
  private readonly subscription

  constructor(private readonly options: DaemonLifecycleRuntimeOptions) {
    this.graceMs = options.graceMs ?? PREMIND_IDLE_SHUTDOWN_GRACE_MS
    this.demandPollMs = options.demandPollMs ?? PREMIND_CLIENT_HEARTBEAT_MS
    this.clock = options.clock ?? systemClock
    this.subscription = this.actor.subscribe((snapshot) => {
      this.handleSnapshot(snapshot.value as DaemonLifecycleState, snapshot.context.stopReason)
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.actor.start()
    this.actor.send({
      type: "STARTUP_COMPLETE",
      hasDemand: this.options.hasDemand(),
    })
    if (this.demandPollMs > 0) {
      this.demandPoll = this.clock.setInterval(
        () => this.evaluateDemand(),
        this.demandPollMs,
      )
      if (typeof this.demandPoll === "object" && "unref" in this.demandPoll) {
        this.demandPoll.unref()
      }
    }
  }

  evaluateDemand(): void {
    if (!this.started) return
    const state = this.actor.getSnapshot().value as DaemonLifecycleState
    if (state === "stopping" || state === "stopped") return
    this.actor.send({ type: "DEMAND_CHANGED", hasDemand: this.options.hasDemand() })
  }

  requestStop(reason: string): void {
    if (!this.started) this.start()
    this.actor.send({ type: "STOP_REQUESTED", reason })
  }

  getSnapshot() {
    return this.actor.getSnapshot()
  }

  close(): void {
    this.clearGraceTimer()
    if (this.demandPoll) {
      this.clock.clearInterval(this.demandPoll)
      this.demandPoll = null
    }
    this.subscription.unsubscribe()
    this.actor.stop()
  }

  private handleSnapshot(
    state: DaemonLifecycleState,
    reason: string | null,
  ): void {
    if (state === "shutdown_grace") {
      if (!this.graceTimer) {
        this.graceTimer = this.clock.setTimeout(() => {
          this.graceTimer = null
          this.actor.send({ type: "GRACE_EXPIRED" })
        }, this.graceMs)
        if (typeof this.graceTimer === "object" && "unref" in this.graceTimer) {
          this.graceTimer.unref()
        }
      }
      return
    }

    this.clearGraceTimer()
    if (state === "stopping" && !this.stoppingStarted) {
      this.stoppingStarted = true
      this.stopReason = reason ?? "requested"
      if (this.demandPoll) {
        this.clock.clearInterval(this.demandPoll)
        this.demandPoll = null
      }
      void Promise.resolve()
        .then(() => this.options.onStopping(this.stopReason))
        .catch((error) => this.options.onError?.(error))
        .finally(() => this.actor.send({ type: "STOPPED" }))
      return
    }

    if (state === "stopped" && !this.stoppedNotified) {
      this.stoppedNotified = true
      this.options.onStopped?.(this.stopReason)
    }
  }

  private clearGraceTimer(): void {
    if (!this.graceTimer) return
    this.clock.clearTimeout(this.graceTimer)
    this.graceTimer = null
  }
}
