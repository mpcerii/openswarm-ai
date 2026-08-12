import { SwarmRuntime } from "@opencode-ai/swarm/runtime/runtime"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmApproval } from "@opencode-ai/swarm/approvals/approval"
import { SwarmModelHealth } from "@opencode-ai/swarm/models/health"
import { SwarmMissionBudget } from "@opencode-ai/swarm/policy/mission-budget"
import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { SwarmAudit } from "@opencode-ai/swarm/audit/audit"
import { buildSnapshot, withEmergency } from "./state/snapshot"
import type { SwarmUiSnapshot } from "./state/types"

// ---------------------------------------------------------------------------
// SwarmBridge: the human-operation surface over the swarm kernel. Owns a
// SwarmRuntime (the in-process kernel; a distributed ControlPlane exposes the
// same query surface), performs every human action with the kernel's own
// guards (approvals, transitions, budgets), and enforces emergency-stop so a
// stopped swarm cannot be mutated back into an inconsistent scheduler state.
// All mutations here are synchronous; `tick` advances the scheduler.
// ---------------------------------------------------------------------------

export class SwarmEmergencyError extends Error {
  constructor(message = "swarm is emergency-stopped; resume before mutating") {
    super(message)
    this.name = "SwarmEmergencyError"
  }
}

export interface BridgeOptions {
  // Auto-start ticking with this interval (ms). 0 disables the interval.
  tickIntervalMs?: number
  // Clock override forwarded to the runtime (deterministic tests).
  now?: () => number
  // Called after every scheduler tick completes (used by the demo seed to
  // keep spawning work so the overlay stays live).
  onTick?: () => void
}

export interface ApproveScope {
  actionPatterns?: string[]
  resourcePatterns?: string[]
  riskCategory?: SwarmConfig.RiskCategory
  maxUses?: number
  expiresAt?: number
}

export class SwarmBridge {
  readonly runtime: SwarmRuntime
  readonly now: () => number
  private emergency = false
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private readonly onTick?: () => void

  constructor(runtime: SwarmRuntime, opts: BridgeOptions = {}) {
    this.runtime = runtime
    this.now = opts.now ?? runtime.now
    this.onTick = opts.onTick
    if (opts.tickIntervalMs !== undefined && opts.tickIntervalMs > 0) {
      this.tickTimer = setInterval(() => {
        void this.tick()
      }, opts.tickIntervalMs)
    }
  }

  dispose(): void {
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  // ---------------------------------------------------------------------
  // Snapshot + scheduler
  // ---------------------------------------------------------------------

  snapshot(): SwarmUiSnapshot {
    return withEmergency(buildSnapshot(this.runtime), this.emergency)
  }

  // Advance the scheduler one step. Never throws; surfaced in lastError.
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runtime.runOnce()
    } finally {
      this.ticking = false
    }
    if (this.emergency) return
    this.onTick?.()
  }

  // ---------------------------------------------------------------------
  // Emergency stop. Stops new admissions, cancels non-executing work, blocks
  // further mutations, preserves state and the audit log. Resume restores
  // scheduling; no swarm data is destroyed.
  // ---------------------------------------------------------------------

  emergencyStop(): void {
    if (this.emergency) return
    this.emergency = true
    this.runtime.pause()
    for (const record of this.runtime.state.agents.values()) {
      const state = record.info.state
      if (state === "queued" || state === "created" || state === "waiting" || state === "blocked" || state === "sleeping") {
        this.runtime.cancelAgent(record.info.id)
      }
    }
    this.runtime.purgeCancelled()
    SwarmAudit.emit(this.runtime.state.audit, "swarm.emergency.stopped", { population: this.runtime.state.agents.size }, this.now())
  }

  resumeFromStop(): void {
    if (!this.emergency) return
    this.emergency = false
    this.runtime.resume()
    SwarmAudit.emit(this.runtime.state.audit, "swarm.emergency.resumed", {}, this.now())
  }

  isEmergencyStopped(): boolean {
    return this.emergency
  }

  private guard(): void {
    if (this.emergency) throw new SwarmEmergencyError()
  }

  // ---------------------------------------------------------------------
  // Human governance actions
  // ---------------------------------------------------------------------

  approveOnce(reqID: string): void {
    this.guard()
    this.runtime.replyApproval(reqID, "once")
  }

  approveScope(reqID: string, scope: ApproveScope): void {
    this.guard()
    this.runtime.grantApproval(reqID, scope as Partial<Omit<SwarmApproval.Grant, "id" | "uses" | "time">>)
  }

  reject(reqID: string): void {
    this.guard()
    this.runtime.denyApproval(reqID)
  }

  resolveBudgetIncrease(reqID: string, decision: "approve" | "modify" | "reject", limits?: SwarmMissionBudget.MissionBudgetLimits): void {
    this.guard()
    this.runtime.resolveBudgetIncrease(reqID, decision, limits)
  }

  // ---------------------------------------------------------------------
  // Human overrides (pause / cancel / model / budget / concurrency)
  // ---------------------------------------------------------------------

  pause(): void {
    this.guard()
    this.runtime.pause()
  }

  resume(): void {
    this.guard()
    this.runtime.resume()
  }

  cancelAgent(agentID: string): void {
    this.guard()
    const record = this.runtime.state.agents.get(agentID)
    if (record === undefined || SwarmAgent.isTerminal(record.info.state)) return
    this.runtime.cancelAgent(agentID as SwarmAgent.ID)
    this.runtime.purgeCancelled()
  }

  // Cancel an agent and its whole descendant branch (bounded by the tree).
  cancelBranch(agentID: string): void {
    this.guard()
    const descendants = this.descendantsOf(agentID)
    for (const id of descendants) {
      const record = this.runtime.state.agents.get(id)
      if (record !== undefined && !SwarmAgent.isTerminal(record.info.state)) this.runtime.cancelAgent(record.info.id)
    }
    this.runtime.purgeCancelled()
  }

  private descendantsOf(agentID: string): string[] {
    const out: string[] = []
    const stack = [agentID]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const record of this.runtime.state.agents.values()) {
        if (record.info.parent?.agentID === current) {
          out.push(record.info.id)
          stack.push(record.info.id)
        }
      }
    }
    return out
  }

  setActiveBound(n: number): void {
    this.guard()
    this.runtime.setActiveBound(n)
  }

  setMissionBudgetLimits(missionID: string, limits: SwarmMissionBudget.MissionBudgetLimits): void {
    this.guard()
    this.runtime.setMissionBudgetLimits(missionID, limits)
  }

  disableModel(model: string, disabled: boolean): void {
    this.guard()
    if (disabled) SwarmModelHealth.disable(this.runtime.state.health, model)
    else SwarmModelHealth.enable(this.runtime.state.health, model)
    SwarmAudit.emit(
      this.runtime.state.audit,
      disabled ? "swarm.model.disabled" : "swarm.model.enabled",
      { model },
      this.now(),
    )
  }

  injectMessage(to: string, body: string): void {
    this.guard()
    const record = this.runtime.state.agents.get(to)
    if (record === undefined) return
    this.runtime.injectMessage(record.info.id, "human", body)
  }

  completeIntegration(missionID: string): void {
    this.guard()
    this.runtime.completeIntegration(missionID, "human")
  }
}
