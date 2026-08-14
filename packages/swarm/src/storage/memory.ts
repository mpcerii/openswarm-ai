export * as SwarmMemoryStore from "./memory"

import { DateTime } from "effect"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"
import { SwarmMessage } from "../messaging/message"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmCensus } from "../census/census"
import { SwarmAudit } from "../audit/audit"
import { SwarmWorker } from "../cluster/worker"
import { SwarmLease } from "../cluster/lease"
import { SwarmIdempotency } from "../cluster/idempotency"
import { SwarmCredentials } from "../cluster/credentials"
import { SwarmQueue } from "../queue/queue"
import type {
  DurableStore,
  SpawnLimits,
  SpawnRejection,
  MissionRecord,
  ConcurrencySnapshot,
  StoreSnapshot,
  MissionBudgetRecord,
  AgentBudgetRecord,
  ChildBudgetAmount,
  MissionAccounting,
} from "./store"

// ---------------------------------------------------------------------------
// Deterministic in-memory store. Every mutating operation runs inside a single
// serialized lock, so the atomic primitives the distributed runtime relies on
// (spawn budget, active/LLM slots, lease claims, operation registration) are
// genuinely atomic even under 8 concurrent worker loops. This is the backend
// the distributed simulation + chaos tests run against — no external infra.
// ---------------------------------------------------------------------------

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const prev = this.tail
    this.tail = prev.then(() => gate)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function withState(record: SwarmAgent.AgentRecord, to: SwarmAgent.State, now: number): SwarmAgent.AgentRecord {
  SwarmAgent.transition(record.state, to)
  return { ...record, state: to, time: { created: record.time.created, updated: DateTime.makeUnsafe(now) } }
}

class MemoryQueue implements SwarmQueue.Backend {
  readonly kind = "memory" as const
  constructor(
    private readonly items: Map<string, SwarmQueue.Message>,
    private readonly lock: Mutex,
  ) {}

  async publish(msg: SwarmQueue.PublishInput): Promise<void> {
    await this.lock.run(() => {
      this.items.set(msg.id, {
        id: msg.id,
        kind: msg.kind,
        payload: msg.payload,
        visibleAt: msg.visibleAt,
        claimToken: null,
        claimedAt: null,
        attempts: 0,
        createdAt: msg.createdAt,
      })
    })
  }

  async claim(max: number, now: number, kind?: string): Promise<SwarmQueue.Claimed[]> {
    return this.lock.run(() => {
      const out: SwarmQueue.Claimed[] = []
      const candidates = [...this.items.values()]
        .filter((m) => m.visibleAt <= now && m.claimToken === null && (kind === undefined || m.kind === kind))
        .sort((a, b) => a.visibleAt - b.visibleAt)
      for (const m of candidates) {
        if (out.length >= max) break
        const token = `tok_${Math.random().toString(36).slice(2, 10)}`
        this.items.set(m.id, { ...m, claimToken: token, claimedAt: now, attempts: m.attempts + 1 })
        out.push({ id: m.id, kind: m.kind, payload: m.payload, claimToken: token, attempts: m.attempts + 1 })
      }
      return out
    })
  }

  async ack(id: string, claimToken: string): Promise<boolean> {
    return this.lock.run(() => {
      const m = this.items.get(id)
      if (m === undefined || m.claimToken !== claimToken) return false
      this.items.delete(id)
      return true
    })
  }

  async nack(id: string, claimToken: string, visibleAt: number): Promise<boolean> {
    return this.lock.run(() => {
      const m = this.items.get(id)
      if (m === undefined || m.claimToken !== claimToken) return false
      this.items.set(id, { ...m, claimToken: null, claimedAt: null, visibleAt })
      return true
    })
  }

  async extend(id: string, claimToken: string, visibleAt: number): Promise<boolean> {
    return this.lock.run(() => {
      const m = this.items.get(id)
      if (m === undefined || m.claimToken !== claimToken) return false
      this.items.set(id, { ...m, visibleAt })
      return true
    })
  }

  async depth(): Promise<number> {
    return this.lock.run(() => this.items.size)
  }

  // Sync size for use inside the store lock (snapshot must stay consistent).
  size(): number {
    return this.items.size
  }
}

export class MemoryStore implements DurableStore {
  readonly kind = "memory" as const
  readonly queue: SwarmQueue.Backend
  private readonly lock = new Mutex()

  private readonly agents = new Map<string, SwarmAgent.AgentRecord>()
  private readonly missions = new Map<string, MissionRecord>()
  private readonly census = new Map<string, SwarmCensus.Info>()
  private readonly messages = new Map<string, SwarmMessage.Info[]>()
  private readonly tasks = new Map<string, SwarmTask.Info>()
  private readonly artifacts = new Map<string, SwarmArtifact.PatchRecord>()
  private readonly audit: SwarmAudit.StoredEvent[] = []
  private readonly auditByType = new Map<string, number[]>()
  private readonly modelOverrides = new Map<string, boolean>()
  private readonly workers = new Map<string, SwarmWorker.Record>()
  private readonly leases = new Map<string, SwarmLease.Record>()
  private readonly operations = new Map<string, SwarmIdempotency.Record>()
  private readonly opIndex = new Map<string, string>()
  private readonly credentials = new Map<string, SwarmCredentials.Record>()
  private readonly secrets = new Map<string, SwarmCredentials.Secret>()
  private readonly spawnChildren = new Map<string, number>()
  private readonly missionBudgets = new Map<string, MissionBudgetRecord>()
  private readonly agentBudgets = new Map<string, AgentBudgetRecord>()

  private population = 0
  private activeAgents = 0
  private activeAgentsPeak = 0
  private activeLLM = 0
  private activeLLMPeak = 0
  private activeWorkspaces = 0
  private workspacePeak = 0

  constructor(
    private readonly limits: SpawnLimits,
    private readonly llmCap: number,
    private readonly workspaceCap: number,
  ) {
    this.queue = new MemoryQueue(new Map<string, SwarmQueue.Message>(), this.lock)
  }

  async getAgent(id: string): Promise<SwarmAgent.AgentRecord | undefined> {
    return this.agents.get(id)
  }

  async putAgent(record: SwarmAgent.AgentRecord): Promise<void> {
    this.agents.set(record.id, record)
  }

  async transitionAgent(id: string, to: SwarmAgent.State): Promise<SwarmAgent.AgentRecord | undefined> {
    return this.lock.run(() => {
      const current = this.agents.get(id)
      if (current === undefined) return undefined
      const updated = withState(current, to, Date.now())
      this.agents.set(id, updated)
      return updated
    })
  }

  async listAgents(): Promise<SwarmAgent.AgentRecord[]> {
    return [...this.agents.values()]
  }

  async listAgentsByState(state: SwarmAgent.State): Promise<SwarmAgent.AgentRecord[]> {
    return [...this.agents.values()].filter((a) => a.state === state)
  }

  async putMission(mission: MissionRecord): Promise<void> {
    this.missions.set(mission.id, mission)
  }

  async getMission(id: string): Promise<MissionRecord | undefined> {
    return this.missions.get(id)
  }

  async listMissions(): Promise<MissionRecord[]> {
    return [...this.missions.values()]
  }

  async putCensus(census: SwarmCensus.Info): Promise<void> {
    this.census.set(census.id, census)
  }

  async getCensus(id: string): Promise<SwarmCensus.Info | undefined> {
    return this.census.get(id)
  }

  async putMessage(message: SwarmMessage.Info): Promise<void> {
    const inbox = this.messages.get(message.to) ?? []
    inbox.push(message)
    this.messages.set(message.to, inbox)
  }

  async messagesForAgent(id: string): Promise<SwarmMessage.Info[]> {
    return this.messages.get(id) ?? []
  }

  async putTask(task: SwarmTask.Info): Promise<void> {
    this.tasks.set(task.id, task)
  }

  async listTasks(): Promise<SwarmTask.Info[]> {
    return [...this.tasks.values()]
  }

  async putArtifact(record: SwarmArtifact.PatchRecord): Promise<void> {
    this.artifacts.set(record.artifact.id, record)
  }

  async listArtifacts(): Promise<SwarmArtifact.PatchRecord[]> {
    return [...this.artifacts.values()]
  }

  async appendAudit(entry: SwarmAudit.StoredEvent): Promise<void> {
    const index = this.audit.length
    this.audit.push(entry)
    const byType = this.auditByType.get(entry.type) ?? []
    byType.push(index)
    this.auditByType.set(entry.type, byType)
  }

  async auditEvents(): Promise<SwarmAudit.StoredEvent[]> {
    return [...this.audit]
  }

  async eventsByType(type: string): Promise<SwarmAudit.StoredEvent[]> {
    const indices = this.auditByType.get(type) ?? []
    return indices.map((i) => this.audit[i]!)
  }

  async hasModelOverrides(): Promise<boolean> {
    return this.modelOverrides.size > 0
  }

  async listEnabledModels(): Promise<string[]> {
    return [...this.modelOverrides.entries()].filter(([, enabled]) => enabled).map(([id]) => id)
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<void> {
    this.modelOverrides.set(id, enabled)
  }

  async putWorker(record: SwarmWorker.Record): Promise<void> {
    this.workers.set(record.id, record)
  }

  async getWorker(id: string): Promise<SwarmWorker.Record | undefined> {
    return this.workers.get(id)
  }

  async listWorkers(): Promise<SwarmWorker.Record[]> {
    return [...this.workers.values()]
  }

  async removeWorker(id: string): Promise<void> {
    this.workers.delete(id)
  }

  async putLease(record: SwarmLease.Record): Promise<void> {
    this.leases.set(record.id, record)
  }

  async getLease(id: string): Promise<SwarmLease.Record | undefined> {
    return this.leases.get(id)
  }

  async listLeases(): Promise<SwarmLease.Record[]> {
    return [...this.leases.values()]
  }

  async listLeasesByWorker(workerID: string): Promise<SwarmLease.Record[]> {
    return [...this.leases.values()].filter((l) => l.worker_id === workerID)
  }

  async listLeasesByAgent(agentID: string): Promise<SwarmLease.Record[]> {
    return [...this.leases.values()].filter((l) => l.agent_id === agentID)
  }

  async atomicClaimLease(id: string, workerID: string, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }> {
    return this.lock.run(() => {
      const lease = this.leases.get(id)
      if (lease === undefined) return { ok: false, reason: "unknown lease" }
      if (lease.status !== "pending") return { ok: false, reason: `lease not claimable (${lease.status})` }
      if (lease.expires_at <= now) return { ok: false, reason: "lease expired before claim" }
      const updated: SwarmLease.Record = { ...lease, worker_id: workerID, status: "claimed", last_heartbeat: now }
      this.leases.set(id, updated)
      return { ok: true, lease: updated }
    })
  }

  async atomicCompleteLease(id: string, workerID: string, result: unknown, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }> {
    return this.lock.run(() => {
      const lease = this.leases.get(id)
      if (lease === undefined) return { ok: false, reason: "unknown lease" }
      if (lease.worker_id !== workerID) return { ok: false, reason: "lease held by another worker" }
      const updated: SwarmLease.Record = {
        ...lease,
        status: "completed",
        last_heartbeat: now,
        expires_at: now,
        result: typeof result === "string" ? result : JSON.stringify(result ?? null),
      }
      this.leases.set(id, updated)
      return { ok: true, lease: updated }
    })
  }

  async touchLeaseHeartbeat(id: string, workerID: string, now: number, expiresAt: number): Promise<boolean> {
    return this.lock.run(() => {
      const lease = this.leases.get(id)
      if (lease === undefined || lease.worker_id !== workerID) return false
      if (lease.status === "completed" || lease.status === "failed" || lease.status === "expired") return false
      this.leases.set(id, { ...lease, last_heartbeat: now, expires_at: expiresAt })
      return true
    })
  }

  async expireLeases(workerID: string | undefined, now: number): Promise<string[]> {
    return this.lock.run(() => {
      const out: string[] = []
      for (const [id, lease] of this.leases) {
        if (lease.status === "completed" || lease.status === "failed" || lease.status === "expired") continue
        if (workerID !== undefined && lease.worker_id !== workerID) continue
        if (lease.expires_at > now) continue
        this.leases.set(id, { ...lease, status: "expired", last_heartbeat: now })
        out.push(id)
      }
      return out
    })
  }

  async beginOperation(record: SwarmIdempotency.Record): Promise<{ duplicate: true; result: unknown } | { duplicate: false }> {
    return this.lock.run(() => {
      const key = `${record.kind}:${record.op_key}`
      const existing = this.opIndex.get(key)
      if (existing !== undefined) {
        const op = this.operations.get(existing)!
        // Only a COMPLETED operation replays; an uncompleted one (crashed
        // before completion) is adopted by the retry so it can finish.
        if (op.completed_at !== null) {
          const result = op.result === null ? undefined : parseJson(op.result)
          return { duplicate: true, result }
        }
        this.operations.delete(existing)
      }
      this.operations.set(record.id, record)
      this.opIndex.set(key, record.id)
      return { duplicate: false }
    })
  }

  async completeOperation(id: string, result: unknown, now: number): Promise<void> {
    await this.lock.run(() => {
      const op = this.operations.get(id)
      if (op === undefined) return
      this.operations.set(id, { ...op, result: JSON.stringify(result ?? null), completed_at: now })
    })
  }

  async hasOperation(kind: SwarmIdempotency.Kind, key: string): Promise<boolean> {
    return this.opIndex.has(`${kind}:${key}`)
  }

  async listOperations(): Promise<SwarmIdempotency.Record[]> {
    return [...this.operations.values()]
  }

  async putCredential(record: SwarmCredentials.Record): Promise<void> {
    this.credentials.set(record.id, record)
  }

  async getCredential(id: string): Promise<SwarmCredentials.Record | undefined> {
    return this.credentials.get(id)
  }

  async listCredentials(): Promise<SwarmCredentials.Record[]> {
    return [...this.credentials.values()]
  }

  async putSecret(secret: SwarmCredentials.Secret): Promise<void> {
    this.secrets.set(secret.ref, secret)
  }

  async getSecret(ref: string): Promise<SwarmCredentials.Secret | undefined> {
    return this.secrets.get(ref)
  }

  async atomicTryConsumeSpawn(parentID: string | undefined, depth: number): Promise<{ ok: true; depth: number } | { ok: false; code: SpawnRejection }> {
    return this.lock.run(() => {
      if (this.population + 1 > this.limits.max_agents) return { ok: false, code: "population_exceeded" }
      if (depth > this.limits.max_depth) return { ok: false, code: "depth_exceeded" }
      if (parentID !== undefined) {
        const children = this.spawnChildren.get(parentID) ?? 0
        if (children + 1 > this.limits.max_children_per_agent) return { ok: false, code: "children_exceeded" }
        this.spawnChildren.set(parentID, children + 1)
      }
      this.population += 1
      return { ok: true, depth }
    })
  }

  async atomicReleaseSpawn(parentID: string | undefined): Promise<void> {
    await this.lock.run(() => {
      if (this.population > 0) this.population -= 1
      if (parentID !== undefined) {
        const children = this.spawnChildren.get(parentID) ?? 0
        if (children > 0) this.spawnChildren.set(parentID, children - 1)
      }
    })
  }

  async atomicTryAdmitAgent(): Promise<boolean> {
    return this.lock.run(() => {
      if (this.activeAgents >= this.limits.max_active_agents) return false
      this.activeAgents += 1
      if (this.activeAgents > this.activeAgentsPeak) this.activeAgentsPeak = this.activeAgents
      return true
    })
  }

  async atomicReleaseAgent(): Promise<void> {
    await this.lock.run(() => {
      if (this.activeAgents > 0) this.activeAgents -= 1
    })
  }

  async atomicTryReserveLLM(): Promise<boolean> {
    return this.lock.run(() => {
      if (this.activeLLM >= this.llmCap) return false
      this.activeLLM += 1
      if (this.activeLLM > this.activeLLMPeak) this.activeLLMPeak = this.activeLLM
      return true
    })
  }

  async atomicReleaseLLM(): Promise<void> {
    await this.lock.run(() => {
      if (this.activeLLM > 0) this.activeLLM -= 1
    })
  }

  async atomicTryConsumeWorkspace(max: number): Promise<boolean> {
    return this.lock.run(() => {
      if (this.activeWorkspaces >= max) return false
      this.activeWorkspaces += 1
      if (this.activeWorkspaces > this.workspacePeak) this.workspacePeak = this.activeWorkspaces
      return true
    })
  }

  async atomicReleaseWorkspace(): Promise<void> {
    await this.lock.run(() => {
      if (this.activeWorkspaces > 0) this.activeWorkspaces -= 1
    })
  }

  async putMissionBudget(record: MissionBudgetRecord): Promise<void> {
    await this.lock.run(() => {
      this.missionBudgets.set(record.missionID, record)
    })
  }

  async getMissionBudget(missionID: string): Promise<MissionBudgetRecord | undefined> {
    return this.missionBudgets.get(missionID)
  }

  async atomicTryConsumeMissionCall(missionID: string): Promise<boolean> {
    return this.lock.run(() => {
      const record = this.missionBudgets.get(missionID)
      if (record === undefined) return true
      const max = record.max_model_calls
      if (max !== undefined && record.used_calls + 1 > max) {
        this.missionBudgets.set(missionID, { ...record, hard_reached: true })
        return false
      }
      this.missionBudgets.set(missionID, { ...record, used_calls: record.used_calls + 1 })
      return true
    })
  }

  async atomicAddMissionTokens(missionID: string, tokens: number): Promise<number> {
    return this.lock.run(() => {
      const record = this.missionBudgets.get(missionID)
      if (record === undefined || tokens <= 0) return record?.used_tokens ?? 0
      const next = { ...record, used_tokens: record.used_tokens + tokens }
      if (record.max_tokens !== undefined && next.used_tokens >= record.max_tokens) next.hard_reached = true
      this.missionBudgets.set(missionID, next)
      return next.used_tokens
    })
  }

  async atomicRaiseMissionLimits(missionID: string, increase: Partial<MissionBudgetRecord>): Promise<void> {
    await this.lock.run(() => {
      const record = this.missionBudgets.get(missionID)
      if (record === undefined) return
      const next = { ...record }
      const add = (field: "max_model_calls" | "max_tokens" | "max_wall_ms" | "max_cost") => {
        const inc = increase[field]
        if (inc === undefined) return
        next[field] = record[field] === undefined ? inc : (record[field] as number) + inc
      }
      add("max_model_calls")
      add("max_tokens")
      add("max_wall_ms")
      add("max_cost")
      if (increase.max_agents !== undefined) next.max_agents = record.max_agents === undefined ? increase.max_agents : record.max_agents + increase.max_agents
      if (increase.max_active_agents !== undefined) next.max_active_agents = record.max_active_agents === undefined ? increase.max_active_agents : record.max_active_agents + increase.max_active_agents
      next.hard_reached = false
      this.missionBudgets.set(missionID, next)
    })
  }

  async atomicSeedAgentBudget(record: AgentBudgetRecord): Promise<void> {
    await this.lock.run(() => {
      this.agentBudgets.set(record.agentID, record)
    })
  }

  async atomicDelegateChildBudget(missionID: string, parentID: string, childID: string, amount: ChildBudgetAmount): Promise<{ ok: true } | { ok: false; code: "parent_budget_exhausted" | "no_parent_allocation" }> {
    return this.lock.run(() => {
      const parent = this.agentBudgets.get(parentID)
      if (parent === undefined) return { ok: false, code: "no_parent_allocation" }
      if (parent.remaining_calls < amount.model_calls || parent.remaining_tokens < amount.tokens || parent.remaining_cost < amount.cost) {
        return { ok: false, code: "parent_budget_exhausted" }
      }
      this.agentBudgets.set(parentID, {
        ...parent,
        remaining_calls: parent.remaining_calls - amount.model_calls,
        remaining_tokens: parent.remaining_tokens - amount.tokens,
        remaining_cost: parent.remaining_cost - amount.cost,
      })
      this.agentBudgets.set(childID, {
        agentID: childID,
        parentID,
        missionID,
        remaining_calls: amount.model_calls,
        remaining_tokens: amount.tokens,
        remaining_cost: amount.cost,
      })
      return { ok: true }
    })
  }

  async atomicReclaimChildBudget(missionID: string, childID: string): Promise<void> {
    await this.lock.run(() => {
      const child = this.agentBudgets.get(childID)
      if (child === undefined || child.missionID !== missionID) return
      const parentID = child.parentID
      this.agentBudgets.delete(childID)
      if (parentID !== null) {
        const parent = this.agentBudgets.get(parentID)
        if (parent !== undefined) {
          this.agentBudgets.set(parentID, {
            ...parent,
            remaining_calls: parent.remaining_calls + child.remaining_calls,
            remaining_tokens: parent.remaining_tokens + child.remaining_tokens,
            remaining_cost: parent.remaining_cost + child.remaining_cost,
          })
        }
      }
    })
  }

  async atomicTryConsumeAgentBudget(agentID: string, calls = 1, tokens = 0, cost = 0): Promise<boolean> {
    return this.lock.run(() => {
      const record = this.agentBudgets.get(agentID)
      if (record === undefined) return true
      if (record.remaining_calls < calls || record.remaining_tokens < tokens || record.remaining_cost < cost) return false
      this.agentBudgets.set(agentID, {
        ...record,
        remaining_calls: record.remaining_calls - calls,
        remaining_tokens: record.remaining_tokens - tokens,
        remaining_cost: record.remaining_cost - cost,
      })
      return true
    })
  }

  async atomicAgentBudgetRemaining(agentID: string): Promise<ChildBudgetAmount | undefined> {
    const record = this.agentBudgets.get(agentID)
    if (record === undefined) return undefined
    return { model_calls: record.remaining_calls, tokens: record.remaining_tokens, cost: record.remaining_cost }
  }

  async missionAccounting(missionID: string): Promise<MissionAccounting | undefined> {
    const record = this.missionBudgets.get(missionID)
    if (record === undefined) return undefined
    return {
      missionID,
      used_calls: record.used_calls,
      used_tokens: record.used_tokens,
      max_model_calls: record.max_model_calls,
      max_tokens: record.max_tokens,
      max_wall_ms: record.max_wall_ms,
      max_cost: record.max_cost,
      hard_reached: record.hard_reached,
      started_at: record.started_at,
    }
  }

  async accounting(): Promise<ConcurrencySnapshot> {
    return this.accountingRef()
  }

  async snapshot(): Promise<StoreSnapshot> {
    return {
      agents: this.agents.size,
      workers: [...this.workers.values()],
      leases: [...this.leases.values()],
      operations: [...this.operations.values()],
      accounting: this.accountingRef(),
      queueDepth: await this.queue.depth(),
    }
  }

  private accountingRef(): ConcurrencySnapshot {
    return {
      population: this.population,
      activeAgents: this.activeAgents,
      activeLLM: this.activeLLM,
      activeWorkspaces: this.activeWorkspaces,
      activeAgentsPeak: this.activeAgentsPeak,
      activeLLMPeak: this.activeLLMPeak,
      maxAgents: this.limits.max_agents,
      maxActiveAgents: this.limits.max_active_agents,
      maxActiveLLM: this.llmCap,
      maxActiveWorkspaces: this.workspaceCap,
    }
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
