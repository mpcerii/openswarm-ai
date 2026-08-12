export * as SwarmControl from "./control"

import { DateTime } from "effect"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"
import { SwarmMessage } from "../messaging/message"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmCensus } from "../census/census"
import { SwarmApproval } from "../approvals/approval"
import { SwarmDedup } from "../dedup/dedup"
import { SwarmConfig } from "../config/config"
import { SwarmAudit } from "../audit/audit"
import { SwarmWorker } from "../cluster/worker"
import { SwarmLease } from "../cluster/lease"
import { SwarmIdempotency } from "../cluster/idempotency"
import { SwarmCredentials } from "../cluster/credentials"
import { SwarmClusterMetrics } from "../cluster/metrics"
import { SwarmModelCatalog } from "../models/catalog"
import { SwarmPools } from "../models/pools"
import { SwarmModelHealth } from "../models/health"
import { SwarmModelRouter } from "../router/router"
import { SwarmGovernor } from "../policy/governor"
import { SwarmMissionBudget } from "../policy/mission-budget"
import { SwarmChildBudget } from "../policy/child-budget"
import { SwarmRecovery } from "../recovery/recovery"
import { SwarmRegistry } from "../registry/registry"
import type { ControlPlaneApi, LeaseOutcome } from "../cluster/transport"
import type { DurableStore, MissionRecord, ChildBudgetAmount } from "../storage/store"

// ---------------------------------------------------------------------------
// Control plane: the single logical boundary owning the durable registries
// (agents, tasks, missions, workers), the scheduler, global concurrency and
// spawn budget, model + approval policy, artifact metadata, and the audit
// log. It NEVER calls a provider — execution happens on workers, which talk
// to this plane only through ControlPlaneApi.
// ---------------------------------------------------------------------------

export interface ControlPlaneParams {
  readonly store: DurableStore
  readonly config: SwarmConfig.Info
  readonly llmCap?: number
  readonly heartbeatTimeoutMs?: number
  readonly leaseTimeoutMs?: number
  readonly now?: () => number
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000
const DEFAULT_LEASE_TIMEOUT_MS = 30_000

export class ControlPlane implements ControlPlaneApi {
  readonly store: DurableStore
  readonly config: SwarmConfig.Info
  readonly llmCap: number
  readonly heartbeatTimeoutMs: number
  readonly leaseTimeoutMs: number
  readonly now: () => number

  private readonly clustering: SwarmDedup.ClusteringState = SwarmDedup.emptyClusteringState()
  private readonly grants: SwarmApproval.Grant[] = []
  private readonly openApprovals = new Map<string, SwarmApproval.Request>()
  private readonly blockedByRequest = new Map<string, string>()
  // Capability requirements attached at spawn (survives in memory; durable
  // placement requirements arrive with a later persistence milestone).
  private readonly requiredCaps = new Map<string, string[]>()
  // Secret grants: agentID -> set of secret refs the agent's work may access.
  private readonly secretGrants = new Map<string, Set<string>>()
  // Model routing + resource governance (Phase 2).
  readonly catalog: readonly SwarmModelCatalog.SwarmModel[]
  readonly healthState: SwarmModelHealth.HealthState = SwarmModelHealth.emptyHealthState()
  readonly governor: SwarmGovernor.GovernorState = SwarmGovernor.emptyGovernorState()
  // leaseID -> model/provider reserved by the governor. Released on ack/nack/
  // expiry so a dead worker cannot leak a concurrency slot.
  private readonly leaseModels = new Map<string, { model: string; provider: string }>()
  // Earliest time an agent may be re-issued a lease (rate-limit backoff).
  private readonly requeueAt = new Map<string, number>()
  // Open budget-increase approvals keyed by request id.
  private readonly budgetRequests = new Map<string, { agentID: string; missionID: string; reason: string }>()
  // Missions already warned at the soft threshold (warn once per mission).
  private readonly budgetSoftWarned = new Set<string>()

  constructor(params: ControlPlaneParams) {
    this.store = params.store
    this.config = params.config
    this.llmCap = params.llmCap ?? Math.max(8, params.config.max_active_agents * 2)
    this.heartbeatTimeoutMs = params.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.leaseTimeoutMs = params.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
    this.now = params.now ?? Date.now
    this.catalog = SwarmModelCatalog.buildCatalog(params.config)
  }

  private audit(type: string, data: unknown, now = this.now()): void {
    void this.store.appendAudit({ type, time: now, data: SwarmAudit.redact(data) })
  }

  // ---------------------------------------------------------------------
  // Mission lifecycle
  // ---------------------------------------------------------------------

  async createMission(input: { id?: string; author?: string; title: string; brief: string; primaryAgentID: SwarmAgent.ID; budget?: SwarmConfig.MissionBudget }): Promise<MissionRecord> {
    const mission: MissionRecord = {
      id: input.id ?? `swm_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      author: input.author ?? "human",
      title: input.title,
      brief: input.brief,
      planApproved: false,
      integrationApproved: false,
      primaryAgentID: input.primaryAgentID,
      createdAt: this.now(),
    }
    await this.store.putMission(mission)
    // Seed the mission budget record + the primary agent's delegation pool so
    // the root can split its allocation across children atomically.
    const limits = SwarmMissionBudget.limitsFromConfig(this.config.budget, input.budget)
    const now = this.now()
    await this.store.putMissionBudget({
      missionID: mission.id,
      ...limits,
      used_calls: 0,
      used_tokens: 0,
      started_at: now,
      hard_reached: false,
    })
    if (limits.max_model_calls !== undefined || limits.max_tokens !== undefined) {
      await this.store.atomicSeedAgentBudget({
        agentID: input.primaryAgentID,
        parentID: null,
        missionID: mission.id,
        remaining_calls: limits.max_model_calls ?? 0,
        remaining_tokens: limits.max_tokens ?? 0,
        remaining_cost: 0,
      })
    }
    this.audit("mission.created", { missionID: mission.id, title: input.title, author: mission.author, budget: limits })
    return mission
  }

  async approvePlan(missionID: string): Promise<void> {
    const mission = await this.store.getMission(missionID)
    if (mission === undefined) throw new Error(`Mission not found: ${missionID}`)
    await this.store.putMission({ ...mission, planApproved: true })
    this.audit("swarm.mission.plan_approved", { missionID })
  }

  async setCensus(missionID: string, census: SwarmCensus.Info): Promise<void> {
    await this.store.putCensus({ ...census, id: missionID as SwarmCensus.ID })
    this.audit("swarm.census.created", { missionID, rootPath: census.rootPath, packages: census.packages })
  }

  async censusFor(missionID: string): Promise<SwarmCensus.Info | undefined> {
    return this.store.getCensus(missionID)
  }

  // ---------------------------------------------------------------------
  // Primary registration + spawn (durable, atomically budgeted)
  // ---------------------------------------------------------------------

  async registerPrimary(input: { missionID: string; agentID: SwarmAgent.ID; role?: string }): Promise<void> {
    const record: SwarmAgent.AgentRecord = {
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
      time: { created: DateTime.makeUnsafe(this.now()), updated: DateTime.makeUnsafe(this.now()) },
    }
    await this.store.putAgent(record)
    this.audit("swarm.agent.spawned", { agentID: input.agentID, parentID: undefined, mission: input.missionID })
  }

  async spawn(
    parentID: SwarmAgent.ID | undefined,
    request: {
      missionID: string
      role?: string
      model?: string
      capability?: string
      pool?: string
      context_size?: number
      requires_tools?: boolean
      priority?: number
      budget?: Partial<ChildBudgetAmount>
    },
  ): Promise<SwarmAgent.SpawnResult> {
    if (!this.config.enabled) {
      return { type: "rejected", code: "swarm_disabled", message: "swarm.enabled is false (opt-in)" } satisfies SwarmAgent.Rejected
    }
    const mission = await this.store.getMission(request.missionID)
    if (mission === undefined) {
      return { type: "rejected", code: "swarm_disabled", message: `Mission not found: ${request.missionID}` } satisfies SwarmAgent.Rejected
    }

    // Model routing: the human allowlist + pools decide, never the caller.
    const routing = await this.routeFor(request)
    if (routing.reject !== undefined) return routing.reject
    const resolvedModel = routing.selected.model

    const parent = parentID !== undefined ? await this.store.getAgent(parentID) : undefined
    const parentDepth = parent?.depth ?? 0
    const depth = parentDepth + 1

    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.grants,
      agentID: parentID ?? mission.primaryAgentID,      missionID: request.missionID,
      action: "spawn",
      resource: request.role ?? "any",
      summary: `Spawn ${request.role ?? "agent"} for mission ${mission.title}`,
      now: this.now(),
    })
    if (decision.effect === "deny") return { type: "rejected", code: "swarm_disabled", message: decision.reason } satisfies SwarmAgent.Rejected

    const budget = await this.store.atomicTryConsumeSpawn(parentID, depth)
    if (!budget.ok) return { type: "rejected", code: budget.code, message: `spawn rejected: ${budget.code}` } satisfies SwarmAgent.Rejected

    const id = SwarmAgent.ID.create()
    // Child budget delegation: the parent moves part of its allocation to the
    // child atomically. A shortfall rejects the spawn (and refunds population)
    // so children can never mint or duplicate capacity.
    if (request.budget !== undefined) {
      const amount: ChildBudgetAmount = {
        model_calls: request.budget.model_calls ?? 0,
        tokens: request.budget.tokens ?? 0,
        cost: request.budget.cost ?? 0,
      }
      const delegated = parentID !== undefined
        ? await this.store.atomicDelegateChildBudget(request.missionID, parentID, id, amount)
        : { ok: false as const, code: "no_parent_allocation" as const }
      if (!delegated.ok) {
        await this.store.atomicReleaseSpawn(parentID)
        return { type: "rejected", code: "budget_exhausted", message: `child budget delegation failed: ${delegated.code}` } satisfies SwarmAgent.Rejected
      }
      this.audit("swarm.budget.child_delegated", { parentID, childID: id, missionID: request.missionID, model_calls: amount.model_calls })
    }

    const record: SwarmAgent.AgentRecord = {
      id,
      rootID: parent?.rootID ?? id,
      parent: parent !== undefined ? { agentID: parent.id, depth: parentDepth } : undefined,
      depth: budget.depth,
      role: request.role,
      state: "queued",
      mission: request.missionID,
      model: request.model,
      resolvedModel,
      sessionID: undefined,
      spawnCredits: 0,
      budget: undefined,
      taskIDs: undefined,
      time: { created: DateTime.makeUnsafe(this.now()), updated: DateTime.makeUnsafe(this.now()) },
    }
    await this.store.putAgent(record)
    if (request.capability !== undefined) this.requiredCaps.set(id, [request.capability])
    this.audit("swarm.agent.spawned", { agentID: id, parentID, mission: request.missionID })
    if (routing.selected !== undefined) {
      this.audit("swarm.model.selected", {
        agentID: id,
        mission: request.missionID,
        requestedModel: request.model,
        requestedCapability: request.capability,
        requestedPool: request.pool,
        model: routing.selected.model,
        reason: routing.selected.reason,
        fallbackOrder: routing.selected.fallbackOrder,
      })
    }
    return { type: "spawned", agents: [id] } satisfies SwarmAgent.Spawned
  }

  // Resolve the model a spawn should use. Returns either a rejected spawn, a
  // concrete selection, or (for rate-limited routing) the deferred candidate
  // the scheduler will backpressure until it becomes usable.
  private async routeFor(request: { missionID: string; model?: string; capability?: string; pool?: string; context_size?: number; requires_tools?: boolean; priority?: number; role?: string }):
    Promise<
      | { reject: SwarmAgent.Rejected; selected?: undefined }
      | { selected: { model: string; reason: string; fallbackOrder: string[] }; reject?: undefined }
    > {
    const ctx = this.routingContext()
    let remainingModelCalls: number | undefined
    const missionBudget = await this.store.getMissionBudget(request.missionID)
    if (missionBudget?.max_model_calls !== undefined) {
      remainingModelCalls = Math.max(0, missionBudget.max_model_calls - missionBudget.used_calls)
    }
    const result = SwarmModelRouter.route(ctx, {
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
    const code = rejectCodeFor(result.code)
    return { reject: { type: "rejected", code, message: `model routing failed: ${result.code}: ${result.reason}` } satisfies SwarmAgent.Rejected }
  }

  private routingContext(): SwarmModelRouter.RoutingContext {
    return {
      policy: this.config.models.routing?.policy ?? "balanced",
      catalog: this.catalog,
      pools: this.config.models.pools,
      health: this.healthState,
      now: this.now(),
      concurrency: SwarmGovernor.activeByModel(this.governor),
      providerConcurrency: SwarmGovernor.activeByProvider(this.governor),
      limits: this.config.models.limits,
      providerLimits: this.config.models.providers,
    }
  }

  // ---------------------------------------------------------------------
  // Worker registration / credentials
  // ---------------------------------------------------------------------

  async issueCredential(input: { workerID: SwarmWorker.ID; name: string; scopes: SwarmCredentials.Scopes; expiresAt?: number }): Promise<{ credential: SwarmCredentials.Record; secret: string }> {
    const secret = `swsec_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`
    const credential: SwarmCredentials.Record = {
      id: SwarmCredentials.ID.create(),
      worker_id: input.workerID,
      name: input.name,
      secret_hash: SwarmCredentials.makeSecret(secret),
      scopes: input.scopes,
      revoked: 0,
      created_at: this.now(),
      expires_at: input.expiresAt ?? null,
    }
    await this.store.putCredential(credential)
    this.audit("swarm.credential.issued", { credentialID: credential.id, workerID: input.workerID, name: input.name })
    return { credential, secret }
  }

  async revokeCredential(credentialID: string): Promise<void> {
    const credential = await this.store.getCredential(credentialID)
    if (credential === undefined) return
    await this.store.putCredential({ ...credential, revoked: 1 })
    this.audit("swarm.credential.revoked", { credentialID })
  }

  async register(registration: SwarmWorker.Registration, secret: string, now: number): Promise<SwarmWorker.RegisterResult> {
    if (registration.credentialID === undefined) {
      return { workerID: registration.workerID, accepted: false, reason: "anonymous workers are not permitted" }
    }
    const credential = await this.store.getCredential(registration.credentialID)
    if (credential === undefined) return { workerID: registration.workerID, accepted: false, reason: "unknown credential" }
    if (!SwarmCredentials.isUsable(credential, now)) return { workerID: registration.workerID, accepted: false, reason: "credential revoked or expired" }
    if (!SwarmCredentials.verifySecret(secret, credential.secret_hash)) return { workerID: registration.workerID, accepted: false, reason: "invalid secret" }
    if (credential.worker_id !== registration.workerID) return { workerID: registration.workerID, accepted: false, reason: "credential does not belong to this worker" }

    const scopedCaps = applyCredentialScopes(registration.capabilities, credential.scopes)
    const worker: SwarmWorker.Record = {
      id: registration.workerID,
      name: registration.name,
      capabilities: scopedCaps,
      health: "healthy",
      last_heartbeat: now,
      registered_at: now,
      offline_at: null,
      leases_total: 0,
      leases_failed: 0,
      credential_id: registration.credentialID ?? null,
    }
    await this.store.putWorker(worker)
    this.audit("swarm.worker.registered", { workerID: worker.id, name: worker.name })
    return { workerID: worker.id as SwarmWorker.ID, accepted: true }
  }

  async heartbeat(workerID: string, status: SwarmWorker.Health, activeLeases: number, now: number): Promise<void> {
    const worker = await this.store.getWorker(workerID)
    if (worker === undefined) return
    const health: SwarmWorker.Health = worker.health === "draining" && status !== "offline" ? "draining" : status
    await this.store.putWorker({ ...worker, health, last_heartbeat: now })
    void activeLeases
  }

  async drain(workerID: string, now: number): Promise<void> {
    const worker = await this.store.getWorker(workerID)
    if (worker === undefined) return
    await this.store.putWorker({ ...worker, health: "draining", last_heartbeat: now })
    this.audit("swarm.worker.draining", { workerID })
  }

  async grantSecret(input: { agentID: string; ref: string }): Promise<void> {
    const grants = this.secretGrants.get(input.agentID) ?? new Set<string>()
    grants.add(input.ref)
    this.secretGrants.set(input.agentID, grants)
  }

  async resolveSecret(workerID: string, agentID: string, ref: string): Promise<{ value: string } | { denied: string }> {
    const worker = await this.store.getWorker(workerID)
    if (worker === undefined) return { denied: "unknown worker" }
    const credential = worker.credential_id !== null ? await this.store.getCredential(worker.credential_id) : undefined
    const secret = await this.store.getSecret(ref)
    if (secret === undefined) return { denied: "unknown secret ref" }
    if (!(this.secretGrants.get(agentID)?.has(ref) ?? false)) return { denied: "secret not granted to this agent" }
    if (credential !== undefined && !SwarmCredentials.allowsSecretScope(credential, secret.scope)) return { denied: "credential scope does not cover this secret" }
    return { value: secret.value }
  }

  // ---------------------------------------------------------------------
  // Scheduling: heartbeat sweep, lease expiry sweep, capability routing
  // ---------------------------------------------------------------------

  async tick(): Promise<void> {
    const now = this.now()
    await this.sweepWorkers(now)
    await this.sweepLeases(now)
    await this.schedule(now)
  }

  async sweepWorkers(now: number): Promise<void> {    for (const worker of await this.store.listWorkers()) {
      if (worker.health === "offline") continue
      if (now - worker.last_heartbeat <= this.heartbeatTimeoutMs) continue
      await this.store.putWorker({ ...worker, health: "offline", offline_at: now })
      this.audit("swarm.worker.offline", { workerID: worker.id, reason: "heartbeat timeout" })
      for (const leaseID of await this.store.expireLeases(worker.id, now)) {
        await this.requeueExpiredLease(leaseID, now)
      }
    }
  }

  async sweepLeases(now: number): Promise<void> {
    for (const leaseID of await this.store.expireLeases(undefined, now)) {
      await this.requeueExpiredLease(leaseID, now)
    }
  }

  // Worker-infra failure: the agent is requeued, never permanently failed.
  private async requeueExpiredLease(leaseID: string, now: number): Promise<void> {
    const lease = await this.store.getLease(leaseID)
    if (lease === undefined) return
    this.releaseModelReservation(leaseID)
    if (lease.llm_reserved) await this.store.atomicReleaseLLM()
    await this.store.atomicReleaseAgent()
    this.audit("swarm.lease.expired", { leaseID, workerID: lease.worker_id, agentID: lease.agent_id })
    const agent = await this.store.getAgent(lease.agent_id)
    if (agent === undefined || SwarmAgent.isDone(agent.state)) return
    if (agent.state === "running") {
      await this.store.transitionAgent(agent.id, "waiting")
      await this.store.transitionAgent(agent.id, "queued")
    }
    this.audit("swarm.agent.requeued", { agentID: agent.id, reason: "worker lease expired", leaseID })
  }

  private async schedule(now: number): Promise<void> {
    const workers = await this.store.listWorkers()
    const leases = await this.store.listLeases()
    const activeByWorker = new Map<string, number>()
    const leasedAgents = new Set<string>()
    for (const lease of leases) {
      if (lease.worker_id !== null && SwarmLease.isActive(lease.status)) {
        activeByWorker.set(lease.worker_id, (activeByWorker.get(lease.worker_id) ?? 0) + 1)
      }
      if (SwarmLease.isActive(lease.status)) leasedAgents.add(lease.agent_id)
    }
    const queued = (await this.store.listAgentsByState("queued")).sort((a, b) => DateTime.toEpochMillis(a.time.created) - DateTime.toEpochMillis(b.time.created))
    for (const agent of queued) {
      if (leasedAgents.has(agent.id)) continue
      // Rate-limit backoff: an agent requeued behind backpressure is skipped
      // until its cooldown passes (prevents retry storms).
      const backoffUntil = this.requeueAt.get(agent.id)
      if (backoffUntil !== undefined && backoffUntil > now) continue
      if (agent.resolvedModel !== undefined && !SwarmModelHealth.isUsable(this.healthState, agent.resolvedModel, now)) continue
      const missionBudget = await this.store.getMissionBudget(agent.mission)
      if (missionBudget?.hard_reached === true) continue
      if (missionBudget?.max_model_calls !== undefined && missionBudget.used_calls >= missionBudget.max_model_calls) continue
      const accounting = await this.store.accounting()
      if (accounting.activeAgents >= this.config.max_active_agents) break
      const caps = this.requiredCaps.get(agent.id) ?? []
      const worker = pickWorker(workers, activeByWorker, caps, agent.resolvedModel)
      // No eligible worker right now: skip this agent, keep scanning the queue
      // so unschedulable (e.g. capability-mismatched) agents never starve the
      // schedulable ones behind them.
      if (worker === undefined) continue
      const runNumber = nextRunNumber(leases, agent.id)
      const attempts = leases.filter((l) => l.agent_id === agent.id).length
      const leaseID = SwarmLease.ID.create()
      const lease: SwarmLease.Record = {
        ...SwarmLease.make({
          id: leaseID,
          agentID: agent.id,
          runNumber,
          issuedAt: now,
          expiresAt: now + this.leaseTimeoutMs,
          attempts,
          opKey: SwarmIdempotency.agentRunKey(agent.id, runNumber),
        }),
        // Stamp the intended worker at issue so observability can attribute
        // pending work even before the lease is claimed.
        worker_id: worker.id,
      }
      await this.store.putLease(lease)
      const admitted = await this.store.atomicTryAdmitAgent()
      if (!admitted) {
        await this.store.putLease({ ...lease, status: "expired" })
        break
      }
      activeByWorker.set(worker.id, (activeByWorker.get(worker.id) ?? 0) + 1)
      leasedAgents.add(agent.id)
      await this.store.queue.publish({
        id: `ql_${leaseID}`,
        kind: `lease:${worker.id}`,
        payload: leaseID,
        visibleAt: now,
        createdAt: now,
      })
      this.audit("swarm.lease.issued", { leaseID, agentID: agent.id, workerID: worker.id, runNumber })
    }
  }

  // ---------------------------------------------------------------------
  // Lease lifecycle (worker-facing)
  // ---------------------------------------------------------------------

  async claimLease(workerID: string, now: number): Promise<SwarmLease.Record | undefined> {
    const worker = await this.store.getWorker(workerID)
    if (worker === undefined || worker.health === "draining" || worker.health === "offline") return undefined
    const delivered = await this.store.queue.claim(1, now, `lease:${workerID}`)
    const first = delivered[0]
    if (first === undefined) return undefined
    const claim = await this.store.atomicClaimLease(first.payload, workerID, now)
    // The delivery message is consumed either way: the lease record is now the
    // authority. Acking it prevents duplicate deliveries from piling up.
    await this.store.queue.ack(first.id, first.claimToken)
    if (!claim.ok) {
      // Duplicate/stale delivery: the lease is already claimed/expired.
      return undefined
    }
    // The agent leaves the scheduler queue and begins executing on this worker.
    const agent = await this.store.getAgent(claim.lease.agent_id)
    if (agent !== undefined && agent.state === "queued") {
      await this.store.transitionAgent(agent.id, "running")
    }
    this.audit("swarm.lease.claimed", { leaseID: claim.lease.id, workerID, agentID: claim.lease.agent_id })
    return claim.lease
  }

  async extendLease(workerID: string, leaseID: string, ms: number, now: number): Promise<boolean> {
    return this.store.touchLeaseHeartbeat(leaseID, workerID, now, now + ms)
  }

  async markLeaseLLM(workerID: string, leaseID: string, reserved: boolean): Promise<boolean> {
    const lease = await this.store.getLease(leaseID)
    if (lease === undefined || lease.worker_id !== workerID) return false
    await this.store.putLease({ ...lease, llm_reserved: reserved })
    return true
  }

  // Reserve per-model/per-provider capacity (the global LLM slot is a separate
  // reservation via reserveLLM). Denials return a queue decision with backoff;
  // the worker nacks and the agent is requeued — never hard-failed.
  async reserveModelCapacity(workerID: string, leaseID: string, model: string, now: number): Promise<{ ok: true } | { ok: false; code: string; backoffMs: number }> {
    const lease = await this.store.getLease(leaseID)
    if (lease === undefined || lease.worker_id !== workerID) return { ok: false, code: "lease_not_held", backoffMs: 500 }
    const agent = await this.store.getAgent(lease.agent_id)
    if (agent?.resolvedModel !== undefined && agent.resolvedModel !== model) return { ok: false, code: "model_mismatch", backoffMs: 500 }
    if (agent !== undefined) {
      const remaining = await this.store.atomicAgentBudgetRemaining(agent.id)
      if (remaining !== undefined && remaining.model_calls <= 0) {
        this.audit("swarm.budget.hard_reached", { missionID: agent.mission, used_calls: -1, used_tokens: -1 })
        return { ok: false, code: "budget_exhausted", backoffMs: 10_000 }
      }
      const missionBudget = await this.store.getMissionBudget(agent.mission)
      if (missionBudget?.hard_reached === true) return { ok: false, code: "budget_exhausted", backoffMs: 10_000 }
    }
    const decision = SwarmGovernor.tryReserve(this.governor, this.governorLimits(), { model, provider: SwarmModelCatalog.providerOf(model), now })
    if (decision.kind === "queue") return { ok: false, code: decision.code, backoffMs: decision.backoffMs }
    this.leaseModels.set(leaseID, { model, provider: SwarmModelCatalog.providerOf(model) })
    return { ok: true }
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

  // Release the governor reservation for a lease (ack/nack/expiry) so a dead
  // worker cannot leak a per-model or per-provider concurrency slot.
  private releaseModelReservation(leaseID: string): void {
    const reserved = this.leaseModels.get(leaseID)
    if (reserved === undefined) return
    this.leaseModels.delete(leaseID)
    SwarmGovernor.release(this.governor, reserved)
  }

  // Soft/hard budget thresholds after a mission consumes resources. Soft ->
  // warn the primary (audit). Hard -> stop scheduling (already enforced by the
  // scheduler reading hard_reached). No task state is mutated here.
  private async afterMissionUsage(missionID: string, usedTokens: number, now: number): Promise<void> {
    const record = await this.store.getMissionBudget(missionID)
    if (record === undefined) return
    const ratio = SwarmMissionBudget.softRatio(this.config)
    const soft = record.max_tokens !== undefined && usedTokens >= record.max_tokens * ratio
    if (soft && !this.budgetSoftWarned.has(missionID)) {
      this.budgetSoftWarned.add(missionID)
      this.audit("swarm.budget.warned", { missionID, used_calls: record.used_calls, used_tokens: usedTokens })
    }
    if (record.hard_reached && now > 0) {
      this.audit("swarm.budget.hard_reached", { missionID, used_calls: record.used_calls, used_tokens: usedTokens })
    }
  }

  async ackLease(workerID: string, leaseID: string, result: unknown, now: number): Promise<LeaseOutcome | { ok: false; reason: string }> {
    const claim = await this.store.atomicCompleteLease(leaseID, workerID, result, now)
    if (!claim.ok) return { ok: false, reason: claim.reason }
    const lease = claim.lease
    const runResult = (typeof result === "object" && result !== null ? result : {}) as { state?: string; requestID?: string; tokens?: number }
    const agent = await this.store.getAgent(lease.agent_id)
    if (agent !== undefined && agent.state === "running") {
      if (runResult.state === "awaiting_approval") {
        await this.store.transitionAgent(agent.id, "awaiting_approval")
        this.audit("swarm.approval.requested", { requestID: runResult.requestID, agentID: agent.id })
      } else {
        await this.store.transitionAgent(agent.id, "completed")
        this.audit("swarm.agent.completed", { agentID: agent.id })
      }
    }
    // A real LLM run (llm_reserved=true) consumed one mission call + tokens.
    if (lease.llm_reserved && agent !== undefined) {
      await this.store.atomicTryConsumeMissionCall(agent.mission)
      if (runResult.tokens !== undefined && runResult.tokens > 0) {
        const used = await this.store.atomicAddMissionTokens(agent.mission, runResult.tokens)
        await this.afterMissionUsage(agent.mission, used, now)
      }
      await this.store.atomicTryConsumeAgentBudget(agent.id, 1, runResult.tokens ?? 0, 0)
    }
    this.releaseModelReservation(leaseID)
    await this.store.atomicReleaseAgent()
    if (lease.llm_reserved) await this.store.atomicReleaseLLM()
    const worker = await this.store.getWorker(workerID)
    if (worker !== undefined) await this.store.putWorker({ ...worker, leases_total: worker.leases_total + 1 })
    this.audit("swarm.lease.completed", { leaseID, workerID, agentID: lease.agent_id, state: runResult.state ?? "completed" })
    return { ok: true, lease, result }
  }

  async nackLease(workerID: string, leaseID: string, reason: string, retryable: boolean, now: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const lease = await this.store.getLease(leaseID)
    if (lease === undefined || lease.worker_id !== workerID) return { ok: false, reason: "not the lease holder" }
    if (!SwarmLease.isActive(lease.status)) return { ok: false, reason: `lease not active (${lease.status})` }
    await this.store.putLease({ ...lease, status: "failed", last_heartbeat: now })
    const agent = await this.store.getAgent(lease.agent_id)
    // Classify provider failures into model health. Auth failures are terminal
    // (retryable=false below) so a bad key never triggers a retry storm.
    if (agent?.resolvedModel !== undefined && !/^(model_capacity|llm_capacity)/i.test(reason)) {
      const health = SwarmModelHealth.classify(reason)
      if (health !== "healthy") {
        const cooldown = health === "rate_limited" ? 2_000 : 0
        const prev = SwarmModelHealth.healthOf(this.healthState, agent.resolvedModel)
        const next = SwarmModelHealth.markHealth(this.healthState, agent.resolvedModel, health, now, cooldown)
        if (next.health !== prev.health || next.disabled !== prev.disabled) {
          this.audit("swarm.model.health_changed", { model: agent.resolvedModel, health: next.health })
        }
        if (health === "authentication_failure") retryable = false
      }
    }
    this.releaseModelReservation(leaseID)
    if (lease.llm_reserved) await this.store.atomicReleaseLLM()
    await this.store.atomicReleaseAgent()
    if (agent !== undefined) {
      if (retryable) {
        if (agent.state === "running") await this.store.transitionAgent(agent.id, "failed")
        if (agent.state === "failed") await this.store.transitionAgent(agent.id, "queued")
        // Backoff before the agent may be re-issued a lease (rate limits).
        const backoffMs = /rate[\s_-]?limit|429|too many/i.test(reason) ? 2_000 : 500
        this.requeueAt.set(agent.id, now + backoffMs)
        this.audit("swarm.agent.requeued", { agentID: agent.id, reason })
      } else {
        if (agent.state === "running") await this.store.transitionAgent(agent.id, "failed")
        this.audit("swarm.agent.failed", { agentID: agent.id, error: reason, attempts: lease.attempts })
      }
    }
    const worker = await this.store.getWorker(workerID)
    if (worker !== undefined) {
      await this.store.putWorker({ ...worker, leases_total: worker.leases_total + 1, leases_failed: worker.leases_failed + 1 })
    }
    this.audit("swarm.lease.failed", { leaseID, workerID, agentID: lease.agent_id, reason, retryable })
    return { ok: true }
  }

  // ---------------------------------------------------------------------
  // Idempotent execution surface (worker-facing)
  // ---------------------------------------------------------------------

  async beginAgentRun(agentID: string, runNumber: number, opID: string, workerID: string, now: number): Promise<{ duplicate: false } | { duplicate: true; result: unknown }> {
    const record: SwarmIdempotency.Record = {
      id: opID,
      kind: "agent.run",
      op_key: SwarmIdempotency.agentRunKey(agentID, runNumber),
      result: null,
      claimed_by: workerID,
      created_at: now,
      completed_at: null,
    }
    return this.store.beginOperation(record)
  }

  async completeAgentRun(agentID: string, runNumber: number, opID: string, result: unknown, now: number): Promise<void> {
    await this.store.completeOperation(opID, result, now)
    void agentID
    void runNumber
    this.audit("swarm.operation.completed", { opID })
  }

  async getAgent(agentID: string): Promise<SwarmAgent.AgentRecord | undefined> {
    return this.store.getAgent(agentID)
  }

  async getMission(id: string): Promise<MissionRecord | undefined> {
    return this.store.getMission(id)
  }

  async getCensus(id: string): Promise<SwarmCensus.Info | undefined> {
    return this.store.getCensus(id)
  }

  async messagesForAgent(agentID: string): Promise<SwarmMessage.Info[]> {
    return this.store.messagesForAgent(agentID)
  }

  async emitAudit(type: string, data: unknown, now: number): Promise<void> {
    this.audit(type, data, now)
  }

  async clusterFinding(agentID: string, report: SwarmDedup.Report): Promise<{ findingID: string }> {
    const outcome = SwarmDedup.clusterReport(this.clustering, report)
    this.audit("swarm.finding.clustered", { findingID: outcome.cluster.id, reporters: outcome.cluster.reporters, canonicalTitle: outcome.cluster.title })
    void agentID
    return { findingID: outcome.cluster.id }
  }

  async createArtifact(agentID: string, opKey: string, patch: SwarmArtifact.PatchBody, now: number): Promise<SwarmArtifact.PatchRecord> {
    const opID = SwarmIdempotency.ID.create()
    const record: SwarmIdempotency.Record = { id: opID, kind: "artifact.create", op_key: opKey, result: null, claimed_by: null, created_at: now, completed_at: null }
    const began = await this.store.beginOperation(record)
    if (began.duplicate) return began.result as SwarmArtifact.PatchRecord
    const task = await this.assignTaskFor(agentID, patch.reason, now)
    const artifact = SwarmArtifact.buildPatchArtifact({ agentID: agentID as SwarmAgent.ID, taskID: task?.id, kind: "patch", patch, summary: patch.reason, time: now })
    await this.store.putArtifact(artifact)
    await this.store.completeOperation(opID, artifact, now)
    this.audit("swarm.artifact.created", { artifactID: artifact.artifact.id, agentID, taskID: task?.id, kind: artifact.artifact.kind, ref: artifact.artifact.ref })
    return artifact
  }

  async createTask(agentID: string, title: string, now: number): Promise<SwarmTask.Info> {
    const task = await this.assignTaskFor(agentID, title, now)
    return task
  }

  private async assignTaskFor(agentID: string, title: string, now: number): Promise<SwarmTask.Info> {
    const task: SwarmTask.Info = {
      id: SwarmTask.ID.create(),
      agentID: agentID as SwarmAgent.ID,
      parentID: undefined,
      title,
      description: undefined,
      state: "completed",
      time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
    }
    await this.store.putTask(task)
    this.audit("swarm.task.created", { taskID: task.id, title })
    this.audit("swarm.task.assigned", { taskID: task.id, agentID })
    return task
  }

  async requestApproval(agentID: string, action: SwarmApproval.Action, resource: string, summary: string, now: number): Promise<SwarmApproval.Request | undefined> {
    const agent = await this.store.getAgent(agentID)
    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.grants,
      agentID: agentID as SwarmAgent.ID,
      missionID: agent?.mission ?? "unknown",
      action,
      resource,
      summary,
      now,
    })
    if (decision.effect === "deny") {
      this.audit("swarm.tool.denied", { agentID, tool: action, reason: decision.reason })
      return undefined
    }
    if (decision.effect === "allow") {
      this.audit("swarm.tool.approved", { agentID, tool: action, scope: "auto" })
      return undefined
    }
    const request: SwarmApproval.Request = {
      id: SwarmApproval.ID.create(),
      agentID: agentID as SwarmAgent.ID,
      action,
      summary,
      metadata: { resource },
      time: DateTime.makeUnsafe(now),
    }
    this.openApprovals.set(request.id, request)
    this.blockedByRequest.set(request.id, agentID)
    this.audit("swarm.tool.requested_approval", { agentID, tool: action })
    return request
  }

  async pendingApproval(agentID: string): Promise<SwarmApproval.Request | undefined> {
    return [...this.openApprovals.values()].find((r) => r.agentID === agentID)
  }

  async addGrant(grant: SwarmApproval.Grant): Promise<void> {
    this.grants.push(grant)
    this.audit("swarm.grant.created", { grantID: grant.id, missionID: grant.missionID, risk: grant.riskCategory })
  }

  async grantApproval(reqID: string, scope?: Partial<Omit<SwarmApproval.Grant, "id" | "uses" | "time">>): Promise<void> {
    await this.replyApproval(reqID, "always", scope)
  }

  async denyApproval(reqID: string): Promise<void> {
    await this.replyApproval(reqID, "reject")
  }

  private async replyApproval(reqID: string, reply: SwarmApproval.Reply, scope?: Partial<Omit<SwarmApproval.Grant, "id" | "uses" | "time">>): Promise<void> {
    const req = this.openApprovals.get(reqID)
    if (req === undefined) throw new Error(`No pending approval: ${reqID}`)
    this.openApprovals.delete(reqID)
    this.blockedByRequest.delete(reqID)
    const agent = await this.store.getAgent(req.agentID)
    if (reply === "reject") {
      this.audit("swarm.approval.denied", { requestID: req.id, agentID: req.agentID })
      if (agent !== undefined && agent.state === "awaiting_approval") {
        await this.store.transitionAgent(agent.id, "failed")
      }
      return
    }
    this.audit("swarm.approval.granted", { requestID: req.id, agentID: req.agentID, reply })
    if (reply === "always") {
      await this.addGrant({
        id: SwarmApproval.ID.create(),
        missionID: agent?.mission ?? "unknown",
        actionPatterns: scope?.actionPatterns ?? [req.action],
        resourcePatterns: scope?.resourcePatterns ?? [],
        riskCategory: scope?.riskCategory ?? SwarmApproval.riskOf(req.action),
        expiresAt: scope?.expiresAt,
        maxUses: scope?.maxUses,
        uses: 0,
        time: DateTime.makeUnsafe(this.now()),
      })
    }
    if (agent !== undefined && agent.state === "awaiting_approval") {
      await this.store.transitionAgent(agent.id, "queued")
      this.audit("swarm.agent.requeued", { agentID: agent.id, reason: "approval granted" })
    }
  }

  // ---------------------------------------------------------------------
  // Mission budget approval (human side)
  // ---------------------------------------------------------------------

  // A primary agent may REQUEST additional mission budget; the human approves,
  // modifies, or rejects. Agents can never approve their own increases.
  async requestBudgetIncrease(input: { agentID: string; reason: string; requested?: SwarmConfig.MissionBudget }): Promise<SwarmApproval.Request | undefined> {
    const agent = await this.store.getAgent(input.agentID)
    const missionID = agent?.mission ?? "unknown"
    const decision = SwarmApproval.evaluate({
      config: this.config.approval,
      grants: this.grants,
      agentID: input.agentID as SwarmAgent.ID,
      missionID,
      action: "budget_increase",
      resource: "mission-budget",
      summary: `Increase mission budget: ${input.reason}`,
      now: this.now(),
    })
    if (decision.effect === "deny") {
      this.audit("swarm.budget.increase_resolved", { requestID: "denied-by-policy", missionID, decision: "reject" })
      return undefined
    }
    if (decision.effect === "allow") {
      await this.raiseMissionBudget(missionID, input.requested)
      this.audit("swarm.budget.increase_resolved", { requestID: "auto", missionID, decision: "approve" })
      return undefined
    }
    const usage = await this.store.getMissionBudget(missionID)
    const request: SwarmApproval.Request = {
      id: SwarmApproval.ID.create(),
      agentID: input.agentID as SwarmAgent.ID,
      action: "budget_increase",
      summary: `Increase mission budget: ${input.reason}`,
      metadata: { resource: "mission-budget", reason: input.reason, used_calls: usage?.used_calls, used_tokens: usage?.used_tokens },
      time: DateTime.makeUnsafe(this.now()),
    }
    this.openApprovals.set(request.id, request)
    this.blockedByRequest.set(request.id, input.agentID)
    this.budgetRequests.set(request.id, { agentID: input.agentID, missionID, reason: input.reason })
    this.audit("swarm.budget.increase_requested", { requestID: request.id, agentID: input.agentID, missionID, reason: input.reason })
    return request
  }

  // Resolve a budget-increase approval. approve/modify raise the mission
  // limits (clearing hard_reached so scheduling resumes); reject leaves them.
  async resolveBudgetIncrease(reqID: string, decision: "approve" | "modify" | "reject", requested?: SwarmConfig.MissionBudget): Promise<void> {
    const pending = this.budgetRequests.get(reqID)
    const req = this.openApprovals.get(reqID)
    if (pending === undefined || req === undefined) throw new Error(`No pending budget increase: ${reqID}`)
    this.budgetRequests.delete(reqID)
    this.openApprovals.delete(reqID)
    this.blockedByRequest.delete(reqID)
    const agent = await this.store.getAgent(pending.agentID)
    if (decision !== "reject") {
      await this.raiseMissionBudget(pending.missionID, requested)
    }
    this.audit("swarm.budget.increase_resolved", { requestID: reqID, missionID: pending.missionID, decision })
    if (decision === "reject" && agent !== undefined && agent.state === "awaiting_approval") {
      await this.store.transitionAgent(agent.id, "failed")
    }
  }

  private async raiseMissionBudget(missionID: string, requested?: SwarmConfig.MissionBudget): Promise<void> {
    if (requested === undefined) return
    await this.store.atomicRaiseMissionLimits(missionID, {
      max_model_calls: requested.max_model_calls,
      max_tokens: requested.max_tokens,
      max_wall_ms: requested.max_wall_ms,
      max_cost: requested.max_cost,
      max_agents: requested.max_agents,
      max_active_agents: requested.max_active_agents,
    })
  }

  // ---------------------------------------------------------------------
  // Global concurrency + secrets (worker-facing)
  // ---------------------------------------------------------------------

  async reserveLLM(workerID: string): Promise<boolean> {
    const reserved = await this.store.atomicTryReserveLLM()
    if (reserved) this.audit("swarm.llm.reserved", { workerID })
    return reserved
  }

  async releaseLLM(workerID: string): Promise<void> {
    await this.store.atomicReleaseLLM()
    this.audit("swarm.llm.released", { workerID })
  }

  async putSecret(secret: SwarmCredentials.Secret): Promise<void> {
    await this.store.putSecret(secret)
  }

  async getSecret(ref: string): Promise<SwarmCredentials.Secret | undefined> {
    return this.store.getSecret(ref)
  }

  // ---------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------

  async metrics(): Promise<SwarmClusterMetrics.ClusterMetrics> {
    const [workers, leases, accounting, queueDepth] = await Promise.all([
      this.store.listWorkers(),
      this.store.listLeases(),
      this.store.accounting(),
      this.store.queue.depth(),
    ])
    return SwarmClusterMetrics.compute(workers, leases, accounting, queueDepth)
  }

  async openApprovalCount(): Promise<number> {
    return this.openApprovals.size
  }

  // ---------------------------------------------------------------------
  // TUI foundation: Models + Resource views (Phase 3 renders these)
  // ---------------------------------------------------------------------

  async modelsView(): Promise<SwarmRegistry.ModelsView> {
    return SwarmRegistry.modelsView(this.config, this.healthState, this.governor, await this.queuedByModelSnapshot())
  }

  async resourceView(missionID: string): Promise<SwarmRegistry.ResourceView | undefined> {
    const budget = await this.store.getMissionBudget(missionID)
    if (budget === undefined) return undefined
    const accounting = await this.store.accounting()
    const limit: SwarmMissionBudget.MissionBudgetLimits = {
      max_agents: budget.max_agents,
      max_active_agents: budget.max_active_agents,
      max_model_calls: budget.max_model_calls,
      max_tokens: budget.max_tokens,
      max_wall_ms: budget.max_wall_ms,
      max_cost: budget.max_cost,
    }
    const state = SwarmMissionBudget.makeState(missionID, limit, budget.started_at, {
      modelCalls: budget.used_calls,
      tokens: budget.used_tokens,
      wallMs: 0,
      cost: 0,
    })
    const threshold = budget.hard_reached
      ? "hard"
      : SwarmMissionBudget.evaluate(state, this.now(), SwarmMissionBudget.softRatio(this.config))
    const queued = await this.queuedByModelSnapshot()
    let queuedTotal = 0
    for (const n of queued.values()) queuedTotal += n
    return SwarmRegistry.resourceView(
      { population: accounting.population, active: accounting.activeAgents, activeWorkspaces: accounting.activeWorkspaces },
      SwarmGovernor.globalActive(this.governor),
      queuedTotal,
      { budget: state, threshold },
      this.openApprovals.size,
    )
  }

  // Live count of queued agents currently blocked on rate limits, by model.
  private async queuedByModelSnapshot(): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    const now = this.now()
    for (const agent of await this.store.listAgentsByState("queued")) {
      if (agent.resolvedModel === undefined) continue
      const backoff = this.requeueAt.get(agent.id)
      const throttled = (backoff !== undefined && backoff > now) || !SwarmModelHealth.isUsable(this.healthState, agent.resolvedModel, now)
      if (!throttled) continue
      map.set(agent.resolvedModel, (map.get(agent.resolvedModel) ?? 0) + 1)
    }
    return map
  }
}

// ---------------------------------------------------------------------------
// Capability-based routing. Model policy stays human-controlled: the agent's
// resolved model comes from the allowlist (control-plane authority) and the
// worker must additionally expose it. Workers are chosen least-loaded for
// fairness; a worker that cannot satisfy the required capabilities or the
// resolved model is skipped, never downgraded.
// ---------------------------------------------------------------------------

function pickWorker(
  workers: SwarmWorker.Record[],
  activeByWorker: Map<string, number>,
  requiredCaps: ReadonlyArray<string>,
  model: string | undefined,
): SwarmWorker.Record | undefined {
  const eligible = workers
    .filter((w) => SwarmWorker.canRun(w, requiredCaps, model))
    .filter((w) => !SwarmWorker.atCapacity(w, activeByWorker.get(w.id) ?? 0))
    .sort((a, b) => {
      const loadA = activeByWorker.get(a.id) ?? 0
      const loadB = activeByWorker.get(b.id) ?? 0
      if (loadA !== loadB) return loadA - loadB
      return a.registered_at - b.registered_at
    })
  return eligible[0]
}

// The next run number is the highest completed run + 1, so a retry after a
// worker crash reuses the same operation key (idempotent replay) while a
// genuinely fresh run always re-executes.
function nextRunNumber(leases: SwarmLease.Record[], agentID: string): number {
  let highest = 0
  for (const lease of leases) {
    if (lease.agent_id === agentID && lease.status === "completed" && lease.run_number > highest) highest = lease.run_number
  }
  return highest + 1
}

// Map a router failure to the swarm spawn rejection vocabulary.
function rejectCodeFor(code: string): SwarmAgent.RejectionCode {
  if (code === "no_models_allowed") return "no_models_allowed"
  if (code === "model_not_allowed") return "model_not_allowed"
  if (code === "pool_empty") return "pool_empty"
  if (code === "context_overflow") return "context_overflow"
  if (code === "no_remaining_budget") return "no_remaining_budget"
  return "no_eligible_model"
}

// Credential scopes are an intersection (never a broadening): a worker's
// declared capabilities, model list, and concurrency ceiling are each capped
// by what its credential allows.
function applyCredentialScopes(capabilities: SwarmWorker.Capabilities, scopes: SwarmCredentials.Scopes): SwarmWorker.Capabilities {
  const capSet = scopes.capabilities.length === 0 ? capabilities.capabilities : capabilities.capabilities.filter((c) => scopes.capabilities.includes(c))
  const modelSet = scopes.models.length === 0 ? capabilities.availableModels : capabilities.availableModels.filter((m) => scopes.models.includes(m))
  const maxConcurrentAgents = scopes.maxConcurrentAgents !== undefined ? Math.min(capabilities.maxConcurrentAgents, scopes.maxConcurrentAgents) : capabilities.maxConcurrentAgents
  return {
    ...capabilities,
    capabilities: capSet,
    availableModels: modelSet,
    maxConcurrentAgents,
  }
}
