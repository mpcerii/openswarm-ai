import { DateTime } from "effect"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmMessage } from "../messaging/message"
import { SwarmApproval } from "../approvals/approval"
import { SwarmConfig } from "../config/config"
import { SwarmBudget } from "../policy/budget"
import { SwarmScheduler } from "../scheduler/scheduler"
import { SwarmWorkspace } from "../workspace/workspace"
import { SwarmProvider } from "../provider/provider"
import { SwarmAudit } from "../audit/audit"
import { SwarmDedup } from "../dedup/dedup"
import { SwarmReview } from "../review/review"
import { SwarmConflict } from "../conflict/conflict"
import { SwarmCensus } from "../census/census"
import { SwarmProvenance } from "../provenance/provenance"
import { SwarmRecovery } from "../recovery/recovery"
import { SwarmModelCatalog } from "../models/catalog"
import { SwarmModelHealth } from "../models/health"
import { SwarmModelRouter } from "../router/router"
import { SwarmGovernor } from "../policy/governor"
import { SwarmMissionBudget } from "../policy/mission-budget"
import { SwarmChildBudget } from "../policy/child-budget"
import { SwarmRegistry } from "../registry/registry"

// Fixed mapping from tool names to Approval.Action vocabulary. Never derived
// from LLM output; the kernel's tool registry is the only authority.
const ACTION_BY_TOOL: Readonly<Record<string, SwarmApproval.Action>> = Object.freeze({
  dependency_change: "dependency_change",
  git_commit: "git_commit",
  git_push: "git_push",
  merge: "merge",
  external_side_effect: "external_side_effect",
  run_bash: "external_side_effect",
  edit_file: "external_side_effect",
})

function missionOf(state: KernelState, agentID: SwarmAgent.ID): string {
  return state.agents.get(agentID)?.info.mission ?? "unknown"
}

// ---------------------------------------------------------------------------
// Kernel parameters. Injectable so the simulation swaps the provider & workspace
// backend, and so the real OpenCode bridge later plugs in its LLM provider,
// snapshot-backed worktree service, and durable event sink — without touching
// the kernel or its tests.
// ---------------------------------------------------------------------------

export interface Params {
  readonly config: SwarmConfig.Info
  readonly provider: SwarmProvider.Provider
  readonly workspace: SwarmWorkspace.Backend
  readonly now?: () => number
  readonly roleBehaviors?: ReadonlyMap<string, SwarmProvider.FakeBehavior>
}

// Mission: the unit of human intent. Owns the census + cluster state.
export interface Mission {
  readonly id: string
  readonly author: string
  readonly title: string
  readonly brief: string
  planApproved: boolean
  integrationApproved: boolean
  readonly primaryAgentID: SwarmAgent.ID
}

// Centralized runtime state. Maps mutated only by SwarmRuntime methods so
// accounting stays atomic against the scheduler tick.
export interface KernelState {
  readonly missions: Map<string, Mission>
  readonly agents: Map<string, SwarmAgent.RuntimeRecord>
  readonly tasks: Map<string, SwarmTask.Info>
  readonly messages: SwarmMessage.Info[]
  readonly pendingMessagesByAgent: Map<string, SwarmMessage.Info[]>
  readonly artifacts: Map<string, SwarmArtifact.PatchRecord>
  readonly reviews: Map<string, SwarmReview.Info>
  readonly openApprovals: Map<string, SwarmApproval.Request>
  readonly grants: SwarmApproval.Grant[]
  readonly censusByMission: Map<string, SwarmCensus.Info>
  readonly clustering: SwarmDedup.ClusteringState
  readonly audit: SwarmAudit.AuditLog
  readonly accounts: SwarmBudget.Accounts
  // Phase 2: model routing + resource governance.
  readonly health: SwarmModelHealth.HealthState
  readonly governor: SwarmGovernor.GovernorState
  readonly missionBudgets: Map<string, SwarmMissionBudget.MissionBudgetState>
  // Per-agent delegated allocation (child budgets). `parentID` records the
  // delegating parent so unused budget can be reclaimed on completion.
  readonly agentBudgets: Map<string, SwarmChildBudget.ChildAllocation & { parentID?: string }>
  // Earliest time a rate-limited agent may be re-admitted.
  readonly requeueAt: Map<string, number>
  readonly budgetRequests: Map<string, { agentID: SwarmAgent.ID; missionID: string; reason: string }>
  readonly budgetSoftWarned: Set<string>
  readonly queue: SwarmScheduler.Queue
  readonly leaseManager: SwarmConflict.LeaseManager
  readonly activeWorkspaces: Map<string, SwarmWorkspace.Allocation>
  // Agents parked because workspace capacity was exhausted. They are NOT
  // re-admitted until a workspace slot frees (bounded wake-up, no spin).
  readonly waitingForWorkspace: Set<string>
  // Resolvers for agents awaiting a workspace slot. releaseWorkspaceOf wakes
  // exactly one parked coder per freed slot.
  readonly workspaceWaiters: Map<string, () => void>
  readonly pauseState: SwarmScheduler.PauseState
  readonly blockedByRequest: Map<string, SwarmAgent.ID>
  readonly cancelled: Set<string>
}

export function emptyState(): KernelState {
  return {
    missions: new Map(),
    agents: new Map(),
    tasks: new Map(),
    messages: [],
    pendingMessagesByAgent: new Map(),
    artifacts: new Map(),
    reviews: new Map(),
    openApprovals: new Map(),
    grants: [],
    censusByMission: new Map(),
    clustering: SwarmDedup.emptyClusteringState(),
    audit: SwarmAudit.emptyAuditLog(),
    accounts: SwarmBudget.emptyAccounts(),
    health: SwarmModelHealth.emptyHealthState(),
    governor: SwarmGovernor.emptyGovernorState(),
    missionBudgets: new Map(),
    agentBudgets: new Map(),
    requeueAt: new Map(),
    budgetRequests: new Map(),
    budgetSoftWarned: new Set(),
    queue: SwarmScheduler.emptyQueue(),
    leaseManager: SwarmConflict.emptyLeaseManager(),
    activeWorkspaces: new Map(),
    waitingForWorkspace: new Set(),
    workspaceWaiters: new Map(),
    pauseState: SwarmScheduler.emptyPauseState(),
    blockedByRequest: new Map(),
    cancelled: new Set(),
  }
}

export class SwarmRuntime {
  readonly state: KernelState = emptyState()
  readonly now: () => number
  readonly provider: SwarmProvider.Provider
  readonly workspace: SwarmWorkspace.Backend
  readonly config: SwarmConfig.Info
  readonly roleBehaviors: ReadonlyMap<string, SwarmProvider.FakeBehavior>

  constructor(params: Params) {
    this.config = params.config
    this.provider = params.provider
    this.workspace = params.workspace
    this.roleBehaviors = params.roleBehaviors ?? new Map()
    this.now = params.now ?? Date.now
  }

  // -----------------------------------------------------------------------
  // Mission lifecycle
  // -----------------------------------------------------------------------

  createMission(input: { id?: string; author?: string; title: string; brief: string; primaryAgentID: SwarmAgent.ID; budget?: SwarmConfig.MissionBudget }): Mission {
    const id = input.id ?? `swm_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const mission: Mission = {
      id,
      author: input.author ?? "human",
      title: input.title,
      brief: input.brief,
      planApproved: false,
      integrationApproved: false,
      primaryAgentID: input.primaryAgentID,
    }
    this.state.missions.set(id, mission)
    // Seed the mission budget + the primary agent's delegation pool so the
    // root can split its allocation across children (atomic in local mode).
    const limits = SwarmMissionBudget.limitsFromConfig(this.config.budget, input.budget)
    const budgetState = SwarmMissionBudget.makeState(id, limits, this.now())
    this.state.missionBudgets.set(id, budgetState)
    if (limits.max_model_calls !== undefined || limits.max_tokens !== undefined) {
      this.state.agentBudgets.set(input.primaryAgentID, {
        modelCalls: limits.max_model_calls ?? 0,
        tokens: limits.max_tokens ?? 0,
        cost: 0,
        parentID: undefined,
      })
    }
    SwarmAudit.emit(this.state.audit, "mission.created", { missionID: id, title: input.title, author: mission.author }, this.now())
    return mission
  }

  approvePlan(missionID: string): void {
    const m = this.state.missions.get(missionID)
    if (!m) throw new Error(`Mission not found: ${missionID}`)
    m.planApproved = true
    SwarmAudit.emit(this.state.audit, "swarm.mission.plan_approved", { missionID }, this.now())
  }

  setCensus(missionID: string, census: SwarmCensus.Info): void {
    this.state.censusByMission.set(missionID, census)
    SwarmAudit.emit(this.state.audit, "swarm.census.created", { missionID, rootPath: census.rootPath, packages: census.packages }, this.now())
  }

  censusFor(missionID: string): SwarmCensus.Info | undefined {
    return this.state.censusByMission.get(missionID)
  }

  // -----------------------------------------------------------------------
  // Primary agent registration. The kernel never replaces OpenCode's `build`
  // agent; it bookmarks the primary's id so spawned agents share the same
  // rootID/mission.
  // -----------------------------------------------------------------------

  registerPrimary(input: { missionID: string; agentID: SwarmAgent.ID; role?: string }): void {
    const mission = this.state.missions.get(input.missionID)
    if (!mission) throw new Error(`Mission not found: ${input.missionID}`)
    const now = DateTime.makeUnsafe(this.now())
    const info: SwarmAgent.Info = {
      id: input.agentID,
      rootID: input.agentID,
      parent: undefined,
      depth: 0,
      role: input.role ?? "primary",
      state: "running",
      mission: input.missionID,
      model: undefined,
      resolvedModel: undefined,
      sessionID: undefined,
      spawnCredits: 0,
      budget: undefined,
      taskIDs: undefined,
      time: { created: now, updated: now },
    }
    this.state.agents.set(input.agentID, SwarmAgent.makeRuntimeRecord(info, { caps: new Set<string>(["spawn", "read", "review"]) }))
    SwarmAudit.emit(this.state.audit, "swarm.agent.spawned", { agentID: input.agentID, parentID: undefined, mission: input.missionID }, this.now())
  }

  // -----------------------------------------------------------------------
  // Spawn — recursive, bounded & policy-checked.
  // -----------------------------------------------------------------------

  spawn(parentID: SwarmAgent.ID | undefined, request: { missionID: string; role?: string; model?: string; capability?: string; pool?: string; context_size?: number; requires_tools?: boolean; priority?: number; budget?: { model_calls?: number; tokens?: number; cost?: number } }): SwarmAgent.SpawnResult {
    if (!this.config.enabled) return { type: "rejected", code: "swarm_disabled", message: "swarm.enabled is false (opt-in)" } satisfies SwarmAgent.Rejected
    const mission = this.state.missions.get(request.missionID)
    if (!mission) return { type: "rejected", code: "swarm_disabled", message: `Mission not found: ${request.missionID}` } satisfies SwarmAgent.Rejected

    // Model routing — the human allowlist + pools decide, never the caller.
    const routing = this.routeFor(request)
    if (routing.reject !== undefined) return routing.reject

    const parentRecord = parentID ? this.state.agents.get(parentID) : undefined
    const parentDepth = parentRecord?.info.depth ?? 0

    // Spawn approval gate.
    const dec = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.state.grants,
      agentID: parentID ?? mission.primaryAgentID,
      missionID: request.missionID,
      action: "spawn",
      resource: request.role ?? "any",
      summary: `Spawn ${request.role ?? "agent"} for mission ${mission.title}`,
      now: this.now(),
    })
    if (dec.effect === "deny") return { type: "rejected", code: "swarm_disabled", message: dec.reason } satisfies SwarmAgent.Rejected
    if (dec.effect === "ask") {
      const req = this.requestApproval(parentID ?? mission.primaryAgentID, "spawn", request.role ?? "any", `Spawn ${request.role ?? "agent"}`)
      if (req !== undefined) {
        // Block until replied. We surface the pending request id for tests to inspect.
        return { type: "rejected", code: "swarm_disabled", message: `spawn awaits approval ${req.id}` } satisfies SwarmAgent.Rejected
      }
    } else {
      SwarmApproval.consumeGrant(this.state.grants, "spawn", request.role ?? "any", request.missionID, this.now())
    }

    // Atomic budget consumption.
    const budget = SwarmBudget.tryConsumeSpawn(this.config, this.state.accounts, parentRecord ? { id: parentRecord.info.id, depth: parentDepth } : undefined)
    if (!budget.ok) return { type: "rejected", code: budget.code, message: `spawn rejected: ${budget.code}` } satisfies SwarmAgent.Rejected

    const id = SwarmAgent.ID.create()
    // Child budget delegation: move part of the parent's allocation to the
    // child atomically. A shortfall rejects the spawn and refunds population
    // so children can never mint or duplicate capacity.
    if (request.budget !== undefined) {
      if (parentID === undefined || !this.state.agentBudgets.has(parentID)) {
        SwarmBudget.releaseSpawn(this.state.accounts, parentID)
        return { type: "rejected", code: "budget_exhausted", message: "child budget delegation failed: no parent allocation" } satisfies SwarmAgent.Rejected
      }
      const parentAllocation = this.state.agentBudgets.get(parentID)!
      const delegation = SwarmChildBudget.delegate(parentAllocation, {
        modelCalls: request.budget.model_calls ?? 0,
        tokens: request.budget.tokens ?? 0,
        cost: request.budget.cost ?? 0,
      })
      if (!delegation.ok) {
        SwarmBudget.releaseSpawn(this.state.accounts, parentID)
        return { type: "rejected", code: "budget_exhausted", message: `child budget delegation failed: ${delegation.code}` } satisfies SwarmAgent.Rejected
      }
      this.state.agentBudgets.set(parentID, delegation.remaining)
      this.state.agentBudgets.set(id, { ...delegation.allocation, parentID })
      SwarmAudit.emit(this.state.audit, "swarm.budget.child_delegated", { parentID, childID: id, missionID: request.missionID, model_calls: delegation.allocation.modelCalls }, this.now())
    }

    const now = DateTime.makeUnsafe(this.now())
    const info: SwarmAgent.Info = {
      id,
      rootID: parentRecord?.info.rootID ?? id,
      parent: parentRecord ? { agentID: parentRecord.info.id, depth: parentDepth } : undefined,
      depth: budget.depth,
      role: request.role,
      state: "created",
      mission: request.missionID,
      model: request.model,
      resolvedModel: routing.selected.model,
      sessionID: undefined,
      spawnCredits: 0,
      budget: undefined,
      taskIDs: undefined,
      time: { created: now, updated: now },
    }
    const record = SwarmAgent.makeRuntimeRecord(info, { caps: parentRecord?.caps ?? new Set<string>() })
    this.state.agents.set(id, record)
    this.transition(id, "queued")
    SwarmScheduler.enqueue(this.state.queue, id, "spawned", this.now())
    SwarmAudit.emit(this.state.audit, "swarm.agent.spawned", { agentID: id, parentID, mission: request.missionID }, this.now())
    SwarmAudit.emit(this.state.audit, "swarm.model.selected", {
      agentID: id,
      mission: request.missionID,
      requestedModel: request.model,
      requestedCapability: request.capability,
      requestedPool: request.pool,
      model: routing.selected.model,
      reason: routing.selected.reason,
      fallbackOrder: routing.selected.fallbackOrder,
    }, this.now())
    return { type: "spawned", agents: [id] } satisfies SwarmAgent.Spawned
  }

  // Resolve the model a spawn should use. Rate-limited routing still returns a
  // concrete (authorized) candidate; the governor backpressures execution.
  private routeFor(request: { missionID: string; role?: string; model?: string; capability?: string; pool?: string; context_size?: number; requires_tools?: boolean; priority?: number }):
    | { reject: SwarmAgent.Rejected; selected?: undefined }
    | { selected: { model: string; reason: string; fallbackOrder: string[] }; reject?: undefined } {
    const missionBudget = this.state.missionBudgets.get(request.missionID)
    const remainingModelCalls = missionBudget?.limits.max_model_calls !== undefined
      ? Math.max(0, missionBudget.limits.max_model_calls - missionBudget.usage.modelCalls)
      : undefined
    const result = SwarmModelRouter.route(this.routingContext(), {
      objective: undefined,
      taskType: request.role,
      requestedModel: request.model,
      requestedCapability: request.capability,
      requestedPool: request.pool,
      contextSize: request.context_size,
      requiresTools: request.requires_tools,
      priority: request.priority,
      remainingBudget: { modelCalls: remainingModelCalls },
    })
    if (result.ok) return { selected: { model: result.model, reason: result.reason, fallbackOrder: result.fallbackOrder } }
    if (result.code === "rate_limited") {
      const candidate = result.candidates?.[0]
      if (candidate !== undefined) {
        return { selected: { model: candidate, reason: `${result.reason}; will queue until usable`, fallbackOrder: result.candidates ?? [] } }
      }
    }
    return { reject: { type: "rejected", code: runtimeRejectCodeFor(result.code), message: `model routing failed: ${result.code}: ${result.reason}` } satisfies SwarmAgent.Rejected }
  }

  private routingContext(): SwarmModelRouter.RoutingContext {
    return {
      policy: this.config.models.routing?.policy ?? "balanced",
      catalog: SwarmModelCatalog.buildCatalog(this.config),
      pools: this.config.models.pools,
      health: this.state.health,
      now: this.now(),
      concurrency: SwarmGovernor.activeByModel(this.state.governor),
      providerConcurrency: SwarmGovernor.activeByProvider(this.state.governor),
      limits: this.config.models.limits,
      providerLimits: this.config.models.providers,
    }
  }

  // -----------------------------------------------------------------------
  // State transitions — the only legal way to mutate agent state.
  // -----------------------------------------------------------------------

  transition(agentID: SwarmAgent.ID, to: SwarmAgent.State): void {
    const r = this.state.agents.get(agentID)
    if (!r) throw new Error(`Unknown agent: ${agentID}`)
    const from = r.info.state
    SwarmAgent.transition(from, to)
    // Schema.Immutable Info is readonly by contract; the runtime is the only
    // authority allowed to flip these fields and does so via this narrow cast.
    const writable = r.info as {
      state: SwarmAgent.State
      time: { created: typeof r.info.time.created; updated: DateTime.Utc }
    }
    writable.state = to
    writable.time = { created: r.info.time.created, updated: DateTime.makeUnsafe(this.now()) }
    SwarmAudit.emit(this.state.audit, "swarm.agent.state_changed", { agentID, from, to }, this.now())
    if (to === "running") SwarmAudit.emit(this.state.audit, "swarm.agent.started", { agentID }, this.now())
    if (to === "completed") SwarmAudit.emit(this.state.audit, "swarm.agent.completed", { agentID }, this.now())
    if (to === "failed") SwarmAudit.emit(this.state.audit, "swarm.agent.failed", { agentID, error: r.lastError ?? "unknown", attempts: r.attempts }, this.now())
    if (to === "waiting") SwarmAudit.emit(this.state.audit, "swarm.agent.waiting", { agentID }, this.now())
  }

  // -----------------------------------------------------------------------
  // Scheduler tick. Drains the wait queue while the active bound stays free.
  // -----------------------------------------------------------------------

  async runOnce(): Promise<{ admitted: number; queued: number; blocked: number }> {
    if (this.state.pauseState.paused) return { admitted: 0, queued: SwarmScheduler.queueSize(this.state.queue), blocked: this.state.blockedByRequest.size }
    if (this.state.cancelled.size > 0) this.purgeCancelled()
    let admitted = 0
    while (true) {
      // Admit up to the free slots, then run the batch concurrently so the
      // active bound is genuinely exercised (not just validated).
      const free = Math.max(0, this.config.max_active_agents - this.state.accounts.active)
      if (free === 0) break
      const batch = SwarmScheduler.drainBatch(
        { limits: this.config, accounts: this.state.accounts, waiting: [] },
        this.state.queue,
        (id) => this.state.agents.has(id) && !this.state.cancelled.has(id),
        free,
        (id) => !this.schedulable(id),
      )
      if (batch.length === 0) break
      admitted += batch.length
      await Promise.allSettled(batch.map((id) => this.runAgent(id)))
      if (this.state.cancelled.size > 0) this.purgeCancelled()
    }
    return { admitted, queued: SwarmScheduler.queueSize(this.state.queue), blocked: this.state.blockedByRequest.size }
  }

  // Run until the queue is empty AND no agent is waiting on an approval. Used
  // by tests as a fixed-point driver.
  async runToFixedPoint(maxTicks = 200): Promise<{ ticks: number; admitted: number }> {
    let ticks = 0
    let admitted = 0
    while (ticks < maxTicks) {
      ticks++
      const r = await this.runOnce()
      admitted += r.admitted
      if (r.queued === 0 && r.blocked === 0 && r.admitted === 0) break
    }
    return { ticks, admitted }
  }

  // Is this agent eligible to be admitted this tick? Mission hard budget,
  // unusable model health, rate-limit backoff and an exhausted child budget
  // defer the agent (kept queued) rather than admitting it into a spin.
  private schedulable(agentID: SwarmAgent.ID): boolean {
    const record = this.state.agents.get(agentID)
    if (!record) return false
    const backoffUntil = this.state.requeueAt.get(agentID)
    if (backoffUntil !== undefined && backoffUntil > this.now()) return false
    const model = record.info.resolvedModel
    if (model !== undefined && !SwarmModelHealth.isUsable(this.state.health, model, this.now())) return false
    const budget = this.state.missionBudgets.get(record.info.mission)
    if (budget !== undefined && budget.hardReached) return false
    if (budget?.limits.max_model_calls !== undefined && budget.usage.modelCalls >= budget.limits.max_model_calls) return false
    const allocation = this.state.agentBudgets.get(agentID)
    if (allocation !== undefined && allocation.modelCalls <= 0) return false
    return true
  }

  private async runAgent(agentID: SwarmAgent.ID): Promise<void> {
    const record = this.state.agents.get(agentID)
    if (!record) return
    record.attempts += 1
    this.transition(agentID, "running")
    const releaseSlot = () => {
      SwarmBudget.setActive(this.state.accounts, false)
      this.releaseLeasesOf(agentID)
      void this.releaseWorkspaceOf(agentID)
    }
    if (record.info.resolvedModel === undefined) {
      record.lastError = "agent has no resolved model (allowlist empty?)"
      this.transition(agentID, "failed")
      releaseSlot()
      return
    }
    // Defense-in-depth: a resolved model that is no longer human-authorized
    // (allowlist changed after spawn) fails instead of executing.
    if (!this.config.models.allowed.includes(record.info.resolvedModel)) {
      record.lastError = `resolved model ${record.info.resolvedModel} is not human-authorized`
      this.transition(agentID, "failed")
      releaseSlot()
      return
    }
    const model = record.info.resolvedModel
    const provider = SwarmModelCatalog.providerOf(model)
    // Rate-limit governor: a throttled reservation requeues the agent with
    // backoff (never a hard failure) and releases the active slot.
    const reserved = SwarmGovernor.tryReserve(this.state.governor, this.governorLimits(), { model, provider, now: this.now() })
    if (reserved.kind === "queue") {
      this.state.requeueAt.set(agentID, this.now() + reserved.backoffMs)
      this.transition(agentID, "failed")
      this.transition(agentID, "queued")
      SwarmScheduler.enqueue(this.state.queue, agentID, `throttled:${reserved.code}`, this.now())
      releaseSlot()
      return
    }
    let tokens = 0
    try {
      const stream = this.provider.stream({
        agentID,
        model,
        role: record.info.role,
        systemPrompt: this.systemPromptFor(record),
        userText: this.userTextFor(record),
        missionID: record.info.mission,
        parentAgentID: record.info.parent?.agentID,
        permittedFiles: this.permittedFilesFor(record),
      })
      for await (const chunk of stream) {
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.tokens !== undefined) tokens += chunk.tokens
        if (chunk.toolCalls) for (const call of chunk.toolCalls) await this.handleTool(agentID, call)
        if (chunk.finish && chunk.finish !== "paused") break
      }
      // A tool handler may have moved the agent out of `running` — blocked on
      // approval (awaiting_approval) or re-queued for capacity/lease conflicts
      // (waiting). In both cases the stream is over but the agent is NOT done:
      // release the active slot and let it be re-admitted by the scheduler.
      if (record.info.state !== "running") {
        SwarmGovernor.release(this.state.governor, { model, provider })
        SwarmBudget.setActive(this.state.accounts, false)
        this.releaseLeasesOf(agentID)
        void this.releaseWorkspaceOf(agentID)
        return
      }
      this.transition(agentID, "completed")
      this.consumeModelRun(record, tokens)
      this.reclaimChildBudget(agentID)
      this.notifyDependents(agentID)
      SwarmGovernor.release(this.state.governor, { model, provider })
      SwarmBudget.setActive(this.state.accounts, false)
      this.releaseLeasesOf(agentID)
      void this.releaseWorkspaceOf(agentID)
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      record.failures += 1
      record.lastError = error.message
      // Track operational model health. Auth failures are terminal below.
      const health = SwarmModelHealth.classify(error)
      if (health !== "healthy") {
        const cooldown = health === "rate_limited" ? 2_000 : 0
        const prev = SwarmModelHealth.healthOf(this.state.health, model)
        const next = SwarmModelHealth.markHealth(this.state.health, model, health, this.now(), cooldown)
        if (next.health !== prev.health || next.disabled !== prev.disabled) {
          SwarmAudit.emit(this.state.audit, "swarm.model.health_changed", { model, health: next.health }, this.now())
        }
      }
      const failure = SwarmRecovery.classify(error)
      const ns = SwarmRecovery.nextStep(SwarmRecovery.policyFor(failure), failure, record.attempts)
      SwarmGovernor.release(this.state.governor, { model, provider })
      SwarmBudget.setActive(this.state.accounts, false)
      this.releaseLeasesOf(agentID)
      void this.releaseWorkspaceOf(agentID)
      if (ns.action === "retry") {
        this.state.requeueAt.set(agentID, this.now() + ns.delayMs)
        this.transition(agentID, "failed")
        this.transition(agentID, "queued")
        SwarmScheduler.enqueue(this.state.queue, agentID, ns.reason, this.now())
      } else if (ns.action === "block") {
        this.transition(agentID, "awaiting_approval")
      } else {
        this.transition(agentID, "failed")
        this.reclaimChildBudget(agentID)
      }
    }
  }

  // Return a child's unused delegated allocation to its parent. Called exactly
  // once when an agent reaches a terminal state.
  private reclaimChildBudget(agentID: string): void {
    const allocation = this.state.agentBudgets.get(agentID)
    if (allocation === undefined || allocation.parentID === undefined) return
    const parent = this.state.agentBudgets.get(allocation.parentID)
    if (parent !== undefined) {
      this.state.agentBudgets.set(allocation.parentID, SwarmChildBudget.reclaim(parent, allocation))
    }
    this.state.agentBudgets.delete(agentID)
  }

  // Consume one model call + tokens against the mission budget and the agent's
  // own delegated allocation (if any). Hard-limit exhaustions flag the mission
  // and stop future scheduling; no task state is mutated here.
  private consumeModelRun(record: SwarmAgent.RuntimeRecord, tokens: number): void {
    const budget = this.state.missionBudgets.get(record.info.mission)
    if (budget !== undefined) {
      const consumed = SwarmMissionBudget.tryConsumeCall(budget)
      SwarmMissionBudget.addTokens(budget, tokens)
      const threshold = SwarmMissionBudget.evaluate(budget, this.now(), SwarmMissionBudget.softRatio(this.config))
      if (threshold === "hard") {
        if (!budget.hardReached) SwarmMissionBudget.markHard(budget)
        SwarmAudit.emit(this.state.audit, "swarm.budget.hard_reached", { missionID: record.info.mission, used_calls: budget.usage.modelCalls, used_tokens: budget.usage.tokens }, this.now())
      } else if (threshold === "soft" && !this.state.budgetSoftWarned.has(record.info.mission)) {
        this.state.budgetSoftWarned.add(record.info.mission)
        SwarmAudit.emit(this.state.audit, "swarm.budget.warned", { missionID: record.info.mission, used_calls: budget.usage.modelCalls, used_tokens: budget.usage.tokens }, this.now())
      }
      void consumed
    }
    const allocation = this.state.agentBudgets.get(record.info.id)
    if (allocation !== undefined) {
      const result = SwarmChildBudget.consume(allocation, 1, tokens, 0)
      const remaining = result.ok ? result.remaining : { ...allocation, modelCalls: 0, tokens: 0, cost: allocation.cost }
      // Preserve the delegation chain so reclaim can return unused budget.
      this.state.agentBudgets.set(record.info.id, { ...remaining, parentID: allocation.parentID })
    }
  }

  private governorLimits(): SwarmGovernor.GovernorLimits {
    const models = this.config.models
    const provider: Record<string, SwarmGovernor.ProviderLimit> = {}
    if (models.providers !== undefined) {
      for (const [id, limit] of Object.entries(models.providers)) {
        provider[id] = {
          concurrency: limit.concurrency,
          requestsPerWindow: limit.requests_per_window,
          tokensPerWindow: limit.tokens_per_window,
          windowMs: limit.window_ms,
        }
      }
    }
    const model: Record<string, SwarmGovernor.ModelLimit> = {}
    if (models.limits !== undefined) {
      for (const [id, limit] of Object.entries(models.limits)) {
        model[id] = {
          concurrency: limit.concurrency,
          requestsPerWindow: limit.requests_per_window,
          tokensPerWindow: limit.tokens_per_window,
          windowMs: limit.window_ms,
        }
      }
    }
    return { globalConcurrent: models.global_concurrency, provider, model }
  }

  private systemPromptFor(record: SwarmAgent.RuntimeRecord): string {
    const mission = this.state.missions.get(record.info.mission)
    return [
      `You are a swarm agent (role=${record.info.role ?? "general"}, depth=${record.info.depth}, model=${record.info.resolvedModel}).`,
      `Mission: ${mission?.title ?? record.info.mission}`,
      `Brief: ${mission?.brief ?? ""}`,
      `Caps: ${[...record.caps].join(", ") || "<none>"}`,
      `Allowed tools: register_finding, write_patch, request_review, propose_integration. High-risk: dependency_change, git_commit, git_push, merge, external_side_effect.`,
    ].join("\n")
  }

  private userTextFor(record: SwarmAgent.RuntimeRecord): string {
    const pending = this.state.pendingMessagesByAgent.get(record.info.id) ?? []
    if (pending.length === 0) return "Continue the mission."
    const out = pending.map((m) => `[${m.from}]: ${m.body}`).join("\n")
    this.state.pendingMessagesByAgent.delete(record.info.id)
    return out
  }

  private permittedFilesFor(record: SwarmAgent.RuntimeRecord): readonly string[] {
    const census = this.censusFor(record.info.mission)
    if (!census) return []
    if (record.info.role?.startsWith("reviewer") || record.info.role === "investigator") return []
    return census.modules.map((m) => m.path)
  }

  // -----------------------------------------------------------------------
  // Tool dispatch. The kernel interprets tool calls rather than executing
  // them verbatim; high-risk tools cross the approval gate first.
  // -----------------------------------------------------------------------

  private async handleTool(agentID: SwarmAgent.ID, call: SwarmProvider.ToolCall): Promise<void> {
    const record = this.state.agents.get(agentID)
    if (!record) return
    SwarmAudit.emit(this.state.audit, "swarm.tool.requested", { agentID, tool: call.tool, args: SwarmAudit.redact(call.args) }, this.now())
    try {
      switch (call.tool) {
        case "register_finding": return this.handleRegisterFinding(agentID, call)
        case "write_patch": return await this.handleWritePatch(agentID, call)
        case "request_review": return await this.handleRequestReview(agentID, call)
        case "propose_integration": return this.handleProposeIntegration(agentID)
        default:
          if (this.isHighRiskTool(call.tool)) return await this.handleHighRiskTool(agentID, call)
          SwarmAudit.emit(this.state.audit, "swarm.tool.denied", { agentID, tool: call.tool, reason: "unknown tool" }, this.now())
      }
    } catch (e) {
      SwarmAudit.emit(this.state.audit, "swarm.tool.denied", { agentID, tool: call.tool, reason: e instanceof Error ? e.message : String(e) }, this.now())
      throw e
    }
  }

  private isHighRiskTool(tool: string): boolean {
    return ["dependency_change", "git_commit", "git_push", "merge", "external_side_effect", "run_bash", "edit_file"].includes(tool)
  }

  private handleRegisterFinding(agentID: SwarmAgent.ID, call: SwarmProvider.ToolCall): void {
    const report: SwarmDedup.Report = {
      title: String(call.args.title ?? "untitled finding"),
      area: call.args.area !== undefined ? String(call.args.area) : undefined,
      location: call.args.location !== undefined ? String(call.args.location) : undefined,
      severity: (call.args.severity as SwarmDedup.Severity) ?? "medium",
      reporter: agentID,
      time: DateTime.makeUnsafe(this.now()),
    }
    const outcome = SwarmDedup.clusterReport(this.state.clustering, report)
    SwarmAudit.emit(this.state.audit, "swarm.finding.clustered", {
      findingID: outcome.cluster.id,
      reporters: outcome.cluster.reporters,
      canonicalTitle: outcome.cluster.title,
    }, this.now())
  }

  private async handleWritePatch(agentID: SwarmAgent.ID, call: SwarmProvider.ToolCall): Promise<void> {
    const record = this.state.agents.get(agentID)
    if (!record) return
    // Coding agents MUST have a workspace. Lazily allocate bounded capacity.
    if (!record.workspacePath && !this.state.activeWorkspaces.has(agentID)) {
      // Hold the active slot and await a freed workspace. This is a genuine
      // block, not a re-admission spin: the active bound stays full of the
      // (≤ max_active_coding_workspaces) coders that can actually run while
      // waiters hold their slots. releaseWorkspaceOf resolves exactly one
      // waiter per freed slot. The agent stays in `running` while parked so
      // parent-completion wakeups (notifyDependents) never touch it.
      while (!SwarmBudget.tryConsumeWorkspace(this.state.accounts, this.config.max_active_coding_workspaces)) {
        await this.waitForWorkspace(agentID)
        // Cancelled (or otherwise terminal) while parked — abort the patch.
        if (!this.state.agents.has(agentID) || record.info.state !== "running") return
      }
      const allocation = await this.workspace.allocate(agentID, `swarm/${agentID.slice(0, 10)}`)
      record.workspacePath = String(allocation.path)
      this.state.activeWorkspaces.set(agentID, allocation)
      SwarmAudit.emit(this.state.audit, "swarm.workspace.created", { agentID, path: String(allocation.path), branch: allocation.branch }, this.now())
    }

    // Lease over the requested area so parallel implementers don't collide.
    // The caller normally passes the census-derived area; the default is a
    // unique per-agent fallback so unrelated agents never block each other.
    const areaPattern = String(call.args.area ?? `**/${agentID.slice(6)}/**`)
    const leaseResult = SwarmConflict.acquireLease(this.state.leaseManager, agentID, { pattern: areaPattern, mode: "exclusive_write" }, this.now())
    if (!leaseResult.ok) {
      this.transition(agentID, "waiting")
      SwarmScheduler.enqueue(this.state.queue, agentID, `lease conflict: ${leaseResult.conflictingAgent}`, this.now())
      return
    }
    record.leases.add(leaseResult.lease.id)

    const taskID = this.assignTaskFor(agentID, String(call.args.title ?? "patch"))?.id
    const body: SwarmArtifact.PatchBody = {
      baseCommit: String(call.args.baseCommit ?? "HEAD"),
      changedFiles: Array.isArray(call.args.changedFiles) ? (call.args.changedFiles as string[]) : [],
      diff: String(call.args.diff ?? ""),
      testsExecuted: Array.isArray(call.args.tests) ? (call.args.tests as string[]) : [],
      testResults: (call.args.testResults ?? ["pass"]) as unknown as ("pass" | "fail" | "skipped")[],
      reason: String(call.args.reason ?? "implementer emitted patch"),
      tokensUsed: record.attempts * 16,
    }
    const artifact = SwarmArtifact.buildPatchArtifact({
      agentID,
      taskID,
      kind: "patch",
      patch: body,
      summary: body.reason,
      time: this.now(),
    })
    this.state.artifacts.set(artifact.artifact.id, artifact)
    SwarmAudit.emit(this.state.audit, "swarm.artifact.created", {
      artifactID: artifact.artifact.id, agentID, taskID, kind: artifact.artifact.kind, ref: artifact.artifact.ref,
    }, this.now())
  }

  private async handleRequestReview(agentID: SwarmAgent.ID, call: SwarmProvider.ToolCall): Promise<void> {
    // Review the agent's own most recent artifact when the call does not name
    // one (natural follow-up after write_patch); otherwise the named one.
    let artifactID = String(call.args.artifactID ?? "")
    if (!this.state.artifacts.has(artifactID)) {
      const own = [...this.state.artifacts.values()].filter((a) => a.artifact.agentID === agentID).at(-1)
      if (own === undefined) return
      artifactID = own.artifact.id
    }
    const objective = (call.args.objective as SwarmReview.Objective) ?? "correctness"
    const reviewerCount = Math.max(1, Number(call.args.reviewerCount ?? 2))
    await this.spawnReviewers(agentID, this.state.agents.get(agentID)?.info.mission ?? "unknown", artifactID, objective, reviewerCount)
  }

  private handleProposeIntegration(agentID: SwarmAgent.ID): void {
    const record = this.state.agents.get(agentID)
    if (!record) return
    const ready = [...this.state.artifacts.values()].filter((a) => a.state === "proposed" || a.state === "reviewed" || a.state === "approved")
    if (ready.length === 0) return
    const changedFiles = new Set<string>(ready.flatMap((r) => r.patch.changedFiles))
    SwarmAudit.emit(this.state.audit, "swarm.integration.proposed", {
      missionID: record.info.mission,
      artifactIDs: ready.map((r) => r.artifact.id),
      changedFiles: changedFiles.size,
      testsAdded: ready.reduce((n, r) => n + r.patch.testsExecuted.length, 0),
    }, this.now())
    this.requestApproval(agentID, "integration", "swarm", `Integrate ${ready.length} reviewed patch(es)`)
  }

  private async handleHighRiskTool(agentID: SwarmAgent.ID, call: SwarmProvider.ToolCall): Promise<void> {
    // Tool names mirror the Approval.Action vocabulary; run_bash/edit_file are
    // sandboxed external-side-effect actions. The kernel never derives risk
    // from LLM output — the mapping is fixed in SwarmApproval.actionRisk.
    const action: SwarmApproval.Action = ACTION_BY_TOOL[call.tool] ?? "external_side_effect"
    const record = this.state.agents.get(agentID)
    if (!record) return
    const resource = String(call.args.target ?? call.args.path ?? "any")
    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.state.grants,
      agentID,
      missionID: record.info.mission,
      action,
      resource,
      summary: `${call.tool} on ${resource}`,
      now: this.now(),
    })
    if (decision.effect === "deny") {
      SwarmAudit.emit(this.state.audit, "swarm.tool.denied", { agentID, tool: call.tool, reason: decision.reason }, this.now())
      return
    }
    if (decision.effect === "ask") {
      this.requestApproval(agentID, action, resource, `${call.tool}: ${resource}`)
      SwarmAudit.emit(this.state.audit, "swarm.tool.requested_approval", { agentID, tool: call.tool }, this.now())
      return
    }
    SwarmApproval.consumeGrant(this.state.grants, action, resource, record.info.mission, this.now())
    SwarmAudit.emit(this.state.audit, "swarm.tool.approved", { agentID, tool: call.tool, scope: "auto" }, this.now())
  }

  private assignTaskFor(agentID: SwarmAgent.ID, title: string): SwarmTask.Info {
    const now = DateTime.makeUnsafe(this.now())
    const task: SwarmTask.Info = {
      id: SwarmTask.ID.create(),
      agentID,
      parentID: undefined,
      title,
      description: undefined,
      state: "completed",
      time: { created: now, updated: now },
    }
    this.state.tasks.set(task.id, task)
    SwarmAudit.emit(this.state.audit, "swarm.task.created", { taskID: task.id, parentID: undefined, title }, this.now())
    SwarmAudit.emit(this.state.audit, "swarm.task.assigned", { taskID: task.id, agentID }, this.now())
    return task
  }

  // -----------------------------------------------------------------------
  // Review swarms. Each reviewer is a fresh read-only agent. The runtime
  // permits read-only reviewers to run without a coding workspace.
  // -----------------------------------------------------------------------

  async spawnReviewers(parentAgentID: SwarmAgent.ID | undefined, missionID: string, artifactID: string, objective: SwarmReview.Objective, reviewerCount: number): Promise<SwarmReview.Info[]> {
    const out: SwarmReview.Info[] = []
    for (let i = 0; i < reviewerCount; i++) {
      const spawnResult = this.spawn(parentAgentID, { missionID, role: `reviewer:${objective}` })
      if (spawnResult.type !== "spawned") continue
      const reviewerID = spawnResult.agents[0]!
      const reviewerRecord = this.state.agents.get(reviewerID)!
      // Reviewers admit through the scheduler concurrency bound; we mark active
      // explicitly so population accounting stays consistent.
      SwarmBudget.setActive(this.state.accounts, true)
      this.transition(reviewerID, "running")
      let verdict: SwarmReview.Verdict = "accept"
      const findings: SwarmReview.Finding[] = []
      let confidence = 60
      try {
        const stream = this.provider.stream({
          agentID: reviewerID,
          model: reviewerRecord.info.resolvedModel ?? "fake/reviewer",
          role: `reviewer:${objective}`,
          systemPrompt: `You are a reviewer (objective=${objective}). ${
            objective === "adversarial" ? "Assume the patch is wrong. Find a concrete failure." : "Accept unless you find a real issue."
          }`,
          userText: `Review artifact ${artifactID}.`,
          missionID,
        })
        for await (const chunk of stream) {
          if (chunk.error) { verdict = "changes_requested"; break }
          if (chunk.toolCalls) {
            for (const call of chunk.toolCalls) {
              if (call.tool === "register_review_finding") {
                const sev = (call.args.severity as SwarmReview.Severity) ?? "low"
                findings.push({
                  severity: sev,
                  message: String(call.args.message ?? "reviewer finding"),
                  location: call.args.location !== undefined ? String(call.args.location) : undefined,
                })
              }
            }
          }
          if (chunk.tokens) confidence = Math.min(100, confidence + chunk.tokens)
          if (chunk.finish && chunk.finish !== "paused") break
        }
      } catch (e) {
        verdict = "changes_requested"
        void e
      }
      if (findings.some((f) => f.severity === "blocker" || f.severity === "high")) verdict = "reject"
      else if (findings.length > 0) verdict = "changes_requested"
      else if (objective === "adversarial") verdict = "accept"
      const review: SwarmReview.Info = {
        id: SwarmReview.ID.create(),
        reviewerAgentID: reviewerID,
        artifactID: artifactID as SwarmArtifact.ID,
        objective,
        verdict,
        findings,
        confidence,
        hypothesis: objective === "adversarial" ? "patch may mis-merge or regress" : undefined,
        time: DateTime.makeUnsafe(this.now()),
      }
      this.state.reviews.set(review.id, review)
      const artifact = this.state.artifacts.get(artifactID)
      if (artifact) {
        artifact.reviews.push(review)
        artifact.state = "reviewed"
      }
      SwarmAudit.emit(this.state.audit, "swarm.review.created", { reviewID: review.id, reviewerAgentID: reviewerID, artifactID, verdict }, this.now())
      this.transition(reviewerID, "completed")
      SwarmBudget.setActive(this.state.accounts, false)
      out.push(review)
    }
    // Recompute acceptability once all reviews are in.
    const artifact = this.state.artifacts.get(artifactID)
    if (artifact) {
      const judge = SwarmReview.isAcceptable(artifact.reviews)
      artifact.state = judge.ok ? "approved" : "reviewed"
    }
    return out
  }

  // -----------------------------------------------------------------------
  // Approval/grant surface (human side)
  // -----------------------------------------------------------------------

  addGrant(grant: SwarmApproval.Grant): void {
    this.state.grants.push(grant)
    SwarmAudit.emit(this.state.audit, "swarm.grant.created", { grantID: grant.id, missionID: grant.missionID, risk: grant.riskCategory }, this.now())
  }

  replyApproval(reqID: string, reply: SwarmApproval.Reply, scope?: Partial<Omit<SwarmApproval.Grant, "id" | "uses" | "time">>): void {
    const req = this.state.openApprovals.get(reqID)
    if (!req) throw new Error(`No pending approval: ${reqID}`)
    const agentID = req.agentID
    this.state.openApprovals.delete(reqID)
    this.state.blockedByRequest.delete(reqID)
    if (reply === "reject") {
      SwarmAudit.emit(this.state.audit, "swarm.approval.denied", { requestID: req.id, agentID }, this.now())
      const record = this.state.agents.get(agentID)
      if (record && record.info.state === "awaiting_approval") this.transition(agentID, "failed")
      return
    }
    SwarmAudit.emit(this.state.audit, "swarm.approval.granted", { requestID: req.id, agentID, reply }, this.now())
    if (reply === "always") {
      const missionID = scope?.missionID ?? this.state.agents.get(agentID)?.info.mission ?? "unknown"
      this.addGrant({
        id: SwarmApproval.ID.create(),
        missionID,
        actionPatterns: scope?.actionPatterns ?? [req.action],
        resourcePatterns: scope?.resourcePatterns ?? [],
        riskCategory: scope?.riskCategory ?? SwarmApproval.riskOf(req.action),
        expiresAt: scope?.expiresAt,
        maxUses: scope?.maxUses,
        uses: 0,
        time: DateTime.makeUnsafe(this.now()),
      })
    }
    const record = this.state.agents.get(agentID)
    if (record && record.info.state === "awaiting_approval") {
      this.transition(agentID, "queued")
      SwarmScheduler.enqueue(this.state.queue, agentID, "approval granted", this.now())
    }
  }

  grantApproval(reqID: string, scope?: Partial<Omit<SwarmApproval.Grant, "id" | "uses" | "time">>): void {
    this.replyApproval(reqID, "always", scope)
  }

  denyApproval(reqID: string): void {
    this.replyApproval(reqID, "reject")
  }

  requestApproval(agentID: SwarmAgent.ID, action: SwarmApproval.Action, resource: string, summary: string): SwarmApproval.Request | undefined {
    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.state.grants,
      agentID,
      missionID: this.state.agents.get(agentID)?.info.mission ?? "unknown",
      action,
      resource,
      summary,
      now: this.now(),
    })
    if (decision.effect === "deny") {
      SwarmAudit.emit(this.state.audit, "swarm.tool.denied", { agentID, tool: action, reason: decision.reason }, this.now())
      return undefined
    }
    if (decision.effect === "allow") {
      // A matching grant is consumed (maxUses accounting) — config-level
      // `allow` consumes nothing.
      SwarmApproval.consumeGrant(this.state.grants, action, resource, missionOf(this.state, agentID), this.now())
      return undefined
    }
    const request: SwarmApproval.Request = {
      id: SwarmApproval.ID.create(),
      agentID,
      action,
      summary,
      metadata: { resource },
      time: DateTime.makeUnsafe(this.now()),
    }
    this.state.openApprovals.set(request.id, request)
    this.state.blockedByRequest.set(request.id, agentID)
    const record = this.state.agents.get(agentID)
    if (record && record.info.state !== "awaiting_approval") this.transition(agentID, "awaiting_approval")
    SwarmAudit.emit(this.state.audit, "swarm.approval.requested", { request }, this.now())
    return request
  }

  // -----------------------------------------------------------------------
  // Integration ledger
  // -----------------------------------------------------------------------

  completeIntegration(missionID: string, approver: string): { applied: string[]; skipped: string[] } {
    const mission = this.state.missions.get(missionID)
    if (!mission) throw new Error(`Mission not found: ${missionID}`)
    const applied: string[] = []
    const skipped: string[] = []
    for (const a of this.state.artifacts.values()) {
      const ownerMission = this.state.agents.get(a.artifact.agentID)?.info.mission
      if (ownerMission !== missionID) continue
      // Human approval covers proposed/reviewed/approved candidates alike;
      // previously integrated ones are never re-applied.
      if (a.state === "proposed" || a.state === "reviewed" || a.state === "approved") {
        a.state = "integrated"
        applied.push(a.artifact.id)
      } else {
        skipped.push(a.artifact.id)
      }
    }
    mission.integrationApproved = true
    SwarmAudit.emit(this.state.audit, "swarm.integration.approved", { missionID, approver }, this.now())
    return { applied, skipped }
  }

  // -----------------------------------------------------------------------
  // /why provenance viewer — reads the kernel state and renders the chain.
  // -----------------------------------------------------------------------

  whyView(): SwarmProvenance.ProvenanceView {
    const reviewsByArtifact: Map<string, SwarmReview.Info[]> = new Map()
    const artifactsByFile: Map<string, SwarmArtifact.Info[]> = new Map()
    const agentByTask: Map<string, SwarmAgent.Info> = new Map()
    const taskByID: Map<string, SwarmTask.Info> = new Map()
    const approvedArtifacts: Set<string> = new Set()
    const integratedArtifacts: Set<string> = new Set()
    const missionAuthor: Map<string, string> = new Map()
    for (const m of this.state.missions.values()) missionAuthor.set(m.id, m.author)
    for (const a of this.state.artifacts.values()) {
      for (const f of a.patch.changedFiles) {
        const list = artifactsByFile.get(f) ?? []
        list.push(a.artifact)
        artifactsByFile.set(f, list)
      }
      if (a.reviews.length > 0) reviewsByArtifact.set(a.artifact.id, a.reviews)
      if (a.state === "approved" || a.state === "integrated") approvedArtifacts.add(a.artifact.id)
      if (a.state === "integrated") integratedArtifacts.add(a.artifact.id)
      if (a.artifact.taskID !== undefined) {
        const record = this.state.agents.get(a.artifact.agentID)
        if (record) agentByTask.set(a.artifact.taskID, record.info)
      }
    }
    for (const t of this.state.tasks.values()) taskByID.set(t.id, t)
    return {
      reviewsByArtifact,
      artifactsByFile,
      agentByTask,
      taskByID,
      missionAuthor,
      approvedArtifacts,
      integratedArtifacts,
    }
  }

  why(file: string, missionID: string): string {
    return SwarmProvenance.renderChain(SwarmProvenance.buildChain(this.whyView(), file, missionID), file)
  }

  // -----------------------------------------------------------------------
  // Pause / cancel / metrics / mailbox
  // -----------------------------------------------------------------------

  pause(): void { this.state.pauseState.paused = true }
  resume(): void { this.state.pauseState.paused = false }

  // Human override: change the global active-agent bound at runtime. The
  // scheduler reads config.max_active_agents on every tick, so the next tick
  // honors the new ceiling. Rejects a non-positive bound.
  setActiveBound(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid active bound: ${n}`)
    ;(this as { config: SwarmConfig.Info }).config = { ...this.config, max_active_agents: n }
    SwarmAudit.emit(this.state.audit, "swarm.budget.active_bound_changed", { max_active_agents: n }, this.now())
  }

  // Human override: set mission budget limits absolutely (raising or lowering).
  // Lowering below current usage clears the hard flag via setLimits so the
  // human's new ceiling is authoritative; existing state is never mutated.
  setMissionBudgetLimits(missionID: string, limits: SwarmMissionBudget.MissionBudgetLimits): void {
    const state = this.state.missionBudgets.get(missionID)
    if (state === undefined) throw new Error(`No mission budget: ${missionID}`)
    SwarmMissionBudget.setLimits(state, limits)
    SwarmAudit.emit(this.state.audit, "swarm.budget.limits_changed", { missionID, limits }, this.now())
  }

  cancelAgent(agentID: SwarmAgent.ID): void {
    const r = this.state.agents.get(agentID)
    if (!r || SwarmAgent.isTerminal(r.info.state)) return
    this.state.cancelled.add(agentID)
    SwarmScheduler.remove(this.state.queue, agentID)
    SwarmAudit.emit(this.state.audit, "swarm.agent.cancelled", { agentID }, this.now())
  }

  // Apply the cancellation set immediately (used by emergency stop so cancelled
  // agents become `cancelled` even while the scheduler is paused).
  purgeCancelled(): void {
    for (const id of [...this.state.cancelled]) {
      const r = this.state.agents.get(id)
      if (!r) { this.state.cancelled.delete(id); continue }
      const agentID = id as SwarmAgent.ID
      // A coder parked waiting for a workspace must be released from its await.
      this.rejectAllWorkspaceWaiters(agentID)
      if (r.info.state === "running") SwarmBudget.setActive(this.state.accounts, false)
      if (r.info.state !== "cancelled" && r.info.state !== "retired") this.transition(agentID, "cancelled")
      this.reclaimChildBudget(agentID)
      this.releaseLeasesOf(agentID)
      void this.releaseWorkspaceOf(agentID)
      this.state.cancelled.delete(id)
    }
  }

  injectMessage(to: SwarmAgent.ID, from: SwarmMessage.Sender, body: string, delivery: SwarmMessage.Delivery = "steer"): SwarmMessage.Info {
    const msg: SwarmMessage.Info = {
      id: SwarmMessage.ID.create(),
      from,
      to,
      body,
      delivery,
      inReplyTo: undefined,
      time: DateTime.makeUnsafe(this.now()),
    }
    this.state.messages.push(msg)
    const inbox = this.state.pendingMessagesByAgent.get(to) ?? []
    inbox.push(msg)
    this.state.pendingMessagesByAgent.set(to, inbox)
    return msg
  }

  private notifyDependents(agentID: SwarmAgent.ID): void {
    for (const r of this.state.agents.values()) {
      if (r.info.state === "waiting" && r.info.parent?.agentID === agentID) {
        this.transition(r.info.id, "queued")
        SwarmScheduler.enqueue(this.state.queue, r.info.id, "parent completed", this.now())
      }
    }
  }

  private async releaseWorkspaceOf(agentID: SwarmAgent.ID): Promise<void> {
    const record = this.state.agents.get(agentID)
    if (!record || !this.state.activeWorkspaces.has(agentID)) return
    await this.workspace.release(agentID)
    record.workspacePath = undefined
    this.state.activeWorkspaces.delete(agentID)
    SwarmBudget.releaseWorkspace(this.state.accounts)
    SwarmAudit.emit(this.state.audit, "swarm.workspace.released", { agentID, path: "<released>" }, this.now())
    // Bounded wake-up: resolve exactly one coder awaiting a workspace slot.
    this.wakeOneWorkspaceWaiter()
  }

  // Blocking wait for a coding workspace. The agent holds its active slot for
  // the whole wait, so the active bound stays honest and no re-admission spin
  // can occur. Cancellation rejects the waiter so the agent's run loop can
  // observe it.
  private waitForWorkspace(agentID: SwarmAgent.ID): Promise<void> {
    return new Promise((resolve) => {
      this.state.workspaceWaiters.set(agentID, resolve)
    })
  }

  private wakeOneWorkspaceWaiter(): void {
    for (const [agentID, resolve] of this.state.workspaceWaiters) {
      this.state.workspaceWaiters.delete(agentID)
      resolve()
      return
    }
  }

  private rejectAllWorkspaceWaiters(agentID: SwarmAgent.ID): void {
    const resolve = this.state.workspaceWaiters.get(agentID)
    if (resolve) {
      this.state.workspaceWaiters.delete(agentID)
      resolve()
    }
  }

  private releaseLeasesOf(agentID: SwarmAgent.ID): void {
    const record = this.state.agents.get(agentID)
    if (!record) return
    for (const lid of [...record.leases]) this.state.leaseManager.active.delete(lid)
    SwarmConflict.releaseAllForAgent(this.state.leaseManager, agentID)
    record.leases.clear()
  }

  metrics() {
    return {
      population: this.state.accounts.population,
      active: this.state.accounts.active,
      activePeak: this.state.accounts.activePeak,
      queued: SwarmScheduler.queueSize(this.state.queue),
      activeWorkspaces: this.state.accounts.activeWorkspaces,
      workspacePeak: this.state.accounts.workspacePeak,
      blockedApprovals: this.state.blockedByRequest.size,
      artifacts: this.state.artifacts.size,
      reviews: this.state.reviews.size,
      findings: SwarmDedup.clusterCount(this.state.clustering),
      missions: this.state.missions.size,
      auditEvents: this.state.audit.events.length,
      llmConcurrent: SwarmGovernor.globalActive(this.state.governor),
      llmQueued: this.queuedTotal(),
    }
  }

  // -----------------------------------------------------------------------
  // Mission budget approval (human side). Agents can never approve their own
  // increases; only the human (via replyApproval) may raise limits.
  // -----------------------------------------------------------------------

  requestBudgetIncrease(input: { agentID: SwarmAgent.ID; reason: string; requested?: SwarmConfig.MissionBudget }): SwarmApproval.Request | undefined {
    const missionID = this.state.agents.get(input.agentID)?.info.mission ?? "unknown"
    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.state.grants,
      agentID: input.agentID,
      missionID,
      action: "budget_increase",
      resource: "mission-budget",
      summary: `Increase mission budget: ${input.reason}`,
      now: this.now(),
    })
    if (decision.effect === "deny") return undefined
    if (decision.effect === "allow") {
      this.raiseMissionBudget(missionID, input.requested)
      return undefined
    }
    const usage = this.state.missionBudgets.get(missionID)?.usage
    const request: SwarmApproval.Request = {
      id: SwarmApproval.ID.create(),
      agentID: input.agentID,
      action: "budget_increase",
      summary: `Increase mission budget: ${input.reason}`,
      metadata: { resource: "mission-budget", reason: input.reason, used_calls: usage?.modelCalls, used_tokens: usage?.tokens },
      time: DateTime.makeUnsafe(this.now()),
    }
    this.state.openApprovals.set(request.id, request)
    this.state.blockedByRequest.set(request.id, input.agentID)
    this.state.budgetRequests.set(request.id, { agentID: input.agentID, missionID, reason: input.reason })
    SwarmAudit.emit(this.state.audit, "swarm.budget.increase_requested", { requestID: request.id, agentID: input.agentID, missionID, reason: input.reason }, this.now())
    return request
  }

  resolveBudgetIncrease(reqID: string, decision: "approve" | "modify" | "reject", requested?: SwarmConfig.MissionBudget): void {
    const pending = this.state.budgetRequests.get(reqID)
    const req = this.state.openApprovals.get(reqID)
    if (pending === undefined || req === undefined) throw new Error(`No pending budget increase: ${reqID}`)
    this.state.budgetRequests.delete(reqID)
    this.state.openApprovals.delete(reqID)
    this.state.blockedByRequest.delete(reqID)
    if (decision !== "reject") this.raiseMissionBudget(pending.missionID, requested)
    SwarmAudit.emit(this.state.audit, "swarm.budget.increase_resolved", { requestID: reqID, missionID: pending.missionID, decision }, this.now())
    if (decision === "reject") {
      const record = this.state.agents.get(pending.agentID)
      if (record && record.info.state === "awaiting_approval") this.transition(pending.agentID, "failed")
    }
  }

  private raiseMissionBudget(missionID: string, requested?: SwarmConfig.MissionBudget): void {
    const state = this.state.missionBudgets.get(missionID)
    if (state === undefined || requested === undefined) return
    SwarmMissionBudget.increaseLimits(state, {
      max_model_calls: requested.max_model_calls,
      max_tokens: requested.max_tokens,
      max_wall_ms: requested.max_wall_ms,
      max_cost: requested.max_cost,
      max_agents: requested.max_agents,
      max_active_agents: requested.max_active_agents,
    })
  }

  // -----------------------------------------------------------------------
  // TUI foundation: Models + Resource views (Phase 3 renders these).
  // -----------------------------------------------------------------------

  modelsView(): SwarmRegistry.ModelsView {
    return SwarmRegistry.modelsView(this.config, this.state.health, this.state.governor, this.queuedByModelSnapshot())
  }

  resourceView(missionID: string): SwarmRegistry.ResourceView | undefined {
    const budget = this.state.missionBudgets.get(missionID)
    if (budget === undefined) return undefined
    const threshold = SwarmMissionBudget.evaluate(budget, this.now(), SwarmMissionBudget.softRatio(this.config))
    return SwarmRegistry.resourceView(
      this.state.accounts,
      SwarmGovernor.globalActive(this.state.governor),
      this.queuedTotal(),
      { budget, threshold },
      this.state.blockedByRequest.size,
    )
  }

  // Live count of queued agents currently blocked on rate limits, by model.
  private queuedByModelSnapshot(): Map<string, number> {
    const map = new Map<string, number>()
    const now = this.now()
    for (const record of this.state.agents.values()) {
      if (record.info.state !== "queued" || record.info.resolvedModel === undefined) continue
      const backoff = this.state.requeueAt.get(record.info.id)
      const throttled = (backoff !== undefined && backoff > now) || !SwarmModelHealth.isUsable(this.state.health, record.info.resolvedModel, now)
      if (!throttled) continue
      map.set(record.info.resolvedModel, (map.get(record.info.resolvedModel) ?? 0) + 1)
    }
    return map
  }

  private queuedTotal(): number {
    let total = 0
    for (const n of this.queuedByModelSnapshot().values()) total += n
    return total
  }
}

// Map a router failure to the swarm spawn rejection vocabulary.
function runtimeRejectCodeFor(code: string): SwarmAgent.RejectionCode {
  if (code === "no_models_allowed") return "no_models_allowed"
  if (code === "model_not_allowed") return "model_not_allowed"
  if (code === "pool_empty") return "pool_empty"
  if (code === "context_overflow") return "context_overflow"
  if (code === "no_remaining_budget") return "no_remaining_budget"
  return "no_eligible_model"
}